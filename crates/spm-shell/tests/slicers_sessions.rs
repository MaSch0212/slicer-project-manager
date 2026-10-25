//! The loop that reads what a launch left behind: the watch, the comparison, the two sweeps and the
//! reconcile, against a real temporary `slicer-sessions/`, a real library and a real `RemoteHost`
//! over a real upstream. A port of the Electron shell's `slicers-sessions.test.ts`, case for case.
//!
//! **The two rules this file exists for are the two data-loss ones**, and they are asserted the way
//! a test that would actually have caught the first draft of the spec has to be: the sweep at next
//! start is asserted to leave the directory *and* to leave it listed, because a sweep that deleted
//! the directory and one that merely stopped listing it are both green against "it was not
//! reported gone". And an orphan is asserted to survive by name on disk, not only to appear in a
//! list.
//!
//! The clock is injected rather than waited on. Every number in `sessions.rs` (the 60 s settle
//! window, the 10 s exit settle, the 90 day record retention) is a duration, and a suite that
//! waited on any of them would either take two minutes or assert nothing about them.
//!
//! Nothing here needs a slicer, a window or Windows.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spm_core::dto::{EntryDiff, FileDto, FileState, SlicerId, SlicerLaunchMode, SlicerSessionDto};
use spm_core::files::entry_hash::{entry_digests, entry_hash};
use spm_core::{AppErrorCode, get_project, resolve_file_path};
use spm_shell::library::{DesktopSession, open_desktop_library};
use spm_shell::remote::RemoteHost;
use spm_shell::slicers::launch::{LAUNCH_RECORD_NAME, LaunchedSession, SlicerLaunchRecord};
use spm_shell::slicers::remote_files::{ProxyRemote, RemoteLibrary};
use spm_shell::slicers::sched::{DirectoryWatcher, NotifyWatcher};
use spm_shell::slicers::sessions::{
    EXIT_SETTLE_MS, SWEPT_RECORD_TTL_MS, SessionAction, SlicerSessions, SlicerSessionsOptions,
    derived_name,
};
use support::slicers::{
    Clock, Env, Harness, HarnessOptions, ManualExit, ManualWatcher, StubRemote, blocking,
    file_dto_json, project_detail_json,
};
use support::threemf::{
    bambu_lineage_project, cura_project, deflated, get_u16, patch_zip_headers, set_u16, stored,
    write_zip,
};
use support::{Upstream, answer};

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

struct SessionHarness {
    env: Env,
    sessions: Arc<SlicerSessions>,
    sessions_dir: PathBuf,
    clock: Arc<Clock>,
    watcher: Arc<ManualWatcher>,
    logs: Arc<std::sync::Mutex<Vec<String>>>,
}

#[derive(Default)]
struct Options {
    remote: Option<Arc<dyn RemoteLibrary>>,
    is_remote: bool,
    no_library: bool,
    /// The library the sessions see open, in place of the environment's own.
    library: Option<DesktopSession>,
}

impl SessionHarness {
    fn new() -> SessionHarness {
        SessionHarness::with(Options::default())
    }

    fn with(options: Options) -> SessionHarness {
        let env = Env::new();
        let sessions_dir = env.dir("case").join("slicer-sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let clock = Clock::new();
        let watcher = ManualWatcher::new();
        let session = options.library.unwrap_or_else(|| env.session());
        let no_library = options.no_library;
        let remote = options.remote;
        let is_remote = options.is_remote;
        let mut session_options = SlicerSessionsOptions::new(
            sessions_dir.clone(),
            Arc::new(move || (!no_library).then(|| session.clone())),
            Arc::new(move || is_remote),
            Arc::new(move || remote.clone()),
        );
        let now_clock = Arc::clone(&clock);
        session_options.now = Arc::new(move || now_clock.now());
        session_options.scheduler = clock.clone();
        session_options.watcher = watcher.clone();
        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&logs);
        session_options.log =
            Arc::new(move |message: &str| sink.lock().unwrap().push(message.to_owned()));
        SessionHarness {
            sessions: SlicerSessions::new(session_options),
            env,
            sessions_dir,
            clock,
            watcher,
            logs,
        }
    }

    fn list(&self) -> Vec<SlicerSessionDto> {
        self.sessions.list()
    }

    /// A launch directory with a record, as the launcher writes one.
    fn launch_directory(
        &self,
        launch_id: &str,
        file_name: &str,
        build: impl FnOnce(&Path),
        overrides: impl FnOnce(&mut SlicerLaunchRecord),
    ) -> Launched {
        let directory = self.sessions_dir.join(launch_id);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(file_name);
        build(&path);
        let mut record = SlicerLaunchRecord {
            launch_id: launch_id.to_owned(),
            mode: SlicerLaunchMode::NewProject,
            project_id: "project-1".to_owned(),
            file_id: "file-1".to_owned(),
            slicer_id: SlicerId::Orca,
            install_id: "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g".to_owned(),
            file_name: file_name.to_owned(),
            launched_hash: entry_hash(&path).unwrap(),
            started_at: self.clock.now(),
            library: None,
            source_slicer: Some(SlicerId::Bambu),
            source_size_bytes: Some(1234),
            launched_entries: Some(entry_digests(&path).unwrap()),
            swept_at: None,
        };
        overrides(&mut record);
        std::fs::write(
            directory.join(LAUNCH_RECORD_NAME),
            serde_json::to_string_pretty(&record).unwrap(),
        )
        .unwrap();
        Launched {
            directory,
            path,
            record,
        }
    }

    /// A launch directory holding a record with **exactly the nine fields the first version
    /// wrote**: no `sourceSlicer`, no `sourceSizeBytes`, no `launchedEntries`, no `sweptAt`.
    ///
    /// Deliberately not `launch_directory` with overrides: overrides can only *add*, so a harness
    /// built that way can never produce the shape this asserts about, and the backward
    /// compatibility claim would go on being true by inspection and untested.
    fn first_version_record(
        &self,
        launch_id: &str,
        file_name: &str,
        project_id: &str,
        build: impl FnOnce(&Path),
    ) -> Launched {
        let directory = self.sessions_dir.join(launch_id);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(file_name);
        build(&path);
        std::fs::write(
            directory.join(LAUNCH_RECORD_NAME),
            json!({
                "launchId": launch_id,
                "mode": "new-project",
                "projectId": project_id,
                "fileId": "file-4",
                "slicerId": "orca",
                "installId": "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
                "fileName": file_name,
                "launchedHash": "what-task-4-wrote",
                "startedAt": self.clock.now(),
            })
            .to_string(),
        )
        .unwrap();
        let record = read_record(&directory);
        Launched {
            directory,
            path,
            record,
        }
    }

    /// Registers a launch with the session host, and hands back the child so a test can exit it.
    fn track(&self, launched: &Launched) -> ManualExit {
        let exit = ManualExit::default();
        self.sessions.track(LaunchedSession {
            launch_id: launched.record.launch_id.clone(),
            directory: launched.directory.clone(),
            path: launched.path.clone(),
            launched_hash: launched.record.launched_hash.clone(),
            exit: Some(Box::new(exit.clone())),
        });
        exit
    }

    fn sample(&self, name: &str, build: impl FnOnce(&Path)) -> PathBuf {
        let path = self.env.dir("sample").join(name);
        build(&path);
        path
    }

    fn project(&self, name: &str) -> String {
        self.env.project(name)
    }

    fn project_files(&self, project_id: &str) -> Vec<String> {
        get_project(self.env.lib(), &self.env.ctx, project_id)
            .unwrap()
            .files
            .into_iter()
            .map(|file| file.name)
            .collect()
    }
}

struct Launched {
    directory: PathBuf,
    path: PathBuf,
    record: SlicerLaunchRecord,
}

fn read_record(directory: &Path) -> SlicerLaunchRecord {
    spm_shell::slicers::sessions::read_record_with(&directory.join(LAUNCH_RECORD_NAME), &|_| {})
        .expect("a readable record")
}

fn only(sessions: Vec<SlicerSessionDto>) -> SlicerSessionDto {
    assert_eq!(
        sessions.len(),
        1,
        "expected exactly one session, got {}",
        sessions.len()
    );
    sessions.into_iter().next().unwrap()
}

