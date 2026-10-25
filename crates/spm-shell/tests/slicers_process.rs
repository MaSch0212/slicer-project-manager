//! The real process spawn, and the assembled subsystem over it, against a **stub executable that
//! opens no window**: it records its argv, working directory and environment next to itself and
//! exits (or stays alive, to be a slicer that is still running). No real slicer is ever started.
//!
//! This is where the lifetime rule for the stripped copy is proved end to end, with real timers, a
//! real directory watch and a real child process: the copy a new project is started from is not
//! swept while the slicer is running, is swept after an observed and settled exit only if it is
//! still byte-identical to what the app wrote, and is never swept once the slicer has saved
//! something back.

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use spm_core::dto::{FileKind, SlicerId, SlicerLaunchMode, SlicerLaunchOptions};
use spm_core::files::classify::classify_file;
use spm_shell::slicers::api::SlicerBackend;
use spm_shell::slicers::config::{
    SLICERS_CONFIG_VERSION, SLICERS_FILE_NAME, SlicersConfig, StoredInstall, write_config,
};
use spm_shell::slicers::detect::InstallOrigin;
use spm_shell::slicers::host::SlicersHostOptions;
use spm_shell::slicers::launch::{LAUNCH_RECORD_NAME, SLICER_CWD_DIR, SLICER_SESSIONS_DIR};
use spm_shell::slicers::service::{SlicerServices, SlicerServicesParts};
use spm_shell::slicers::sessions::read_record_with;
use spm_shell::slicers::spawn::{ProcessSpawner, SlicerSpawner};
use support::slicers::{Env, stl_bytes};
use support::stub::{build_stub, keep_alive, record_of, sidecar};
use support::threemf::{cura_project, deflated, stored, write_zip};

fn passthrough_environment(extra: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> =
        ["PATH", "SystemRoot", "windir", "TEMP", "TMP"]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
            .collect();
    environment.extend(
        extra
            .iter()
            .map(|(name, value)| (OsString::from(*name), OsString::from(*value))),
    );
    environment
}

fn same_path(a: &str, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(Path::new(a)) == canonical(b)
}

/// What a slicer's Ctrl+S leaves at the path it was handed: a complete archive, different content.
fn save_over(path: &Path, value: &str) {
    write_zip(
        path,
        &[
            deflated("3D/3dmodel.model", "<model/>"),
            stored(
                "Metadata/project_settings.config",
                format!("{{\"wall_loops\": \"{value}\"}}"),
            ),
        ],
        None,
    );
}

fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

// ---------------------------------------------------------------------------------------------
// The spawner
// ---------------------------------------------------------------------------------------------

#[test]
fn a_started_slicer_gets_its_arguments_its_cwd_and_none_of_this_apps_variables() {
    let env = Env::new();
    let exe = build_stub(&env.dir("stub"), "stub-slicer");
    let cwd = env.dir("cwd");
    let spawner = ProcessSpawner::with_environment(passthrough_environment(&[
        ("SPM_REMOTE_URL", "http://secret.invalid"),
        ("spm_library_dir", "C:\\somewhere"),
        ("SPM_DESKTOP_USER_DATA", "C:\\data"),
        ("WEBVIEW2_USER_DATA_FOLDER", "C:\\webview"),
        ("TAURI_ENV_DEBUG", "1"),
        ("KEEP_ME_FOR_THE_SLICER", "yes"),
    ]));

    let child = spawner
        .spawn(
            &exe.to_string_lossy(),
            &["with a space.3mf".to_owned(), "C:\\a b\\c.3mf".to_owned()],
            &cwd,
        )
        .unwrap();

    let record = record_of(&exe);
    // One bare positional argument per file, spaces and all, untouched by any quoting.
    assert_eq!(
        record["args"],
        serde_json::json!(["with a space.3mf", "C:\\a b\\c.3mf"])
    );
    // The working directory the app chose, never an inherited one.
    assert!(
        same_path(record["cwd"].as_str().unwrap(), &cwd),
        "{}",
        record["cwd"]
    );
    assert_eq!(record["pid"].as_u64(), child.pid.map(u64::from));
    // Detached from any console input.
    assert_eq!(record["stdinEof"], true);
    // Nothing of this app's configuration or secrets: not by prefix, not in any letter case.
    let names: Vec<String> = record["env"]
        .as_object()
        .unwrap()
        .keys()
        .map(|name| name.to_ascii_uppercase())
        .collect();
    for scrubbed in ["SPM_", "WEBVIEW2_", "TAURI_"] {
        assert!(
            !names.iter().any(|name| name.starts_with(scrubbed)),
            "the child inherited a {scrubbed}* variable: {names:?}"
        );
    }
    // And what a slicer genuinely needs is still there.
    assert_eq!(record["env"]["KEEP_ME_FOR_THE_SLICER"], "yes");
    assert!(names.iter().any(|name| name == "PATH"), "{names:?}");
}

