//! Remote-server mode (spec 2.6): the shell pointed at a Slicer Project Manager server instead of
//! at a folder. A port of the Electron shell's `remote.ts`, with the same reasons.
//!
//! **The webview is never navigated to the remote origin, and never learns what it is.** It stays
//! on the app's own loopback origin, uses the same same-origin `fetch` client the browser build
//! uses, and every `/api/...` request it makes is answered by this proxy, which forwards it to the
//! configured origin. The shell is a reverse proxy for one server.
//!
//! That is not indirection for its own sake. Four things make it the only workable shape (each one
//! was measured against the Electron shell, and each holds again here):
//!
//! - **The bridge.** Tauri injects `window.__TAURI_INTERNALS__` into every page a webview loads. A
//!   webview navigated to a remote origin would hand that origin the means to *ask* for desktop
//!   commands, and only the capability ACL would stand between the two. The webview stays on its
//!   own origin so the ACL has nothing to refuse.
//! - **File URLs.** The server decorates its DTOs with `/api/files/<id>/thumb`, a *relative* URL.
//!   On the app's origin that resolves to the app's origin, so those bytes have to be served from
//!   here whatever else happens.
//! - **CORS.** Fetching the remote origin directly from the app's origin is cross-origin. The
//!   server sends no CORS headers and constraint 2 forbids teaching it any. Through the proxy every
//!   request is same-origin.
//! - **The cookie.** `SameSite=Lax` drops the session cookie on a cross-site subresource request,
//!   and `Secure` (which the server sets for anything that is not plain-http localhost) is refused
//!   from a page the webview does not consider secure. A browser tab gets this for free because
//!   the page and the API share an origin; the desktop app is not a browser tab. Here the session
//!   never reaches the webview at all (see [`RemoteHost`]), so neither attribute can matter.
//!
//! Everything here is plain HTTP in and out, so `tests/remote.rs` drives all of it against a real
//! upstream server on loopback.

use std::collections::BTreeMap;
use std::sync::Mutex;

use axum::body::{Body, HttpBody};
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{Method, Request, Response, StatusCode};
use futures_util::StreamExt;
use serde_json::Value;
use spm_core::dto::Capabilities;
use spm_core::{AppError, AppErrorCode};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::capabilities::{REMOTE_SHELL_CAPABILITIES, parse_capabilities, union_capabilities};
use crate::diag;

/// Names a remote server for one launch, overriding whatever is remembered.
pub const REMOTE_URL_ENV: &str = "SPM_REMOTE_URL";

/// What the web client reaches for. Anything else is refused before a request leaves the app.
pub const API_PATH_PREFIX: &str = "/api";

/// The header a client may use to declare an upload's length (the Electron shell's workaround for
/// a renderer that could not set `content-length`). A webview's `fetch` and `XMLHttpRequest` do
/// set a real `Content-Length` for a `Blob` body and that is honoured too; this one wins when both
/// are present.
pub const UPLOAD_LENGTH_HEADER: &str = "x-spm-content-length";

/// Turns what the user typed into the origin the shell will talk to, or fails with `Validation`.
///
/// **This is untrusted input**: it arrives from the webview, through the connect command. What it
/// can do is bounded by being an *origin* and nothing else. The path, query and fragment are
/// refused rather than dropped, so `https://example.com/api/../..` cannot become a base for path
/// arithmetic later, and a user who pasted a deep link is told their URL was not what this wanted
/// rather than being silently connected somewhere else.
///
/// `http:` and `https:` only. Every other scheme is refused, including the ones that would be
/// actively dangerous to hand to an HTTP client: `file:` reads the user's disk, `data:` would make
/// the shell serve webview-supplied bytes from its own origin.
///
/// Credentials in the URL are refused rather than stripped: they would otherwise be a password the
/// shell holds and never uses, and silently dropping half of what somebody typed is worse than
/// saying no.
pub fn parse_remote_origin(raw: &str) -> Result<String, AppError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(AppError::validation("a server URL is required"));
    }
    let url = Url::parse(text).map_err(|_| AppError::validation(format!("not a URL: {text}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::validation(format!(
            "a server URL must be http or https, not {}:",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::validation(
            "a server URL must not carry a username or a password",
        ));
    }
    // `new URL('https://h/?').search` is '' (an empty query is no query), and so is `hash`.
    if url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return Err(AppError::validation(
            "a server URL must not carry a query string or a fragment",
        ));
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return Err(AppError::validation(format!(
            "a server URL must name an origin, not a path: {}",
            url.path()
        )));
    }
    // The URL parser has already normalised `/api/../..` into the bare origin, which would connect
    // somewhere other than what was typed. What was *typed* after the host must be no path at all.
    let after_scheme = text.split_once("://").map_or("", |(_, rest)| rest);
    let after_host = after_scheme
        .find(['/', '?', '#'])
        .map_or("", |end| &after_scheme[end..]);
    let typed_path = after_host.split(['?', '#']).next().unwrap_or("");
    if !(typed_path.is_empty() || typed_path == "/") {
        return Err(AppError::validation(format!(
            "a server URL must name an origin, not a path: {typed_path}"
        )));
    }
    Ok(url.origin().ascii_serialization())
}

