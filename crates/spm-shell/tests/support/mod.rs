//! What the shell's tests share: scripted dialogs, a recorder for what the window is told, fake
//! preview runners, a client for the loopback listener, and a real upstream server to proxy to.

#![allow(dead_code)]

pub mod fixtures;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use spm_core::Library;
use spm_shell::library::{
    ConfirmOptions, FolderPickerOptions, ModeChoice, ModePickerOptions, PreviewRunner,
    PromptTrigger, Prompts, StartPreviews,
};
use spm_shell::server::{DesktopServer, Ui};
use spm_shell::shell::{Shell, ShellEvents, ShellOptions, ShellRoute};
use tempfile::TempDir;

/// Answers the shell's questions from a script, and remembers what it was asked.
#[derive(Default)]
pub struct ScriptedPrompts {
    folders: Mutex<VecDeque<Option<PathBuf>>>,
    modes: Mutex<VecDeque<ModeChoice>>,
    confirms: Mutex<VecDeque<bool>>,
    pub folder_questions: Mutex<Vec<(FolderPickerOptions, PromptTrigger)>>,
    pub mode_questions: Mutex<Vec<ModePickerOptions>>,
    pub confirm_questions: Mutex<Vec<ConfirmOptions>>,
    /// How long every answer takes: a dialog stays open while the user decides.
    pub delay: Mutex<Duration>,
    pub folder_calls: AtomicUsize,
    pub mode_calls: AtomicUsize,
    pub confirm_calls: AtomicUsize,
}

impl ScriptedPrompts {
    pub fn new() -> Arc<ScriptedPrompts> {
        Arc::new(ScriptedPrompts::default())
    }

    pub fn will_pick(&self, dir: Option<&Path>) {
        self.folders
            .lock()
            .unwrap()
            .push_back(dir.map(Path::to_path_buf));
    }

    pub fn will_choose(&self, choice: ModeChoice) {
        self.modes.lock().unwrap().push_back(choice);
    }

    pub fn will_confirm(&self, answer: bool) {
        self.confirms.lock().unwrap().push_back(answer);
    }

    pub fn hold_dialogs_open_for(&self, delay: Duration) {
        *self.delay.lock().unwrap() = delay;
    }

    fn wait(&self) {
        let delay = *self.delay.lock().unwrap();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
    }
}

impl Prompts for ScriptedPrompts {
    fn pick_folder(
        &self,
        options: &FolderPickerOptions,
        trigger: PromptTrigger,
    ) -> Option<PathBuf> {
        self.folder_calls.fetch_add(1, Ordering::SeqCst);
        self.folder_questions
            .lock()
            .unwrap()
            .push((options.clone(), trigger));
        self.wait();
        self.folders.lock().unwrap().pop_front().flatten()
    }

    fn ask_mode(&self, options: &ModePickerOptions) -> ModeChoice {
        self.mode_calls.fetch_add(1, Ordering::SeqCst);
        self.mode_questions.lock().unwrap().push(options.clone());
        self.wait();
        self.modes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(ModeChoice::Cancel)
    }

    fn confirm_remote(&self, options: &ConfirmOptions) -> bool {
        self.confirm_calls.fetch_add(1, Ordering::SeqCst);
        self.confirm_questions.lock().unwrap().push(options.clone());
        self.wait();
        self.confirms.lock().unwrap().pop_front().unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Navigate(ShellRoute),
    Reload,
}

/// What the shell told the window.
#[derive(Default)]
pub struct Recorder {
    events: Mutex<Vec<Event>>,
}

impl Recorder {
    pub fn new() -> Arc<Recorder> {
        Arc::new(Recorder::default())
    }

    pub fn events(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
    }

    pub fn reloads(&self) -> usize {
        self.events()
            .iter()
            .filter(|e| **e == Event::Reload)
            .count()
    }
}

impl ShellEvents for Recorder {
    fn navigate(&self, route: ShellRoute) {
        self.events.lock().unwrap().push(Event::Navigate(route));
    }