fn cura_bytes(path: &Path) {
    cura_project(path, None);
}

/// A Bambu-lineage project with one setting in it, so a later save can change exactly that entry.
fn project_with_setting(path: &Path, value: &str) {
    write_zip(
        path,
        &[
            deflated("3D/3dmodel.model", "<model/>"),
            stored(
                "Metadata/project_settings.config",
                format!("{{\"wall_loops\": \"{value}\"}}"),
            ),
            stored("Metadata/slice_info.config", "<config/>"),
        ],
        None,
    );
}

fn setting_diff() -> EntryDiff {
    EntryDiff {
        added: vec![],
        removed: vec![],
        changed: vec!["Metadata/project_settings.config".to_owned()],
    }
}

fn exists(path: &Path) -> bool {
    path.exists()
}

fn local_key(dir: &Path) -> String {
    let canonical = std::fs::canonicalize(dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    format!(
        "local:{}",
        canonical.strip_prefix("\\\\?\\").unwrap_or(&canonical)
    )
}

fn import(
    h: &SessionHarness,
    launch_id: &str,
    project_id: Option<&str>,
) -> Result<Option<FileDto>, spm_core::AppError> {
    h.sessions
        .resolve(launch_id, SessionAction::Import, project_id)
}

// ---------------------------------------------------------------------------------------------
// The two data-loss rules (constraint 10)
// ---------------------------------------------------------------------------------------------

#[test]
fn the_sweep_at_next_start_leaves_an_unchanged_directory_on_disk_and_listed() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-a", "bracket.3mf", cura_bytes, |_| {});

    h.sessions.sweep_at_start();

    // Both halves, and they are different claims. A sweep that deleted the directory and one that
    // merely stopped listing it would each pass the other assertion on its own, and only the pair
    // says the session survived in a form the user can still answer.
    assert!(
        exists(&launched.directory),
        "the launch directory was deleted"
    );
    assert!(exists(&launched.path), "the launched file was deleted");
    let session = only(h.list());
    assert_eq!(session.launch_id, "launch-a");
    assert_eq!(session.file_state, FileState::Unchanged);
    assert!(!session.is_orphan);
    // The two sizes, as outputs rather than as fixture inputs: `sourceSizeBytes` is what the record
    // kept because an in-place save destroys it, and `returnedSizeBytes` is the file as it is now.
    assert_eq!(session.source_size_bytes, Some(1234));
    assert_eq!(
        session.returned_size_bytes,
        Some(i64::try_from(std::fs::metadata(&launched.path).unwrap().len()).unwrap())
    );
}

#[test]
fn a_3mf_with_no_launch_json_comes_back_as_an_orphan_and_is_never_swept() {
    let h = SessionHarness::new();
    // Both shapes a record-less file can take: inside a directory whose record never got written,
    // and loose in `slicer-sessions/` itself.
    let in_directory = h.sessions_dir.join("crashed");
    std::fs::create_dir_all(&in_directory).unwrap();
    cura_bytes(&in_directory.join("came-back.3mf"));
    cura_bytes(&h.sessions_dir.join("loose.3mf"));

    // The count the start-up log line is built from, counted by enumeration without reading a byte
    // of any of these files, so it has to agree with what `list()` would produce the hard way.
    assert_eq!(h.sessions.sweep_at_start(), 2);

    let mut listed = h.list();
    listed.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    assert_eq!(listed.len(), 2);
    assert_eq!(
        listed
            .iter()
            .map(|session| (
                session.launch_id.as_str(),
                session.is_orphan,
                session.file_state
            ))
            .collect::<Vec<_>>(),
        [
            ("crashed/came-back.3mf", true, FileState::Changed),
            ("loose.3mf", true, FileState::Changed),
        ]
    );
    // The classification is the only thing an orphan can say about which slicer it came from.
    assert_eq!(
        listed
            .iter()
            .map(|session| session.slicer_id)
            .collect::<Vec<_>>(),
        [Some(SlicerId::Cura), Some(SlicerId::Cura)]
    );
    // On disk, by name. The list above would look the same if the sweep had listed them and then
    // removed them.
    assert!(exists(&in_directory.join("came-back.3mf")));
    assert!(exists(&h.sessions_dir.join("loose.3mf")));
}

#[test]
fn an_orphan_that_names_no_slicer_at_all_is_still_listed_and_settles() {
    let h = SessionHarness::new();
    std::fs::write(
        h.sessions_dir.join("cube.stl"),
        "solid cube\nendsolid cube\n",
    )
    .unwrap();

    let session = only(h.list());

    // The load-bearing half, and the one `slicer_id == None` cannot carry: a mesh is not a ZIP and
    // never will be, so a settle check that asked "does the central directory parse?" of *every*
    // file would leave this settling until the window ran out and then call it unreadable, for
    // ever, on a file that is perfectly readable. `None` is what both branches answer.
    assert_eq!(session.file_state, FileState::Changed);
    assert!(session.is_orphan);
    // The one honest answer, and the reason the field is nullable: nothing about an `.stl` names a
    // product. Dropping it from the list instead is what sweep rule 2 forbids.
    assert_eq!(session.slicer_id, None);
    assert!(exists(&h.sessions_dir.join("cube.stl")));
}

#[test]
fn a_file_beside_a_record_that_is_not_the_launched_one_is_reported_not_adopted() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-b", "bracket.3mf", cura_bytes, |_| {});
    // What a Cura Save-As aimed at the launch directory produces: a second file, under a name of
    // the user's choosing, that is emphatically not the file the record describes.
    cura_bytes(&launched.directory.join("bracket-v2.3mf"));

    let mut listed = h.list();
    listed.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    assert_eq!(
        listed
            .iter()
            .map(|session| (session.file_name.as_str(), session.is_orphan))
            .collect::<Vec<_>>(),
        [("bracket-v2.3mf", true), ("bracket.3mf", false)]
    );
    // It is not mistaken for the launched file (that session is still `unchanged`), and it carries
    // the neighbouring record's project, because the app can answer that question without asking.
    assert_eq!(listed[1].file_state, FileState::Unchanged);
    assert_eq!(listed[0].project_id, "project-1");
    assert_eq!(listed[0].file_id, "");
}

// ---------------------------------------------------------------------------------------------
// The record outliving its file
// ---------------------------------------------------------------------------------------------

#[test]
fn an_observed_and_settled_exit_sweeps_the_file_keeps_the_record_and_keeps_the_directory() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-c", "bracket.3mf", cura_bytes, |_| {});
    let child = h.track(&launched);

    let exited_at = h.clock.now();
    child.exit();
    // Nothing yet: the settle period is what makes the exit an observation rather than a verdict.
    h.clock.advance(i64::try_from(EXIT_SETTLE_MS).unwrap() - 1);
    assert!(
        exists(&launched.path),
        "the sweep ran before the settle period was up"
    );
    h.clock.advance(2);

    assert!(
        !exists(&launched.path),
        "the byte-unchanged copy should have been swept"
    );
    assert!(
        exists(&launched.directory),
        "the directory must survive its file"
    );
    let kept = read_record(&launched.directory);
    assert_eq!(
        kept.swept_at,
        Some(exited_at + i64::try_from(EXIT_SETTLE_MS).unwrap())
    );
    assert_eq!(kept.project_id, "project-1");
    // The memory is not a session: there is nothing there for anyone to answer.
    assert!(h.list().is_empty());
}

#[test]
fn a_file_recreated_beside_a_swept_record_is_matched_back_to_its_project() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-d",
        "bracket.3mf",
        |path| project_with_setting(path, "2"),
        |_| {},
    );
    let child = h.track(&launched);
    child.exit();
    h.clock.advance(11_000);
    assert!(!exists(&launched.path));

    // Row 20: the next Ctrl+S puts a complete file back at exactly this path.
    project_with_setting(&launched.path, "4");

    let session = only(h.list());
    assert!(
        !session.is_orphan,
        "the record is what makes this not an orphan"
    );
    assert_eq!(session.project_id, "project-1");
    assert_eq!(session.file_id, "file-1");
    assert_eq!(session.file_state, FileState::Changed);
    // And the diff is against what was *launched*, which the record kept when the file went.
    assert_eq!(session.entry_diff, Some(setting_diff()));
}