/// Whether the session on this origin travels in the clear.
///
/// Not a refusal: a library server on a home LAN over plain http is the normal case for this app,
/// and the alternative to allowing it is that the desktop shell cannot reach the server the README
/// tells people to run. It is a warning because the *whole* exchange is readable on that network:
/// the login, the token and every model.
pub fn is_plaintext_to_another_machine(origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    !matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

/// What the shell forwards from the webview's request to the server, and nothing else.
///
/// An allow-list because the webview is the untrusted side and this is the one place its bytes
/// reach another machine. Three entries earn their place: `content-type` (the server's JSON
/// parsing reads it), `accept`, and `x-spm-file-name`, which is how an upload names its file.
///
/// `cookie`, `origin`, `referer`, `host` and `authorization` are **not** on it: the session is the
/// shell's to hold (see [`RemoteHost`]), and a server must see no `Origin` from this app, so that
/// no CORS decision is ever made on it.
const FORWARDED_REQUEST_HEADERS: [&str; 3] = ["content-type", "accept", "x-spm-file-name"];

/// Headers that describe one hop of a connection, not the message: never passed on from the server.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Headers the shell puts on every proxied response, overriding whatever the server sent.
///
/// These bytes land on the origin that holds the Tauri bridge, and their content type is chosen by
/// another machine. A hostile server answering `/api/files/<id>/raw` with `text/html` would
/// otherwise commit a document **in the app's own origin** and run its script there. `nosniff`
/// stops a boring type being upgraded into a renderable one; the `sandbox` policy is for the case
/// where the server simply says `text/html`: a document that commits under it has an opaque
/// origin, runs no script and submits no forms, so there is nothing left to reach the bridge with.
///
/// A CSP is inert on a subresource, so `fetch` and `<img src="/api/files/.../thumb">` are
/// untouched, which `tests/remote.rs` drives rather than assumes.
const FORCED_RESPONSE_HEADERS: [(&str, &str); 2] = [
    ("x-content-type-options", "nosniff"),
    ("content-security-policy", "default-src 'none'; sandbox"),
];

/// What the web client uses. Anything else is refused before a request leaves the app.
const ALLOWED_METHODS: [Method; 5] = [
    Method::GET,
    Method::POST,
    Method::PUT,
    Method::PATCH,
    Method::DELETE,
];

/// The most a capabilities answer may weigh before it is not one.
const MAX_CAPABILITIES_BYTES: usize = 1024 * 1024;

/// One remote server, its session, and the proxy that reaches it.
///
/// **Where the session lives: in this object, in the app's memory, and nowhere else.** Every
/// `Set-Cookie` the server sends is kept in the jar and replayed on later requests; the webview
/// never sees a token and cannot read one, exactly as `HttpOnly` gives a browser tab. The object
/// is dropped when the mode changes and dies with the process, so **a restart deliberately logs the
/// user out**: persisting it would put a bearer credential for a remote server on the user's disk
/// for as long as its `Max-Age`, protected by nothing this app controls. If that is later judged
/// the wrong trade, the change is to persist the jar through the OS credential store.
pub struct RemoteHost {
    origin: String,
    client: reqwest::Client,
    /// Cookie name to value, as the server last set them.
    cookies: Mutex<BTreeMap<String, String>>,
    /// Cancelled when the shell lets go of this server: aborts every request still in flight, so
    /// a request issued a moment before a mode switch cannot land afterwards and its answer cannot
    /// be handed to a page that is about to be replaced. It is also the only bound this proxy
    /// places on an upstream that accepts a request and never answers.
    in_flight: CancellationToken,
}

impl RemoteHost {
    /// A host for `origin`, which must already be an origin ([`parse_remote_origin`]).
    pub fn new(origin: &str) -> RemoteHost {
        let client = reqwest::Client::builder()
            // A redirect is refused, and named, by `send`; following one would leave the origin
            // the user named.
            .redirect(reqwest::redirect::Policy::none())
            // The OS proxy settings are not this app's to consult: the user named a server.
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        RemoteHost {
            origin: origin.to_owned(),
            client,
            cookies: Mutex::new(BTreeMap::new()),
            in_flight: CancellationToken::new(),
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Whether a session is being carried right now.
    pub fn has_session(&self) -> bool {
        !self.jar().is_empty()
    }

    fn jar(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, String>> {
        self.cookies.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether [`RemoteHost::close`] has been called.
    pub fn is_closed(&self) -> bool {
        self.in_flight.is_cancelled()
    }

    /// Lets go of the server, and of the session with it.
    ///
    /// Called when the shell changes mode. Clearing the cookies is the point: without it a host
    /// that something still held a reference to would go on being able to act as the logged-in
    /// user. A late call then fails loudly (503) rather than reaching the server out of a mode the
    /// shell has left.
    pub fn close(&self) {
        self.in_flight.cancel();
        self.jar().clear();
    }

    /// Answers one `/api/...` request out of the remote server.
    ///
    /// The path is taken from the request and appended to the configured origin, and **every
    /// response the webview sees comes from that origin on a path under `/api`**. Two separate
    /// things hold that up: a path with a dot segment (in any spelling) is refused, and the URL
    /// the request is turned into is checked to still be under `/api` on the same origin;
    /// **redirects are not followed** (see [`RemoteHost::send`]), without which the confinement
    /// would be true of the first hop only.
    pub async fn proxy(&self, request: Request<Body>) -> Response<Body> {
        if self.is_closed() {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                AppErrorCode::Internal,
                "the server connection has been closed",
            );
        }
        let path = request.uri().path().to_owned();
        if !path.starts_with("/api/") || has_dot_segment(&path) {
            return failure(
                StatusCode::NOT_FOUND,
                AppErrorCode::NotFound,
                &format!("no such path: {path}"),
            );
        }
        if !ALLOWED_METHODS.contains(request.method()) {
            return failure(
                StatusCode::METHOD_NOT_ALLOWED,
                AppErrorCode::Validation,
                &format!("{} is not allowed", request.method()),
            );
        }
        let is_capabilities = request.method() == Method::GET && path == "/api/capabilities";
        let response = self.send(request).await;
        if is_capabilities && response.status() == StatusCode::OK {
            return self.unioned(response).await;
        }
        response
    }

    /// The union, as a value rather than a response: the shell's remote column over whatever the
    /// server says.
    ///
    /// Fails rather than degrading when the server will not answer: the web app's store already
    /// falls back to the most restrictive set, and inventing `requiresAuth: false` for a server
    /// that is merely unreachable would walk the user into an app where every call fails.
    pub async fn capabilities(&self) -> Result<Capabilities, AppError> {
        let request = Request::get("/api/capabilities")
            .body(Body::empty())
            .map_err(AppError::internal)?;
        let response = self.proxy(request).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), MAX_CAPABILITIES_BYTES)
            .await
            .unwrap_or_default();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status != StatusCode::OK || parse_capabilities(&body).is_none() {
            return Err(AppError::new(
                AppErrorCode::Internal,
                format!("{} did not answer with its capabilities", self.origin),
            ));
        }
        // `proxy` already unioned it.
        parse_capabilities(&body).ok_or_else(|| AppError::internal("unreachable"))
    }

    /// Spec 2.4's union, applied where the webview cannot skip it.
    ///
    /// The web app runs its same-origin client unchanged, so `capabilities()` is a plain
    /// `GET /api/capabilities` and whatever comes back is what the whole UI keys off. Doing the
    /// union in the page would mean a desktop-only wrapper around a client the spec says to use as
    /// it is; doing it here means the shell's column is added by the only process that knows what
    /// shell this is.
    ///
    /// A backend that answers something that is not a capability set is passed through untouched
    /// rather than unioned with a guess: inventing flags out of a proxy's error page would light up
    /// UI on the strength of a 200 from something that is not this server.
    async fn unioned(&self, response: Response<Body>) -> Response<Body> {
        let (mut parts, body) = response.into_parts();
        let Ok(bytes) = axum::body::to_bytes(body, MAX_CAPABILITIES_BYTES).await else {
            return failure(
                StatusCode::BAD_GATEWAY,
                AppErrorCode::Internal,
                &format!(
                    "{} answered /api/capabilities with something too large",
                    self.origin
                ),
            );
        };
        let backend = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| parse_capabilities(&value));
        let Some(backend) = backend else {
            diag::warn("the remote server answered /api/capabilities with something else");
            parts.headers.remove(header::CONTENT_LENGTH);
            return Response::from_parts(parts, Body::from(bytes));
        };
        let merged = union_capabilities(&REMOTE_SHELL_CAPABILITIES, &backend);
        let json = serde_json::to_vec(&merged).unwrap_or_default();
        parts.headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        parts
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from(json.len()));
        // `parts.headers` is what `forward` already produced, so it carries the forced pair.
        Response::from_parts(parts, Body::from(json))
    }

    async fn send(&self, request: Request<Body>) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let target = format!(
            "{}{}",
            self.origin,
            parts.uri.path_and_query().map_or("", |pq| pq.as_str())
        );
        // The confinement, checked on the URL that will actually be requested: parsing normalises
        // what string checks can miss.
        let confined = Url::parse(&target).ok().filter(|url| {
            url.origin().ascii_serialization() == self.origin && url.path().starts_with("/api/")
        });
        let Some(url) = confined else {
            return failure(
                StatusCode::NOT_FOUND,
                AppErrorCode::NotFound,
                &format!("no such path: {}", parts.uri.path()),
            );
        };

        let mut headers = reqwest::header::HeaderMap::new();
        for name in FORWARDED_REQUEST_HEADERS {
            if let Some(value) = parts.headers.get(name) {
                headers.insert(HeaderName::from_static(name), value.clone());
            }
        }
        // Only where there is a body to measure. A length on a GET would otherwise become a
        // `content-length` describing a body that is not there.
        let has_body = parts.method != Method::GET
            && !HttpBody::is_end_stream(&body)
            && HttpBody::size_hint(&body).exact() != Some(0);
        let declared = has_body
            .then(|| declared_upload_length(&parts.headers))
            .flatten();
        // Without a length an upload reaches the server as `Transfer-Encoding: chunked`, and the
        // server refuses a body with no length with 411 before it writes a byte. The length the
        // client already knows becomes the real one here.
        if let Some(length) = declared {
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
        }
        if let Some(cookie) = self.cookie_header()
            && let Ok(value) = HeaderValue::from_str(&cookie)
        {
            headers.insert(header::COOKIE, value);
        }

        let mut upstream = self
            .client
            .request(parts.method.clone(), url)
            .headers(headers);
        if has_body {
            // Streamed, never buffered: an upload may be a whole CuraManager archive, and the
            // shell holding a copy of it in memory to count its bytes would be a worse answer than
            // the 411 the header above avoids.
            upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
        }

        let sent = tokio::select! {
            biased;
            () = self.in_flight.cancelled() => Err("the connection to the server was closed".to_owned()),
            result = upstream.send() => result.map_err(|error| error_chain(&error)),
        };
        let response = match sent {
            Ok(response) => response,
            Err(detail) => {
                // The server is not there, the name does not resolve, TLS failed, or the shell
                // let go of it. It reaches the UI as an error with a code like every other
                // failure, naming the server.
                return failure(
                    StatusCode::BAD_GATEWAY,
                    AppErrorCode::Internal,
                    &format!("could not reach {}: {detail}", self.origin),
                );
            }
        };
        // The refusal comes first: taking a `Set-Cookie` off a response this proxy is about to
        // reject sits oddly beside "nothing else is fetched".
        if is_redirect(response.status().as_u16()) {
            return self.refuse_redirect(&response);
        }
        self.absorb_cookies(&response);
        self.forward(response)
    }

    /// A redirect is refused, and named, rather than followed or passed on.
    ///
    /// Refused because following it leaves the origin the user named: measured against the
    /// Electron shell, a `302 Location: http://127.0.0.1:<other>/...` was fetched by default and
    /// handed back with status 200, a general read primitive for whatever the page could get the
    /// shell pointed at, wearing the configured server's identity. Not passed on either: the
    /// page's own `fetch` would follow it, and a `Location` on another origin is then a request
    /// from the page to that origin, the same escape one layer out.
    ///
    /// The message names the target because the one legitimate way to meet this is a reverse
    /// proxy redirecting `http://host` to `https://host`. It is a diagnostic (logged here and in
    /// the page's console), not a dialog.
    fn refuse_redirect(&self, response: &reqwest::Response) -> Response<Body> {
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("somewhere else")
            .to_owned();
        diag::warn(&format!(
            "refused a redirect from {} to {location}",
            self.origin
        ));
        failure(
            StatusCode::BAD_GATEWAY,
            AppErrorCode::Internal,
            &format!(
                "{} redirected to {location}; this app talks to one server and does not follow \
                 redirects. Use that address directly if it is the right one.",
                self.origin
            ),
        )
    }

    /// Hands the server's answer to the webview, with two headers the server does not get a say
    /// in, and without the server's cookies.
    ///
    /// The body is passed through undecoded (no decompression is enabled on the client and no
    /// `accept-encoding` is sent), so a `content-length` or `content-encoding` the server chose
    /// still describes the bytes. The Electron shell dropped both because `fetch` had decoded the
    /// body; here nothing has.
    fn forward(&self, response: reqwest::Response) -> Response<Body> {
        let status = response.status();
        let mut headers = response.headers().clone();
        headers.remove(header::SET_COOKIE);
        for name in HOP_BY_HOP {
            headers.remove(name);
        }
        let cancelled = self.in_flight.clone();
        // Ends the body the moment the shell lets go of the server, rather than streaming on from
        // a server it has left.
        let stream = response
            .bytes_stream()
            .take_until(async move { cancelled.cancelled().await });
        let mut out = Response::new(Body::from_stream(stream));
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        for (name, value) in FORCED_RESPONSE_HEADERS {
            out.headers_mut().insert(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        out
    }

    fn cookie_header(&self) -> Option<String> {
        let jar = self.jar();
        if jar.is_empty() {
            return None;
        }
        Some(
            jar.iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    /// Takes whatever the server set, by name, rather than knowing the session cookie's name.
    ///
    /// A jar keyed on whatever arrives needs no copy of the server's constant and survives the
    /// server adding a second cookie. `Path` and `Domain` are ignored on purpose: there is exactly
    /// one origin and every request this proxy makes is under `/api`, so there is no second scope
    /// for a cookie to belong to. `Secure` and `SameSite` are never consulted either, because the
    /// cookie is replayed only to the one origin it came from and never reaches the webview.
    fn absorb_cookies(&self, response: &reqwest::Response) {
        for line in response.headers().get_all(header::SET_COOKIE) {
            let Ok(line) = line.to_str() else { continue };
            let mut parts = line.split(';');
            let Some(pair) = parts.next() else { continue };
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            if name.is_empty() {
                continue;
            }
            // A logout is spelled as an empty value *and* `Max-Age=0`; either on its own is the
            // same instruction, so either deletes.
            let expired = parts.any(|attribute| attribute.trim().eq_ignore_ascii_case("max-age=0"));
            let mut jar = self.jar();
            if value.is_empty() || expired {
                jar.remove(name);
            } else {
                jar.insert(name.to_owned(), value.to_owned());
            }
        }
    }
}

/// Whether a status is a redirect this proxy must refuse.
///
/// **304 is excluded, and it is the reason this is a function rather than a range check.** `Not
/// Modified` shares the 3xx band and is not a redirect at all: it carries no `Location`, and
/// reporting it as "redirected to somewhere else" would be a confusing 502 for a perfectly
/// ordinary conditional response.
pub fn is_redirect(status: u16) -> bool {
    (300..400).contains(&status) && status != 304
}

/// The length the client declared for an upload body, or `None`.
///
/// Validated rather than forwarded: a value that is not a plain run of digits would reach the
/// HTTP client as a `content-length` it rejects, and the failure would surface as an opaque proxy
/// error rather than as the malformed header it is. A body whose real length disagrees with this
/// fails the request (a 502), and the only party that can lie here is the client, about its own
/// upload.
pub fn declared_upload_length(headers: &axum::http::HeaderMap) -> Option<u64> {
    let digits = |name: &str| {
        let raw = headers.get(name)?.to_str().ok()?;
        (!raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| raw.parse::<u64>().ok())
            .flatten()
    };
    digits(UPLOAD_LENGTH_HEADER).or_else(|| digits("content-length"))
}

/// Whether any segment of `path` is `.` or `..`, in any spelling a URL parser would normalise
/// (`%2e`, `%2E`).
pub fn has_dot_segment(path: &str) -> bool {
    path.split('/').any(|segment| {
        let lowered = segment.to_ascii_lowercase().replace("%2e", ".");
        lowered == "." || lowered == ".."
    }) || path.contains('\\')
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// The app's own error envelope, so a failure the shell invents keeps its identity too. The same
/// two headers `forward` forces ride on it: these bodies are the shell's own and could not be made
/// renderable, but a reader comparing the two paths should not have to work out why one is
/// protected and the other is not.
pub fn failure(status: StatusCode, code: AppErrorCode, message: &str) -> Response<Body> {
    let envelope = AppError::new(code, message).to_envelope();
    let body = serde_json::to_vec(&envelope).unwrap_or_default();
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    for (name, value) in FORCED_RESPONSE_HEADERS {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    response
}
