//! Ported from `legacy/server/test/users.test.ts`. The `activationUrl` / `normalizePublicOrigin`
//! unit tests are in `src/origin.rs`.

use serde_json::{Value, json};

use crate::support::{PASSWORD, Req, Setup, TestServer};

async fn create_user(server: &TestServer, cookie: &str, body: Value) -> crate::support::Reply {
    server
        .fetch("/api/users", Req::post().cookie(cookie).json(&body))
        .await
}

#[tokio::test]
async fn creating_a_user_returns_an_activation_url_carrying_the_token_in_the_fragment() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = create_user(
        &server,
        &cookie,
        json!({ "username": "anna", "displayName": "Anna" }),
    )
    .await;
    assert_eq!(reply.status, 200);

    let body = reply.json();
    assert_eq!(body["user"]["username"], "anna");
    assert_eq!(body["user"]["status"], "pending");
    let url = body["activationUrl"].as_str().unwrap();
    let token = url
        .strip_prefix("http://localhost/activate#")
        .unwrap_or_else(|| panic!("unexpected link: {url}"));
    assert_eq!(token.len(), 43);
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        "{token}"
    );
    // A query string would land in access logs and Referer headers.
    assert!(!url.contains('?'));
}

#[tokio::test]
async fn the_link_uses_the_origin_the_request_arrived_on() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/users",
            Req::post()
                .cookie(&cookie)
                .host(Some("10.0.0.4:8000"))
                .json(&json!({ "username": "anna", "displayName": "Anna" })),
        )
        .await;
    assert!(
        reply.json()["activationUrl"]
            .as_str()
            .unwrap()
            .starts_with("http://10.0.0.4:8000/activate#")
    );
}

#[tokio::test]
async fn a_configured_public_origin_reaches_the_links_both_routes_hand_out() {
    let server = TestServer::with(Setup {
        public_origin: Some("https://print.example.com".into()),
        ..Setup::default()
    });
    let cookie = server.login_as_admin().await;
    let created = create_user(
        &server,
        &cookie,
        json!({ "username": "anna", "displayName": "Anna" }),
    )
    .await
    .json();
    assert!(
        created["activationUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://print.example.com/activate#")
    );

    let id = created["user"]["id"].as_str().unwrap();
    let reissued = server
        .fetch(
            &format!("/api/users/{id}/invite"),
            Req::post().cookie(&cookie),
        )
        .await;
    assert!(
        reissued.json()["activationUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://print.example.com/activate#")
    );
}

#[tokio::test]
async fn a_non_admin_is_refused_every_users_route() {
    let server = TestServer::new();
    let admin = server.login_as_admin().await;
    let (anna, created) = server.create_active_user(&admin, "anna").await;
    let id = created["user"]["id"].as_str().unwrap();

    let list = server.fetch("/api/users", Req::get().cookie(&anna)).await;
    assert_eq!(list.status, 403);
    let create = create_user(
        &server,
        &anna,
        json!({ "username": "xx", "displayName": "X" }),
    )
    .await;
    assert_eq!(create.status, 403);
    let delete = server
        .fetch(&format!("/api/users/{id}"), Req::delete().cookie(&anna))
        .await;
    assert_eq!(delete.status, 403);
}

#[tokio::test]
async fn an_invite_can_be_reissued_and_the_quota_updated() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let created = create_user(
        &server,
        &cookie,
        json!({ "username": "anna", "displayName": "Anna" }),
    )
    .await
    .json();
    let id = created["user"]["id"].as_str().unwrap();

    let reissued = server
        .fetch(
            &format!("/api/users/{id}/invite"),
            Req::post().cookie(&cookie),
        )
        .await;
    assert_eq!(reissued.status, 200);
    assert_ne!(reissued.json()["activationUrl"], created["activationUrl"]);

    let patched = server
        .fetch(
            &format!("/api/users/{id}"),
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "quotaBytes": 1_000_000 })),
        )
        .await;
    assert_eq!(patched.json()["quotaBytes"], 1_000_000);
}

#[tokio::test]
async fn removing_the_last_active_admin_is_a_409() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let me = server
        .fetch("/api/account", Req::get().cookie(&cookie))
        .await
        .json();

    let reply = server
        .fetch(
            &format!("/api/users/{}", me["id"].as_str().unwrap()),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.error_code(), "LastActiveAdmin");
}

#[tokio::test]
async fn account_patch_and_password_change_work_on_the_caller() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    let patched = server
        .fetch(
            "/api/account",
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "displayName": "Marc S" })),
        )
        .await;
    assert_eq!(patched.json()["displayName"], "Marc S");

    let changed = server
        .fetch(
            "/api/account/password",
            Req::post().cookie(&cookie).json(&json!({
                "current": PASSWORD,
                "next": "an even longer password",
            })),
        )
        .await;
    assert_eq!(changed.status, 204);

    let relogin = server
        .fetch(
            "/api/auth/login",
            Req::post()
                .json(&json!({ "username": "admin", "password": "an even longer password" })),
        )
        .await;
    assert_eq!(relogin.status, 200);
}

#[tokio::test]
async fn settings_round_trip_through_the_api() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    let defaults = server
        .fetch("/api/account/settings", Req::get().cookie(&cookie))
        .await
        .json();
    assert_eq!(defaults["language"], "en");
    assert_eq!(defaults["theme"], "system");

    let put = server
        .fetch(
            "/api/account/settings",
            Req::put()
                .cookie(&cookie)
                .json(&json!({ "language": "de", "viewMode": "list" })),
        )
        .await;
    let saved = put.json();
    assert_eq!(saved["language"], "de");
    assert_eq!(saved["viewMode"], "list");
    let again = server
        .fetch("/api/account/settings", Req::get().cookie(&cookie))
        .await
        .json();
    assert_eq!(again["language"], "de");
}

#[tokio::test]
async fn an_unknown_setting_key_is_rejected_rather_than_stored() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/account/settings",
            Req::put()
                .cookie(&cookie)
                .json(&json!({ "language": "klingon" })),
        )
        .await;
    assert_eq!(reply.status, 400);
}