#[test]
fn an_exit_sweep_leaves_a_changed_file_exactly_where_it_is() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-e",
        "bracket.3mf",
        |path| project_with_setting(path, "2"),
        |_| {},
    );
    let child = h.track(&launched);

    project_with_setting(&launched.path, "4");
    child.exit();
    h.clock.advance(60_000);

    assert!(
        exists(&launched.path),
        "a file that came back changed must never be swept"
    );
    assert_eq!(only(h.list()).file_state, FileState::Changed);
}

#[test]
fn a_record_whose_file_has_gone_expires_after_ninety_days_and_not_before() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-f", "bracket.3mf", cura_bytes, |_| {});
    std::fs::remove_file(&launched.path).unwrap();
    let mut record = read_record(&launched.directory);
    record.swept_at = Some(h.clock.now());
    std::fs::write(
        launched.directory.join(LAUNCH_RECORD_NAME),
        serde_json::to_string(&record).unwrap(),
    )
    .unwrap();

    h.clock.advance(SWEPT_RECORD_TTL_MS - 1);
    h.sessions.sweep_at_start();
    assert!(
        exists(&launched.directory),
        "the record must outlive its file for the full period"
    );

    h.clock.advance(2);
    h.sessions.sweep_at_start();
    assert!(!exists(&launched.directory));
}

#[test]
fn the_start_sweep_never_touches_a_directory_that_still_holds_a_file_however_old() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-g", "bracket.3mf", cura_bytes, |record| {
        record.started_at = 1;
        record.swept_at = Some(1);
    });

    h.clock.advance(SWEPT_RECORD_TTL_MS * 10);
    h.sessions.sweep_at_start();

    // A `sweptAt` older than any retention there is, beside a file that came back anyway. The
    // retention is about the *record*; the file is the user's and the app has never compared it.
    assert!(exists(&launched.directory));
    assert!(exists(&launched.path));
    assert_eq!(only(h.list()).file_state, FileState::Unchanged);
}

#[test]
fn a_record_written_before_the_reconcile_still_lists_and_shows_less_rather_than_something_wrong() {
    let h = SessionHarness::new();
    h.first_version_record("launch-task4", "bracket.3mf", "project-4", cura_bytes);

    let listed = only(h.list());

    // The fields the reader requires are all there, so this is a session and not an orphan, and
    // everything that identifies it survives.
    assert!(!listed.is_orphan);
    assert_eq!(listed.project_id, "project-4");
    assert_eq!(listed.file_id, "file-4");
    assert_eq!(listed.slicer_id, Some(SlicerId::Orca));
    assert_eq!(listed.file_state, FileState::Changed);
    // And the four fields added since are simply absent: never a wrong value, never a failure.
    assert_eq!(listed.entry_diff, None);
    assert_eq!(listed.source_slicer, Some(None));
    assert_eq!(listed.source_size_bytes, None);
    // `returnedAs` against an unknown source is reached deliberately rather than by accident: the
    // app does not know what went out and does know what is there, and saying so is more use than
    // silence. The card renders the missing half as "unknown".
    assert_eq!(listed.returned_as, Some(Some(SlicerId::Cura)));
}

#[test]
fn a_record_written_before_the_reconcile_can_still_be_imported_and_swept() {
    let h = SessionHarness::new();
    let project_id = h.project("Task four");
    let launched = h.first_version_record(
        "launch-task4-import",
        "bracket.3mf",
        &project_id,
        cura_bytes,
    );

    let added = import(&h, "launch-task4-import", None).unwrap().unwrap();

    assert_eq!(added.name, "bracket (cura).3mf");
    assert!(!exists(&launched.path));
    assert_eq!(
        read_record(&launched.directory).swept_at,
        Some(h.clock.now())
    );
}

// ---------------------------------------------------------------------------------------------
// Which library a session belongs to
// ---------------------------------------------------------------------------------------------

#[test]
fn a_session_from_a_library_that_is_not_open_is_not_listed_and_is_not_answerable() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-elsewhere", "bracket.3mf", cura_bytes, |record| {
        record.library = Some(format!(
            "local:{}",
            h.env.root.path().join("some-other-library").display()
        ));
    });

    // `slicer-sessions/` is per-machine and every id in a record is per-library, so without the
    // library key this sat on `/settings/slicers` beside the open library's own sessions, and an
    // import resolved its `projectId` against whatever happened to be open.
    assert!(h.list().is_empty());

    let refused = import(&h, "launch-elsewhere", None).unwrap_err();
    assert_eq!(refused.code, AppErrorCode::Conflict);
    assert!(
        refused.message.contains("different library"),
        "{}",
        refused.message
    );
    // Nothing was deleted, and nothing was uploaded. Switching back is the whole recovery.
    assert!(exists(&launched.path));
    assert!(exists(&launched.directory));
    assert_eq!(h.sessions.discard_many(&["launch-elsewhere".to_owned()]), 0);
}

#[test]
fn the_same_session_lists_again_once_its_own_library_is_open() {
    let other = Env::new();
    let h = SessionHarness::with(Options {
        library: Some(other.session()),
        ..Options::default()
    });
    h.launch_directory("launch-theirs", "bracket.3mf", cura_bytes, |record| {
        record.library = Some(local_key(other.library.path()));
    });

    // The pair to the test above, against the same fixture: if the filter refused everything, both
    // would pass, and only this one says the key is being compared rather than merely present.
    assert_eq!(only(h.list()).launch_id, "launch-theirs");
}

