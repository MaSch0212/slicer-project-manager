//! The REST API over `spm-core`.

use axum::{Router, routing::get};

async fn health() -> &'static str {
    spm_core::app_name()
}

/// The HTTP router.
pub fn router() -> Router {
    Router::new().route("/api/health", get(health))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_answers_ok() {
        let response = router()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
}
