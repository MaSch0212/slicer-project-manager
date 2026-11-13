//! The endpoints a desktop keeps its local copy of the library in step through (see
//! [`spm_core::library_sync`]). Each write or delete names what it expects to replace in the
//! [`SYNC_BASE_HEADER`]; a change made on the server meanwhile is a 409, never overwritten.

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{delete, get, put};
use spm_core::AppError;
use spm_core::library_sync::{BaseVersion, put_file_at, sync_manifest, trash_file, trash_project};

use super::files::{body_reader, drain, require_content_length};
use crate::error::{ApiError, blocking};
use crate::extract::{Session, json, no_content};
use crate::percent::decode_uri_component_or_fail;
use crate::state::AppState;

/// `absent`, `*`, or the 64-hex-digit SHA-256 of the content the change replaces.
pub const SYNC_BASE_HEADER: &str = "x-spm-sync-base";
/// The file's path relative to its project folder, `/`-separated and percent-encoded.
pub const SYNC_PATH_HEADER: &str = "x-spm-sync-path";

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sync/manifest", get(manifest))
        .route("/api/sync/projects/{id}/file", put(put_file))
        .route("/api/sync/projects/{id}", delete(remove_project))
        .route("/api/sync/files/{id}", delete(remove_file))
}

fn base_of(headers: &HeaderMap) -> Result<BaseVersion, ApiError> {
    headers
        .get(SYNC_BASE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(BaseVersion::parse)
        .ok_or_else(|| {
            AppError::validation(format!(
                "{SYNC_BASE_HEADER} must be `absent`, `*` or a SHA-256 in hex"
            ))
            .into()
        })
}

fn rel_path_of(headers: &HeaderMap) -> Result<String, ApiError> {
    let raw = headers
        .get(SYNC_PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation(format!("{SYNC_PATH_HEADER} header is required")))?;
    Ok(decode_uri_component_or_fail(
        raw,
        &format!("{SYNC_PATH_HEADER} header"),
    )?)
}

async fn manifest(
    State(state): State<AppState>,
    Session(ctx): Session,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let manifest = blocking(move || sync_manifest(&lib, &ctx)).await?;
    Ok(json(&manifest))
}

async fn put_file(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let base = base_of(&headers)?;
    let rel_path = rel_path_of(&headers)?;
    let size = require_content_length(&headers, true)?;
    let size = i64::try_from(size)
        .map_err(|_| AppError::validation("the declared upload size is too large"))?;
    let lib = state.lib().clone();
    let file = blocking(move || {
        let mut reader = body_reader(body);
        let result = put_file_at(&lib, &ctx, &project_id, &rel_path, base, size, &mut reader);
        if result.is_err() {
            drain(&mut reader);
        }
        result
    })
    .await?;
    Ok(json(&file))
}

async fn remove_file(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let base = base_of(&headers)?;
    let lib = state.lib().clone();
    blocking(move || trash_file(&lib, &ctx, &id, base)).await?;
    Ok(no_content())
}

async fn remove_project(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    blocking(move || trash_project(&lib, &ctx, &id)).await?;
    Ok(no_content())
}
