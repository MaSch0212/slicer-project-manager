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
    "ACL: a webview at the same origin with another label is refused the app command",
    "ACL: a webview on another loopback port is refused the app command",
];

struct Run {
    status: ExitStatus,
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
        .stderr(Stdio::null())
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
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the hidden run did not finish in 180 s");
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
    assert!(failed.is_empty(), "failed checks:\n{}", failed.join("\n"));
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
