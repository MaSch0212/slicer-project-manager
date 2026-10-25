//! The hidden smoke run, as an automated test: the **built app** started with no visible window
//! and no focus change (`SPM_DESKTOP_HIDDEN=1`), once per mode. See `src/hidden.rs` for what the
//! app checks about itself; this runs it, reads its report, and asserts the report is complete and
//! green and the process exited cleanly.
//!
//! Nothing here uses `tauri-driver` or anything that shows a window. The test spawns the binary
//! with `CREATE_NO_WINDOW`, and the app creates its windows `visible(false)` and `focused(false)`
//! and never shows one.

#![cfg(windows)]

use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use spm_core::ensure_bootstrap_admin;
use spm_core::testing::TempLibrary;
use spm_http::{AppState, AuthMode, HttpOptions, router};

// The stand-in slicer (compiled on demand, opens no window) and the archive builders are the shell
// crate's own test support, shared rather than copied.
#[path = "../../../../crates/spm-shell/tests/support/stub.rs"]
mod stub;
#[path = "../../../../crates/spm-core/tests/it/fixtures.rs"]
mod threemf;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The checks a complete report has. A check that stops being made is a failure, not a pass.
const REQUIRED_CHECKS: &[&str] = &[
    "binds loopback only",
    "no secret: the app is refused",
    "no secret: the API is refused",
    "a made-up cookie is refused",
    "a made-up handshake token is refused",
    "the handshake sets an HttpOnly SameSite=Strict cookie and redirects",
    "the handshake token is spent after one use",
    "a request from another origin is refused even with the cookie",
    "capabilities are answered with the secret, as the union",
    "the app is served with a content security policy",
    "the window is hidden and unfocused",
    "the window is named for the app",
    "the hidden webview booted the app and asked for its capabilities",
    "ACL: the main webview can call an app command",
    "ACL: the main webview is refused a command outside the manifest, and one that does not exist",
    "the app booted in the webview: loopback origin, the page the mode calls for, a heading",
    "the page logged no console error or warning and threw nothing",
    "navigation policy: file: and about: are refused and window.open is denied",
    "permission requests are denied: geolocation and notifications",
    "slicers: the main webview reads the configuration through the bridge",
    "slicers: null crosses the bridge as a value (unbind, and no default)",
    "slicers: a bad argument is a Validation rejection the page can map, not a bare string",
    "ACL: a webview at the same origin with another label is refused the app command",
    "ACL: a webview on another loopback port is refused the app command",
];

/// The extra check a run that starts a stand-in slicer through the bridge makes.
const LAUNCH_CHECK: &str = "slicers: a stub launch through the bridge hands a mesh over in place and a 3MF stripped, and refuses an unbound product by name";

struct Run {
    status: ExitStatus,
    stderr: String,
    ready: Value,
    report: Value,
}

