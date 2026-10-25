//! Ported from `legacy/server/test/files.test.ts`.

use std::fs;

use serde_json::{Value, json};
use spm_core::{PreviewConfig, run_preview_batch};
use spm_http::percent::encode_uri_component;

use crate::support::fixtures::{cube_stl, cura_project, png, png_size};
use crate::support::{Reply, Req, TestServer};

async fn upload(
    server: &TestServer,
    cookie: &str,
    project_id: &str,
    name: &str,
    content: &[u8],
) -> Reply {
    server
        .fetch(
            &format!("/api/projects/{project_id}/files"),
            Req::post()
                .cookie(cookie)
                .header("x-spm-file-name", &encode_uri_component(name))
                .bytes(content),
        )
        .await
}

async fn project_detail(server: &TestServer, cookie: &str, id: &str) -> Value {
    server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(cookie))
        .await
        .json()
}

fn file_named<'a>(detail: &'a Value, name: &str) -> &'a Value {
    detail["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["name"] == name)
        .unwrap_or_else(|| panic!("no file {name} in {detail}"))
}

#[tokio::test]
async fn upload_indexes_the_file_and_returns_a_decorated_dto() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;

    let reply = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "benchy.stl",
        b"solid benchy",
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let file = reply.json();
    assert_eq!(file["name"], "benchy.stl");
    assert_eq!(file["kind"], "model");
    assert_eq!(file["previewState"], "pending");
    assert_eq!(
        file["rawUrl"],
        format!("/api/files/{}/raw", file["id"].as_str().unwrap())
    );
    assert!(file.get("thumbUrl").is_none());
    // The bytes landed in the project folder, under the declared name.
    assert_eq!(
        fs::read(server.dir().join("admin").join("Benchy").join("benchy.stl")).unwrap(),
        b"solid benchy"
    );
}

#[tokio::test]
async fn upload_without_a_name_header_or_length_is_refused() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let path = format!("/api/projects/{}/files", project["id"].as_str().unwrap());

    let no_name = server
        .fetch(&path, Req::post().cookie(&cookie).bytes("solid"))
        .await;
    assert_eq!(no_name.status, 400);

    // A streamed body carries no content-length: the quota check could not know the size.
    let no_length = server
        .fetch(
            &path,
            Req::post()
                .cookie(&cookie)
                .header("x-spm-file-name", "a.stl")
                .stream(vec![b"solid".to_vec()]),
        )
        .await;
    assert_eq!(no_length.status, 411);
    assert_eq!(no_length.error_code(), "LengthRequired");
}

#[tokio::test]
async fn a_traversal_attempt_in_the_name_header_is_refused() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let reply = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "../escape.stl",
        b"solid",
    )
    .await;
    assert_eq!(reply.status, 400);
    assert!(!server.dir().join("admin").join("escape.stl").exists());
    assert!(!server.dir().join("escape.stl").exists());
}

#[tokio::test]
async fn a_malformed_percent_escape_in_the_name_header_is_a_400_not_a_500() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let reply = server
        .fetch(
            &format!("/api/projects/{}/files", project["id"].as_str().unwrap()),
            Req::post()
                .cookie(&cookie)
                .header("x-spm-file-name", "%")
                .bytes("solid"),
        )
        .await;
    assert_eq!(reply.status, 400);
}

#[tokio::test]
async fn exceeding_the_quota_is_a_413_carrying_the_numbers() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let me = server
        .fetch("/api/account", Req::get().cookie(&cookie))
        .await
        .json();
    server
        .fetch(
            &format!("/api/users/{}", me["id"].as_str().unwrap()),
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "quotaBytes": 10 })),
        )
        .await;
    let project = server.new_project(&cookie, "Benchy").await;

    let reply = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "big.stl",
        "x".repeat(50).as_bytes(),
    )
    .await;
    assert_eq!(reply.status, 413);
    assert_eq!(reply.error_code(), "QuotaExceeded");
    assert_eq!(
        reply.json()["error"]["details"],
        json!({ "usageBytes": 0, "quotaBytes": 10, "incomingBytes": 50 })
    );
    assert!(
        !server
            .dir()
            .join("admin")
            .join("Benchy")
            .join("big.stl")
            .exists()
    );
}

#[tokio::test]
async fn raw_streams_the_bytes_with_a_real_content_type() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let file = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "benchy.stl",
        b"solid benchy",
    )
    .await
    .json();

    let reply = server
        .fetch(file["rawUrl"].as_str().unwrap(), Req::get().cookie(&cookie))
        .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type").as_deref(), Some("model/stl"));
    assert_eq!(reply.header("content-length").as_deref(), Some("12"));
    assert_eq!(
        reply.header("content-disposition").as_deref(),
        Some("inline; filename*=UTF-8''benchy.stl")
    );
    assert_eq!(reply.text(), "solid benchy");
}

#[tokio::test]
async fn raw_and_thumb_require_a_session() {
    let server = TestServer::new();
    assert_eq!(server.get("/api/files/anything/raw").await.status, 401);
    assert_eq!(server.get("/api/files/anything/thumb").await.status, 401);
}

