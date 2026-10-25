//! A temporary library behind the real router, driven in-process.
//!
//! `tower::ServiceExt::oneshot` runs the same router and the same middleware a socket would, minus
//! the socket. The things a socket changes (the peer address, a body that arrives in frames) are
//! supplied explicitly: [`Req::ip`] injects the peer address the way `into_make_service_with_
//! connect_info` does, and [`Req::stream`] sends a body with no `content-length`. The tests that
//! need a real socket (`wire.rs`, `dev_proxy.rs`) bind one.

#![allow(dead_code)]

pub mod fixtures;

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode};
use serde_json::Value;
use spm_core::testing::{LogCapture, TempLibrary};
use spm_core::{Library, ensure_bootstrap_admin};
use spm_http::{AppState, AuthMode, DevProxy, HttpOptions, UiSource, router};
use tower::ServiceExt;

pub const PASSWORD: &str = "a good long password";

/// What a test chooses about the server it gets.
#[derive(Default)]
pub struct Setup {
    pub logging: bool,
    pub public_origin: Option<String>,
    pub ui: Option<UiSource>,
    /// Forward non-API requests to this dev-server origin.
    pub proxy: Option<String>,
    pub local: bool,
}

pub struct TestServer {
    pub library: TempLibrary,
    pub router: Router,
    pub state: AppState,
    pub logs: LogCapture,
    pub bootstrap_token: Option<String>,
    clock: Arc<AtomicI64>,
}

impl TestServer {
    pub fn new() -> TestServer {
        TestServer::with(Setup::default())
    }

    pub fn with(setup: Setup) -> TestServer {
        let (library, logs) = if setup.logging {
            TempLibrary::logged()
        } else {
            (TempLibrary::new(), LogCapture::default())
        };
        let lib: Library = (*library).clone();
        let (auth, bootstrap_token) = if setup.local {
            let ctx = spm_core::ensure_local_user(&lib).expect("the local user is created");
            (AuthMode::Local(ctx), None)
        } else {
            let boot = ensure_bootstrap_admin(&lib)
                .expect("bootstrap runs")
                .expect("an empty library gets a bootstrap admin");
            (AuthMode::Sessions, Some(boot.token))
        };
        let clock = Arc::new(AtomicI64::new(spm_core::clock::now_ms()));
        let clock_for_state = Arc::clone(&clock);
        let lib_log = lib.log().clone();
        let state = AppState::new(
            lib,
            HttpOptions {
                auth,
                public_origin: setup.public_origin,
                ui: match setup.proxy {
                    Some(origin) => UiSource::DevProxy(DevProxy::new(origin, lib_log)),
                    None => setup.ui.unwrap_or(UiSource::None),
                },
                logger: None,
                clock: Some(Arc::new(move || clock_for_state.load(Ordering::SeqCst))),
            },
        );
        let router = router(state.clone());
        TestServer {
            library,
            router,
            state,
            logs,
            bootstrap_token,
            clock,
        }
    }

    pub fn lib(&self) -> &Library {
        &self.library
    }

    pub fn dir(&self) -> &std::path::Path {
        self.library.dir()
    }

    /// Moves the rate limiter's clock forward without sleeping.
    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub async fn fetch(&self, path: &str, req: Req) -> Reply {
        let mut request = req.build(path);
        // The peer address a listener with connect info would have recorded.
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0);
        if peer.is_none() {
            request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                0,
            )));
        }
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        Reply::from(response).await
    }

    pub async fn get(&self, path: &str) -> Reply {
        self.fetch(path, Req::get()).await
    }

    /// Activates the bootstrap admin and returns a usable `Cookie` header value.
    pub async fn login_as_admin(&self) -> String {
        let token = self
            .bootstrap_token
            .clone()
            .expect("a sessions-mode server has a bootstrap token");
        let reply = self
            .fetch(
                &format!("/api/auth/activation/{token}"),
                Req::post().json(&serde_json::json!({ "password": PASSWORD, "confirm": PASSWORD })),
            )
            .await;
        assert_eq!(reply.status, 200, "activation failed: {}", reply.text());
        reply.cookie().expect("activation sets a cookie")
    }

    /// Creates a user as the admin, activates them, and returns their `Cookie` value.
    pub async fn create_active_user(&self, admin_cookie: &str, username: &str) -> (String, Value) {
        let created = self
            .fetch(
                "/api/users",
                Req::post()
                    .cookie(admin_cookie)
                    .json(&serde_json::json!({ "username": username, "displayName": username })),
            )
            .await;
        assert_eq!(created.status, 200, "{}", created.text());
        let body = created.json();
        let url = body["activationUrl"].as_str().unwrap();
        let token = url.split('#').nth(1).unwrap();
        let activated = self
            .fetch(
                &format!("/api/auth/activation/{token}"),
                Req::post().json(&serde_json::json!({
                    "password": "another long password",
                    "confirm": "another long password",
                })),
            )
            .await;
        assert_eq!(activated.status, 200, "{}", activated.text());
        (activated.cookie().unwrap(), body)
    }

    /// Creates a project as `cookie` and returns its JSON.
    pub async fn new_project(&self, cookie: &str, name: &str) -> Value {
        let reply = self
            .fetch(
                "/api/projects",
                Req::post()
                    .cookie(cookie)
                    .json(&serde_json::json!({ "name": name })),
            )
            .await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        reply.json()
    }
}

