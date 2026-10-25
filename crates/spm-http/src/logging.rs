//! One log line per request.
//!
//! Every API request is logged once at `info` with its method, path, status and duration (and the
//! user, once a session resolved). A 4xx stays at `info`: a 401 on an expired cookie is routine,
//! not a warning sign. A 5xx is the server's own fault and goes out at `error` as `request
//! failed`, preceded by an `unhandled error` record carrying the cause that the client never saw.
//! Static assets are a page load's worth of noise, so they sit one level below at `debug`.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use spm_core::fields;
use spm_core::log::LogValue;

use crate::error::LoggedError;
use crate::extract::UserIdSlot;
use crate::state::AppState;

pub(crate) async fn request_log(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let slot = Arc::new(UserIdSlot::default());
    request.extensions_mut().insert(Arc::clone(&slot));

    let mut response = next.run(request).await;

    let log = state.log();
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let status = i64::from(response.status().as_u16());

    if let Some(LoggedError(error)) = response.extensions_mut().remove::<LoggedError>() {
        log.error(
            "unhandled error",
            fields![
                "err" => LogValue::error(&error),
                "cause" => error.cause.clone(),
            ],
        );
    }

    if !path.starts_with("/api/") {
        log.debug(
            "static",
            fields!["method" => &method, "path" => &path, "status" => status, "ms" => ms],
        );
        return response;
    }

    // The user id only once a session resolved: an anonymous one is the empty string, which reads
    // as a field whose value went missing rather than as "nobody was signed in".
    let user_id = slot.get();
    let mut record = vec![
        ("method", LogValue::from(&method)),
        ("path", LogValue::from(&path)),
        ("status", LogValue::from(status)),
        ("ms", LogValue::from(ms)),
    ];
    if let Some(user_id) = user_id {
        record.push(("userId", LogValue::from(user_id)));
    }
    if response.status().is_server_error() {
        log.error("request failed", &record);
    } else {
        log.info("request", &record);
    }
    response
}
