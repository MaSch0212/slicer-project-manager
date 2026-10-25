//! The static half of the former TypeScript server test `static.test.ts` that goes through the router
//! (`makeHandler serves non-API requests from the web root it was given`). The file-level cases
//! (`serveStatic`, `staticFilePath`, icon types) are unit tests in `src/static_files.rs`; the
//! default-web-root cases are in `spm-server` (`web.rs`, `env.rs`), where the default now lives.

use std::borrow::Cow;
use std::fs;
use std::sync::Arc;

use spm_http::{Assets, UiSource};

use crate::support::{Req, Setup, TestServer};

#[tokio::test]
async fn the_router_serves_non_api_requests_from_the_web_root_it_was_given() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("index.html"),
        "<!doctype html>from the configured root",
    )
    .unwrap();
    let server = TestServer::with(Setup {
        ui: Some(UiSource::dir(root.path())),
        ..Setup::default()
    });

    let reply = server.get("/projects/abc").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "<!doctype html>from the configured root");
    assert_eq!(
        reply.content_type().as_deref(),
        Some("text/html; charset=utf-8")
    );
}

#[tokio::test]
async fn an_unknown_api_path_never_falls_through_to_the_ui() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("index.html"), "<!doctype html>ui").unwrap();
    let server = TestServer::with(Setup {
        ui: Some(UiSource::dir(root.path())),
        ..Setup::default()
    });
    let reply = server.get("/api/nope").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), "NotFound");
    // `/api` itself is not an API path (there is no trailing slash), so it is the UI's.
    assert_eq!(server.get("/api").await.text(), "<!doctype html>ui");
}

#[tokio::test]
async fn without_a_ui_every_non_api_request_is_a_404() {
    let server = TestServer::new();
    let reply = server.get("/").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.text(), "not found");
}

struct Compiled;

impl Assets for Compiled {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        match path {
            "index.html" => Some(Cow::Borrowed(b"<!doctype html>embedded")),
            "favicon.svg" => Some(Cow::Borrowed(b"<svg/>")),
            _ => None,
        }
    }
}

#[tokio::test]
async fn any_assets_source_can_stand_in_for_a_directory() {
    let server = TestServer::with(Setup {
        ui: Some(UiSource::Assets(Arc::new(Compiled))),
        ..Setup::default()
    });
    assert_eq!(server.get("/").await.text(), "<!doctype html>embedded");
    assert_eq!(
        server.get("/deep/link").await.text(),
        "<!doctype html>embedded"
    );
    let icon = server.get("/favicon.svg").await;
    assert_eq!(icon.text(), "<svg/>");
    assert_eq!(icon.content_type().as_deref(), Some("image/svg+xml"));
}

#[tokio::test]
async fn the_ui_answers_any_method_like_the_legacy_static_handler() {
    let server = TestServer::with(Setup {
        ui: Some(UiSource::Assets(Arc::new(Compiled))),
        ..Setup::default()
    });
    let reply = server.fetch("/", Req::post().bytes("x")).await;
    assert_eq!(reply.status, 200);
}
