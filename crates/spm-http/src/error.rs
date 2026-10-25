//! Errors on the wire: the `{ "error": { code, message, details } }` envelope and the status each
//! code answers with.

use axum::body::Body;
use axum::http::header::{CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use spm_core::{AppError, AppErrorCode};

/// The legacy `STATUS_BY_CODE`.
pub fn status_for(code: AppErrorCode) -> StatusCode {
    match code {
        AppErrorCode::Validation | AppErrorCode::InvalidToken => StatusCode::BAD_REQUEST,
        AppErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        AppErrorCode::Forbidden => StatusCode::FORBIDDEN,
        AppErrorCode::NotFound => StatusCode::NOT_FOUND,
        AppErrorCode::Conflict | AppErrorCode::LastActiveAdmin => StatusCode::CONFLICT,
        AppErrorCode::TokenExpired => StatusCode::GONE,
        AppErrorCode::LengthRequired => StatusCode::LENGTH_REQUIRED,
        AppErrorCode::QuotaExceeded => StatusCode::PAYLOAD_TOO_LARGE,
        AppErrorCode::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
        AppErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub(crate) const JSON_TYPE: &str = "application/json; charset=utf-8";

/// An [`AppError`] on its way out as a response.
#[derive(Debug)]
pub struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(error: AppError) -> ApiError {
        ApiError(error)
    }
}

/// Rides on a 5xx response so the request-logging layer can record the error's cause. Never sent
/// to the client.
#[derive(Debug, Clone)]
pub(crate) struct LoggedError(pub AppError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let error = self.0;
        let body = serde_json::to_vec(&error.to_envelope()).unwrap_or_else(|_| {
            br#"{"error":{"code":"Internal","message":"internal error","details":{}}}"#.to_vec()
        });
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = status_for(error.code);
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(JSON_TYPE));
        if error.code == AppErrorCode::TooManyRequests {
            let seconds = error
                .details
                .as_ref()
                .and_then(|details| details.get("retryAfterSeconds"))
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0);
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }
        // The client sees `internal error` and nothing else; the cause is kept server-side, because
        // an Internal reaching here is a bug and the cause is what makes it findable.
        if error.code == AppErrorCode::Internal {
            response.extensions_mut().insert(LoggedError(error));
        }
        response
    }
}

/// A 405 for a known path that no route claimed this method for. Its code is not one of
/// [`AppErrorCode`]'s: it was never part of the error vocabulary the UI maps to messages.
pub fn method_not_allowed() -> Response {
    let mut response = Response::new(Body::from(
        r#"{"error":{"code":"MethodNotAllowed","message":"method not allowed","details":{}}}"#,
    ));
    *response.status_mut() = StatusCode::METHOD_NOT_ALLOWED;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(JSON_TYPE));
    response
}

/// Runs a synchronous core use case on the blocking pool. Every core call goes through here: they
/// take locks, hash passwords and touch the disk.
pub async fn blocking<T, F>(work: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result.map_err(ApiError),
        Err(joined) => Err(ApiError(AppError::internal(format!(
            "a blocking task failed: {joined}"
        )))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn every_code_has_its_legacy_status() {
        let expected = [
            (AppErrorCode::Validation, 400),
            (AppErrorCode::InvalidToken, 400),
            (AppErrorCode::Unauthorized, 401),
            (AppErrorCode::Forbidden, 403),
            (AppErrorCode::NotFound, 404),
            (AppErrorCode::Conflict, 409),
            (AppErrorCode::LastActiveAdmin, 409),
            (AppErrorCode::TokenExpired, 410),
            (AppErrorCode::LengthRequired, 411),
            (AppErrorCode::QuotaExceeded, 413),
            (AppErrorCode::TooManyRequests, 429),
            (AppErrorCode::Internal, 500),
        ];
        assert_eq!(expected.len(), AppErrorCode::ALL.len());
        for (code, status) in expected {
            assert_eq!(status_for(code).as_u16(), status, "{code}");
        }
    }

    #[tokio::test]
    async fn an_internal_error_leaks_neither_its_cause_nor_a_stack() {
        let response = ApiError(AppError::internal("a secret internal detail")).into_response();
        assert_eq!(response.status(), 500);
        let logged = response.extensions().get::<LoggedError>().cloned();
        assert_eq!(
            logged.unwrap().0.cause.as_deref(),
            Some("a secret internal detail")
        );
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(!text.contains("secret"), "{text}");
        assert_eq!(
            text,
            r#"{"error":{"code":"Internal","message":"internal error","details":{}}}"#
        );
    }

    #[tokio::test]
    async fn a_blocking_panic_is_an_internal_error_not_a_dead_server() {
        let result: Result<(), ApiError> = blocking(|| panic!("boom")).await;
        assert_eq!(result.unwrap_err().0.code, AppErrorCode::Internal);
    }
}
