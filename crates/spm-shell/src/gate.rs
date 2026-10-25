//! The per-launch secret: what keeps every other process on this machine out of the API.
//!
//! The loopback listener is reachable by anything that can open a TCP connection to
//! `127.0.0.1:<port>`: another user's process, a browser tab on any origin, malware. In local
//! folder mode the router behind it authenticates *nobody* (there is one user and no login), so
//! without this gate the library would be open to all of them.
//!
//! How it works:
//!
//! 1. At launch the app mints a **handshake token**: 32 random bytes, hex, single use. It is the
//!    secret. The app hands it to its own webview inside the first URL it loads
//!    (`/_spm/handshake?k=<token>`), and nowhere else.
//! 2. Redeeming it (once) answers `303` with a **session cookie** (`HttpOnly`, `SameSite=Strict`,
//!    a second random value) and sends the webview on to the page. The token is spent, so a
//!    process that later learns the URL (from browser history, say) can do nothing with it.
//! 3. Every other request must carry that cookie. Anything without it is a bare `403`.
//!
//! Two more checks close what a cookie alone leaves open. Cookies are scoped by *host*, not port,
//! and `SameSite` treats two ports on `127.0.0.1` as the same site, so a page served by some other
//! local process could send our cookie. Browsers always send `Origin` on a cross-origin request
//! that can change anything, and `Sec-Fetch-Site` on every request: a request whose `Origin` is
//! not this app's, or whose `Sec-Fetch-Site` says it came from another origin, is refused. And the
//! `Host` header must be exactly this listener's, which defeats DNS rebinding.

use std::collections::VecDeque;
use std::sync::Mutex;

use axum::extract::{Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

/// The path the handshake token is redeemed at. Reserved: nothing else lives under `/_spm/`.
pub const HANDSHAKE_PATH: &str = "/_spm/handshake";
/// The name of the session cookie.
pub const COOKIE_NAME: &str = "spm_launch";
/// The query parameter the token travels in.
pub const TOKEN_PARAM: &str = "k";

/// How many unspent tokens and live sessions are kept; the oldest goes first. A launch makes a
/// handful at most (one per window load).
const KEEP: usize = 16;

pub struct LaunchGate {
    /// `127.0.0.1:<port>`, the only `Host` this listener answers to.
    authority: String,
    tokens: Mutex<VecDeque<String>>,
    sessions: Mutex<VecDeque<String>>,
}

fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    // A system that cannot give random bytes cannot give a secret either: refuse to run rather
    // than mint something guessable.
    getrandom::fill(&mut bytes).expect("the operating system provides random bytes");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn matches_any(set: &VecDeque<String>, candidate: &str) -> Option<usize> {
    // Constant time per comparison, and every entry is compared: how early a match is found must
    // not be observable.
    let mut found = None;
    for (index, known) in set.iter().enumerate() {
        if known.as_bytes().ct_eq(candidate.as_bytes()).into() {
            found = Some(index);
        }
    }
    found
}

impl LaunchGate {
    /// A gate for the listener at `authority` (`127.0.0.1:<port>`).
    pub fn new(authority: impl Into<String>) -> LaunchGate {
        LaunchGate {
            authority: authority.into(),
            tokens: Mutex::new(VecDeque::new()),
            sessions: Mutex::new(VecDeque::new()),
        }
    }

    pub fn authority(&self) -> &str {
        &self.authority
    }

    pub fn origin(&self) -> String {
        format!("http://{}", self.authority)
    }

    /// Mints a fresh, single-use handshake token.
    pub fn mint_token(&self) -> String {
        let token = random_hex();
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.push_back(token.clone());
        while tokens.len() > KEEP {
            tokens.pop_front();
        }
        token
    }

    /// The URL that logs the app's own webview in: `redirect_to` is where it lands afterwards.
    pub fn handshake_url(&self, redirect_to: &str) -> String {
        let token = self.mint_token();
        format!(
            "{}{HANDSHAKE_PATH}?{TOKEN_PARAM}={token}&to={}",
            self.origin(),
            redirect_to.replace('%', "%25").replace('&', "%26")
        )
    }

    /// Spends `token` and returns the session cookie value, or `None` if it was never minted or is
    /// spent already.
    pub fn redeem(&self, token: &str) -> Option<String> {
        {
            let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
            let index = matches_any(&tokens, token)?;
            tokens.remove(index);
        }
        let session = random_hex();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.push_back(session.clone());
        while sessions.len() > KEEP {
            sessions.pop_front();
        }
        Some(session)
    }

    /// Whether `value` is a live session cookie.
    pub fn is_session(&self, value: &str) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        matches_any(&sessions, value).is_some()
    }

    /// The `Set-Cookie` value for a session.
    pub fn set_cookie(session: &str) -> String {
        format!("{COOKIE_NAME}={session}; Path=/; HttpOnly; SameSite=Strict")
    }

    /// Whether the request is from this app's own origin and host (everything but the cookie).
    fn is_own_request(&self, headers: &HeaderMap) -> bool {
        let header_is = |name: header::HeaderName, expected: &str| {
            headers
                .get(name)
                .is_none_or(|value| value.as_bytes() == expected.as_bytes())
        };
        // `Host` is required: HTTP/1.1 clients always send it, and one that does not is not the
        // webview.
        let host_ok = headers
            .get(header::HOST)
            .is_some_and(|value| value.as_bytes() == self.authority.as_bytes());
        let origin_ok = header_is(header::ORIGIN, &self.origin());
        let fetch_site_ok = headers
            .get("sec-fetch-site")
            .is_none_or(|value| matches!(value.as_bytes(), b"same-origin" | b"none"));
        host_ok && origin_ok && fetch_site_ok
    }

    /// Whether the request carries a live session cookie.
    fn has_session(&self, headers: &HeaderMap) -> bool {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|line| line.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .any(|(name, value)| name == COOKIE_NAME && self.is_session(value))
    }
}

fn forbidden() -> Response {
    let mut response = Response::new(axum::body::Body::from("forbidden"));
    *response.status_mut() = StatusCode::FORBIDDEN;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The middleware every request passes through, before anything else looks at it.
pub async fn gate_layer(
    State(gate): State<std::sync::Arc<LaunchGate>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if !gate.is_own_request(headers) {
        return forbidden();
    }
    // The handshake is the one door without a cookie: it is where the cookie comes from. Its
    // handler redeems the token and refuses everything else.
    let is_handshake = request.uri().path() == HANDSHAKE_PATH;
    if !is_handshake && !gate.has_session(headers) {
        return forbidden();
    }
    next.run(request).await
}
