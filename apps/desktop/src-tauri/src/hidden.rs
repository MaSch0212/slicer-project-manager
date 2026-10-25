//! The hidden smoke run: the built app, started with **no visible window and no focus change**,
//! that opens a library, says it is ready, answers requests through its real loopback listener,
//! proves the webview's policies and the capability ACL from inside real webviews, and exits.
//!
//! `SPM_DESKTOP_HIDDEN=1` creates every window with `visible(false)` and `focused(false)` and
//! nothing ever shows one (no menu either: a menu is chrome of a window nobody sees). The webview
//! still loads: WebView2 does not need a visible window, so the page really boots, asks the
//! loopback server for its capabilities with its cookie, and the run reads that off the server's
//! own request log.
//!
//! Two more variables drive it, both optional:
//!
//! - `SPM_DESKTOP_READY_FILE=<path>`: written (atomically) once the listener is up and the window
//!   exists. It carries the port and the mode, **never the secret**.
//! - `SPM_DESKTOP_SMOKE_REPORT=<path>`: run [`spm_shell::smoke`] against the listener, add what
//!   only the app can see, write the report there and exit `0` if every check passed and `1` if
//!   not. What only the app can see:
//!   - the main window is named for the app, hidden and unfocused, and its page booted: it is on
//!     the loopback origin, on the page its mode calls for (Projects, the connect page, or the
//!     sign-in page in front of a server), with no console error or warning;
//!   - the webview's policies hold: a navigation to a `file:` or `about:` URL is refused, a
//!     `window.open` is denied, and a request for geolocation or notifications is denied (all of
//!     them side-effect free; an `http(s)` link would open the system browser, so that arm is
//!     tested as a pure function instead);
//!   - **the capability ACL, from inside webviews**: the main webview can call an app command and
//!     is refused a command outside the manifest and one that does not exist; a second webview at
//!     the very same origin but another label is refused the app command (the capability is by
//!     webview label); and a webview on another loopback port (a server this run starts for the
//!     purpose) is refused too (the `remote.urls` entry is that exact origin).
//!
//! The probes report through the document title, which needs no permission. After the report the
//! run closes its windows and lets Tauri exit because the last one closed (the path a user takes),
//! so the exit code is also a test of that. `tests/hidden_smoke.rs` runs all of it against the
//! built binary.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spm_shell::json_store::write_json_file;
use spm_shell::server::{DesktopServer, ServerHandle};
use spm_shell::shell::{ActiveMode, Shell};
use spm_shell::smoke::{self, Check, SmokeExpect};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::window::TitleSink;
use crate::{READY_FILE_ENV, SMOKE_LAUNCH_ENV, SMOKE_REPORT_ENV, env_value, is_hidden};

/// How long the run waits for the webview to ask for its capabilities, and for each probe.
const WAIT: Duration = Duration::from_secs(30);

/// How long the process may take to exit once its last window has been closed.
const EXIT_GRACE: Duration = Duration::from_secs(10);

/// Runs in every probe page and reports what the bridge let it do, through the document title.
const PROBE_JS: &str = r#"
(async () => {
  const call = async (command, args) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
    } catch (error) {
      return { ok: false, error: typeof error === 'string' ? error : JSON.stringify(error) };
    }
  };
  const result = {
    bridge: typeof window.__TAURI_INTERNALS__,
    state: await call('desktop_library_state'),
    slicers: await call('desktop_slicers_get'),
    outside: await call('plugin:app|version'),
    missing: await call('no_such_command'),
  };
  document.title = 'PROBE:' + JSON.stringify(result);
})();
"#;

/// Installed in the main webview before any page script runs: collects what the page logs as a
/// warning or an error, and what it throws.
pub const MAIN_INIT_JS: &str = r#"
(() => {
  if (window.__spmProbe) return;
  const errors = [];
  window.__spmProbe = { errors };
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      errors.push(level + ': ' + args.map(String).join(' '));
      original(...args);
    };
  }
  window.addEventListener('error', (event) => errors.push('error event: ' + event.message));
  window.addEventListener('unhandledrejection', (event) =>
    errors.push('unhandled rejection: ' + String(event.reason)),
  );
})();
"#;