#[tokio::test]
async fn thumb_is_a_404_while_pending_and_a_png_once_ready() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let id = project["id"].as_str().unwrap();
    // A real Cura project in the project folder, which the queue then extracts the picture from.
    fs::write(
        server.dir().join("admin").join("Benchy").join("benchy.3mf"),
        cura_project(&png(300, 300)),
    )
    .unwrap();
    server
        .fetch("/api/projects/rescan", Req::post().cookie(&cookie))
        .await;

    let detail = project_detail(&server, &cookie, id).await;
    let pending = file_named(&detail, "benchy.3mf");
    assert_eq!(pending["previewState"], "pending");
    let thumb = server
        .fetch(
            &format!("/api/files/{}/thumb", pending["id"].as_str().unwrap()),
            Req::get().cookie(&cookie),
        )
        .await;
    assert_eq!(thumb.status, 404);

    run_preview_batch(server.lib(), &PreviewConfig::default()).unwrap();

    let detail = project_detail(&server, &cookie, id).await;
    let ready = file_named(&detail, "benchy.3mf");
    assert_eq!(ready["previewState"], "ready");
    let thumb_url = ready["thumbUrl"].as_str().unwrap();
    assert_eq!(
        thumb_url,
        format!("/api/files/{}/thumb", ready["id"].as_str().unwrap())
    );
    // And the project's cover is the same URL.
    assert_eq!(detail["coverThumbUrl"], thumb_url);

    let thumb = server.fetch(thumb_url, Req::get().cookie(&cookie)).await;
    assert_eq!(thumb.status, 200);
    assert_eq!(thumb.header("content-type").as_deref(), Some("image/png"));
    assert_eq!(
        thumb.header("cache-control").as_deref(),
        Some("private, max-age=60")
    );
}

/// The wiring `spm-server` does, end to end through the API: an STL carries no thumbnail of its
/// own, so the only thing that can put one behind this route is the rasterizer actually rendering
/// it.
#[tokio::test]
async fn thumb_serves_the_rasterized_png_for_a_plain_stl_model() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let id = project["id"].as_str().unwrap();
    fs::write(
        server.dir().join("admin").join("Benchy").join("cube.stl"),
        cube_stl(),
    )
    .unwrap();
    server
        .fetch("/api/projects/rescan", Req::post().cookie(&cookie))
        .await;

    run_preview_batch(server.lib(), &PreviewConfig::default()).unwrap();

    let detail = project_detail(&server, &cookie, id).await;
    let ready = file_named(&detail, "cube.stl");
    assert_eq!(ready["previewState"], "ready");

    let thumb = server
        .fetch(
            ready["thumbUrl"].as_str().unwrap(),
            Req::get().cookie(&cookie),
        )
        .await;
    assert_eq!(thumb.status, 200);
    assert_eq!(thumb.header("content-type").as_deref(), Some("image/png"));
    // The bytes the client receives, not just the row: a 256 pixel PNG is what was rendered.
    assert_eq!(png_size(&thumb.body), (256, 256));
}

#[tokio::test]
async fn rename_and_delete_work_through_the_api() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let file = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "a.stl",
        b"solid",
    )
    .await
    .json();
    let id = file["id"].as_str().unwrap();

    let renamed = server
        .fetch(
            &format!("/api/files/{id}"),
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "name": "b.stl" })),
        )
        .await;
    assert_eq!(renamed.json()["name"], "b.stl");

    let deleted = server
        .fetch(&format!("/api/files/{id}"), Req::delete().cookie(&cookie))
        .await;
    assert_eq!(deleted.status, 204);
    let raw = server
        .fetch(&format!("/api/files/{id}/raw"), Req::get().cookie(&cookie))
        .await;
    assert_eq!(raw.status, 404);
}

/// A file row can outlive its bytes (rescan marks a file `missing` without deleting the row, and
/// the bytes can vanish underneath the server at any time). Streaming its raw bytes must map that
/// to a 404, not fall through as an unhandled 500.
#[tokio::test]
async fn raw_is_a_404_not_a_500_when_the_bytes_are_gone_from_disk() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let file = upload(
        &server,
        &cookie,
        project["id"].as_str().unwrap(),
        "gone.stl",
        b"solid",
    )
    .await
    .json();

    fs::remove_file(server.dir().join("admin").join("Benchy").join("gone.stl")).unwrap();

    let reply = server
        .fetch(file["rawUrl"].as_str().unwrap(), Req::get().cookie(&cookie))
        .await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), "NotFound");
}

#[tokio::test]
async fn another_users_file_is_a_404() {
    let server = TestServer::new();
    let admin = server.login_as_admin().await;
    let (anna, _) = server.create_active_user(&admin, "anna").await;
    let project = server.new_project(&admin, "Benchy").await;
    let file = upload(
        &server,
        &admin,
        project["id"].as_str().unwrap(),
        "a.stl",
        b"solid",
    )
    .await
    .json();

    let reply = server
        .fetch(file["rawUrl"].as_str().unwrap(), Req::get().cookie(&anna))
        .await;
    assert_eq!(reply.status, 404);
}