fn run_hidden(root: &Path, extra_env: &[(&str, &str)]) -> Run {
    let ready_file = root.join("ready.json");
    let report_file = root.join("report.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_spm-desktop"));
    command
        .env("SPM_DESKTOP_HIDDEN", "1")
        .env("SPM_DESKTOP_USER_DATA", root.join("data"))
        .env("SPM_DESKTOP_READY_FILE", &ready_file)
        .env("SPM_DESKTOP_SMOKE_REPORT", &report_file)
        .env_remove("SPM_LIBRARY_DIR")
        .env_remove("SPM_REMOTE_URL")
        .env_remove("SPM_DEV_UI_ORIGIN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(root.join("stderr.txt")).unwrap())
        .creation_flags(CREATE_NO_WINDOW);
    for (name, value) in extra_env {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("the built app starts");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(400) {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = std::fs::read_to_string(root.join("stderr.txt")).unwrap_or_default();
            panic!(
                "the hidden run did not finish in 400 s; it said:
{stderr}"
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let read =
        |file: &Path| -> Value {
            serde_json::from_str(&std::fs::read_to_string(file).unwrap_or_else(|e| {
                panic!("{} was not written (exit {status}): {e}", file.display())
            }))
            .unwrap()
        };
    Run {
        stderr: std::fs::read_to_string(root.join("stderr.txt")).unwrap_or_default(),
        status,
        ready: read(&ready_file),
        report: read(&report_file),
    }
}

fn assert_green(run: &Run) {
    let checks = run.report["checks"].as_array().unwrap();
    let failed: Vec<String> = checks
        .iter()
        .filter(|check| check["ok"] != true)
        .map(|check| format!("{}: {}", check["name"], check["detail"]))
        .collect();
    assert!(
        failed.is_empty(),
        "failed checks:\n{}\nthe app said:\n{}",
        failed.join("\n"),
        run.stderr
    );
    assert_eq!(run.report["ok"], true);
    for name in REQUIRED_CHECKS {
        assert!(
            checks.iter().any(|check| check["name"] == *name),
            "the report has no check named {name:?}"
        );
    }
    // Exit 0 means the last window closing ended the process (the app exits 1 on a failed check
    // and 2 if it outlived its last window).
    assert!(run.status.success(), "exit status {}", run.status);
}

fn assert_ready(run: &Run, mode: &str) {
    assert_eq!(run.ready["ready"], true);
    assert_eq!(run.ready["hidden"], true);
    assert_eq!(run.ready["mode"], mode);
    assert!(run.ready["port"].as_u64().unwrap() > 0);
    assert!(run.ready["pid"].as_u64().unwrap() > 0);
    // The secret is never in the file another process could read.
    let text = run.ready.to_string();
    assert!(!text.contains("spm_launch") && !text.contains("token") && !text.contains("secret"));
    // And the port is closed once the process is gone.
    let port = run.ready["port"].as_u64().unwrap() as u16;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    assert!(
        TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_err(),
        "the listener outlived the process"
    );
}

#[test]
fn a_local_library_the_built_app_hidden_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("library");
    std::fs::create_dir_all(library.join("Seeded Project")).unwrap();
    std::fs::write(library.join("Seeded Project").join("note.txt"), "hello").unwrap();

    let run = run_hidden(
        root.path(),
        &[("SPM_LIBRARY_DIR", library.to_str().unwrap())],
    );
    assert_green(&run);
    assert_ready(&run, "local");
    // It opened (migrated, seeded) the library it was pointed at, and an environment override is
    // not remembered.
    assert!(library.join(".spm").join("app.db").is_file());
    assert!(!root.path().join("data").join("state.json").exists());
    // `/api/projects` was asked of the local library.
    assert!(
        run.report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |check| check["name"] == "the local library answers /api/projects"
                    && check["ok"] == true
            )
    );
}

#[test]
fn a_first_run_with_no_library_lands_on_the_connect_page() {
    let root = tempfile::tempdir().unwrap();
    let run = run_hidden(root.path(), &[]);
    assert_green(&run);
    assert_ready(&run, "unset");
}

#[test]
fn a_remote_server_the_built_app_hidden_through_the_proxy() {
    // A real server in this process: sessions, a bootstrap admin, the real router.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let library = TempLibrary::new();
    ensure_bootstrap_admin(&library).unwrap();
    let state = AppState::new(
        (*library).clone(),
        HttpOptions {
            auth: AuthMode::Sessions,
            ..HttpOptions::default()
        },
    );
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    let _server = runtime.spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let root = tempfile::tempdir().unwrap();
    let run = run_hidden(root.path(), &[("SPM_REMOTE_URL", &origin)]);
    assert_green(&run);
    assert_ready(&run, "remote");
    // The webview never touched the server's origin: every request it made was to the app's own.
    // (It could not have: its navigation policy sends other origins to the system browser.) The
    // server saw the proxy, and the page got a sign-in page because the server wants one.
    assert!(
        !root.path().join("data").join("state.json").exists(),
        "SPM_REMOTE_URL is for one launch"
    );
}

/// **A stand-in slicer, started through the real bridge by the built app, hidden.** The page's own
/// `invoke` hands a mesh and a Cura-authored 3MF to the stand-in (which opens no window and writes
/// down what it was given); the test then reads what the stand-in saw: the mesh in place, the 3MF
/// as a stripped copy in a launch directory under the app's data directory, a working directory the
/// app chose, and none of the app's own variables.
#[test]
fn a_stub_slicer_is_started_through_the_bridge_by_the_built_app_hidden() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let library = root.path().join("library");
    let project = library.join("Launch Project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("cube.stl"),
        "solid cube
endsolid cube
",
    )
    .unwrap();
    threemf::cura_project(&project.join("bracket.3mf"), None);

    // The user's Orca, added by hand (which is how a portable install is): the stand-in.
    let exe = stub::build_stub(&root.path().join("stub"), "stub-orca");
    stub::keep_a_copy_of_the_argument(&exe);
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("slicers.json"),
        serde_json::json!({
            "version": 1,
            "installs": [{
                "id": "manual:stub",
                "slicerId": "orca",
                "label": "OrcaSlicer (the stand-in)",
                "origin": { "kind": "manual", "id": "stub" },
                "version": null,
                "pathHint": exe.to_string_lossy(),
                "addedAt": 1,
            }],
            "bindings": { "orca": "manual:stub" },
            "defaultSlicerId": "orca",
        })
        .to_string(),
    )
    .unwrap();

    let run = run_hidden(
        root.path(),
        &[
            ("SPM_LIBRARY_DIR", library.to_str().unwrap()),
            ("SPM_DESKTOP_SMOKE_LAUNCH", "1"),
            // A variable of the app's own that must never reach a slicer.
            ("SPM_REMOTE_URL_FOR_THE_TEST", "http://secret.invalid"),
        ],
    );
    assert_green(&run);
    assert!(
        run.report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["name"] == LAUNCH_CHECK && check["ok"] == true),
        "the report has no passing {LAUNCH_CHECK:?}"
    );

    // What the stand-in was handed by the *second* launch (the 3MF): a copy in a launch directory
    // under the data directory, stripped of the slicer configuration it came with.
    let record = stub::record_of(&exe);
    let handed = std::path::PathBuf::from(record["args"][0].as_str().unwrap());
    let sessions = data.join("slicer-sessions");
    assert_eq!(handed.file_name().unwrap(), "bracket.3mf");
    let launch_directory = handed.parent().unwrap();
    assert_eq!(
        std::fs::canonicalize(launch_directory.parent().unwrap()).unwrap(),
        std::fs::canonicalize(&sessions).unwrap()
    );
    assert_eq!(
        std::fs::canonicalize(record["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(launch_directory).unwrap()
    );
    let copy = std::path::PathBuf::from(format!("{}.arg-copy.3mf", exe.display()));
    assert!(
        copy.is_file(),
        "the stand-in kept no copy of what it was handed"
    );
    assert_eq!(
        spm_core::files::classify::classify_file(&copy).kind,
        spm_core::dto::FileKind::Model,
        "what the slicer was handed still carries a slicer configuration"
    );
    // The user's own file in the library is untouched: still a Cura project.
    assert_eq!(
        spm_core::files::classify::classify_file(&project.join("bracket.3mf")).kind,
        spm_core::dto::FileKind::SlicerProject
    );
    // The mesh went in place, so the scratch directory was the stand-in's working directory then;
    // it exists because the launcher made it.
    assert!(data.join("slicer-cwd").is_dir());
    // Nothing of the app's own configuration reached the child.
    let names: Vec<String> = record["env"]
        .as_object()
        .unwrap()
        .keys()
        .map(|name| name.to_ascii_uppercase())
        .collect();
    assert!(
        !names.iter().any(|name| name.starts_with("SPM_")),
        "the child inherited {names:?}"
    );
    assert_eq!(record["stdinEof"], true);
    // And the launch record names the library it came from.
    let launch_record: Value = serde_json::from_str(
        &std::fs::read_to_string(launch_directory.join("launch.json")).unwrap(),
    )
    .unwrap();
    assert!(
        launch_record["library"]
            .as_str()
            .unwrap()
            .starts_with("local:")
    );
}

#[path = "support/browse_fixture.rs"]
mod browse_fixture;

/// What the model browser's part of the run must report, by name.
const BROWSE_CHECKS: &[&str] = &[
    "browse: a whole-window request is intersected below the chrome, never over it",
    "browse: a 1x1 request is not honoured as a rectangle",
    "browse: a real request is positioned by the shell (set_bounds on the child)",
    "browse: the commands reach the view through the real bridge and refuse what they must",
    "browse: the policy is on the view's own webview (a custom scheme, a redirect into one, a file: and an unparseable URL are refused; a redirect to a page is followed)",
    "browse: a target=_blank link navigates the view itself and opens no window",
    "browse: a blob: download through <a download>, location.href and window.open, and an attachment, are each staged and verifiable",
    "browse: a download is attributed to the page the view was on, not to the blob: URL",
    "browse: discard removes a staged download",
    "browse: a page is matched to the project whose website has its key, and nothing else matches (the honest answer)",
    "browse: landing refuses an unsafe name and an id it never staged, then lands through the loopback API with the bytes in the project and the staging directory gone",
    "browse: detach destroys the view, a second attach remembers the last page, and clearing forgets it",
    "browse security: an invoke from the browse webview is refused (an app command, a browse command, a plugin command), though the bridge object is there",
    "browse security: the loopback API refuses the browse webview (no launch secret, so no request passed the gate), while the main webview's identical request does",
    "browse security: a permission request from the browse webview is denied",
    "browse security: its storage is isolated from the main webview's profile, both ways (same origin, different data directory)",
    "browse: the view has a persistent profile directory of its own beside the main webview's",
    "browse: the view is gone when the route is (no browse webview is left)",
];

/// **The model browser, hidden, against a fixture site.** The real child webview is created inside
/// the real (invisible) main window, driven through the real bridge for every command, and then
/// from its own side for the security properties: an `invoke` from it is refused, the loopback
/// listener never sees it past the gate, its storage is its own, and it is denied geolocation. A
/// download goes through `blob:` by three DOM idioms and as an attachment, is staged in the app's
/// own directory (never the user's Downloads), and lands in a project through the loopback API.
#[test]
fn the_model_browser_the_real_child_webview_against_a_fixture_site_hidden() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let fixture = runtime.block_on(browse_fixture::Fixture::start());
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("library");
    std::fs::create_dir_all(&library).unwrap();

    let run = run_hidden(
        root.path(),
        &[
            ("SPM_LIBRARY_DIR", library.to_str().unwrap()),
            ("SPM_DESKTOP_SMOKE_BROWSE", &fixture.origin()),
            ("SPM_DESKTOP_BROWSE_TEST_HOSTS", &fixture.as_a_site()),
        ],
    );
    assert_green(&run);
    let checks = run.report["checks"].as_array().unwrap();
    for name in BROWSE_CHECKS {
        let found = checks.iter().find(|check| check["name"] == *name);
        assert!(
            found.is_some_and(|check| check["ok"] == true),
            "browse check {name:?}: {found:?}"
        );
    }

    // The landed file is in the project folder, byte for byte (4096 bytes of 7).
    let landed = library.join("Landing Project").join("model-files.bin");
    assert_eq!(std::fs::read(&landed).unwrap(), vec![7u8; 4096]);
    // Nothing is left staged, and nothing went to the user's own Downloads folder.
    let staging = root.path().join("data").join("model-downloads");
    assert!(
        !staging.exists() || std::fs::read_dir(&staging).unwrap().next().is_none(),
        "the staging directory still holds {:?}",
        std::fs::read_dir(&staging).map(|d| d.count())
    );
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let downloads = Path::new(&profile).join("Downloads");
        for name in ["anchor.bin", "served.bin", "model-files.bin"] {
            assert!(
                !downloads.join(name).exists(),
                "{name} reached the user's Downloads"
            );
        }
    }
    // The view's profile is the app's own directory, and the last page it was on is remembered in
    // a file beside it (cleared once by the page, then written again by the later navigations).
    assert!(root.path().join("data").join("browse-profile").is_dir());
    let remembered: Value = serde_json::from_str(
        &std::fs::read_to_string(root.path().join("data").join("browse.json")).unwrap(),
    )
    .unwrap();
    assert!(
        remembered["lastUrl"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://127.0.0.1:")),
        "{remembered}"
    );
    drop(fixture);
}