/// Run in the main webview once the app has booted: what the page looks like, what the policies
/// let it do, and what the bridge lets it call.
const MAIN_PROBE_JS: &str = r#"
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = async (command, args) => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
    } catch (error) {
      return { ok: false, error: typeof error === 'string' ? error : JSON.stringify(error) };
    }
  };
  for (let i = 0; i < 100 && !document.querySelector('h1'); i++) await sleep(100);
  const result = {
    bridge: typeof window.__TAURI_INTERNALS__,
    state: await call('desktop_library_state'),
    outside: await call('plugin:app|version'),
    missing: await call('no_such_command'),
    origin: location.origin,
    path: location.pathname,
    heading: document.querySelector('h1')?.textContent ?? null,
  };
  // The slicer commands through the real bridge. `null` is "unbind" and "no default", and it has
  // to arrive as a value: an absent argument is a different (refused) request.
  result.slicers = await call('desktop_slicers_get');
  /*LAUNCH*/
  result.unbind = await call('desktop_slicers_bind', { slicerId: 'cura', installId: null });
  result.noDefault = await call('desktop_slicers_set_default', { slicerId: null });
  result.badProduct = await call('desktop_slicers_add_manual', { slicerId: 'superslicer' });
  result.badOptions = await call('desktop_slicers_open', {
    fileId: 'f', projectId: 'p', opts: { mode: 'as-is', localPath: 'C:/Windows/win.ini' },
  });
  result.sessions = await call('desktop_slicers_sessions');
  const home = location.href;
  location.assign('file:///C:/Windows/win.ini');
  await sleep(500);
  result.stayedAfterFile = location.href === home;
  location.assign('about:blank');
  await sleep(500);
  result.stayedAfterBlank = location.href === home;
  result.popupBlankDenied = window.open('about:blank', '_blank') === null;
  result.popupDataDenied = window.open('data:text/html,hi', '_blank') === null;
  result.geolocation = await new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (error) => resolve('error ' + error.code),
      { timeout: 8000 },
    ),
  );
  result.notifications =
    typeof Notification === 'undefined' ? 'unsupported' : await Notification.requestPermission();
  result.errors = window.__spmProbe ? window.__spmProbe.errors : ['the probe was not installed'];
  document.title = 'PROBE:' + JSON.stringify(result);
})();
"#;

/// The part of the main probe that starts a stub slicer through the bridge. Only in a run that
/// asked for it (`SPM_DESKTOP_SMOKE_LAUNCH=1`): the seeded library has a project with a mesh and a
/// Cura-authored 3MF in it, and the machine's `slicers.json` names a stand-in that opens no window.
const LAUNCH_PROBE_JS: &str = r#"
  result.launches = [];
  let project = null;
  for (let i = 0; i < 150 && !project; i++) {
    const list = await (await fetch('/api/projects')).json();
    project = list.find((entry) => entry.name === 'Launch Project') ?? null;
    if (!project) await sleep(200);
  }
  if (project) {
    const detail = await (await fetch('/api/projects/' + project.id)).json();
    const named = (name) => detail.files.find((entry) => entry.name === name);
    for (const name of ['cube.stl', 'bracket.3mf']) {
      const file = named(name);
      const answer = file
        ? await call('desktop_slicers_open', {
            fileId: file.id,
            projectId: project.id,
            opts: { mode: 'new-project' },
          })
        : { ok: false, error: 'the seeded file is missing' };
      result.launches.push({ name, ...answer });
      // The stand-in records itself beside its own executable, so the next launch waits for this
      // one's record to be written rather than overwriting it.
      await sleep(1500);
    }
    // Cura is not bound on this machine, so opening a Cura project as it is is refused by name.
    result.asIsCura = await call('desktop_slicers_open', {
      fileId: named('bracket.3mf').id,
      projectId: project.id,
      opts: { mode: 'as-is' },
    });
  }
"#;

fn main_probe_js(launch: bool) -> String {
    MAIN_PROBE_JS.replace("/*LAUNCH*/", if launch { LAUNCH_PROBE_JS } else { "" })
}

