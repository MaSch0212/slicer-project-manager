//! Ported from `legacy/server/test/auth.test.ts`.

use serde_json::json;

use crate::support::{PASSWORD, Req, TestServer};

#[tokio::test]
async fn capabilities_is_public_and_describes_the_server_build() {
    let server = TestServer::new();
    let reply = server.get("/api/capabilities").await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.json(),
        json!({
            "requiresAuth": true,
            "canManageUsers": true,
            "canPickLocalFolder": false,
            "canLaunchSlicer": false,
            "canConfigureSlicers": false,
            "canBrowseModelSites": false,
        })
    );
}

#[tokio::test]
async fn an_unknown_api_route_is_a_404_with_the_error_envelope() {
    let server = TestServer::new();
    let reply = server.get("/api/nope").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), "NotFound");
    assert_eq!(
        reply.content_type().as_deref(),
        Some("application/json; charset=utf-8")
    );
}

#[tokio::test]
async fn a_session_route_without_a_cookie_is_a_401() {
    let server = TestServer::new();
    let reply = server.get("/api/account").await;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.error_code(), "Unauthorized");
}

#[tokio::test]
async fn a_malformed_percent_escape_in_the_session_cookie_is_a_401_not_a_500() {
    let server = TestServer::new();
    let reply = server
        .fetch("/api/account", Req::get().cookie("spm_session=%"))
        .await;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.error_code(), "Unauthorized");
}

#[tokio::test]
async fn the_activation_token_can_be_checked_before_a_password_is_typed() {
    let server = TestServer::new();
    let token = server.bootstrap_token.clone().unwrap();
    let ok = server.get(&format!("/api/auth/activation/{token}")).await;
    assert_eq!(ok.json(), json!({ "valid": true, "username": "admin" }));
    // Key order is part of the bytes clients have always seen.
    assert_eq!(ok.text(), r#"{"valid":true,"username":"admin"}"#);

    let bad = server.get("/api/auth/activation/not-a-real-token").await;
    assert_eq!(bad.status, 200);
    assert_eq!(bad.text(), r#"{"valid":false}"#);
}

#[tokio::test]
async fn activation_sets_an_http_only_session_cookie_and_returns_the_user() {
    let server = TestServer::new();
    let token = server.bootstrap_token.clone().unwrap();
    let reply = server
        .fetch(
            &format!("/api/auth/activation/{token}"),
            Req::post().json(&json!({ "password": PASSWORD, "confirm": PASSWORD })),
        )
        .await;
    assert_eq!(reply.status, 200);
    let cookie = reply.set_cookie().unwrap();
    assert!(cookie.starts_with("spm_session="), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Lax"), "{cookie}");
    // No Secure flag over http://localhost, or a development browser would drop the cookie.
    assert!(!cookie.contains("Secure"), "{cookie}");

    let user = reply.json();
    assert_eq!(user["username"], "admin");
    assert_eq!(user["status"], "active");
    assert_eq!(user["isAdmin"], true);
}

#[tokio::test]
async fn the_cookie_is_secure_everywhere_but_plain_http_localhost() {
    // The exact exception: plain http to `localhost` or `127.0.0.1`. Anything else, including a
    // LAN address or a public name (which is what a TLS-terminating proxy forwards), is Secure,
    // and `X-Forwarded-Proto` changes nothing: a client sets it, not the network.
    for (host, secure) in [
        (Some("localhost"), false),
        (Some("localhost:8000"), false),
        (Some("127.0.0.1:3000"), false),
        (Some("LOCALHOST:8000"), false),
        (Some("print.example.com"), true),
        (Some("10.0.0.4:8000"), true),
        (Some("localhost.example.com"), true),
        (None, true),
    ] {
        let server = TestServer::new();
        let token = server.bootstrap_token.clone().unwrap();
        let reply = server
            .fetch(
                &format!("/api/auth/activation/{token}"),
                Req::post()
                    .host(host)
                    .header("x-forwarded-proto", "http")
                    .json(&json!({ "password": PASSWORD, "confirm": PASSWORD })),
            )
            .await;
        assert_eq!(reply.status, 200, "{host:?}");
        assert_eq!(
            reply.set_cookie().unwrap().contains("Secure"),
            secure,
            "{host:?}: {}",
            reply.set_cookie().unwrap()
        );
    }
}

#[tokio::test]
async fn a_validation_failure_reports_the_offending_field() {
    let server = TestServer::new();
    let token = server.bootstrap_token.clone().unwrap();
    let reply = server
        .fetch(
            &format!("/api/auth/activation/{token}"),
            Req::post().json(&json!({ "password": "short", "confirm": "short" })),
        )
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), "Validation");
    let issues = reply.json()["error"]["details"]["issues"].clone();
    assert!(issues.is_array(), "{issues}");
    assert_eq!(issues[0]["path"], json!(["password"]));
}

#[tokio::test]
async fn a_body_that_is_not_json_is_a_400() {
    let server = TestServer::new();
    let reply = server
        .fetch("/api/auth/login", Req::post().bytes("not json"))
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), "Validation");
    assert_eq!(
        reply.json()["error"]["message"],
        "request body is not valid JSON"
    );
}

#[tokio::test]
async fn login_works_after_activation_and_rejects_a_wrong_password() {
    let server = TestServer::new();
    server.login_as_admin().await;

    let ok = server
        .fetch(
            "/api/auth/login",
            Req::post().json(&json!({ "username": "admin", "password": PASSWORD })),
        )
        .await;
    assert_eq!(ok.status, 200);
    assert!(ok.set_cookie().is_some());

    let bad = server
        .fetch(
            "/api/auth/login",
            Req::post().json(&json!({ "username": "admin", "password": "wrong password" })),
        )
        .await;
    assert_eq!(bad.status, 401);
}

#[tokio::test]
async fn a_session_cookie_authenticates_and_logout_revokes_it() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    let me = server
        .fetch("/api/account", Req::get().cookie(&cookie))
        .await;
    assert_eq!(me.status, 200);
    assert_eq!(me.json()["username"], "admin");

    let out = server
        .fetch("/api/auth/logout", Req::post().cookie(&cookie))
        .await;
    assert_eq!(out.status, 204);
    assert!(out.set_cookie().unwrap().contains("Max-Age=0"));

    let after = server
        .fetch("/api/account", Req::get().cookie(&cookie))
        .await;
    assert_eq!(after.status, 401);
}

#[tokio::test]
async fn a_wrong_method_on_a_known_path_is_a_405() {
    let server = TestServer::new();
    let reply = server.fetch("/api/capabilities", Req::delete()).await;
    assert_eq!(reply.status, 405);
    assert_eq!(reply.error_code(), "MethodNotAllowed");
}
