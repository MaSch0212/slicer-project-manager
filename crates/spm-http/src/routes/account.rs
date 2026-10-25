use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use spm_core::dto::SettingsPatch;
use spm_core::validate::{ChangePasswordInput, ProfilePatch};
use spm_core::{change_password, get_settings, me, put_settings, update_profile};

use crate::error::{ApiError, blocking};
use crate::extract::{ParsedJson, Session, json, no_content};
use crate::state::AppState;

pub(super) fn routes(state: &AppState) -> Router<AppState> {
    let mut router = Router::new()
        .route("/api/account", get(get_account).patch(patch_account))
        .route(
            "/api/account/settings",
            get(get_account_settings).put(put_account_settings),
        );
    if state.sessions() {
        // The local user has no password to change.
        router = router.route("/api/account/password", post(post_password));
    }
    router
}

async fn get_account(
    State(state): State<AppState>,
    Session(ctx): Session,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(&blocking(move || me(&lib, &ctx)).await?))
}

async fn patch_account(
    State(state): State<AppState>,
    Session(ctx): Session,
    ParsedJson(patch): ParsedJson<ProfilePatch>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(
        &blocking(move || update_profile(&lib, &ctx, patch)).await?,
    ))
}

async fn post_password(
    State(state): State<AppState>,
    Session(ctx): Session,
    ParsedJson(input): ParsedJson<ChangePasswordInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    blocking(move || change_password(&lib, &ctx, &input.current, &input.next)).await?;
    Ok(no_content())
}

async fn get_account_settings(
    State(state): State<AppState>,
    Session(ctx): Session,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(&blocking(move || get_settings(&lib, &ctx)).await?))
}

async fn put_account_settings(
    State(state): State<AppState>,
    Session(ctx): Session,
    ParsedJson(patch): ParsedJson<SettingsPatch>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(
        &blocking(move || put_settings(&lib, &ctx, patch)).await?,
    ))
}
