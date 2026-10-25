//! Ported from `legacy/server/test/logging.test.ts`.

use axum::body::Body;
use axum::http::Request;
use spm_core::log::{LogLevel, LogLevelSetting, LogRecord, LogValue};
use spm_core::testing::LogCapture;
use spm_core::{Library, OpenOptions};
use spm_http::{AppState, HttpOptions, router};
use tower::ServiceExt;

use crate::support::{Req, Setup, TestServer};

fn logged_server() -> TestServer {
    TestServer::with(Setup {
        logging: true,
        ..Setup::default()
    })
}

fn requests(logs: &LogCapture) -> Vec<LogRecord> {
    logs.records()
        .into_iter()
        .filter(|record| record.message == "request" || record.message == "request failed")
        .collect()
}

fn text(record: &LogRecord, name: &str) -> Option<String> {
    match record.field(name) {
        Some(LogValue::Str(value)) => Some(value.clone()),
        _ => None,
    }
}

#[tokio::test]
async fn every_api_request_is_logged_once_at_info_with_method_path_status_and_duration() {
    let server = logged_server();
    server.logs.clear();
    let reply = server.get("/api/capabilities").await;
    assert_eq!(reply.status, 200);

    let logged = requests(&server.logs);
    assert_eq!(logged.len(), 1, "expected exactly one request line");
    let record = &logged[0];
    assert_eq!(record.level, LogLevel::Info);
    assert_eq!(record.message, "request");
    assert_eq!(text(record, "method").as_deref(), Some("GET"));
    assert_eq!(text(record, "path").as_deref(), Some("/api/capabilities"));
    assert_eq!(record.field("status"), Some(&LogValue::Int(200)));
    assert!(matches!(record.field("ms"), Some(LogValue::UInt(_))));
    // Anonymous: the field is omitted rather than logged as an empty string.
    assert!(
        record.field("userId").is_none(),
        "an anonymous request carried a userId"
    );
}

#[tokio::test]
async fn an_authenticated_request_carries_the_resolved_user_id() {
    let server = logged_server();
    let cookie = server.login_as_admin().await;
    server.logs.clear();
    let reply = server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await;
    assert_eq!(reply.status, 200);

    let record = &requests(&server.logs)[0];
    assert_eq!(text(record, "path").as_deref(), Some("/api/projects"));
    assert!(text(record, "userId").is_some_and(|id| !id.is_empty()));
}

#[tokio::test]
async fn a_4xx_is_still_info_it_is_routine_not_a_server_fault() {
    let server = logged_server();
    server.logs.clear();
    let reply = server.get("/api/projects").await;
    assert_eq!(reply.status, 401);

    let record = &requests(&server.logs)[0];
    assert_eq!(record.level, LogLevel::Info);
    assert_eq!(record.field("status"), Some(&LogValue::Int(401)));
}

#[tokio::test]
async fn static_requests_log_at_debug_so_a_page_load_does_not_flood_the_default_level() {
    let server = logged_server();
    server.logs.clear();
    server.get("/some/asset.js").await;

    let record = server.logs.find("static").expect("a static record");
    assert_eq!(record.level, LogLevel::Debug);
    assert_eq!(text(&record, "path").as_deref(), Some("/some/asset.js"));
    // And nothing at info, which is the whole point of putting it a level down.
    assert!(
        server
            .logs
            .records()
            .iter()
            .all(|entry| entry.level != LogLevel::Info),
        "{:?}",
        server.logs.records()
    );
}

#[tokio::test]
async fn logging_stays_off_unless_the_host_asks_for_it() {
    // A library opened with a silent logger: the router must add nothing of its own.
    let dir = tempfile::tempdir().unwrap();
    let capture = LogCapture::default();
    let lib = Library::open(
        dir.path(),
        OpenOptions {
            logger: Some(capture.logger(LogLevelSetting::Silent)),
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let app = router(AppState::new(lib, HttpOptions::default()));
    for path in ["/api/capabilities", "/api/account", "/some/asset.js"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(response.status().as_u16() > 0);
    }
    assert!(capture.records().is_empty(), "{:?}", capture.records());
}

/// A 500 is the only response that logs its cause, and the client must see neither the internal
/// message nor anything like a stack. None of the real routes can be made to fail on demand, so
/// this takes a table out from under the database: the use case then fails with a database error,
/// which core reports as `Internal` with the SQLite message as its cause.
#[tokio::test]
async fn an_unexpected_failure_logs_its_cause_at_error_and_leaks_neither_it_nor_a_stack() {
    let server = logged_server();
    let cookie = server.login_as_admin().await;
    server
        .lib()
        .db()
        .execute_batch("ALTER TABLE projects RENAME TO projects_moved")
        .unwrap();
    server.logs.clear();

    let reply = server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await;
    assert_eq!(reply.status, 500);
    assert_eq!(
        reply.text(),
        r#"{"error":{"code":"Internal","message":"internal error","details":{}}}"#
    );

    let unhandled = server
        .logs
        .find("unhandled error")
        .expect("the throw is logged separately, so the cause is not lost");
    assert_eq!(unhandled.level, LogLevel::Error);
    let cause = text(&unhandled, "cause").expect("a cause");
    assert!(cause.contains("projects"), "{cause}");
    assert!(!reply.text().contains("projects"));
}

#[tokio::test]
async fn a_5xx_request_line_is_logged_at_error_not_info() {
    let server = logged_server();
    let cookie = server.login_as_admin().await;
    server
        .lib()
        .db()
        .execute_batch("ALTER TABLE projects RENAME TO projects_moved")
        .unwrap();
    server.logs.clear();

    server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await;

    let line = server
        .logs
        .find("request failed")
        .expect("a 500 was logged as an ordinary request");
    assert_eq!(line.level, LogLevel::Error);
    assert_eq!(line.field("status"), Some(&LogValue::Int(500)));
    assert_eq!(text(&line, "path").as_deref(), Some("/api/projects"));
    // The ordinary line must not also appear.
    assert!(server.logs.find("request").is_none());
    // And the cause is logged before the request line, so it is next to it in the output.
    let order: Vec<String> = server
        .logs
        .records()
        .into_iter()
        .map(|record| record.message)
        .collect();
    let cause_at = order.iter().position(|m| m == "unhandled error").unwrap();
    let line_at = order.iter().position(|m| m == "request failed").unwrap();
    assert!(cause_at < line_at, "{order:?}");
}
