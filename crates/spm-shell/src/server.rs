//! The one transport (migration spec 3.3): a single HTTP listener on `127.0.0.1`, an OS-assigned
//! port, run as a task inside the app. The main webview loads its pages and makes its API calls
//! from it, in every mode.
//!
//! What answers a request depends on what the [`Shell`] says is active:
//!
//! | path          | local folder                    | remote server            | nothing open yet |
//! | ------------- | ------------------------------- | ------------------------ | ---------------- |
//! | `/api/capabilities` | the shell column united with the library's | the proxied server's, united with the remote shell column | the shell column |
//! | `/api/...`    | `spm-http`'s router over the library | reverse-proxied to the server | `409 Conflict` |
//! | anything else | the embedded web bundle (or the Vite dev server) | same | same |
//!
//! Nothing here is reachable without the launch secret ([`crate::gate`]); the gate is the
//! outermost layer, so a request without it does not even learn which of those rows it would have
//! hit.

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use spm_core::AppError;
use spm_core::dto::Capabilities;
use spm_http::{ApiError, Assets, AuthMode, DevProxy, capabilities_for, static_files};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

use crate::capabilities::{LOCAL_SHELL_CAPABILITIES, UNSET_SHELL_CAPABILITIES, union_capabilities};
use crate::gate::{self, HANDSHAKE_PATH, LaunchGate, gate_layer};
use crate::shell::{ActiveMode, Shell, ShellRoute};

/// Where the non-API requests are answered from.
#[derive(Clone)]
pub enum Ui {
    /// The files compiled into the app.
    Assets(Arc<dyn Assets>),
    /// Development only: forward to a running Vite dev server.
    Dev(DevProxy),
    /// Nothing: every non-API request is a 404.
    None,
}

/// What the page is allowed to load and connect to.
///
/// `connect-src` names Tauri's IPC endpoints besides `'self'`: on Windows `invoke` is a `fetch` to
/// `http://ipc.localhost`, and a policy that forbids it would fall back to a slower path on every
/// call. Styles are `'unsafe-inline'` because the UI sets style attributes; scripts are not.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
    connect-src 'self' ipc: http://ipc.localhost; worker-src 'self' blob:; object-src 'none'; \
    base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

struct ServerContext {
    shell: Arc<Shell>,
    gate: Arc<LaunchGate>,
    ui: Ui,
    hits: Mutex<VecDeque<Hit>>,
}

/// How many requests [`DesktopServer::hits`] remembers.
const HITS_KEPT: usize = 256;

/// One request that got past the gate: what a test or the smoke run reads to see what the webview
/// really asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub method: String,
    pub path: String,
    /// The request came from a browser engine (its `User-Agent` starts with `Mozilla/`), as the
    /// webview's do and the smoke run's own client's do not.
    pub browser: bool,
}

/// A running loopback listener.
pub struct DesktopServer {
    addr: SocketAddr,
    gate: Arc<LaunchGate>,
    shell: Arc<Shell>,
    context: Arc<ServerContext>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

/// What a task that outlives the borrow of the server needs to look at it: its address, its gate
/// and the requests it has served.
#[derive(Clone)]
pub struct ServerHandle {
    addr: SocketAddr,
    gate: Arc<LaunchGate>,
    context: Arc<ServerContext>,
}

impl ServerHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn gate(&self) -> &Arc<LaunchGate> {
        &self.gate
    }

    /// The most recent requests that passed the gate, oldest first.
    pub fn hits(&self) -> Vec<Hit> {
        self.context
            .hits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

impl DesktopServer {
    /// Binds `127.0.0.1:0` and starts serving. **Loopback only, always:** binding another
    /// interface would put the library on the LAN and raise a firewall prompt.
    pub async fn start(shell: Arc<Shell>, ui: Ui) -> std::io::Result<DesktopServer> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let addr = listener.local_addr()?;
        debug_assert!(addr.ip().is_loopback());
        let gate = Arc::new(LaunchGate::new(format!("127.0.0.1:{}", addr.port())));
        let context = Arc::new(ServerContext {
            shell: Arc::clone(&shell),
            gate: Arc::clone(&gate),
            ui,
            hits: Mutex::new(VecDeque::new()),
        });
        let shutdown = CancellationToken::new();
        let hits = Arc::clone(&context);
        let app = app(context).into_make_service_with_connect_info::<SocketAddr>();
        let stop = shutdown.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { stop.cancelled().await })
                .await;
        });
        Ok(DesktopServer {
            addr,
            gate,
            shell,
            context: hits,
            shutdown,
            task: Some(task),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `http://127.0.0.1:<port>`: the origin the webview is on.
    pub fn origin(&self) -> String {
        self.gate.origin()
    }

    pub fn gate(&self) -> &Arc<LaunchGate> {
        &self.gate
    }

    /// The URL that logs the webview in and lands it on `route`. Single use: ask again to load
    /// again.
    pub fn handshake_url(&self, route: ShellRoute) -> String {
        self.gate.handshake_url(route.path())
    }

    /// The handshake URL for wherever the shell's mode says the webview belongs: home with a
    /// library open (or a server connected), the connect page with nothing.
    pub fn initial_url(&self) -> String {
        self.handshake_url(initial_route(&self.shell))
    }

    /// The most recent requests that passed the gate, oldest first.
    pub fn hits(&self) -> Vec<Hit> {
        self.handle().hits()
    }

    pub fn handle(&self) -> ServerHandle {
        ServerHandle {
            addr: self.addr,
            gate: Arc::clone(&self.gate),
            context: Arc::clone(&self.context),
        }
    }

    /// Stops accepting, gives in-flight requests a moment, then drops whatever is left.
    pub async fn stop(mut self) {
        self.shutdown.cancel();
        if let Some(mut task) = self.task.take()
            && tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
        {
            task.abort();
        }
    }
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Where a freshly loaded webview belongs in the shell's current mode.
pub fn initial_route(shell: &Shell) -> ShellRoute {
    match shell.mode() {
        ActiveMode::Unset => ShellRoute::Connect,
        ActiveMode::Local | ActiveMode::Remote => ShellRoute::Home,
    }
}

fn app(context: Arc<ServerContext>) -> Router {
    Router::new()
        .route(HANDSHAKE_PATH, get(handshake))
        .fallback(dispatch)
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&context),
            record_hit,
        ))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&context.gate),
            gate_layer,
        ))
        .with_state(context)
}