#[test]
fn a_slicer_that_is_still_running_has_not_exited_and_its_exit_is_observed_when_it_comes() {
    let env = Env::new();
    let exe = build_stub(&env.dir("stub"), "stub-alive");
    keep_alive(&exe, 2500);
    let spawner = ProcessSpawner::with_environment(passthrough_environment(&[]));

    let child = spawner
        .spawn(
            &exe.to_string_lossy(),
            &["x.3mf".to_owned()],
            &env.dir("cwd"),
        )
        .unwrap();
    record_of(&exe);

    let (tx, rx) = mpsc::channel();
    child.exit.unwrap().on_exit(Box::new(move || {
        let _ = tx.send(Instant::now());
    }));
    // Alive: the record is written and the process is still sleeping, so no exit has been seen.
    assert!(
        rx.recv_timeout(Duration::from_millis(600)).is_err(),
        "an exit was reported for a process that is still running"
    );
    // And then it does end, and is told about once.
    rx.recv_timeout(Duration::from_secs(30))
        .expect("the exit was never observed");
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "the exit was reported twice"
    );
}

#[test]
fn an_exit_that_already_happened_is_reported_to_a_late_watcher() {
    let env = Env::new();
    let exe = build_stub(&env.dir("stub"), "stub-quick");
    let spawner = ProcessSpawner::with_environment(passthrough_environment(&[]));
    let child = spawner
        .spawn(
            &exe.to_string_lossy(),
            &["x.3mf".to_owned()],
            &env.dir("cwd"),
        )
        .unwrap();
    record_of(&exe);
    std::thread::sleep(Duration::from_millis(1500));

    let (tx, rx) = mpsc::channel();
    child.exit.unwrap().on_exit(Box::new(move || {
        let _ = tx.send(());
    }));

    rx.recv_timeout(Duration::from_secs(10))
        .expect("a late watcher was never told");
}

#[test]
fn a_spawn_of_something_that_is_not_there_is_an_error_not_a_panic() {
    let env = Env::new();
    let spawner = ProcessSpawner::with_environment(passthrough_environment(&[]));
    let missing = env.dir("nothing").join("no-such-slicer.exe");

    let result = spawner.spawn(
        &missing.to_string_lossy(),
        &["x.3mf".to_owned()],
        &env.dir("cwd"),
    );

    assert!(result.is_err());
}

// ---------------------------------------------------------------------------------------------
// The assembled subsystem, over a real process
// ---------------------------------------------------------------------------------------------

struct Assembly {
    env: Env,
    data_dir: PathBuf,
    exe: PathBuf,
    services: Arc<SlicerServices>,
}

