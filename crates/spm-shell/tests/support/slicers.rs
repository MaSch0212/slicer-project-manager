//! What the slicer tests share: a clock the test drives, a directory watch it fires by hand, a
//! spawner that records instead of starting anything, a library with files in it, and the machine
//! the launch tests run on (all five slicers installed, all bound).
//!
//! **Nothing here starts a slicer or opens a window.** The one test that starts a real process
//! uses a stub executable that records its own argv and exits (`stub.rs`).

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use spm_core::dto::SlicerId;
use spm_core::testing::TempLibrary;
use spm_core::{Ctx, Library, create_project, ensure_local_user, resolve_file_path, upload_file};
use spm_shell::library::DesktopSession;
use spm_shell::slicers::config::{
    SLICERS_CONFIG_VERSION, SLICERS_FILE_NAME, SlicersConfig, StoredInstall, write_config,
};
use spm_shell::slicers::detect::InstallOrigin;
use spm_shell::slicers::host::{SlicersHost, SlicersHostOptions};
use spm_shell::slicers::launch::{SlicerLauncher, SlicerLauncherOptions};
use spm_shell::slicers::remote_files::RemoteLibrary;
use spm_shell::slicers::sched::{DirectoryWatcher, Scheduler, TimerId, WatchHandle};
use spm_shell::slicers::spawn::{ExitCallback, ExitWatch, SlicerSpawner, SpawnedSlicer};

// ---------------------------------------------------------------------------------------------
// A clock the test drives
// ---------------------------------------------------------------------------------------------

enum Task {
    Once(Option<Box<dyn FnOnce() + Send>>),
    Every(Arc<dyn Fn() + Send + Sync>),
}

struct Scheduled {
    at: i64,
    every: Option<i64>,
    task: Task,
}

struct ClockState {
    now: i64,
    next_id: TimerId,
    scheduled: BTreeMap<TimerId, Scheduled>,
}

/// `Date.now`, `setTimeout` and `setInterval`, all moved by hand.
///
/// It is deliberately not a general fake-timer library: what the sessions need is that `now()` and
/// the scheduler agree, because the settle window is measured with the first and spent by the
/// second. A suite where those two clocks could drift would let a 60 s window elapse in fifty
/// ticks of a 500 ms timer and never notice which of them was wrong.
pub struct Clock {
    state: Mutex<ClockState>,
}

impl Clock {
    pub fn new() -> Arc<Clock> {
        Arc::new(Clock {
            state: Mutex::new(ClockState {
                now: 1_756_000_000_000,
                next_id: 1,
                scheduled: BTreeMap::new(),
            }),
        })
    }

    pub fn now(&self) -> i64 {
        self.state.lock().unwrap().now
    }

    pub fn set_now(&self, now: i64) {
        self.state.lock().unwrap().now = now;
    }

    /// How many timers are pending.
    pub fn pending(&self) -> usize {
        self.state.lock().unwrap().scheduled.len()
    }

    /// Moves time forward, firing everything due, in order.
    pub fn advance(&self, ms: i64) {
        let until = self.now() + ms;
        loop {
            let due = {
                let mut state = self.state.lock().unwrap();
                let next = state
                    .scheduled
                    .iter()
                    .filter(|(_, entry)| entry.at <= until)
                    .min_by_key(|(id, entry)| (entry.at, **id))
                    .map(|(id, _)| *id);
                let Some(id) = next else {
                    break;
                };
                let at = state.scheduled[&id].at;
                state.now = at;
                let entry = state.scheduled.get_mut(&id).unwrap();
                match &mut entry.task {
                    Task::Once(task) => {
                        let task = task.take();
                        state.scheduled.remove(&id);
                        task.map(|task| -> Box<dyn FnOnce()> { Box::new(task) })
                    }
                    Task::Every(task) => {
                        let task = Arc::clone(task);
                        entry.at += entry.every.unwrap_or(1);
                        Some(Box::new(move || task()) as Box<dyn FnOnce()>)
                    }
                }
            };
            if let Some(run) = due {
                run();
            }
        }
        self.state.lock().unwrap().now = until;
    }

    fn add(&self, ms: u64, every: bool, task: Task) -> TimerId {
        let mut state = self.state.lock().unwrap();
        let id = state.next_id;
        state.next_id += 1;
        let ms = i64::try_from(ms).unwrap();
        let at = state.now + ms;
        state.scheduled.insert(
            id,
            Scheduled {
                at,
                every: every.then_some(ms),
                task,
            },
        );
        id
    }
}

impl Scheduler for Clock {
    fn after(&self, ms: u64, task: Box<dyn FnOnce() + Send>) -> TimerId {
        self.add(ms, false, Task::Once(Some(task)))
    }

