//! The sync endpoints a desktop keeps its local copy of the library in step through.

use std::fs;

use spm_http::percent::encode_uri_component;

use crate::support::{Req, TestServer};

#[tokio::test]
async fn a_file_put_through_sync_shows_up_in_the_manifest_and_a_stale_replace_is_a_409() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Robot").await;
    let id = project["id"].as_str().unwrap();

    let put = |base: String, body: &'static [u8]| {
        Req::put()
            .cookie(&cookie)
            .header("x-spm-sync-path", &encode_uri_component("parts/arm.stl"))
            .header("x-spm-sync-base", &base)
            .bytes(body)
    };
    let created = server
        .fetch(
            &format!("/api/sync/projects/{id}/file"),
            put("absent".into(), b"one"),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    let created = created.json();
    assert_eq!(created["relPath"], "parts/arm.stl");
    assert_eq!(
        fs::read(
            server
                .dir()
                .join("admin")
                .join("Robot")
                .join("parts")
                .join("arm.stl")
        )
        .unwrap(),
        b"one"
    );

    let manifest = server
        .fetch("/api/sync/manifest", Req::get().cookie(&cookie))
        .await
        .json();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["projects"][0]["dirName"], "Robot");
    assert_eq!(manifest["projects"][0]["files"][0], created);

    let stale = server
        .fetch(
            &format!("/api/sync/projects/{id}/file"),
            put("absent".into(), b"two"),
        )
        .await;
    assert_eq!(stale.status, 409, "{}", stale.text());
    let replaced = server
        .fetch(
            &format!("/api/sync/projects/{id}/file"),
            put(created["sha256"].as_str().unwrap().to_owned(), b"two"),
        )
        .await;
    assert_eq!(replaced.status, 200, "{}", replaced.text());

    // A missing base header is refused before anything is written.
    let unbased = server
        .fetch(
            &format!("/api/sync/projects/{id}/file"),
            Req::put()
                .cookie(&cookie)
                .header("x-spm-sync-path", "x.stl")
                .bytes(b"x".to_vec()),
        )
        .await;
    assert_eq!(unbased.status, 400);

    // Deletes go to the trash.
    let file_id = created["id"].as_str().unwrap();
    let deleted = server
        .fetch(
            &format!("/api/sync/files/{file_id}"),
            Req::delete().cookie(&cookie).header(
                "x-spm-sync-base",
                replaced.json()["sha256"].as_str().unwrap(),
            ),
        )
        .await;
    assert_eq!(deleted.status, 204, "{}", deleted.text());
    let gone = server
        .fetch(
            &format!("/api/sync/projects/{id}"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(gone.status, 204);
    assert!(!server.dir().join("admin").join("Robot").exists());
    assert_eq!(
        fs::read_dir(server.dir().join(".spm").join("trash"))
            .unwrap()
            .count(),
        2
    );
}

#[tokio::test]
async fn the_sync_endpoints_need_a_session() {
    let server = TestServer::new();
    assert_eq!(server.get("/api/sync/manifest").await.status, 401);
}