#[test]
fn an_orphan_beside_a_foreign_record_is_listed_asks_where_it_belongs_and_can_be_answered() {
    let h = SessionHarness::new();
    let project_id = h.project("Adopted from elsewhere");
    let launched = h.launch_directory("launch-foreign", "bracket.3mf", cura_bytes, |record| {
        record.library = Some(format!(
            "local:{}",
            h.env.root.path().join("not-this-one").display()
        ));
        record.project_id = "a-project-in-the-other-library".to_owned();
    });
    // What a Cura Save-As into somebody else's launch directory leaves behind. The launched file is
    // that library's business; this one has no record of its own, and the two rules meet here:
    // "only this library's sessions" must not quietly become "and none of the files it cannot
    // explain either", which is the one thing sweep rule 2 forbids outright.
    let stray = launched.directory.join("came-back.3mf");
    cura_bytes(&stray);

    let listed = only(h.list());
    assert_eq!(listed.launch_id, "launch-foreign/came-back.3mf");
    assert!(listed.is_orphan);
    // **The half that listing alone cannot see.** Inheriting the neighbouring record's `projectId`
    // made the card render no "which project?" prompt and enable Import, which then resolved
    // another library's UUID against this one and came back `NotFound`.
    assert_eq!(listed.project_id, "");
    let modified = std::fs::metadata(&stray).unwrap().modified().unwrap();
    let modified_ms = i64::try_from(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    assert!(
        (listed.started_at - modified_ms).abs() <= 1,
        "it aged against a foreign library clock: {} vs {modified_ms}",
        listed.started_at
    );

    let added = import(&h, "launch-foreign/came-back.3mf", Some(&project_id))
        .unwrap()
        .unwrap();

    assert_eq!(added.name, "came-back (cura).3mf");
    assert_eq!(h.project_files(&project_id), ["came-back (cura).3mf"]);
    assert!(!exists(&stray));
    // And the foreign session it was sitting beside is untouched: not swept, not stamped, not listed.
    assert!(exists(&launched.directory.join("bracket.3mf")));
    assert_eq!(read_record(&launched.directory).swept_at, None);
}

#[test]
fn a_remote_session_is_told_apart_by_its_origin_not_merely_by_being_remote() {
    let remote = StubRemote::new("https://library.invalid");
    let h = SessionHarness::with(Options {
        is_remote: true,
        remote: Some(remote),
        ..Options::default()
    });
    h.launch_directory("launch-here", "a.3mf", cura_bytes, |record| {
        record.library = Some("remote:https://library.invalid".to_owned());
    });
    h.launch_directory("launch-there", "b.3mf", cura_bytes, |record| {
        record.library = Some("remote:https://someone-else.invalid".to_owned());
    });

    assert_eq!(
        h.list()
            .iter()
            .map(|session| session.launch_id.as_str())
            .collect::<Vec<_>>(),
        ["launch-here"]
    );
}

/// A junction (or, off Windows, a symlink): one folder with two names.
fn link(real: &Path, alias: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(alias)
            .arg(real)
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .status()
            .expect("cmd runs");
        assert!(status.success(), "mklink /J failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(real, alias).unwrap();
}

#[test]
fn the_same_folder_reached_by_another_name_is_the_same_library() {
    // `Library::dir` is stored verbatim, and case is not the only way one folder gets two
    // spellings: a device-path prefix, a UNC alias for a local disk, an 8.3 short name and a
    // junction all name one directory and none of them compare equal as strings. A junction is the
    // one of the five that can be built without privileges on Windows *and* exists on POSIX, so it
    // is the one this asserts with; the failure they all produce is the same, and it is quiet: a
    // user's own sessions vanishing from the list with only a log line to say why.
    let scratch = Env::new();
    let real = scratch.dir("linked-real");
    let alias = scratch.root.path().join("linked-alias");
    link(&real, &alias);
    let session = open_desktop_library(&alias).expect("a library opens through the alias");

    // Launched with the folder named one way, listed with it named the other.
    let h = SessionHarness::with(Options {
        library: Some(session),
        ..Options::default()
    });
    h.launch_directory("launch-linked", "bracket.3mf", cura_bytes, |record| {
        record.library = Some(local_key(&real));
    });

    assert_eq!(only(h.list()).launch_id, "launch-linked");
}

#[test]
fn a_hand_edited_library_that_is_not_a_string_is_ignored_not_thrown_on() {
    let h = SessionHarness::new();
    let directory = h.sessions_dir.join("launch-handedited");
    std::fs::create_dir_all(&directory).unwrap();
    cura_bytes(&directory.join("bracket.3mf"));
    // `launch.json` lives in the app's data directory and the threat model is a person editing it,
    // not an attacker; `same_library` compares strings, so this is the one optional field where a
    // wrong *type* would break the read, and a failure here loses every other session too.
    std::fs::write(
        directory.join(LAUNCH_RECORD_NAME),
        json!({
            "launchId": "launch-handedited",
            "mode": "new-project",
            "projectId": "project-9",
            "fileId": "file-9",
            "slicerId": "orca",
            "installId": "msix:x",
            "fileName": "bracket.3mf",
            "launchedHash": "whatever",
            "startedAt": h.clock.now(),
            "library": 42,
        })
        .to_string(),
    )
    .unwrap();

    let listed = only(h.list());

    // Dropped to "cannot tell", which is the same safe default a record written before the field
    // existed gets, and everything else in the record is still read.
    assert_eq!(listed.project_id, "project-9");
    assert!(!listed.is_orphan);
}

#[test]
fn a_record_with_no_library_at_all_is_still_listed_and_an_orphan_always_is() {
    let third = Env::new();
    let h = SessionHarness::with(Options {
        library: Some(third.session()),
        ..Options::default()
    });
    // Written before the field existed. "Cannot tell" is not "belongs to somebody else", and
    // hiding these would be this change deleting the user's memory of unfinished work.
    h.first_version_record("launch-task4-lib", "bracket.3mf", "project-4", cura_bytes);
    cura_bytes(&h.sessions_dir.join("stray.3mf"));

    let mut listed: Vec<String> = h
        .list()
        .into_iter()
        .map(|session| session.launch_id)
        .collect();
    listed.sort();
    assert_eq!(listed, ["launch-task4-lib", "stray.3mf"]);
}

// ---------------------------------------------------------------------------------------------
// Not re-reading what has not moved
// ---------------------------------------------------------------------------------------------

#[test]
fn listing_twice_hashes_once_and_a_write_is_still_noticed() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-memo",
        "bracket.3mf",
        |path| project_with_setting(path, "one"),
        |_| {},
    );
    // The fixture hashes with `entry_hash` directly, not through the sessions, so nothing is
    // memoised yet.
    assert_eq!(h.sessions.hash_count(), 0);

    // The hot path: the card mounts on every project page visit and asks on construction. This used
    // to decompress every entry of every archive under `slicer-sessions/` on each of them.
    assert_eq!(only(h.list()).file_state, FileState::Unchanged);
    let after_first = h.sessions.hash_count();
    assert_eq!(
        after_first, 1,
        "the first list has to actually read the file"
    );
    for _ in 0..5 {
        assert_eq!(only(h.list()).file_state, FileState::Unchanged);
    }
    assert_eq!(
        h.sessions.hash_count(),
        after_first,
        "nothing moved, and it read the bytes anyway"
    );

    // And the half that matters: `list()` is still the mechanism of record. It asks the disk every
    // time; what it skips is recomputing a hash for bytes whose mtime and size agree.
    //
    // A **different-length** value, not `one` to `two`: same length meant same archive size, so the
    // whole assertion rested on the modification time moving between two writes a few milliseconds
    // apart, and Windows last-write granularity is about 15.6 ms.
    project_with_setting(
        &launched.path,
        "a considerably longer value than the one before it",
    );
    assert_eq!(only(h.list()).file_state, FileState::Changed);
    assert!(
        h.sessions.hash_count() > after_first,
        "a changed file was answered from the memo"
    );
}

#[test]
fn a_file_recreated_after_a_sweep_is_hashed_again_rather_than_remembered() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-memo-2",
        "bracket.3mf",
        |path| project_with_setting(path, "one"),
        |_| {},
    );
    // List first so the memo holds the launched file's hash: the sweep is then what has to forget it.
    assert_eq!(only(h.list()).file_state, FileState::Unchanged);
    let child = h.track(&launched);
    child.exit();
    h.clock.advance(11_000);
    assert!(!exists(&launched.path));

    // Row 20 puts a complete file back at exactly this path. A memo the sweep had not invalidated
    // would answer for it out of what the *previous* file hashed to.
    project_with_setting(&launched.path, "two");
    let before = h.sessions.hash_count();

    assert_eq!(only(h.list()).file_state, FileState::Changed);
    assert!(h.sessions.hash_count() > before);
}

// ---------------------------------------------------------------------------------------------
// Change detection, end to end
// ---------------------------------------------------------------------------------------------

#[test]
fn a_changed_entry_is_named_and_nothing_else_is() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-h",
        "bracket.3mf",
        |path| project_with_setting(path, "two"),
        |_| {},
    );

    project_with_setting(&launched.path, "three");

    let session = only(h.list());
    assert_eq!(session.file_state, FileState::Changed);
    assert_eq!(session.entry_diff, Some(setting_diff()));
    // The pair of sizes is what a user compares at a glance, so it has to move with the file: the
    // source is the record's, and the returned one is measured now.
    assert_eq!(session.source_size_bytes, Some(1234));
    assert_eq!(
        session.returned_size_bytes,
        Some(i64::try_from(std::fs::metadata(&launched.path).unwrap().len()).unwrap())
    );
    assert_ne!(session.returned_size_bytes, session.source_size_bytes);
}

#[test]
fn the_same_content_with_different_zip_timestamps_is_unchanged() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-i",
        "bracket.3mf",
        |path| bambu_lineage_project(path, &["X-BBL-Client-Version"], None),
        |_| {},
    );

    // What all three of the Bambu-lineage savers do on every save: the same entries, wall-clock
    // timestamps in the headers. A whole-file hash reports this as a change; `entry_hash` does not.
    let before = std::fs::read(&launched.path).unwrap();
    patch_zip_headers(&launched.path, |entry| {
        set_u16(entry.file, entry.central_at + 12, 0x4321);
        set_u16(entry.file, entry.central_at + 14, 0x5678);
        set_u16(entry.file, entry.local_at + 10, 0x4321);
        set_u16(entry.file, entry.local_at + 12, 0x5678);
    });
    assert_ne!(
        std::fs::read(&launched.path).unwrap(),
        before,
        "the fixture did not actually change any bytes"
    );
    assert_eq!(get_u16(&std::fs::read(&launched.path).unwrap(), 10), 0x4321);

    assert_eq!(only(h.list()).file_state, FileState::Unchanged);
}