    fn every(&self, ms: u64, task: Arc<dyn Fn() + Send + Sync>) -> TimerId {
        self.add(ms, true, Task::Every(task))
    }

    fn cancel(&self, id: TimerId) {
        self.state.lock().unwrap().scheduled.remove(&id);
    }
}

// ---------------------------------------------------------------------------------------------
// A directory watch the test fires
// ---------------------------------------------------------------------------------------------

pub struct Watched {
    pub directory: PathBuf,
    pub fire: Arc<dyn Fn() + Send + Sync>,
    pub closed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ManualWatcher {
    pub watched: Mutex<Vec<Watched>>,
    pub fail: AtomicBool,
}

struct ManualHandle(Arc<AtomicBool>);

impl WatchHandle for ManualHandle {}

impl Drop for ManualHandle {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl ManualWatcher {
    pub fn new() -> Arc<ManualWatcher> {
        Arc::new(ManualWatcher::default())
    }

    /// Fires the watch on the `index`th directory, as the operating system would.
    pub fn fire(&self, index: usize) {
        let fire = Arc::clone(&self.watched.lock().unwrap()[index].fire);
        fire();
    }

    pub fn count(&self) -> usize {
        self.watched.lock().unwrap().len()
    }

    pub fn closed(&self, index: usize) -> bool {
        self.watched.lock().unwrap()[index]
            .closed
            .load(Ordering::SeqCst)
    }
}

impl DirectoryWatcher for ManualWatcher {
    fn watch(
        &self,
        directory: &Path,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> std::io::Result<Box<dyn WatchHandle>> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(std::io::Error::other("unsupported on this filesystem"));
        }
        let closed = Arc::new(AtomicBool::new(false));
        self.watched.lock().unwrap().push(Watched {
            directory: directory.to_path_buf(),
            fire: on_change,
            closed: Arc::clone(&closed),
        });
        Ok(Box::new(ManualHandle(closed)))
    }
}

// ---------------------------------------------------------------------------------------------
// A spawner that records
// ---------------------------------------------------------------------------------------------

/// One recorded spawn, **including the working directory the child was given**, and whether that
/// directory existed *at the moment of the spawn*: the only moment at which the answer is
/// interesting (a `create_dir_all` moved to construction, or to the end of `open`, passes an
/// after-the-fact check in the test body and fails this one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawned {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cwd_existed: bool,
}

#[derive(Default)]
struct ExitState {
    exited: bool,
    callback: Option<ExitCallback>,
}

#[derive(Clone, Default)]
pub struct ManualExit(Arc<Mutex<ExitState>>);

impl ManualExit {
    /// The spawned process exits now.
    pub fn exit(&self) {
        let callback = {
            let mut state = self.0.lock().unwrap();
            state.exited = true;
            state.callback.take()
        };
        if let Some(callback) = callback {
            callback();
        }
    }
}

impl ExitWatch for ManualExit {
    fn on_exit(self: Box<Self>, callback: ExitCallback) {
        let now = {
            let mut state = self.0.lock().unwrap();
            if state.exited {
                Some(callback)
            } else {
                state.callback = Some(callback);
                None
            }
        };
        if let Some(callback) = now {
            callback();
        }
    }
}

#[derive(Default)]
pub struct RecordingSpawner {
    pub spawns: Mutex<Vec<Spawned>>,
    pub exits: Mutex<Vec<ManualExit>>,
    pub fail: AtomicBool,
    pub watchable: AtomicBool,
}

impl RecordingSpawner {
    pub fn new() -> Arc<RecordingSpawner> {
        Arc::new(RecordingSpawner {
            watchable: AtomicBool::new(true),
            ..RecordingSpawner::default()
        })
    }

    pub fn spawned(&self) -> Vec<Spawned> {
        self.spawns.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.spawns.lock().unwrap().len()
    }

    /// The first argument of every spawn: the path each slicer was handed.
    pub fn paths(&self) -> Vec<String> {
        self.spawned()
            .into_iter()
            .map(|spawn| spawn.args[0].clone())
            .collect()
    }

    /// The `index`th spawned process exits.
    pub fn exit(&self, index: usize) {
        let exit = self.exits.lock().unwrap()[index].clone();
        exit.exit();
    }
}