pub struct Req {
    method: Method,
    cookie: Option<String>,
    ip: Option<IpAddr>,
    headers: Vec<(String, String)>,
    body: ReqBody,
    host: Option<String>,
}

enum ReqBody {
    Empty,
    Bytes(Vec<u8>),
    Stream(Vec<Vec<u8>>),
}

impl Req {
    fn new(method: Method) -> Req {
        Req {
            method,
            cookie: None,
            ip: None,
            headers: Vec::new(),
            body: ReqBody::Empty,
            host: Some("localhost".to_owned()),
        }
    }

    pub fn get() -> Req {
        Req::new(Method::GET)
    }
    pub fn post() -> Req {
        Req::new(Method::POST)
    }
    pub fn patch() -> Req {
        Req::new(Method::PATCH)
    }
    pub fn put() -> Req {
        Req::new(Method::PUT)
    }
    pub fn delete() -> Req {
        Req::new(Method::DELETE)
    }

    pub fn cookie(mut self, cookie: &str) -> Req {
        self.cookie = Some(cookie.to_owned());
        self
    }

    pub fn ip(mut self, ip: &str) -> Req {
        self.ip = Some(ip.parse().expect("an IP address"));
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Req {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn host(mut self, host: Option<&str>) -> Req {
        self.host = host.map(str::to_owned);
        self
    }

    pub fn json(mut self, value: &Value) -> Req {
        self.headers
            .push(("content-type".into(), "application/json".into()));
        self.body = ReqBody::Bytes(serde_json::to_vec(value).unwrap());
        self
    }

    /// A raw body with its `content-length` set, as a client library does for a known-size body.
    pub fn bytes(mut self, bytes: impl Into<Vec<u8>>) -> Req {
        self.body = ReqBody::Bytes(bytes.into());
        self
    }

    /// A body sent in frames with no `content-length`: what a chunked upload looks like.
    pub fn stream(mut self, chunks: Vec<Vec<u8>>) -> Req {
        self.body = ReqBody::Stream(chunks);
        self
    }

    fn build(self, path: &str) -> Request<Body> {
        let mut builder = Request::builder().method(self.method).uri(path);
        if let Some(host) = &self.host {
            builder = builder.header(HOST, host.as_str());
        }
        if let Some(cookie) = &self.cookie {
            builder = builder.header(COOKIE, cookie.as_str());
        }
        let explicit_length = self
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-length"));
        for (name, value) in &self.headers {
            builder = builder.header(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        let body = match self.body {
            ReqBody::Empty => Body::empty(),
            ReqBody::Bytes(bytes) => {
                // Constructing a request in-process does not add content-length from the body the
                // way a client crossing a network does, so do it here; an explicit header still
                // wins, so a test can assert on a deliberately wrong one.
                if !explicit_length {
                    builder = builder.header(CONTENT_LENGTH, bytes.len());
                }
                Body::from(bytes)
            }
            ReqBody::Stream(chunks) => Body::from_stream(futures_util::stream::iter(
                chunks
                    .into_iter()
                    .map(|chunk| Ok::<_, Infallible>(Bytes::from(chunk))),
            )),
        };
        let mut request = builder.body(body).unwrap();
        if let Some(ip) = self.ip {
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::new(ip, 0)));
        }
        request
    }
}

pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    async fn from(response: axum::response::Response) -> Reply {
        let (parts, body) = response.into_parts();
        let body = to_bytes(body, usize::MAX).await.expect("the body reads");
        Reply {
            status: parts.status.as_u16(),
            headers: parts.headers,
            body: body.to_vec(),
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("not JSON ({error}): {}", self.text()))
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    pub fn set_cookie(&self) -> Option<String> {
        self.headers
            .get(SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    /// The `name=value` half of `Set-Cookie`, as a client would send it back.
    pub fn cookie(&self) -> Option<String> {
        self.set_cookie()
            .map(|cookie| cookie.split(';').next().unwrap().to_owned())
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap().to_owned()
    }

    pub fn is(&self, status: StatusCode) -> bool {
        self.status == status.as_u16()
    }

    pub fn content_type(&self) -> Option<String> {
        self.headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }
}

/// Serves `router` on a loopback port with connect info, the way `spm-server` does, and returns
/// the address. The task ends with the test's runtime.
pub async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    address
}

impl TestServer {
    /// GET `path` as `cookie` and parse the JSON body.
    pub async fn get_json_with_cookie(&self, path: &str, cookie: &str) -> Value {
        let reply = self.fetch(path, Req::get().cookie(cookie)).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        reply.json()
    }
}
