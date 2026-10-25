//! The REST API (parent spec 4.3). One module per resource; every handler is a thin shell that
//! extracts, calls a core use case on the blocking pool, and shapes the answer.

use axum::Router;
use axum::extract::{Request, State};
use axum::middleware;
use axum::response::{IntoResponse, Response};

use crate::dev_proxy::DevProxy;
use crate::error::{ApiError, method_not_allowed};
use crate::logging::request_log;
use crate::state::{AppState, UiSource};
use crate::static_files::{not_found, serve_assets};

mod account;
mod auth;
mod capabilities;
mod files;
mod import;
mod projects;
mod users;

pub use files::UPLOAD_NAME_HEADER;
pub use import::MAX_ARCHIVE_BYTES;

/// The HTTP router over a library.
///
/// The same router serves the NAS binary and the desktop app's in-process listener: build an
/// [`AppState`] (a library, an [`crate::AuthMode`], where the UI comes from) and mount the result.
/// For per-client rate limiting, serve it with
/// `router(state).into_make_service_with_connect_info::<SocketAddr>()`; the limiter keys on the
/// TCP peer address and on nothing a client can set.
pub fn router(state: AppState) -> Router {
    let mut api = Router::new()
        .merge(capabilities::routes())
        .merge(account::routes(&state))
        .merge(projects::routes())
        .merge(files::routes())
        .merge(import::routes(&state));
    if state.sessions() {
        // Local mode has one user and no passwords: nothing to sign in to, nothing to administer.
        api = api.merge(auth::routes(&state)).merge(users::routes());
    }
    api.method_not_allowed_fallback(|| async { method_not_allowed() })
        .fallback(fallback)
        .layer(middleware::from_fn_with_state(state.clone(), request_log))
        .with_state(state)
}

/// Everything no route claimed: an unknown `/api/` path is a 404 with the error envelope,
/// anything else is the UI.
async fn fallback(State(state): State<AppState>, request: Request) -> Response {
    if request.uri().path().starts_with("/api/") {
        return ApiError(spm_core::AppError::not_found("no such endpoint")).into_response();
    }
    match &state.inner.ui {
        UiSource::DevProxy(proxy) => DevProxy::handle(proxy, request).await,
        _ => match &state.inner.assets {
            Some(assets) => serve_assets(assets, request.uri().path()).await,
            None => not_found(),
        },
    }
}

/// Wraps a route so each client address gets `rule` for it. The key is the route's registered
/// pattern (`key`), not the concrete URL: every distinct activation token would otherwise get its
/// own fresh budget and the limit would do nothing. Runs before authentication and body parsing,
/// as the legacy router did.
pub(crate) fn limited(
    route: axum::routing::MethodRouter<AppState>,
    state: &AppState,
    key: &'static str,
    rule: crate::rate_limit::RateLimitRule,
) -> axum::routing::MethodRouter<AppState> {
    route.route_layer(middleware::from_fn_with_state(
        (state.clone(), key, rule),
        rate_limit_layer,
    ))
}

async fn rate_limit_layer(
    State((state, key, rule)): State<(AppState, &'static str, crate::rate_limit::RateLimitRule)>,
    request: Request,
    next: middleware::Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map_or_else(|| "unknown".to_owned(), |info| info.0.ip().to_string());
    match state
        .inner
        .limiter
        .check(&format!("{peer}|{key}"), rule, state.now())
    {
        Ok(()) => next.run(request).await,
        Err(error) => ApiError(error).into_response(),
    }
}
