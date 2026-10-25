use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;

use crate::extract::json;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/capabilities", get(capabilities))
}

/// Public: it describes the backend the client is about to sign in to.
async fn capabilities(State(state): State<AppState>) -> Response {
    json(&state.inner.capabilities)
}