/// The whole subsystem as the app wires it, with the stub as the user's Orca (added by hand, which
/// is how a portable install is) and short real timers.
fn assemble() -> Assembly {
    let env = Env::new();
    let data_dir = env.dir("data");
    let exe = build_stub(&data_dir.join("stub"), "stub-orca");
    let install_id = "manual:stub".to_owned();
    write_config(
        &data_dir.join(SLICERS_FILE_NAME),
        &SlicersConfig {
            version: SLICERS_CONFIG_VERSION,
            installs: vec![StoredInstall {
                id: install_id.clone(),
                slicer_id: SlicerId::Orca,
                label: "OrcaSlicer (the stub)".to_owned(),
                origin: InstallOrigin::Manual {
                    id: "stub".to_owned(),
                },
                version: None,
                path_hint: exe.to_string_lossy().into_owned(),
                added_at: 1,
                missing: false,
            }],
            bindings: [(SlicerId::Orca, install_id)].into_iter().collect(),
            default_slicer_id: Some(SlicerId::Orca),
        },
    )
    .unwrap();
    let mut host = SlicersHostOptions::new(data_dir.join(SLICERS_FILE_NAME));
    host.detection_supported = false;
    host.warn = Arc::new(|_| {});
    let session = env.session();
    let services = SlicerServices::new(SlicerServicesParts {
        data_dir: data_dir.clone(),
        host,
        session: Arc::new(move || Some(session.clone())),
        is_remote: Arc::new(|| false),
        remote: Arc::new(|| None),
        spawner: Arc::new(ProcessSpawner::with_environment(passthrough_environment(
            &[],
        ))),
        tune_sessions: Some(Box::new(|options| {
            options.exit_settle_ms = 400;
            options.poll_interval_ms = 200;
            options.watch_debounce_ms = 50;
            options.log = Arc::new(|_| {});
        })),
        tune_launcher: None,
    });
    Assembly {
        env,
        data_dir,
        exe,
        services,
    }
}

fn new_project() -> SlicerLaunchOptions {
    SlicerLaunchOptions {
        mode: SlicerLaunchMode::NewProject,
        slicer_id: None,
    }
}

#[test]
fn the_subsystem_puts_the_sessions_and_the_scratch_cwd_side_by_side_under_the_data_directory() {
    let a = assemble();
    let project_id = a.env.project("Placement");
    let (stl_id, stl_path) = a.env.add_file(&project_id, "cube.stl", stl_bytes);
    let (cura_id, _) = a
        .env
        .add_file(&project_id, "bracket.3mf", |path| cura_project(path, None));

    // In place: the slicer is handed the library path, and its working directory is the scratch one.
    a.services
        .open(&stl_id, &project_id, &new_project())
        .unwrap();
    let record = record_of(&a.exe);
    assert!(
        same_path(record["args"][0].as_str().unwrap(), &stl_path),
        "{record}"
    );
    assert!(
        same_path(
            record["cwd"].as_str().unwrap(),
            &a.data_dir.join(SLICER_CWD_DIR)
        ),
        "{record}"
    );
    assert!(
        a.services.sessions().unwrap().is_empty(),
        "an in-place launch makes no session"
    );
    std::fs::remove_file(sidecar(&a.exe, ".record.json")).unwrap();

    // Through a launch directory: a different directory, a sibling, under the same parent.
    let launch = a
        .services
        .open(&cura_id, &project_id, &new_project())
        .unwrap();
    let record = record_of(&a.exe);
    let directory = a.data_dir.join(SLICER_SESSIONS_DIR).join(&launch.launch_id);
    assert!(
        same_path(record["cwd"].as_str().unwrap(), &directory),
        "{record}"
    );
    assert_eq!(
        Path::new(record["args"][0].as_str().unwrap())
            .parent()
            .map(|p| std::fs::canonicalize(p).unwrap()),
        Some(std::fs::canonicalize(&directory).unwrap())
    );
    assert_ne!(
        a.data_dir.join(SLICER_CWD_DIR),
        a.data_dir.join(SLICER_SESSIONS_DIR)
    );
    a.services.close();
}