/// What the probes reported, by window label.
#[derive(Clone, Default)]
pub struct Probes {
    titles: Arc<Mutex<HashMap<String, Value>>>,
    /// Every probe title, in order: a page that reports several steps (the model browser's)
    /// is read by step name, where `titles` keeps only the latest per window.
    steps: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Probes {
    /// The sink to hand to the windows, only when a smoke report was asked for.
    pub fn from_env() -> Option<Probes> {
        env_value(SMOKE_REPORT_ENV).map(|_| Probes::default())
    }

    pub fn sink(&self) -> TitleSink {
        let titles = Arc::clone(&self.titles);
        let steps = Arc::clone(&self.steps);
        Arc::new(move |label, title| {
            if let Some(json) = title.strip_prefix("PROBE:")
                && let Ok(value) = serde_json::from_str::<Value>(json)
            {
                steps
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((label.to_owned(), value.clone()));
                titles
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(label.to_owned(), value);
            }
        })
    }

    /// The latest probe title from `label`.
    pub fn latest(&self, label: &str) -> Option<Value> {
        self.titles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
    }

    /// The first report of `step` from `label`, waiting up to `timeout` for it.
    pub async fn wait_step(&self, label: &str, step: &str, timeout: Duration) -> Option<Value> {
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            let found = self
                .steps
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .find(|(from, value)| from == label && value["step"] == step)
                .map(|(_, value)| value.clone());
            if found.is_some() {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        None
    }

    async fn wait_for(&self, label: &str) -> Option<Value> {
        let started = std::time::Instant::now();
        while started.elapsed() < WAIT {
            if let Some(value) = self
                .titles
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(label)
            {
                return Some(value.clone());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        None
    }
}

pub fn announce_and_smoke<R: Runtime>(
    app: &AppHandle<R>,
    main: &WebviewWindow<R>,
    server: &DesktopServer,
    shell: &Arc<Shell>,
    ui_embedded: bool,
    probes: Option<Probes>,
) {
    let ready_file = env_value(READY_FILE_ENV);
    let report_file = env_value(SMOKE_REPORT_ENV);
    if ready_file.is_none() && report_file.is_none() {
        return;
    }
    let (app, main, shell) = (app.clone(), main.clone(), Arc::clone(shell));
    let handle = server.handle();
    tauri::async_runtime::spawn(async move {
        if let Some(path) = ready_file {
            let mode = match shell.mode() {
                ActiveMode::Unset => "unset",
                ActiveMode::Local => "local",
                ActiveMode::Remote => "remote",
            };
            let ready = json!({
                "ready": true,
                "pid": std::process::id(),
                "port": handle.addr().port(),
                "mode": mode,
                "hidden": is_hidden(),
                "uiEmbedded": ui_embedded,
            });
            if let Err(error) = write_json_file(Path::new(&path), &ready) {
                spm_shell::diag::error(&format!("could not write the ready file: {error}"));
            }
        }
        if let (Some(path), Some(probes)) = (report_file, probes) {
            let ok = write_report(&path, &app, &main, &shell, &handle, ui_embedded, &probes).await;
            if ok {
                close_everything_and_let_tauri_exit(&app, &main).await;
            } else {
                app.exit(1);
            }
        }
    });
}

/// Closes the probe windows and then the main one, and waits for the process to exit because its
/// last window closed. If it does not, it is a failure (exit code 2), not a hang.
async fn close_everything_and_let_tauri_exit<R: Runtime>(
    app: &AppHandle<R>,
    main: &WebviewWindow<R>,
) {
    for label in ["probe-same-origin", "probe-other-port", "probe-storage"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
    let _ = main.close();
    tokio::time::sleep(EXIT_GRACE).await;
    spm_shell::diag::error("the process did not exit when its last window closed");
    app.exit(2);
}

/// A tiny HTTP server on another loopback port that answers every request with a page that runs
/// the probe: a different origin on the same host, the case a `127.0.0.1:*` pattern would get
/// wrong.
async fn serve_probe_page() -> std::io::Result<u16> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let page = format!("<!doctype html><title>other</title><script>{PROBE_JS}</script>");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let page = page.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 2048];
                let _ = stream.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Ok(port)
}

pub(crate) fn hidden_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: &str,
    data_dir: std::path::PathBuf,
    sink: TitleSink,
) -> tauri::Result<WebviewWindow<R>> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| tauri::Error::InvalidWebviewUrl("not a URL"))?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .data_directory(data_dir)
        .initialization_script(PROBE_JS)
        .on_document_title_changed(move |window, title| sink(window.label(), title))
        .build()
}

fn refused(report: &Value, key: &str) -> bool {
    report
        .get(key)
        .and_then(|call| call.get("ok"))
        .and_then(Value::as_bool)
        == Some(false)
}

fn describe(report: &Option<Value>) -> String {
    report
        .as_ref()
        .map_or_else(|| "no answer".to_owned(), ToString::to_string)
}

fn check(report: &mut smoke::SmokeReport, name: &str, ok: bool, detail: impl Into<String>) {
    report.checks.push(Check {
        name: name.to_owned(),
        ok,
        detail: detail.into(),
    });
}

