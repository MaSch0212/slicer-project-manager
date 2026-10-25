use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::{get, patch, post};
use serde::Serialize;
use spm_core::dto::UserDto;
use spm_core::validate::{CreateUserInput, UpdateUserInput};
use spm_core::{create_user, delete_user, list_users, reissue_invite, update_user};

use crate::error::{ApiError, blocking};
use crate::extract::{ParsedJson, Session, json, no_content};
use crate::origin::{activation_url, request_origin};
use crate::session::request_authority;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/users", get(list).post(create))
        .route("/api/users/{id}/invite", post(invite))
        .route("/api/users/{id}", patch(update).delete(remove))
}

/// Structs rather than `json!` maps: key order is part of the bytes clients have always seen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedUserBody {
    user: UserDto,
    activation_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteBody {
    activation_url: String,
}

fn link(state: &AppState, uri: &Uri, headers: &HeaderMap, token: &str) -> String {
    activation_url(
        &request_origin(request_authority(uri, headers).as_deref()),
        token,
        state.inner.public_origin.as_deref(),
    )
}

async fn list(State(state): State<AppState>, Session(ctx): Session) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(&blocking(move || list_users(&lib, &ctx)).await?))
}

async fn create(
    State(state): State<AppState>,
    Session(ctx): Session,
    uri: Uri,
    headers: HeaderMap,
    ParsedJson(input): ParsedJson<CreateUserInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let created = blocking(move || create_user(&lib, &ctx, input)).await?;
    // Returned once, for the admin to copy out of band. There is no SMTP.
    Ok(json(&CreatedUserBody {
        user: created.user,
        activation_url: link(&state, &uri, &headers, &created.token),
    }))
}

async fn invite(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let token = blocking(move || reissue_invite(&lib, &ctx, &id)).await?;
    Ok(json(&InviteBody {
        activation_url: link(&state, &uri, &headers, &token),
    }))
}

async fn update(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    ParsedJson(patch): ParsedJson<UpdateUserInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(
        &blocking(move || update_user(&lib, &ctx, &id, patch)).await?,
    ))
}

async fn remove(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    blocking(move || delete_user(&lib, &ctx, &id)).await?;
    Ok(no_content())
}
