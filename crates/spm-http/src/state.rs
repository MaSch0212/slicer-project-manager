//! What the router needs to answer a request, and the knobs a host turns.

use std::path::PathBuf;
use std::sync::Arc;

use spm_core::dto::Capabilities;
use spm_core::{Ctx, Library, Logger};

use crate::dev_proxy::DevProxy;
use crate::rate_limit::RateLimiter;
use crate::static_files::{Assets, DirAssets};

/// A clock reading in epoch milliseconds. Only the rate limiter reads it; tests substitute one
/// they can advance.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// How a request becomes a user.
#[derive(Debug, Clone)]
pub enum AuthMode {
    /// The server: a login, a session cookie, and `requiresAuth: true`. Anything outside the
    /// public routes without a live session is a 401.
    Sessions,
    /// The desktop's local folder: exactly one user, no login, no session. Every request is that
    /// user (`spm_core::ensure_local_user` makes the `Ctx`), `requiresAuth` and `canManageUsers`
    /// are `false`, and the login, activation and user-administration routes do not exist.
    ///
    /// Nothing authenticates the caller in this mode: whoever can reach the router is the user.
    /// The host that mounts it on a socket is responsible for who that is (the desktop app binds
    /// `127.0.0.1` behind a per-launch secret).
    Local(Ctx),
}

/// Where non-API requests are answered from.
#[derive(Clone)]
pub enum UiSource {
    /// Nothing: every non-API request is a 404.
    None,
    /// A built bundle in a directory (`SPM_WEB_ROOT`).
    Dir(PathBuf),
    /// A bundle from any [`Assets`] source, such as files compiled into the binary.
    Assets(Arc<dyn Assets>),
    /// Development only: forward to a running Vite dev server.
    DevProxy(DevProxy),
}

/// Everything a host chooses. `Default` is the NAS server with no UI.
#[derive(Clone)]
pub struct HttpOptions {
    pub auth: AuthMode,
    /// The origin activation links are built on (`SPM_PUBLIC_ORIGIN`), already normalised with
    /// [`crate::normalize_public_origin`]. `None` uses the request's own origin.
    pub public_origin: Option<String>,
    pub ui: UiSource,
    /// Defaults to the library's own logger, which is silent unless the host configured one.
    pub logger: Option<Logger>,
    /// Defaults to the system clock.
    pub clock: Option<Clock>,
}

impl Default for HttpOptions {
    fn default() -> Self {
        HttpOptions {
            auth: AuthMode::Sessions,
            public_origin: None,
            ui: UiSource::None,
            logger: None,
            clock: None,
        }
    }
}

/// The capabilities this backend contributes. A shell adds its own (picking a folder, launching a
/// slicer, ...) and the client uses the union (parent spec 2.4).
pub fn capabilities_for(auth: &AuthMode) -> Capabilities {
    let sessions = matches!(auth, AuthMode::Sessions);
    Capabilities {
        requires_auth: sessions,
        can_manage_users: sessions,
        can_pick_local_folder: false,
        can_launch_slicer: false,
        can_configure_slicers: false,
        can_browse_model_sites: false,
    }
}

pub(crate) struct Inner {
    pub lib: Library,
    pub log: Logger,
    pub auth: AuthMode,
    pub public_origin: Option<String>,
    pub ui: UiSource,
    /// `ui` as an asset source, built once rather than per request.
    pub assets: Option<Arc<dyn Assets>>,
    pub limiter: RateLimiter,
    pub clock: Clock,
    pub capabilities: Capabilities,
}

/// The router's shared state: cheap to clone, `Send + Sync`.
#[derive(Clone)]
pub struct AppState {
    pub(crate) inner: Arc<Inner>,
}

impl AppState {
    pub fn new(lib: Library, options: HttpOptions) -> AppState {
        let log = options.logger.unwrap_or_else(|| lib.log().clone());
        let clock = options
            .clock
            .unwrap_or_else(|| Arc::new(spm_core::clock::now_ms));
        let capabilities = capabilities_for(&options.auth);
        let assets = options.ui.assets();
        AppState {
            inner: Arc::new(Inner {
                lib,
                log,
                auth: options.auth,
                public_origin: options.public_origin,
                ui: options.ui,
                assets,
                limiter: RateLimiter::new(),
                clock,
                capabilities,
            }),
        }
    }

    pub fn lib(&self) -> &Library {
        &self.inner.lib
    }

    pub fn log(&self) -> &Logger {
        &self.inner.log
    }

    pub(crate) fn now(&self) -> i64 {
        (self.inner.clock)()
    }

    pub(crate) fn sessions(&self) -> bool {
        matches!(self.inner.auth, AuthMode::Sessions)
    }
}

impl UiSource {
    /// A directory bundle, made absolute against the current directory the way `SPM_WEB_ROOT` is.
    pub fn dir(path: impl Into<PathBuf>) -> UiSource {
        let path = path.into();
        UiSource::Dir(std::path::absolute(&path).unwrap_or(path))
    }

    pub(crate) fn assets(&self) -> Option<Arc<dyn Assets>> {
        match self {
            UiSource::Dir(path) => Some(Arc::new(DirAssets::new(path.clone()))),
            UiSource::Assets(assets) => Some(Arc::clone(assets)),
            UiSource::None | UiSource::DevProxy(_) => None,
        }
    }
}