#[test]
fn a_returning_file_that_classifies_as_another_slicer_says_so() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-j",
        "bracket.3mf",
        |path| bambu_lineage_project(path, &["X-BBL-Client-Type"], None),
        |record| record.source_slicer = Some(SlicerId::Bambu),
    );

    // Section 16: a Bambu project opened in Orca and saved comes back classified `orca`. The header
    // its `slice_info.config` carries is the writer's, and the writer changed. The reconcile carries
    // the returning file's identity, not the record's.
    bambu_lineage_project(&launched.path, &["OrcaSlicer-Version"], None);

    let session = only(h.list());
    assert_eq!(session.file_state, FileState::Changed);
    assert_eq!(session.source_slicer, Some(Some(SlicerId::Bambu)));
    assert_eq!(session.returned_as, Some(Some(SlicerId::Orca)));
}

// ---------------------------------------------------------------------------------------------
// The settle window
// ---------------------------------------------------------------------------------------------

#[test]
fn a_file_that_is_empty_then_half_written_then_complete_reports_settling_then_changed() {
    let h = SessionHarness::new();
    let launched = h.launch_directory(
        "launch-k",
        "bracket.3mf",
        |path| project_with_setting(path, "one"),
        |_| {},
    );
    // What the slicer is going to end up having written, built elsewhere so the launch directory
    // can hold nothing but the partial states until the last step.
    let complete =
        std::fs::read(h.sample("saved.3mf", |path| project_with_setting(path, "two"))).unwrap();

    // Cura's measured shape: 0 bytes, and an exclusive lock, for at least six seconds.
    std::fs::write(&launched.path, []).unwrap();
    let first = only(h.list()).file_state;
    h.clock.advance(5_000);

    // Half of an archive: the local header is there, the central directory is not. This is the one
    // `entry_hash` alone gets wrong: it would hash the partial bytes and report a change, and the
    // user would be offered half a file to upload.
    std::fs::write(&launched.path, &complete[..40]).unwrap();
    let second = only(h.list()).file_state;
    h.clock.advance(5_000);

    std::fs::write(&launched.path, &complete).unwrap();
    let third = only(h.list());

    // Ten seconds of unreadability, past Cura's measured six-second lock and well inside the
    // window, and `unreadable` never appears.
    assert_eq!(
        [first, second, third.file_state],
        [FileState::Settling, FileState::Settling, FileState::Changed]
    );
    assert_eq!(third.entry_diff, Some(setting_diff()));
}

#[test]
fn a_file_that_never_settles_is_reported_unreadable_once_the_window_is_spent() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-l", "bracket.3mf", cura_bytes, |_| {});
    std::fs::write(&launched.path, []).unwrap();

    assert_eq!(only(h.list()).file_state, FileState::Settling);
    h.clock.advance(59_000);
    assert_eq!(only(h.list()).file_state, FileState::Settling);
    h.clock.advance(2_000);
    assert_eq!(only(h.list()).file_state, FileState::Unreadable);
    assert!(
        h.logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("gave up reading bracket.3mf")),
        "giving up is said in the log: {:?}",
        h.logs.lock().unwrap()
    );

    // And a window that has been spent is not held against the next write: a file that goes
    // unreadable twice gets a fresh window each time rather than inheriting a spent one.
    bambu_lineage_project(&launched.path, &["OrcaSlicer-Version"], None);
    assert_eq!(only(h.list()).file_state, FileState::Changed);
}

#[test]
fn an_unreadable_file_is_refused_for_import_rather_than_uploaded_half_written() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-m", "bracket.3mf", cura_bytes, |_| {});
    std::fs::write(&launched.path, []).unwrap();

    let settling = import(&h, "launch-m", None).unwrap_err();
    assert_eq!(settling.code, AppErrorCode::Conflict);
    assert!(settling.message.contains("still being written"));
    // The page tells this refusal from "launched elsewhere" by `details.fileState`.
    assert_eq!(settling.details.as_ref().unwrap()["fileState"], "settling");

    h.clock.advance(61_000);
    let unreadable = import(&h, "launch-m", None).unwrap_err();
    assert_eq!(unreadable.code, AppErrorCode::Conflict);
    assert!(unreadable.message.contains("could not be read"));
    assert!(
        exists(&launched.path),
        "a refused import must not remove anything"
    );
}

// ---------------------------------------------------------------------------------------------
// The watch, and what it may not do on its own
// ---------------------------------------------------------------------------------------------

#[test]
fn a_watch_event_uploads_nothing_only_resolve_does() {
    let remote = StubRemote::new("https://library.invalid");
    let h = SessionHarness::with(Options {
        is_remote: true,
        remote: Some(remote.clone()),
        ..Options::default()
    });
    let launched = h.launch_directory(
        "launch-n",
        "bracket.3mf",
        |path| project_with_setting(path, "one"),
        |_| {},
    );
    h.track(&launched);

    project_with_setting(&launched.path, "two");
    assert_eq!(h.watcher.count(), 1, "the launch was not watched at all");
    h.watcher.fire(0);
    h.clock.advance(120_000);

    assert!(
        remote.posts().is_empty(),
        "something uploaded a file nobody asked to upload"
    );
    assert!(exists(&launched.path));

    import(&h, "launch-n", None).unwrap();

    assert_eq!(remote.posts(), ["/projects/project-1/files"]);
}

#[test]
fn the_poll_compares_only_when_the_file_has_moved_and_catches_a_write_no_watch_reported() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-o", "bracket.3mf", cura_bytes, |_| {});
    h.track(&launched);

    // Six ticks of a five-second poll, over a file nothing has touched. The first establishes the
    // baseline; the rest are the "do not bother" half of the mtime hint, and they are the only
    // reason the hint is not a branch no assertion could fail on.
    h.clock.advance(30_000);
    assert_eq!(h.sessions.comparison_count(), 1);
    assert_eq!(only(h.list()).file_state, FileState::Unchanged);

    // A write the watch never told anyone about, which is the whole case the poll exists for, and
    // why the spec says not to delete it as redundant.
    std::fs::write(&launched.path, []).unwrap();
    h.clock.advance(6_000);
    assert!(
        h.sessions.comparison_count() > 1,
        "the poll never noticed the write"
    );
    assert_eq!(only(h.list()).file_state, FileState::Settling);
    h.clock.advance(60_000);
    assert_eq!(only(h.list()).file_state, FileState::Unreadable);
}

#[test]
fn the_real_directory_watch_reaches_the_settle_loop_on_this_platform() {
    // Everything else in this file injects the watch, which proves the loop and says nothing about
    // the directory watch itself. This one uses the real one, with the clock still injected so the
    // debounce is not a real wait, because "the watch fires" is a property of the platform and not
    // of this module, and it is unmeasured on a network-backed data directory.
    let env = Env::new();
    let clock = Clock::new();
    let sessions_dir = env.dir("watch").join("slicer-sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let session = env.session();
    let mut options = SlicerSessionsOptions::new(
        sessions_dir.clone(),
        Arc::new(move || Some(session.clone())),
        Arc::new(|| false),
        Arc::new(|| None),
    );
    let now_clock = Arc::clone(&clock);
    options.now = Arc::new(move || now_clock.now());
    options.scheduler = clock.clone();
    options.watcher = Arc::new(NotifyWatcher) as Arc<dyn DirectoryWatcher>;
    let sessions = SlicerSessions::new(options);

    let directory = sessions_dir.join("launch-real");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("bracket.3mf");
    cura_bytes(&path);
    sessions.track(LaunchedSession {
        launch_id: "launch-real".to_owned(),
        directory: directory.clone(),
        path: path.clone(),
        launched_hash: entry_hash(&path).unwrap(),
        exit: None,
    });
    assert_eq!(sessions.comparison_count(), 0);

    bambu_lineage_project(&path, &["OrcaSlicer-Version"], None);

    // A real event, so a real wait, but polled to a generous ceiling rather than slept for a fixed
    // 300 ms: the behaviour being ruled out is "the event never arrives", so any ceiling separates
    // the two and a tight one only measures how busy the machine is. It exits on the first tick
    // that sees it.
    let deadline = Instant::now() + Duration::from_secs(20);
    while sessions.comparison_count() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
        clock.advance(1_000);
    }

    assert!(
        sessions.comparison_count() > 0,
        "the directory watch never reached the settle loop"
    );
    sessions.close();
}

