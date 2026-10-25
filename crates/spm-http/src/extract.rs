//! Extractors the routes share: the signed-in user, a validated JSON body, the peer address.

use std::sync::{Arc, Mutex, PoisonError};

use axum::body::{Body, to_bytes};
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;
use serde_json::Value;
use spm_core::auth::sessions::resolve_session;
use spm_core::validate::{self, Validate};
use spm_core::{AppError, Ctx};

use crate::error::{ApiError, blocking};
use crate::session::read_session_token;
use crate::state::{AppState, AuthMode};

/// Request bodies parsed as JSON are small; anything past this is refused rather than buffered.
pub const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;

/// Filled in once a request has been tied to a user, so the request log can name them. Lives in
/// the request's extensions; the logging layer holds the other end.
#[derive(Debug, Default)]
pub(crate) struct UserIdSlot(Mutex<Option<String>>);

impl UserIdSlot {
    pub(crate) fn set(&self, user_id: &str) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(user_id.to_owned());
    }

    pub(crate) fn get(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// The user a request acts for. In [`AuthMode::Sessions`] this is the session cookie resolved; in
/// [`AuthMode::Local`] it is the one local user. A request without a live session is a 401.
pub struct Session(pub Ctx);

impl FromRequestParts<AppState> for Session {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Session, ApiError> {
        let ctx = match &state.inner.auth {
            AuthMode::Local(ctx) => ctx.clone(),
            AuthMode::Sessions => {
                let token = read_session_token(&parts.headers);
                let resolved = match token {
                    Some(token) => {
                        let lib = state.lib().clone();
                        blocking(move || resolve_session(&lib, &token, spm_core::clock::now_ms()))
                            .await?
                    }
                    None => None,
                };
                resolved.ok_or_else(|| {
                    ApiError(AppError::unauthorized("a valid session is required"))
                })?
            }
        };
        if let Some(slot) = parts.extensions.get::<Arc<UserIdSlot>>() {
            slot.set(&ctx.user_id);
        }
        Ok(Session(ctx))
    }
}

/// A request body parsed as JSON and validated by core's rules (the single place they live).
/// Malformed JSON is `Validation: request body is not valid JSON`; a rule failure is a
/// `Validation` carrying `details.issues`.
pub struct ParsedJson<T>(pub T);

impl<T, S> FromRequest<S> for ParsedJson<T>
where
    T: DeserializeOwned + Validate,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<ParsedJson<T>, ApiError> {
        let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| ApiError(AppError::validation("request body could not be read")))?;
        parse_json_body(&bytes).map(ParsedJson)
    }
}

pub(crate) fn parse_json_body<T: DeserializeOwned + Validate>(bytes: &[u8]) -> Result<T, ApiError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| ApiError(AppError::validation("request body is not valid JSON")))?;
    validate::parse::<T>(&value).map_err(|issues| ApiError(issues.into()))
}

/// A JSON response with the content type the legacy server sent.
pub(crate) fn json<T: serde::Serialize>(value: &T) -> axum::response::Response {
    use axum::http::HeaderValue;
    use axum::http::header::CONTENT_TYPE;
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    let mut response = axum::response::Response::new(Body::from(body));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static(crate::error::JSON_TYPE),
    );
    response
}

pub(crate) fn no_content() -> axum::response::Response {
    let mut response = axum::response::Response::new(Body::empty());
    *response.status_mut() = axum::http::StatusCode::NO_CONTENT;
    response
}
