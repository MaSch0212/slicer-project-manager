//! `AuthMode::Local`: the desktop's local folder, where there is one user and nobody logs in
//! (parent spec 2.4 and 2.6). No legacy equivalent: the Electron shell answered these calls over
//! IPC, and the migration puts them on this router.

use serde_json::json;

use crate::support::{Req, Setup, TestServer};

fn local() -> TestServer {
    TestServer::with(Setup {
        local: true,
        ..Setup::default()
    })
}

#[tokio::test]
async fn capabilities_say_no_login_and_no_user_management() {
    let server = local();
    let reply = server.get("/api/capabilities").await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.json(),
        json!({
            "requiresAuth": false,
            "canManageUsers": false,
            "canPickLocalFolder": false,
            "canLaunchSlicer": false,
            "canConfigureSlicers": false,
            "canBrowseModelSites": false,
        })
    );
}

#[tokio::test]
async fn every_session_route_acts_for_the_local_user_without_a_cookie() {
    let server = local();

    let me = server.get("/api/account").await;
    assert_eq!(me.status, 200);
    assert_eq!(me.json()["isAdmin"], false);

    let created = server
        .fetch(
            "/api/projects",
            Req::post().json(&json!({ "name": "Benchy" })),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    // A flat library: the project folder sits directly under the library root, with no user level.
    assert!(server.dir().join("Benchy").is_dir());

    let list = server.get("/api/projects").await;
    assert_eq!(list.json().as_array().unwrap().len(), 1);

    let settings = server.get("/api/account/settings").await;
    assert_eq!(settings.json()["language"], "en");
}

#[tokio::test]
async fn a_cookie_is_ignored_not_required() {
    let server = local();
    let reply = server
        .fetch("/api/account", Req::get().cookie("spm_session=garbage"))
        .await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn the_login_activation_user_and_password_routes_do_not_exist() {
    let server = local();
    for (request, path) in [
        (Req::post().json(&json!({})), "/api/auth/login"),
        (Req::post(), "/api/auth/logout"),
        (Req::get(), "/api/auth/activation/abc"),
        (Req::get(), "/api/users"),
        (Req::post().json(&json!({})), "/api/users"),
        (Req::post().json(&json!({})), "/api/account/password"),
    ] {
        let reply = server.fetch(path, request).await;
        assert_eq!(reply.status, 404, "{path}");
        assert_eq!(reply.error_code(), "NotFound", "{path}");
    }
}

#[tokio::test]
async fn files_stream_in_local_mode_too() {
    let server = local();
    let project = server.new_project("", "Benchy").await;
    let id = project["id"].as_str().unwrap();
    let uploaded = server
        .fetch(
            &format!("/api/projects/{id}/files"),
            Req::post()
                .header("x-spm-file-name", "a.stl")
                .bytes("solid a"),
        )
        .await;
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());
    let raw = server
        .fetch(uploaded.json()["rawUrl"].as_str().unwrap(), Req::get())
        .await;
    assert_eq!(raw.text(), "solid a");
}