#[test]
fn closing_lets_go_of_every_watcher_and_timer() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-p", "bracket.3mf", cura_bytes, |_| {});
    h.track(&launched);
    assert_eq!(h.sessions.tracked_count(), 1);

    h.sessions.close();

    assert_eq!(h.sessions.tracked_count(), 0);
    assert!(h.watcher.closed(0));
    assert_eq!(
        h.clock.pending(),
        0,
        "a timer outlived the session it belonged to"
    );
}

#[test]
fn a_watch_that_cannot_be_started_does_not_fail_the_launch_and_the_poll_still_runs() {
    // `notify` can fail on a filesystem it does not support. The watch is an optimisation, so the
    // failure is logged and swallowed, and the poll (the mechanism of record's scheduler) is there.
    let h = SessionHarness::new();
    h.watcher
        .fail
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let launched = h.launch_directory("launch-w", "bracket.3mf", cura_bytes, |_| {});

    h.track(&launched);

    assert_eq!(h.sessions.tracked_count(), 1);
    assert!(
        h.logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("could not watch"))
    );
    h.clock.advance(6_000);
    assert_eq!(h.sessions.comparison_count(), 1);
}

#[test]
fn the_process_being_alive_is_reported_and_its_exit_is_not_a_conclusion() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-x", "bracket.3mf", cura_bytes, |_| {});
    let child = h.track(&launched);
    assert!(only(h.list()).process_alive);

    child.exit();

    // The exit is an observation: the process is gone, the file is still there, and nothing was
    // swept until the settle period is up.
    let session = only(h.list());
    assert!(!session.process_alive);
    assert_eq!(session.file_state, FileState::Unchanged);
    assert!(exists(&launched.path));
}

// ---------------------------------------------------------------------------------------------
// The reconcile, locally
// ---------------------------------------------------------------------------------------------

#[test]
fn an_import_adds_a_derived_name_twice_and_never_touches_the_original() {
    let h = SessionHarness::new();
    let project_id = h.project("Round trip");
    let original = std::fs::read(h.sample("bracket-original.3mf", cura_bytes)).unwrap();
    let (file_id, library_path) = h.env.add_file(&project_id, "bracket.3mf", |path| {
        std::fs::write(path, &original).unwrap();
    });

    for round in ["first", "second"] {
        let launched = h.launch_directory(
            &format!("launch-{round}"),
            "bracket.3mf",
            |path| bambu_lineage_project(path, &["X-BBL-Client-Version", "Application"], None),
            |record| {
                record.project_id = project_id.clone();
                record.file_id = file_id.clone();
                record.launched_hash = "not-what-is-there".to_owned();
            },
        );
        let added = import(&h, &format!("launch-{round}"), None).unwrap();
        assert!(
            added.is_some(),
            "an import must answer with the file it added"
        );
        assert!(
            !exists(&launched.path),
            "the launch copy is swept once it is safely in"
        );
    }

    let mut names = h.project_files(&project_id);
    names.sort();
    assert_eq!(
        names,
        [
            "bracket (orca) (2).3mf",
            "bracket (orca).3mf",
            "bracket.3mf"
        ]
    );
    // The original is untouched, byte for byte. Substitution is ordered, not barred, and this is
    // the order: the returning file is added, and deleting the old one is the user's own action.
    assert_eq!(std::fs::read(&library_path).unwrap(), original);
    assert_eq!(
        resolve_file_path(h.env.lib(), &h.env.ctx, &file_id)
            .unwrap()
            .abs_path,
        library_path
    );
}

#[test]
fn the_derived_name_follows_what_the_file_classifies_as_now_not_what_was_launched() {
    let h = SessionHarness::new();
    let project_id = h.project("Round trip identity");
    let launched = h.launch_directory(
        "launch-identity",
        "bracket.3mf",
        |path| bambu_lineage_project(path, &["X-BBL-Client-Type"], None),
        |record| {
            record.project_id = project_id.clone();
            record.source_slicer = Some(SlicerId::Bambu);
            record.slicer_id = SlicerId::Orca;
            record.launched_hash = "not-what-is-there".to_owned();
        },
    );
    // What came back is a *Cura* project, which is neither what went out (`bambu`) nor the product
    // that was launched (`orca`). A name taken from the record would say one of those two.
    cura_bytes(&launched.path);

    let added = import(&h, "launch-identity", None).unwrap().unwrap();

    assert_eq!(added.name, "bracket (cura).3mf");
}

#[test]
fn discarding_an_orphan_beside_a_record_touches_neither_the_record_nor_the_launched_file() {
    let h = SessionHarness::new();
    let launched = h.launch_directory("launch-neighbour", "bracket.3mf", cura_bytes, |_| {});
    let stray = launched.directory.join("bracket-v2.3mf");
    cura_bytes(&stray);

    h.sessions
        .resolve(
            "launch-neighbour/bracket-v2.3mf",
            SessionAction::Discard,
            None,
        )
        .unwrap();

    assert!(!exists(&stray));
    // The neighbour is a different session with a different file. Writing a `sweptAt` onto its
    // record would say the app had removed a file that is still sitting right there.
    assert!(exists(&launched.path));
    assert_eq!(read_record(&launched.directory).swept_at, None);
    assert!(exists(&launched.directory));
}

#[test]
fn an_orphan_needs_a_project_and_takes_the_one_it_is_given() {
    let h = SessionHarness::new();
    let project_id = h.project("Adopted");
    cura_bytes(&h.sessions_dir.join("stray.3mf"));

    let missing = import(&h, "stray.3mf", None).unwrap_err();
    assert_eq!(missing.code, AppErrorCode::Validation);
    assert!(missing.message.contains("which project"));
    assert!(exists(&h.sessions_dir.join("stray.3mf")));

    let added = import(&h, "stray.3mf", Some(&project_id)).unwrap().unwrap();
    assert_eq!(added.name, "stray (cura).3mf");
    assert_eq!(h.project_files(&project_id), ["stray (cura).3mf"]);
    // The whole directory entry goes, because there was no record to keep.
    assert!(!exists(&h.sessions_dir.join("stray.3mf")));
}

#[test]
fn a_discard_removes_the_file_and_keeps_the_record() {
    let h = SessionHarness::new();
    let first = h.launch_directory("launch-q", "a.3mf", cura_bytes, |_| {});

    assert_eq!(
        h.sessions
            .resolve("launch-q", SessionAction::Discard, None)
            .unwrap(),
        None
    );

    assert!(!exists(&first.path));
    assert!(exists(&first.directory));
    assert_eq!(read_record(&first.directory).swept_at, Some(h.clock.now()));
}

#[test]
fn a_bulk_discard_sweeps_every_one_it_was_given_and_counts_only_those() {
    let h = SessionHarness::new();
    let first = h.launch_directory("launch-r", "a.3mf", cura_bytes, |_| {});
    let second = h.launch_directory("launch-s", "b.3mf", cura_bytes, |_| {});
    let spared = h.launch_directory("launch-t", "c.3mf", cura_bytes, |_| {});

    // Three ids, one of which has never existed: an id that has already gone is not a failure, and
    // the count is what actually happened rather than what was asked for.
    let discarded = h.sessions.discard_many(&[
        "launch-r".to_owned(),
        "launch-s".to_owned(),
        "launch-nowhere".to_owned(),
    ]);

    assert_eq!(discarded, 2);
    // Both, and by name. One enumeration serves the whole list now, and a loop that swept only the
    // first of them would still have counted two.
    assert!(!exists(&first.path));
    assert!(!exists(&second.path));
    assert_eq!(read_record(&first.directory).swept_at, Some(h.clock.now()));
    assert_eq!(read_record(&second.directory).swept_at, Some(h.clock.now()));
    // And nothing it was not given.
    assert!(exists(&spared.path));
}