impl SlicerSpawner for RecordingSpawner {
    fn spawn(&self, command: &str, args: &[String], cwd: &Path) -> Result<SpawnedSlicer, String> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("ENOENT".to_owned());
        }
        self.spawns.lock().unwrap().push(Spawned {
            command: command.to_owned(),
            args: args.to_vec(),
            cwd: cwd.to_path_buf(),
            cwd_existed: cwd.exists(),
        });
        let exit = ManualExit::default();
        self.exits.lock().unwrap().push(exit.clone());
        Ok(SpawnedSlicer {
            pid: Some(4242),
            exit: self
                .watchable
                .load(Ordering::SeqCst)
                .then(|| Box::new(exit) as Box<dyn ExitWatch>),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// A library with files in it
// ---------------------------------------------------------------------------------------------

/// A library in a temporary directory, its one local user, and a scratch area for building files.
pub struct Env {
    pub library: TempLibrary,
    pub ctx: Ctx,
    pub root: tempfile::TempDir,
    seq: AtomicUsize,
}

impl Env {
    pub fn new() -> Env {
        let library = TempLibrary::new();
        let ctx = ensure_local_user(&library).expect("a local user");
        let root = tempfile::Builder::new()
            .prefix("spm-slicers-")
            .tempdir()
            .expect("a temp dir");
        Env {
            library,
            ctx,
            root,
            seq: AtomicUsize::new(0),
        }
    }

    pub fn next(&self) -> usize {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn lib(&self) -> &Library {
        &self.library
    }

    pub fn session(&self) -> DesktopSession {
        DesktopSession {
            lib: (*self.library).clone(),
            ctx: self.ctx.clone(),
        }
    }

    /// A fresh directory under the scratch root.
    pub fn dir(&self, name: &str) -> PathBuf {
        let dir = self.root.path().join(format!("{name}-{}", self.next()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn project(&self, name: &str) -> String {
        create_project(
            self.lib(),
            &self.ctx,
            spm_core::validate::CreateProjectInput {
                name: format!("{name} {}", self.next()),
                ..Default::default()
            },
        )
        .expect("a project")
        .id
    }

    /// Builds a file with `build`, uploads it to the project, and answers its id and library path.
    pub fn add_file(
        &self,
        project_id: &str,
        name: &str,
        build: impl FnOnce(&Path),
    ) -> (String, PathBuf) {
        let staging = self.dir("staging").join(name);
        build(&staging);
        let bytes = std::fs::read(&staging).unwrap();
        let file = upload_file(
            self.lib(),
            &self.ctx,
            project_id,
            name,
            i64::try_from(bytes.len()).unwrap(),
            Cursor::new(bytes),
        )
        .expect("an upload");
        let resolved = resolve_file_path(self.lib(), &self.ctx, &file.id).unwrap();
        (file.id, resolved.abs_path)
    }
}

/// An ASCII STL, which is what `classify_file` calls a model on its extension alone.
pub fn stl_bytes(path: &Path) {
    std::fs::write(path, "solid cube\nendsolid cube\n").unwrap();
}

/// Bytes, not a model, and no fixture: nothing on a launch path parses a STEP file.
pub fn step_bytes(path: &Path) {
    std::fs::write(path, "ISO-10303-21;").unwrap();
}

// ---------------------------------------------------------------------------------------------
// The machine a launch runs on
// ---------------------------------------------------------------------------------------------

pub const CURA_13: &str = "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0";
pub const CURA_12: &str = "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0";
pub const ORCA: &str = "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g";
pub const BAMBU: &str = "registry:HKLM:Bambu Studio-02.08.02.61";
pub const ANYCUBIC: &str = "registry:HKLM:AnycubicSlicerNext 1.4.1.2-1.4.1.2";
pub const PRUSA: &str = "registry:HKLM:PrusaSlicer-2.9.6";

pub const CURA_13_EXE: &str = "C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe";
pub const CURA_12_EXE: &str = "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe";
pub const ORCA_EXE: &str =
    "C:\\Program Files\\WindowsApps\\OrcaSlicer_2.4.3.0_x64\\orca-slicer.exe";
pub const BAMBU_EXE: &str = "C:\\Program Files\\Bambu Studio\\bambu-studio.exe";
pub const ANYCUBIC_EXE: &str = "C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe";
pub const PRUSA_EXE: &str = "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe";

pub fn install(id: &str, slicer_id: SlicerId, label: &str, path_hint: &str) -> StoredInstall {
    StoredInstall {
        id: id.to_owned(),
        slicer_id,
        label: label.to_owned(),
        origin: match id.strip_prefix("msix:") {
            Some(family) => InstallOrigin::Msix {
                package_family: family.to_owned(),
            },
            None => InstallOrigin::Registry {
                hive: "HKLM".to_owned(),
                key: id.to_owned(),
            },
        },
        version: None,
        path_hint: path_hint.to_owned(),
        added_at: 1_700_000_000_000,
        missing: false,
    }
}

/// The machine the spike ran on, minus the second Cura: one install per product, all bound, the
/// default slicer Orca.
pub fn machine() -> SlicersConfig {
    SlicersConfig {
        version: SLICERS_CONFIG_VERSION,
        installs: vec![
            install(
                CURA_13,
                SlicerId::Cura,
                "UltiMaker Cura 5.13.0",
                CURA_13_EXE,
            ),
            install(ORCA, SlicerId::Orca, "OrcaSlicer", ORCA_EXE),
            install(BAMBU, SlicerId::Bambu, "Bambu Studio", BAMBU_EXE),
            install(
                ANYCUBIC,
                SlicerId::Anycubic,
                "AnycubicSlicerNext 1.4.1.2",
                ANYCUBIC_EXE,
            ),
            install(PRUSA, SlicerId::Prusaslicer, "PrusaSlicer", PRUSA_EXE),
        ],
        bindings: [
            (SlicerId::Cura, CURA_13),
            (SlicerId::Orca, ORCA),
            (SlicerId::Bambu, BAMBU),
            (SlicerId::Anycubic, ANYCUBIC),
            (SlicerId::Prusaslicer, PRUSA),
        ]
        .into_iter()
        .map(|(slicer, id)| (slicer, id.to_owned()))
        .collect(),
        default_slicer_id: Some(SlicerId::Orca),
    }
}

// ---------------------------------------------------------------------------------------------
// A launcher on that machine
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct HarnessOptions {
    pub config: Option<SlicersConfig>,
    /// Which executables are on this machine. `None` means all of them.
    pub present: Option<Vec<&'static str>>,
    pub is_remote: bool,
    pub no_library: bool,
    pub now: Option<i64>,
    pub launch_id: Option<String>,
    pub remote: Option<Arc<dyn RemoteLibrary>>,
    pub spawn_fails: bool,
}

pub struct Harness {
    pub launcher: Arc<SlicerLauncher>,
    pub spawner: Arc<RecordingSpawner>,
    pub host: Arc<SlicersHost>,
    pub home: PathBuf,
    pub sessions_dir: PathBuf,
    /// `<data>/slicer-cwd`, deliberately not created here: the launcher must make it.
    pub scratch_cwd_dir: PathBuf,
    /// Every launch the launcher announced (so a test can look at what the watch would be told).
    pub launched: Arc<Mutex<Vec<spm_shell::slicers::launch::LaunchedSession>>>,
}

impl Harness {
    pub fn new(env: &Env, options: HarnessOptions) -> Harness {
        let home = env.dir("case");
        let sessions_dir = home.join("slicer-sessions");
        // Never created by the harness: every `cwd_existed` assertion is a claim about the
        // launcher's own `create_dir_all`, and a directory this function made would answer for it.
        let scratch_cwd_dir = home.join("slicer-cwd");
        let config_file = home.join(SLICERS_FILE_NAME);
        write_config(
            &config_file,
            &options.config.clone().unwrap_or_else(machine),
        )
        .unwrap();

        let present = options.present.clone();
        let mut host_options = SlicersHostOptions::new(config_file);
        host_options.detection_supported = true;
        // Every hint is a real file unless the case says otherwise. Off by default rather than on
        // would make every launch fail for the same reason and hide the ones that should.
        host_options.is_regular_file = Arc::new(move |path: &str| {
            present
                .as_ref()
                .is_none_or(|present| present.contains(&path))
        });
        // A re-resolution that finds nothing, which is what marks a vanished install `missing`.
        host_options.run = Arc::new(|| Ok("[]".to_owned()));
        host_options.io = Arc::new(|_: &str| true);
        host_options.warn = Arc::new(|_| {});
        let host = Arc::new(SlicersHost::new(host_options));

        let spawner = RecordingSpawner::new();
        spawner.fail.store(options.spawn_fails, Ordering::SeqCst);
        let session = env.session();
        let no_library = options.no_library;
        let remote = options.remote.clone();
        let is_remote = options.is_remote;
        let mut launcher_options = SlicerLauncherOptions::new(
            sessions_dir.clone(),
            scratch_cwd_dir.clone(),
            Arc::clone(&host),
            Arc::new(move || (!no_library).then(|| session.clone())),
            Arc::new(move || is_remote),
            // Local mode throughout `slicers_launch.rs`: `slicers_sessions.rs` owns the remote
            // launch, where there is a proxy to answer with. A `None` here is what makes a stray
            // remote-mode launch fail loudly rather than silently reading a library that is not
            // the one being served.
            Arc::new(move || remote.clone()),
            spawner.clone(),
        );
        let now = options.now.unwrap_or(1_756_382_400_000);
        launcher_options.now = Arc::new(move || now);
        let launch_id = options.launch_id.clone();
        let counter = Arc::new(AtomicUsize::new(0));
        launcher_options.new_launch_id = Arc::new(move || match &launch_id {
            Some(id) => id.clone(),
            None => format!("launch-{}", counter.fetch_add(1, Ordering::SeqCst) + 1),
        });
        let launched = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&launched);
        launcher_options.on_launched =
            Some(Arc::new(move |launch| sink.lock().unwrap().push(launch)));
        Harness {
            launcher: Arc::new(SlicerLauncher::new(launcher_options)),
            spawner,
            host,
            home,
            sessions_dir,
            scratch_cwd_dir,
            launched,
        }
    }

    /// Every directory under `slicer-sessions`, or empty when nothing ever created it.
    pub fn sessions(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.sessions_dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

// ---------------------------------------------------------------------------------------------
// A remote library that records
// ---------------------------------------------------------------------------------------------

/// What a server answers for a project with one file in it, as the web API spells it.
pub fn project_detail_json(
    project_id: &str,
    file_id: &str,
    name: &str,
    kind: &str,
    slicer: Option<&str>,
) -> serde_json::Value {
    let mut file = serde_json::json!({
        "id": file_id,
        "name": name,
        "kind": kind,
        "sizeBytes": 0,
        "previewState": "pending",
        "rawUrl": format!("/api/files/{file_id}/raw"),
    });
    if let Some(slicer) = slicer {
        file["slicer"] = serde_json::json!(slicer);
    }
    serde_json::json!({
        "id": project_id,
        "name": "Remote project",
        "tags": [],
        "isArchived": false,
        "createdAt": 0,
        "updatedAt": 0,
        "fileCounts": { "model": 0, "slicerProject": 1, "other": 0 },
        "state": "ok",
        "files": [file],
    })
}

/// What a server answers for a file it has just stored.
pub fn file_dto_json(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "kind": "slicer_project",
        "sizeBytes": 1,
        "previewState": "pending",
        "rawUrl": format!("/api/files/{id}/raw"),
    })
}

/// A [`RemoteLibrary`] that answers plausibly and records what it was asked, without a network.
pub struct StubRemote {
    pub origin: String,
    pub calls: Mutex<Vec<(String, String)>>,
}

impl StubRemote {
    pub fn new(origin: &str) -> Arc<StubRemote> {
        Arc::new(StubRemote {
            origin: origin.to_owned(),
            calls: Mutex::new(Vec::new()),
        })
    }

    pub fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }

    pub fn posts(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|(method, _)| method == "POST")
            .map(|(_, path)| path)
            .collect()
    }
}

impl RemoteLibrary for StubRemote {
    fn origin(&self) -> &str {
        &self.origin
    }

    fn get(
        &self,
        path: &str,
    ) -> Result<spm_shell::slicers::remote_files::RemoteResponse, spm_core::AppError> {
        self.calls
            .lock()
            .unwrap()
            .push(("GET".to_owned(), path.to_owned()));
        let project_id = path.trim_start_matches("/projects/");
        Ok(spm_shell::slicers::remote_files::RemoteResponse {
            status: 200,
            body: project_detail_json(project_id, "file-1", "bracket.3mf", "slicer_project", None)
                .to_string()
                .into_bytes(),
        })
    }

    fn download(
        &self,
        path: &str,
        destination: &Path,
    ) -> Result<spm_shell::slicers::remote_files::RemoteResponse, spm_core::AppError> {
        self.calls
            .lock()
            .unwrap()
            .push(("GET".to_owned(), path.to_owned()));
        std::fs::write(destination, b"bytes").map_err(spm_core::AppError::internal)?;
        Ok(spm_shell::slicers::remote_files::RemoteResponse {
            status: 200,
            body: Vec::new(),
        })
    }

    fn upload(
        &self,
        path: &str,
        name: &str,
        _content_type: &str,
        _file: &Path,
        _size_bytes: u64,
    ) -> Result<spm_shell::slicers::remote_files::RemoteResponse, spm_core::AppError> {
        self.calls
            .lock()
            .unwrap()
            .push(("POST".to_owned(), path.to_owned()));
        Ok(spm_shell::slicers::remote_files::RemoteResponse {
            status: 200,
            body: file_dto_json("new-1", name).to_string().into_bytes(),
        })
    }
}

/// Runs blocking work (the whole slicer subsystem is blocking) off the async test's worker.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(work)
        .await
        .expect("the blocking task ran")
}