async fn write_report<R: Runtime>(
    path: &str,
    app: &AppHandle<R>,
    main: &WebviewWindow<R>,
    shell: &Shell,
    handle: &ServerHandle,
    ui_embedded: bool,
    probes: &Probes,
) -> bool {
    let mode = shell.mode();
    let local = mode == ActiveMode::Local;
    // Where a freshly loaded page belongs: the Projects page with a library, the page that asks
    // where it is with none, the sign-in page in front of a server that wants one.
    let (mode_name, expected_path) = match mode {
        ActiveMode::Local => ("local", "/projects"),
        ActiveMode::Unset => ("unset", "/desktop/connect"),
        ActiveMode::Remote => ("remote", "/login"),
    };
    let mut report = smoke::run(
        handle.addr(),
        handle.gate(),
        &SmokeExpect {
            local_library: local,
            ui_embedded,
        },
    )
    .await;

    let visible = main.is_visible().unwrap_or(true);
    let focused = main.is_focused().unwrap_or(true);
    check(
        &mut report,
        "the window is hidden and unfocused",
        !visible && !focused,
        format!("visible {visible}, focused {focused}"),
    );
    let title = main.title().unwrap_or_default();
    check(
        &mut report,
        "the window is named for the app",
        title == crate::window::APP_NAME,
        title,
    );

    if ui_embedded {
        // The page booted in the hidden webview and asked for its capabilities with its cookie.
        let started = std::time::Instant::now();
        let mut asked = false;
        while started.elapsed() < WAIT {
            asked = handle
                .hits()
                .iter()
                .any(|hit| hit.browser && hit.path == "/api/capabilities");
            if asked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let seen: Vec<String> = handle
            .hits()
            .iter()
            .filter(|hit| hit.browser)
            .map(|hit| format!("{} {}", hit.method, hit.path))
            .collect();
        check(
            &mut report,
            "the hidden webview booted the app and asked for its capabilities",
            asked,
            format!("browser requests seen: {seen:?}"),
        );
    }

    // The probes, from inside real webviews.
    let launch = env_value(SMOKE_LAUNCH_ENV).is_some_and(|value| value == "1");
    let _ = main.eval(main_probe_js(launch));
    let data_dir = std::env::var_os(crate::USER_DATA_ENV)
        .map(|dir| Path::new(&dir).join("webview"))
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("webview"))
        })
        .unwrap_or_default();
    let same_origin = hidden_window(
        app,
        "probe-same-origin",
        &handle.gate().handshake_url("/"),
        data_dir.clone(),
        probes.sink(),
    );
    let other_port = match serve_probe_page().await {
        Ok(port) => hidden_window(
            app,
            "probe-other-port",
            &format!("http://127.0.0.1:{port}/"),
            data_dir.clone(),
            probes.sink(),
        )
        .map(|_| port),
        Err(error) => Err(tauri::Error::Io(error)),
    };

    let main_probe = probes.wait_for(crate::security::MAIN_WEBVIEW).await;
    let origin = format!("http://{}", handle.addr());
    check(
        &mut report,
        "ACL: the main webview can call an app command",
        main_probe.as_ref().is_some_and(|probe| {
            probe["state"]["ok"] == true && probe["state"]["value"]["mode"] == mode_name
        }),
        describe(&main_probe),
    );
    check(
        &mut report,
        "ACL: the main webview is refused a command outside the manifest, and one that does not exist",
        main_probe
            .as_ref()
            .is_some_and(|probe| refused(probe, "outside") && refused(probe, "missing")),
        describe(&main_probe),
    );
    check(
        &mut report,
        "the app booted in the webview: loopback origin, the page the mode calls for, a heading",
        main_probe.as_ref().is_some_and(|probe| {
            probe["origin"] == origin.as_str()
                && probe["path"] == expected_path
                && probe["heading"]
                    .as_str()
                    .is_some_and(|heading| !heading.is_empty())
        }),
        describe(&main_probe),
    );
    check(
        &mut report,
        "the page logged no console error or warning and threw nothing",
        main_probe
            .as_ref()
            .is_some_and(|probe| probe["errors"].as_array().is_some_and(Vec::is_empty)),
        main_probe.as_ref().map_or_else(
            || "no answer".to_owned(),
            |probe| probe["errors"].to_string(),
        ),
    );
    check(
        &mut report,
        "navigation policy: file: and about: are refused and window.open is denied",
        main_probe.as_ref().is_some_and(|probe| {
            probe["stayedAfterFile"] == true
                && probe["stayedAfterBlank"] == true
                && probe["popupBlankDenied"] == true
                && probe["popupDataDenied"] == true
        }),
        describe(&main_probe),
    );
    check(
        &mut report,
        "permission requests are denied: geolocation and notifications",
        main_probe.as_ref().is_some_and(|probe| {
            probe["geolocation"] == "error 1" && probe["notifications"] == "denied"
        }),
        main_probe.as_ref().map_or_else(
            || "no answer".to_owned(),
            |probe| {
                format!(
                    "geolocation {}, notifications {}",
                    probe["geolocation"], probe["notifications"]
                )
            },
        ),
    );

    check(
        &mut report,
        "slicers: the main webview reads the configuration through the bridge",
        main_probe.as_ref().is_some_and(|probe| {
            probe["slicers"]["ok"] == true
                && probe["slicers"]["value"]["installs"].is_array()
                && probe["slicers"]["value"]["detectionSupported"].is_boolean()
                && probe["sessions"]["ok"] == true
                && probe["sessions"]["value"].is_array()
        }),
        describe(&main_probe),
    );
    check(
        &mut report,
        "slicers: null crosses the bridge as a value (unbind, and no default)",
        main_probe
            .as_ref()
            .is_some_and(|probe| probe["unbind"]["ok"] == true && probe["noDefault"]["ok"] == true),
        describe(&main_probe),
    );
    // A rejection that is a string is what the ACL says; one that is `{code, message}` is the
    // shell's own, and the page maps the code to a message.
    check(
        &mut report,
        "slicers: a bad argument is a Validation rejection the page can map, not a bare string",
        main_probe.as_ref().is_some_and(|probe| {
            ["badProduct", "badOptions"].iter().all(|key| {
                probe[key]["ok"] == false
                    && probe[key]["error"]
                        .as_str()
                        .is_some_and(|error| error.contains("\"code\":\"Validation\""))
            })
        }),
        describe(&main_probe),
    );
    if launch {
        check(
            &mut report,
            "slicers: a stub launch through the bridge hands a mesh over in place and a 3MF stripped, and refuses an unbound product by name",
            main_probe.as_ref().is_some_and(|probe| {
                let launches = probe["launches"].as_array().cloned().unwrap_or_default();
                launches.len() == 2
                    && launches.iter().all(|launch| launch["ok"] == true)
                    && launches[0]["value"]["stripped"] == false
                    && launches[1]["value"]["stripped"] == true
                    && probe["asIsCura"]["ok"] == false
                    && probe["asIsCura"]["error"]
                        .as_str()
                        .is_some_and(|error| error.contains("\"code\":\"NotFound\""))
            }),
            describe(&main_probe),
        );
    }

    let same_probe = if same_origin.is_ok() {
        probes.wait_for("probe-same-origin").await
    } else {
        None
    };
    check(
        &mut report,
        "ACL: a webview at the same origin with another label is refused the app command",
        same_probe.as_ref().is_some_and(|probe| {
            probe["bridge"] == "object"
                && refused(probe, "state")
                && refused(probe, "slicers")
                && refused(probe, "outside")
        }),
        format!("{} (origin {origin})", describe(&same_probe)),
    );

    let other_probe = if other_port.is_ok() {
        probes.wait_for("probe-other-port").await
    } else {
        None
    };
    check(
        &mut report,
        "ACL: a webview on another loopback port is refused the app command",
        other_probe.as_ref().is_some_and(|probe| {
            probe["bridge"] == "object"
                && refused(probe, "state")
                && refused(probe, "slicers")
                && refused(probe, "outside")
        }),
        format!(
            "{} (port {})",
            describe(&other_probe),
            other_port.as_ref().map_or(0, |port| *port)
        ),
    );

    if let Some(fixture) = env_value(crate::SMOKE_BROWSE_ENV) {
        let opener = |label: &str, url: &str| {
            hidden_window(app, label, url, data_dir.clone(), probes.sink()).is_ok()
        };
        crate::hidden_browse::run(&mut report, app, main, handle, probes, &fixture, &opener).await;
    }

    report.ok = report.checks.iter().all(|check| check.ok);
    let value = serde_json::to_value(&report).unwrap_or_default();
    if let Err(error) = write_json_file(Path::new(path), &value) {
        spm_shell::diag::error(&format!("could not write the smoke report: {error}"));
        return false;
    }
    report.ok
}