#[test]
fn resolving_a_session_that_is_not_there_is_not_found_rather_than_a_path_join() {
    let h = SessionHarness::new();
    h.launch_directory("launch-elsewhere", "a.3mf", cura_bytes, |_| {});

    for launch_id in ["..", "../../etc/passwd", "..\\..\\evil", "launch-nowhere"] {
        let error = h
            .sessions
            .resolve(launch_id, SessionAction::Discard, None)
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::NotFound, "{launch_id}");
    }
    // Nothing outside the sessions directory was reachable, because nothing was joined: the id is
    // matched against what the enumerator found.
    let names: Vec<String> = std::fs::read_dir(&h.sessions_dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["launch-elsewhere"]);
}

#[test]
fn derived_name_counts_up_and_keeps_the_extension_it_was_given() {
    use std::collections::HashSet;
    let none: HashSet<String> = HashSet::new();
    let taken =
        |names: &[&str]| -> HashSet<String> { names.iter().map(|n| (*n).to_owned()).collect() };

    assert_eq!(
        derived_name("bracket.3mf", Some(SlicerId::Orca), &none).unwrap(),
        "bracket (orca).3mf"
    );
    assert_eq!(
        derived_name(
            "bracket.3mf",
            Some(SlicerId::Orca),
            &taken(&["bracket (orca).3mf"])
        )
        .unwrap(),
        "bracket (orca) (2).3mf"
    );
    assert_eq!(
        derived_name(
            "bracket.3mf",
            Some(SlicerId::Orca),
            &taken(&["bracket (orca).3mf", "bracket (orca) (2).3mf"])
        )
        .unwrap(),
        "bracket (orca) (3).3mf"
    );
    // An orphan that names no slicer gets no attribution invented for it.
    assert_eq!(derived_name("cube.stl", None, &none).unwrap(), "cube.stl");
    assert_eq!(
        derived_name("cube.stl", None, &taken(&["cube.stl"])).unwrap(),
        "cube (2).stl"
    );
    assert_eq!(
        derived_name("README", Some(SlicerId::Cura), &none).unwrap(),
        "README (cura)"
    );
}

// ---------------------------------------------------------------------------------------------
// Remote mode (a real RemoteHost over a real upstream)
// ---------------------------------------------------------------------------------------------

fn json_answer(body: &Value) -> axum::response::Response {
    answer(
        200,
        &[("content-type", "application/json")],
        body.to_string(),
    )
}

fn error_answer(status: u16, code: &str, message: &str) -> axum::response::Response {
    answer(
        status,
        &[("content-type", "application/json")],
        json!({ "error": { "code": code, "message": message } }).to_string(),
    )
}

/// A launcher in remote mode: no library at all, a real `RemoteHost` pointed at `upstream`.
///
/// `no_library` on purpose. Remote mode has no library, and a launcher that quietly read one would
/// pass every assertion here while doing the wrong thing on a real machine that happens to have a
/// folder open as well.
fn remote_harness(env: &Env, upstream: &Upstream) -> Harness {
    let host = Arc::new(RemoteHost::new(&upstream.origin));
    let remote: Arc<dyn RemoteLibrary> =
        Arc::new(ProxyRemote::new(host, tokio::runtime::Handle::current()));
    Harness::new(
        env,
        HarnessOptions {
            is_remote: true,
            no_library: true,
            remote: Some(remote),
            ..HarnessOptions::default()
        },
    )
}

fn targets(upstream: &Upstream) -> Vec<String> {
    upstream
        .requests()
        .into_iter()
        .map(|seen| seen.target)
        .collect()
}

fn leftover_names(h: &Harness) -> Vec<String> {
    h.sessions()
}

