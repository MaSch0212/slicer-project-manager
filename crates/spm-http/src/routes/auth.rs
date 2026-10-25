use axum::Router;
use axum::extract::{Path, State};
use axum::http::header::{SET_COOKIE, USER_AGENT};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use serde::Serialize;
use spm_core::auth::activation::check_activation_token;
use spm_core::auth::sessions::delete_session;
use spm_core::validate::{ActivateInput, LoginInput};
use spm_core::{LoginResult, activate_account, login};

use super::limited;
use crate::error::{ApiError, blocking};
use crate::extract::{ParsedJson, json};
use crate::rate_limit::RateLimitRule;
use crate::session::{
    is_local_http, read_session_token, request_authority, session_clear_cookie, session_set_cookie,
};
use crate::state::AppState;

/// Generous for a human typing a password, but it caps an attacker's sampling rate to 600 an hour:
/// the mitigation for login's password-versus-username timing gap.
const AUTH_RATE_LIMIT: RateLimitRule = RateLimitRule {
    limit: 10,
    window_ms: 60_000,
};

pub(super) fn routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/api/auth/login",
            limited(
                post(post_login),
                state,
                "POST /api/auth/login",
                AUTH_RATE_LIMIT,
            ),
        )
        .route("/api/auth/logout", post(post_logout))
        .route(
            "/api/auth/activation/{token}",
            // Only the POST takes a password guess; the read-only check is not limited.
            get(get_activation).merge(limited(
                post(post_activation),
                state,
                "POST /api/auth/activation/{token}",
                AUTH_RATE_LIMIT,
            )),
        )
}

/// A struct rather than a `json!` map: key order is part of the bytes clients have always seen.
#[derive(Serialize)]
struct ActivationCheckBody {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn with_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

fn session_response(result: &LoginResult, headers: &HeaderMap, uri: &axum::http::Uri) -> Response {
    let local = is_local_http(request_authority(uri, headers).as_deref());
    let cookie = session_set_cookie(
        &result.token,
        result.expires_at,
        spm_core::clock::now_ms(),
        local,
    );
    with_cookie(json(&result.user), &cookie)
}

async fn post_login(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    ParsedJson(input): ParsedJson<LoginInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let agent = user_agent(&headers);
    let result =
        blocking(move || login(&lib, &input.username, &input.password, agent.as_deref())).await?;
    Ok(session_response(&result, &headers, &uri))
}

async fn post_logout(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(token) = read_session_token(&headers) {
        let lib = state.lib().clone();
        blocking(move || delete_session(&lib, &token)).await?;
    }
    let local = is_local_http(request_authority(&uri, &headers).as_deref());
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    Ok(with_cookie(response, &session_clear_cookie(local)))
}

/// Read-only, so an expired link errors before a password is typed.
async fn get_activation(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let check =
        blocking(move || check_activation_token(&lib, &token, spm_core::clock::now_ms())).await?;
    Ok(match (check.valid, check.username) {
        (true, Some(username)) => json(&ActivationCheckBody {
            valid: true,
            username: Some(username),
        }),
        _ => json(&ActivationCheckBody {
            valid: false,
            username: None,
        }),
    })
}

async fn post_activation(
    State(state): State<AppState>,
    Path(token): Path<String>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    ParsedJson(input): ParsedJson<ActivateInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let agent = user_agent(&headers);
    let result =
        blocking(move || activate_account(&lib, &token, &input.password, agent.as_deref())).await?;
    Ok(session_response(&result, &headers, &uri))
}