/// Remembers the request, for [`DesktopServer::hits`]. Inside the gate, so it only ever sees
/// requests that carried the secret (or are the handshake).
async fn record_hit(
    State(context): State<Arc<ServerContext>>,
    request: Request,
    next: Next,
) -> Response {
    let hit = Hit {
        method: request.method().as_str().to_owned(),
        path: request.uri().path().to_owned(),
        browser: request
            .headers()
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|agent| agent.starts_with("Mozilla/")),
    };
    {
        let mut hits = context.hits.lock().unwrap_or_else(|e| e.into_inner());
        hits.push_back(hit);
        while hits.len() > HITS_KEPT {
            hits.pop_front();
        }
    }
    next.run(request).await
}

/// Redeems the handshake token, once, and sends the webview on its way with its session cookie.
async fn handshake(State(context): State<Arc<ServerContext>>, request: Request) -> Response {
    let query: HashMap<String, String> = request
        .uri()
        .query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    let session = query
        .get(gate::TOKEN_PARAM)
        .and_then(|token| context.gate.redeem(token));
    let Some(session) = session else {
        return refuse();
    };
    // Only a path on this origin: a redirect target that could leave it would be an open redirect
    // out of the app's own window.
    let to = query
        .get("to")
        .filter(|to| is_local_path(to))
        .map_or_else(|| initial_route(&context.shell).path(), String::as_str);
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    if let Ok(location) = HeaderValue::from_str(to) {
        headers.insert(header::LOCATION, location);
    }
    if let Ok(cookie) = HeaderValue::from_str(&LaunchGate::set_cookie(&session)) {
        headers.insert(header::SET_COOKIE, cookie);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn is_local_path(to: &str) -> bool {
    to.starts_with('/') && !to.starts_with("//") && !to.contains('\\') && !to.contains('\n')
}

fn refuse() -> Response {
    let mut response = Response::new(Body::from("forbidden"));
    *response.status_mut() = StatusCode::FORBIDDEN;
    response
}

/// Everything that is not the handshake: the API by mode, or the UI.
async fn dispatch(State(context): State<Arc<ServerContext>>, request: Request) -> Response {
    let path = request.uri().path();
    if path == "/api" || path.starts_with("/api/") {
        return dispatch_api(&context.shell, request).await;
    }
    if is_reserved(path) {
        // Reserved: never the SPA shell, never a bundle file.
        return not_found();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    match &context.ui {
        Ui::Assets(assets) => static_files::serve_assets(assets, path).await,
        Ui::Dev(proxy) => proxy.handle(request).await,
        Ui::None => not_found(),
    }
}

/// Whether `path` is under the reserved `/_spm` prefix, in any spelling the bundle lookup would
/// decode into it (`/%5Fspm/x`, `//_spm/x`, `/_SPM/x`).
fn is_reserved(path: &str) -> bool {
    let decoded =
        spm_http::percent::try_decode_uri_component(path).unwrap_or_else(|| path.to_owned());
    decoded
        .trim_start_matches('/')
        .split('/')
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case("_spm"))
}

fn not_found() -> Response {
    let mut response = Response::new(Body::from("not found"));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

async fn dispatch_api(shell: &Shell, request: Request) -> Response {
    let is_capabilities =
        request.method() == Method::GET && request.uri().path() == "/api/capabilities";
    if let Some(remote) = shell.remote() {
        return remote.proxy(request).await;
    }
    if let Some(session) = shell.session() {
        if is_capabilities {
            let backend = capabilities_for(&AuthMode::Local(session.ctx));
            return json(&union_capabilities(&LOCAL_SHELL_CAPABILITIES, &backend));
        }
        if let Some(router) = shell.local_router() {
            return match router.oneshot(request).await {
                Ok(response) => response,
                Err(never) => match never {},
            };
        }
    }
    if is_capabilities {
        return json(&UNSET_SHELL_CAPABILITIES);
    }
    ApiError(AppError::conflict("no library is open")).into_response()
}

fn json(capabilities: &Capabilities) -> Response {
    let mut response = Response::new(Body::from(
        serde_json::to_vec(capabilities).unwrap_or_default(),
    ));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// Headers every response gets, whoever produced it: no sniffing, no referrer, no framing, and a
/// content security policy on documents (the web bundle's, and the dev server's).
async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let is_html = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-resource-policy", "same-origin"),
    ] {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    if is_html && !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        );
    }
    response
}