/// **The lifetime of the stripped copy.** A real process, real timers, a real directory watch.
#[test]
fn the_stripped_copy_is_not_swept_while_the_slicer_runs_and_is_swept_after_an_unchanged_exit() {
    let a = assemble();
    keep_alive(&a.exe, 1500);
    let project_id = a.env.project("Lifetime");
    let (file_id, library_path) = a
        .env
        .add_file(&project_id, "bracket.3mf", |path| cura_project(path, None));
    let original = std::fs::read(&library_path).unwrap();

    let launch = a
        .services
        .open(&file_id, &project_id, &new_project())
        .unwrap();
    assert!(launch.stripped);
    record_of(&a.exe);
    let directory = a.data_dir.join(SLICER_SESSIONS_DIR).join(&launch.launch_id);
    let copy = directory.join("bracket.3mf");
    // What the slicer was handed carries no slicer configuration: a plain model.
    assert_eq!(classify_file(&copy).kind, FileKind::Model);

    // While the slicer is running (it sleeps for 1.5 s) the copy is there, and is listed as a
    // session whose process is alive.
    std::thread::sleep(Duration::from_millis(400));
    assert!(
        copy.exists(),
        "the copy was swept while the slicer was still running"
    );
    let sessions = a.services.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].process_alive);

    // After the process exits and the settle period passes, the copy is byte-identical to what the
    // app wrote, so it goes; the record and the directory stay.
    wait_until("the unchanged copy to be swept", || !copy.exists());
    assert!(directory.exists(), "the directory must survive its file");
    // The file goes first and the record is stamped a moment after, so wait for the stamp too.
    wait_until("the record to be stamped", || {
        read_record_with(&directory.join(LAUNCH_RECORD_NAME), &|_| {})
            .is_some_and(|record| record.swept_at.is_some())
    });
    assert!(a.services.sessions().unwrap().is_empty());

    // And the user's own file in the library was never touched.
    assert_eq!(std::fs::read(&library_path).unwrap(), original);
    a.services.close();
}

#[test]
fn a_copy_the_slicer_saved_something_into_is_never_swept_by_the_app() {
    let a = assemble();
    keep_alive(&a.exe, 1500);
    let project_id = a.env.project("Saved");
    let (file_id, _) = a
        .env
        .add_file(&project_id, "bracket.3mf", |path| cura_project(path, None));

    let launch = a
        .services
        .open(&file_id, &project_id, &new_project())
        .unwrap();
    record_of(&a.exe);
    let directory = a.data_dir.join(SLICER_SESSIONS_DIR).join(&launch.launch_id);
    let copy = directory.join("bracket.3mf");

    // The slicer's Ctrl+S, while it is still running: the same path, different content.
    save_over(&copy, "saved by the slicer");

    // Wait for the process to end and for the settle period to pass twice over, then look.
    std::thread::sleep(Duration::from_millis(3000));
    assert!(
        copy.exists(),
        "a file that came back changed must never be swept"
    );
    let sessions = a.services.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].file_state, spm_core::dto::FileState::Changed);
    assert!(!sessions[0].process_alive);
    a.services.close();
}

#[test]
fn the_record_json_a_launch_writes_is_valid_json_with_the_library_it_came_from() {
    let a = assemble();
    let project_id = a.env.project("Record");
    let (file_id, _) = a
        .env
        .add_file(&project_id, "bracket.3mf", |path| cura_project(path, None));

    let launch = a
        .services
        .open(&file_id, &project_id, &new_project())
        .unwrap();

    let text = std::fs::read_to_string(
        a.data_dir
            .join(SLICER_SESSIONS_DIR)
            .join(&launch.launch_id)
            .join(LAUNCH_RECORD_NAME),
    )
    .unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert!(value["library"].as_str().unwrap().starts_with("local:"));
    assert_eq!(value["projectId"], project_id);
    a.services.close();
}