    fn reload(&self) {
        self.events.lock().unwrap().push(Event::Reload);
    }
}

/// A preview runner that does nothing and says when it was told to stop.
pub struct IdleRunner {
    pub stopped: Arc<AtomicUsize>,
}

impl PreviewRunner for IdleRunner {
    fn stop(self: Box<Self>) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }
}

/// Starts [`IdleRunner`]s and counts them.
#[derive(Default)]
pub struct IdlePreviews {
    pub started: Arc<AtomicUsize>,
    pub stopped: Arc<AtomicUsize>,
}

impl IdlePreviews {
    pub fn starter(self: &Arc<Self>) -> StartPreviews {
        let this = Arc::clone(self);
        Arc::new(move |_lib: &Library| {
            this.started.fetch_add(1, Ordering::SeqCst);
            Box::new(IdleRunner {
                stopped: Arc::clone(&this.stopped),
            })
        })
    }
}

/// A shell on a temporary state file, with scripted dialogs and idle preview runners.
pub struct World {
    pub shell: Arc<Shell>,
    pub prompts: Arc<ScriptedPrompts>,
    pub events: Arc<Recorder>,
    pub previews: Arc<IdlePreviews>,
    pub root: TempDir,
}

impl World {
    pub fn new() -> World {
        World::with(|_| {})
    }

    pub fn with(configure: impl FnOnce(&mut ShellOptions)) -> World {
        let root = tempfile::Builder::new()
            .prefix("spm-shell-")
            .tempdir()
            .expect("a temp dir");
        World::in_root(root, configure)
    }

    pub fn in_root(root: TempDir, configure: impl FnOnce(&mut ShellOptions)) -> World {
        let prompts = ScriptedPrompts::new();
        let events = Recorder::new();
        let previews = Arc::new(IdlePreviews::default());
        let mut options = ShellOptions::new(
            root.path().join("data").join("state.json"),
            prompts.clone(),
            events.clone(),
        );
        options.start_previews = previews.starter();
        configure(&mut options);
        World {
            shell: Shell::new(options),
            prompts,
            events,
            previews,
            root,
        }
    }

    /// A second shell on the same state file and folders: "the next launch".
    pub fn relaunch(&self) -> World {
        let prompts = ScriptedPrompts::new();
        let events = Recorder::new();
        let previews = Arc::new(IdlePreviews::default());
        let mut options = ShellOptions::new(self.state_file(), prompts.clone(), events.clone());
        options.start_previews = previews.starter();
        World {
            shell: Shell::new(options),
            prompts,
            events,
            previews,
            root: tempfile::tempdir().expect("a temp dir"),
        }
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.path().join("data").join("state.json")
    }

    /// A new, empty folder to use as a library.
    pub fn folder(&self, name: &str) -> PathBuf {
        let dir = self.root.path().join(name);
        std::fs::create_dir_all(&dir).expect("a folder");
        dir
    }

    pub fn state(&self) -> Value {
        std::fs::read_to_string(self.state_file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }
}

/// No environment.
pub fn no_env(_: &str) -> Option<String> {
    None
}

/// An environment of the given variables.
pub fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let pairs: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    move |name| {
        pairs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    }
}

// ---------------------------------------------------------------------------------------------
// The loopback listener, from the outside
// ---------------------------------------------------------------------------------------------

/// A client for a [`DesktopServer`] that has done the handshake: it carries the session cookie the
/// way the webview does.
pub struct Client {
    pub origin: String,
    pub http: reqwest::Client,
    pub cookie: String,
}

pub struct Reply {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent("spm-test")
        .build()
        .unwrap()
}

