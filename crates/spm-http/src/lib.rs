//! The REST API over `spm-core`: an axum router, session cookies, error and progress plumbing,
//! rate limiting, static files and the development UI proxy.
//!
//! # One router, three hosts
//!
//! [`router`] takes an [`AppState`] and returns an `axum::Router`. The NAS binary (`spm-server`)
//! serves it on a TCP port; the desktop app mounts the same router on its own loopback listener
//! (migration spec 3.3). What differs between them is data, not code, and lives in
//! [`HttpOptions`]:
//!
//! * [`AuthMode::Sessions`]: login, session cookie, user administration (the server).
//! * [`AuthMode::Local`]: exactly one user, no login (the desktop's local folder). The capability
//!   flags say so (`requiresAuth: false`) and the auth and user routes are not registered.
//! * [`UiSource`]: a directory, embedded files, a dev-server proxy, or nothing.
//!
//! Ownership and authorisation are enforced in `spm-core`; this crate only turns requests into
//! use-case calls (every one on the blocking pool) and results into responses.
//!
//! # Rate limiting
//!
//! The limiter keys on the TCP peer address and nothing else (never `X-Forwarded-For`, which a
//! client sets). Serve with connect info to give it that address:
//!
//! ```ignore
//! let app = spm_http::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
//! axum::serve(listener, app).await?;
//! ```

pub mod decorate;
pub mod dev_proxy;
pub mod error;
pub mod origin;
pub mod percent;
pub mod rate_limit;
pub mod session;
pub mod static_files;

mod extract;
mod logging;
mod routes;
mod state;

pub use dev_proxy::{DevProxy, resolve_dev_ui_origin};
pub use error::{ApiError, blocking, status_for};
pub use extract::{ParsedJson, Session};
pub use origin::normalize_public_origin;
pub use routes::{MAX_ARCHIVE_BYTES, UPLOAD_NAME_HEADER, router};
pub use state::{AppState, AuthMode, Clock, HttpOptions, UiSource, capabilities_for};
pub use static_files::{Assets, DirAssets};

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use spm_core::testing::TempLibrary;
    use tower::ServiceExt;

    #[tokio::test]
    async fn the_router_builds_and_answers() {
        let library = TempLibrary::new();
        let state = AppState::new((*library).clone(), HttpOptions::default());
        let response = router(state)
            .oneshot(
                Request::get("/api/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
}
