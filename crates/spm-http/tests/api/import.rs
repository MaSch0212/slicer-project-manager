//! Ported from `legacy/server/test/import.test.ts`.

use std::fs;

use spm_http::MAX_ARCHIVE_BYTES;

use crate::support::fixtures::zip;
use crate::support::{Req, TestServer};

fn archive() -> Vec<u8> {
    zip(&[
        ("MyLibrary/Widget A/part.stl", b"solid a"),
        (
            "MyLibrary/Widget A/metadata.json",
            br#"{"Tags":["toys"],"IsArchived":true}"#,
        ),
        ("MyLibrary/Bracket/model.3mf", b"x"),
    ])
}

fn import(cookie: &str, body: Vec<u8>) -> Req {
    Req::post()
        .cookie(cookie)
        .header("content-type", "application/zip")
        .bytes(body)
}

fn staged(server: &TestServer) -> Vec<String> {
    fs::read_dir(server.dir().join(".spm").join("uploads"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[tokio::test]
async fn an_uploaded_archive_is_imported_and_reported_back() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    let reply = server
        .fetch("/api/import/curamanager", import(&cookie, archive()))
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let body = reply.json();
    assert_eq!(body["projectsExtracted"], 2);
    assert_eq!(body["filesExtracted"], 3);
    assert_eq!(body["strippedRoot"], "MyLibrary");
    assert_eq!(body["rescan"]["adopted"], 2);
    assert_eq!(body["tagsApplied"], 1);

    // The projects are really on disk, under the admin's own library folder.
    assert!(server.dir().join("admin/Widget A/part.stl").exists());
    assert!(server.dir().join("admin/Bracket/model.3mf").exists());
}

#[tokio::test]
async fn the_staged_upload_is_deleted_whether_the_import_succeeds_or_fails() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    server
        .fetch("/api/import/curamanager", import(&cookie, archive()))
        .await;
    // A multi-gigabyte copy left inside the user's own library would silently eat their quota.
    assert!(staged(&server).is_empty());

    // The same must hold on the failure path: this one collides with the import above.
    let conflict = server
        .fetch("/api/import/curamanager", import(&cookie, archive()))
        .await;
    assert_eq!(conflict.status, 409);
    assert!(staged(&server).is_empty());
}

#[tokio::test]
async fn a_collision_is_a_409_naming_the_folders_and_changes_nothing() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    server
        .fetch("/api/import/curamanager", import(&cookie, archive()))
        .await;
    let before = fs::read(server.dir().join("admin/Widget A/part.stl")).unwrap();

    let reply = server
        .fetch("/api/import/curamanager", import(&cookie, archive()))
        .await;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.error_code(), "Conflict");
    let message = reply.json()["error"]["message"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(message.contains("Widget A"), "{message}");
    assert_eq!(
        fs::read(server.dir().join("admin/Widget A/part.stl")).unwrap(),
        before
    );
}

#[tokio::test]
async fn the_import_endpoint_requires_a_session() {
    let server = TestServer::new();
    let reply = server
        .fetch("/api/import/curamanager", Req::post().bytes(archive()))
        .await;
    assert_eq!(reply.status, 401);
}

#[tokio::test]
async fn an_upload_with_no_length_is_a_411_rather_than_an_unbounded_write() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    // A streamed body carries no content-length, which is exactly the case the precheck exists
    // for: nothing should be written to disk before the size is known.
    let reply = server
        .fetch(
            "/api/import/curamanager",
            Req::post().cookie(&cookie).stream(vec![archive()]),
        )
        .await;
    assert_eq!(reply.status, 411);
    assert!(!server.dir().join(".spm").join("uploads").exists());
}

#[tokio::test]
async fn an_archive_larger_than_the_cap_is_refused_before_a_byte_is_staged() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/import/curamanager",
            Req::post()
                .cookie(&cookie)
                // The header alone decides this; no body of that size is ever produced.
                .header("content-length", &(MAX_ARCHIVE_BYTES + 1).to_string())
                .bytes(archive()),
        )
        .await;
    assert_eq!(reply.status, 413);
    assert_eq!(reply.error_code(), "QuotaExceeded");
    assert!(!server.dir().join(".spm").join("uploads").exists());
}

#[tokio::test]
async fn an_archive_with_nothing_importable_in_it_is_a_400_that_explains_why() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/import/curamanager",
            import(&cookie, zip(&[("loose.txt", b"hello")])),
        )
        .await;
    assert_eq!(reply.status, 400);
    let message = reply.json()["error"]["message"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(message.contains("no project folders"), "{message}");
}

#[tokio::test]
async fn something_that_is_not_a_zip_is_refused_and_not_left_behind() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/import/curamanager",
            import(&cookie, b"this is not a zip archive at all".to_vec()),
        )
        .await;
    assert!(
        reply.status >= 400 && reply.status < 500,
        "{}",
        reply.status
    );
    assert!(staged(&server).is_empty());
}