async fn open_remote(
    h: &Harness,
    file_id: &str,
    project_id: &str,
    mode: SlicerLaunchMode,
    slicer_id: Option<SlicerId>,
) -> Result<spm_core::dto::SlicerLaunchDto, spm_core::AppError> {
    let launcher = Arc::clone(&h.launcher);
    let (file_id, project_id) = (file_id.to_owned(), project_id.to_owned());
    blocking(move || {
        launcher.open(
            &file_id,
            &project_id,
            &spm_core::dto::SlicerLaunchOptions { mode, slicer_id },
        )
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_launch_downloads_through_the_proxy_and_launches_out_of_the_launch_directory() {
    let env = Env::new();
    let source = {
        let path = env.dir("remote-source").join("remote-source.3mf");
        cura_bytes(&path);
        std::fs::read(path).unwrap()
    };
    let bytes = source.clone();
    let upstream = Upstream::start(move |seen| match seen.target.as_str() {
        "/api/projects/p-1" => json_answer(&project_detail_json(
            "p-1",
            "f-1",
            "bracket.3mf",
            "slicer_project",
            None,
        )),
        "/api/files/f-1/raw" => answer(200, &[], bytes.clone()),
        _ => answer(404, &[], "no"),
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let launch = open_remote(
        &h,
        "f-1",
        "p-1",
        SlicerLaunchMode::NewProject,
        Some(SlicerId::Orca),
    )
    .await
    .unwrap();

    assert_eq!(
        targets(&upstream),
        ["/api/projects/p-1", "/api/files/f-1/raw"]
    );
    let directory = h.sessions_dir.join(&launch.launch_id);
    let copy = directory.join("bracket.3mf");
    // The path that was spawned, not that a spawn happened.
    assert_eq!(h.spawner.paths(), [copy.to_string_lossy().into_owned()]);
    assert!(exists(&copy));
    // Stripped in place: the download is gone and what is left is not the bytes that arrived.
    assert!(launch.stripped);
    let mut names: Vec<String> = std::fs::read_dir(&directory)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["bracket.3mf", "launch.json"]);
    assert_ne!(std::fs::read(&copy).unwrap(), source);
    let record = read_record(&directory);
    assert_eq!(record.project_id, "p-1");
    assert_eq!(record.file_id, "f-1");
    assert_eq!(record.source_slicer, Some(SlicerId::Cura));
    // Which library this came out of. In remote mode that is an origin, and two servers with a
    // project of the same id are otherwise indistinguishable in `slicer-sessions/`.
    assert_eq!(record.library, Some(format!("remote:{}", upstream.origin)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_launch_of_an_stl_also_goes_through_a_launch_directory() {
    let env = Env::new();
    let bytes = b"solid cube\nendsolid cube\n".to_vec();
    let body = bytes.clone();
    let upstream = Upstream::start(move |seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1", "f-1", "cube.stl", "model", None,
            ))
        } else {
            answer(200, &[], body.clone())
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let launch = open_remote(
        &h,
        "f-1",
        "p-1",
        SlicerLaunchMode::NewProject,
        Some(SlicerId::Orca),
    )
    .await
    .unwrap();

    // Local mode launches a mesh where it lies, because the slicer then proposes its project beside
    // it in the project folder. In remote mode there is no project folder on this machine, so the
    // in-place argument does not exist and every launch has a directory.
    let copy = h.sessions_dir.join(&launch.launch_id).join("cube.stl");
    assert_eq!(h.spawner.paths(), [copy.to_string_lossy().into_owned()]);
    assert_eq!(std::fs::read(&copy).unwrap(), bytes);
    assert!(!launch.stripped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_as_is_launch_hands_over_exactly_what_the_library_holds() {
    let env = Env::new();
    let bytes = {
        let path = env.dir("as-is-source").join("as-is-source.3mf");
        cura_bytes(&path);
        std::fs::read(path).unwrap()
    };
    let body = bytes.clone();
    let upstream = Upstream::start(move |seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1",
                "f-1",
                "bracket.3mf",
                "slicer_project",
                Some("cura"),
            ))
        } else {
            answer(200, &[], body.clone())
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let launch = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::AsIs, None)
        .await
        .unwrap();

    // `as-is` means the user's own project, unchanged. It still needs a directory in remote mode
    // (there is no library path on this machine) but the bytes in it are the bytes on the server,
    // and stripping them would be the opposite of what the mode is for.
    let copy = h.sessions_dir.join(&launch.launch_id).join("bracket.3mf");
    assert_eq!(h.spawner.paths(), [copy.to_string_lossy().into_owned()]);
    assert!(!launch.stripped);
    assert_eq!(std::fs::read(&copy).unwrap(), bytes);
    // The slicer the *server's* index says wrote it, exactly as local `as-is` reads the slicer out
    // of the local index, and not the configured default, which is Orca on this fixture machine.
    assert_eq!(launch.slicer_id, SlicerId::Cura);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_as_is_launch_of_a_mesh_refuses_before_a_byte_is_downloaded() {
    let env = Env::new();
    let upstream = Upstream::start(|seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1", "f-1", "cube.stl", "model", None,
            ))
        } else {
            answer(200, &[], vec![1u8, 2, 3])
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let error = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::AsIs, None)
        .await
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert!(
        error
            .message
            .contains("only a slicer project can be opened as it is")
    );
    // The cheap refusal runs first: nothing was downloaded and no directory was made.
    assert_eq!(targets(&upstream), ["/api/projects/p-1"]);
    assert!(leftover_names(&h).is_empty());
    assert_eq!(h.spawner.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launching_cura_in_remote_mode_still_spawns_and_says_nothing_will_come_back() {
    let env = Env::new();
    let bytes = {
        let path = env.dir("cura-source").join("cura-source.3mf");
        cura_bytes(&path);
        std::fs::read(path).unwrap()
    };
    let upstream = Upstream::start(move |seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1",
                "f-1",
                "bracket.3mf",
                "slicer_project",
                None,
            ))
        } else {
            answer(200, &[], bytes.clone())
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let launch = open_remote(
        &h,
        "f-1",
        "p-1",
        SlicerLaunchMode::NewProject,
        Some(SlicerId::Cura),
    )
    .await
    .unwrap();

    assert_eq!(
        h.spawner.count(),
        1,
        "the launch must still happen; the limit is stated, not enforced"
    );
    let notice = launch
        .notices
        .iter()
        .find(|line| line.contains("uploaded by hand"))
        .unwrap_or_else(|| panic!("no round-trip notice in {:?}", launch.notices));
    assert!(notice.contains("never saves back over the file it was given"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_import_declares_its_length_because_the_server_answers_411_without_one() {
    let upstream = Upstream::start(|seen| {
        if seen.method == "POST" {
            json_answer(&file_dto_json("new-1", "bracket (cura).3mf"))
        } else {
            json_answer(&project_detail_json(
                "p-9",
                "f-9",
                "bracket.3mf",
                "slicer_project",
                None,
            ))
        }
    })
    .await;
    let host = Arc::new(RemoteHost::new(&upstream.origin));
    let remote: Arc<dyn RemoteLibrary> =
        Arc::new(ProxyRemote::new(host, tokio::runtime::Handle::current()));
    let h = Arc::new(SessionHarness::with(Options {
        is_remote: true,
        no_library: true,
        remote: Some(remote),
        ..Options::default()
    }));
    let launched = h.launch_directory("launch-u", "bracket.3mf", cura_bytes, |record| {
        record.project_id = "p-9".to_owned();
        record.file_id = "f-9".to_owned();
        record.launched_hash = "not-what-is-there".to_owned();
    });
    let size_bytes = std::fs::metadata(&launched.path).unwrap().len();

    let worker = Arc::clone(&h);
    let added = blocking(move || import(&worker, "launch-u", None))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(added.name, "bracket (cura).3mf");
    let upload = upstream
        .requests()
        .into_iter()
        .find(|seen| seen.method == "POST")
        .expect("nothing was posted");
    assert_eq!(upload.target, "/api/projects/p-9/files");
    // The trap. The proxy turns `x-spm-content-length` into the real one; without it the body
    // reaches the server as `Transfer-Encoding: chunked` and it refuses with 411 before writing a
    // byte, because the quota check has to know the size first.
    assert_eq!(
        upload.header("content-length"),
        Some(size_bytes.to_string())
    );
    assert_eq!(
        upload.header("x-spm-file-name").as_deref(),
        Some("bracket%20(cura).3mf")
    );
    assert_eq!(upload.body.len() as u64, size_bytes);
    // And the launch copy was swept only after the upload landed.
    assert!(!exists(&launched.path));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_launch_names_the_file_it_was_asked_for_and_refuses_a_pair_that_is_not_one() {
    let env = Env::new();
    let bytes = {
        let path = env.dir("second").join("second.3mf");
        cura_bytes(&path);
        std::fs::read(path).unwrap()
    };
    let mut detail = project_detail_json("p-1", "f-1", "first.3mf", "slicer_project", None);
    let second = {
        let mut file = detail["files"][0].clone();
        file["id"] = json!("f-2");
        file["name"] = json!("second.3mf");
        file
    };
    detail["files"].as_array_mut().unwrap().push(second);
    let upstream = Upstream::start(move |seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&detail)
        } else {
            answer(200, &[], bytes.clone())
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    // The second file, not the first. A launcher that took whatever the project listed first would
    // hand the slicer a file the user did not choose, and record it under the id of one they did.
    let launch = open_remote(
        &h,
        "f-2",
        "p-1",
        SlicerLaunchMode::NewProject,
        Some(SlicerId::Orca),
    )
    .await
    .unwrap();
    assert!(targets(&upstream).contains(&"/api/files/f-2/raw".to_owned()));
    assert_eq!(
        h.spawner.paths(),
        [h.sessions_dir
            .join(&launch.launch_id)
            .join("second.3mf")
            .to_string_lossy()
            .into_owned()]
    );
    assert_eq!(
        read_record(&h.sessions_dir.join(&launch.launch_id)).file_id,
        "f-2"
    );

    // And the pair check itself: in remote mode this lookup is the only thing that makes one, so a
    // page naming a file that is not in the project it named is refused before any bytes move.
    let before = targets(&upstream).len();
    let error = open_remote(&h, "f-9", "p-1", SlicerLaunchMode::NewProject, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::NotFound);
    assert_eq!(targets(&upstream)[before..], ["/api/projects/p-1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_download_that_fails_leaves_no_launch_directory_behind() {
    let env = Env::new();
    let upstream = Upstream::start(|seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1",
                "f-1",
                "bracket.3mf",
                "slicer_project",
                None,
            ))
        } else {
            error_answer(404, "NotFound", "gone")
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let error = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::NewProject, None)
        .await
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::NotFound);
    assert_eq!(h.spawner.count(), 0);
    // Nothing was handed to anything and no record exists, so this directory could explain nothing
    // and no slicer could put anything back into it: which is why removing it does not touch
    // constraint 10, and why leaving it would be litter nothing would ever sweep.
    assert!(leftover_names(&h).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_failure_keeps_its_code_across_the_wire() {
    let env = Env::new();
    let upstream = Upstream::start(|_| error_answer(413, "QuotaExceeded", "no room")).await;
    let h = remote_harness(&env, &upstream);

    let error = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::AsIs, None)
        .await
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::QuotaExceeded);
    assert_eq!(error.message, "no room");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_200_that_is_not_a_project_is_a_sentence_not_a_type_error_dressed_as_one() {
    // A proxy's idea of an error page, or a server this app is not actually talking to. Cast
    // unchecked, this reached the file lookup and arrived at the user as `Internal` carrying a
    // message about reading a property of undefined.
    let env = Env::new();
    let upstream = Upstream::start(|_| json_answer(&json!({}))).await;
    let h = remote_harness(&env, &upstream);

    let error = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::NewProject, None)
        .await
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Internal);
    assert!(
        error.message.contains("did not answer with a project"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("undefined") && !error.message.contains("Cannot read"));
    assert_eq!(h.spawner.count(), 0);
    assert!(leftover_names(&h).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_server_naming_a_file_something_unusable_is_refused_before_anything_is_written() {
    let env = Env::new();
    let upstream = Upstream::start(|seen| {
        if seen.target == "/api/projects/p-1" {
            json_answer(&project_detail_json(
                "p-1",
                "f-1",
                "../../escaped.3mf",
                "slicer_project",
                None,
            ))
        } else {
            answer(200, &[], vec![1u8, 2, 3])
        }
    })
    .await;
    let h = remote_harness(&env, &upstream);

    let error = open_remote(&h, "f-1", "p-1", SlicerLaunchMode::NewProject, None)
        .await
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(h.spawner.count(), 0);
    assert!(leftover_names(&h).is_empty());
    assert_eq!(targets(&upstream), ["/api/projects/p-1"]);
}