impl Client {
    /// Does the handshake against `server`, as the webview does.
    pub async fn handshake(server: &DesktopServer) -> Client {
        let http = http();
        let response = http
            .get(server.gate().handshake_url("/"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 303);
        let set_cookie = response
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let cookie = set_cookie.split(';').next().unwrap().to_owned();
        Client {
            origin: server.origin(),
            http,
            cookie,
        }
    }

    pub fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.origin))
            .header("cookie", &self.cookie)
    }

    pub async fn send(&self, builder: reqwest::RequestBuilder) -> Reply {
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.bytes().await.unwrap().to_vec();
        Reply {
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Reply {
        self.send(self.request(reqwest::Method::GET, path)).await
    }

    pub async fn post_json(&self, path: &str, body: &Value) -> Reply {
        self.send(self.request(reqwest::Method::POST, path).json(body))
            .await
    }

    pub async fn put_json(&self, path: &str, body: &Value) -> Reply {
        self.send(self.request(reqwest::Method::PUT, path).json(body))
            .await
    }

    pub async fn delete(&self, path: &str) -> Reply {
        self.send(self.request(reqwest::Method::DELETE, path)).await
    }

    pub async fn upload(&self, project_id: &str, name: &str, bytes: Vec<u8>) -> Reply {
        self.send(
            self.request(
                reqwest::Method::POST,
                &format!("/api/projects/{project_id}/files"),
            )
            .header("x-spm-file-name", name)
            .body(bytes),
        )
        .await
    }
}

/// A listener over `shell`, serving nothing but the API.
pub async fn serve(shell: &Arc<Shell>) -> DesktopServer {
    DesktopServer::start(Arc::clone(shell), Ui::None)
        .await
        .expect("the listener starts")
}

/// A listener over `shell` that serves a bundle from a directory.
pub async fn serve_dir(shell: &Arc<Shell>, dir: &Path) -> DesktopServer {
    DesktopServer::start(
        Arc::clone(shell),
        Ui::Assets(Arc::new(spm_http::DirAssets::new(dir))),
    )
    .await
    .expect("the listener starts")
}

/// Polls until `check` holds, or fails after `within`.
pub async fn eventually(within: Duration, what: &str, mut check: impl FnMut() -> bool) {
    let started = std::time::Instant::now();
    while started.elapsed() < within {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for: {what}");
}

// ---------------------------------------------------------------------------------------------
// A real server to proxy to
// ---------------------------------------------------------------------------------------------

/// One request an upstream received, body and all.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    /// Path and query, as the server saw them.
    pub target: String,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
    /// The whole body arrived (a body that was cut short, or lied about its length, did not).
    pub complete: bool,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    }
}

pub type UpstreamReply =
    std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>;

/// A listener on `127.0.0.1` that records every request and answers from a script.
pub struct Upstream {
    pub addr: std::net::SocketAddr,
    pub origin: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Upstream {
    pub async fn start_async(
        handler: impl Fn(Seen) -> UpstreamReply + Send + Sync + 'static,
    ) -> Upstream {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let handler = Arc::new(handler);
        let record = Arc::clone(&seen);
        let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
            let (record, handler) = (Arc::clone(&record), Arc::clone(&handler));
            async move {
                let (parts, body) = request.into_parts();
                let (body, complete) = match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
                    Ok(bytes) => (bytes.to_vec(), true),
                    Err(_) => (Vec::new(), false),
                };
                let seen = Seen {
                    method: parts.method.to_string(),
                    target: parts
                        .uri
                        .path_and_query()
                        .map(|pq| pq.as_str().to_owned())
                        .unwrap_or_default(),
                    headers: parts.headers,
                    body,
                    complete,
                };
                record.lock().unwrap().push(seen.clone());
                handler(seen).await
            }
        });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Upstream {
            addr,
            origin: format!("http://{addr}"),
            seen,
            task,
        }
    }

    pub async fn start(
        handler: impl Fn(&Seen) -> axum::response::Response + Send + Sync + 'static,
    ) -> Upstream {
        Upstream::start_async(move |seen| {
            let response = handler(&seen);
            Box::pin(async move { response })
        })
        .await
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn last(&self) -> Seen {
        self.requests().last().cloned().expect("a request arrived")
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// An answer: status, headers, body.
pub fn answer(
    status: u16,
    headers: &[(&str, &str)],
    body: impl Into<axum::body::Body>,
) -> axum::response::Response {
    let mut builder = axum::response::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body.into()).unwrap()
}

/// A request for the proxy, as the loopback listener would hand it over.
pub fn proxy_request(
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: impl Into<axum::body::Body>,
) -> axum::http::Request<axum::body::Body> {
    let mut builder = axum::http::Request::builder().method(method).uri(target);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body.into()).unwrap()
}

pub async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec()
}

pub async fn body_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&body_bytes(response).await).unwrap()
}
