//! The run loop: the router mounted on a real listener with the UI, bootstrap and shutdown wired
//! as `spm-server` wires them.

use std::fs;

use spm_core::ensure_bootstrap_admin;
use spm_server::web::EmbeddedAssets;

use crate::common::{env_for, http, open, start};

#[tokio::test]
async fn the_server_answers_the_api_and_shuts_down_when_told_to() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path(), None);
    let server = start(lib, &env_for(dir.path(), 3_600_000)).await;

    let capabilities = http(server.addr, "GET", "/api/capabilities", &[]).await;
    assert_eq!(capabilities.status, 200);
    assert_eq!(capabilities.json()["requiresAuth"], true);
    assert_eq!(capabilities.json()["canManageUsers"], true);

    let missing = http(server.addr, "GET", "/api/nope", &[]).await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["error"]["code"], "NotFound");

    let unauthorised = http(server.addr, "GET", "/api/projects", &[]).await;
    assert_eq!(unauthorised.status, 401);

    // Graceful shutdown: the future resolves, the in-flight work drains, `run` returns Ok.
    server.stop().await;
}

#[tokio::test]
async fn spm_web_root_serves_a_directory_with_the_spa_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    fs::write(
        web.path().join("index.html"),
        "<!doctype html>from the directory",
    )
    .unwrap();
    fs::create_dir(web.path().join("assets")).unwrap();
    fs::write(web.path().join("assets").join("app.js"), "console.log(1)").unwrap();
    let mut env = env_for(dir.path(), 3_600_000);
    env.web_root = Some(web.path().to_path_buf());
    let server = start(open(dir.path(), None), &env).await;

    let index = http(server.addr, "GET", "/", &[]).await;
    assert_eq!(index.status, 200);
    assert_eq!(index.text(), "<!doctype html>from the directory");
    assert_eq!(
        index.header("content-type"),
        Some("text/html; charset=utf-8")
    );

    let asset = http(server.addr, "GET", "/assets/app.js", &[]).await;
    assert_eq!(
        asset.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );

    let deep = http(server.addr, "GET", "/projects/abc", &[]).await;
    assert_eq!(deep.text(), "<!doctype html>from the directory");

    // A traversal attempt falls through to index.html rather than leaking a file.
    fs::write(dir.path().join("secret.txt"), "do not serve me").unwrap();
    let traversal = http(server.addr, "GET", "/%2e%2e/secret.txt", &[]).await;
    assert_eq!(traversal.text(), "<!doctype html>from the directory");
    server.stop().await;
}

#[tokio::test]
async fn without_spm_web_root_the_embedded_bundle_is_served() {
    let dir = tempfile::tempdir().unwrap();
    let server = start(open(dir.path(), None), &env_for(dir.path(), 3_600_000)).await;

    let index = http(server.addr, "GET", "/", &[]).await;
    if EmbeddedAssets::has_index() {
        // The binary carries its own UI, and a deep link gets the same page.
        assert_eq!(index.status, 200);
        assert_eq!(
            index.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        let embedded =
            fs::read(std::path::Path::new(EmbeddedAssets::source_dir()).join("index.html"))
                .unwrap();
        assert_eq!(index.body, embedded);
        let deep = http(server.addr, "GET", "/some/client/route", &[]).await;
        assert_eq!(deep.body, embedded);
    } else {
        // Built without a bundle: there is no UI of its own to serve, and that is a plain 404.
        assert_eq!(index.status, 404);
    }
    server.stop().await;
}

#[tokio::test]
async fn the_activation_link_of_a_first_run_works_against_the_running_server() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path(), None);
    let boot = ensure_bootstrap_admin(&lib)
        .unwrap()
        .expect("a fresh library bootstraps");
    let server = start(lib, &env_for(dir.path(), 3_600_000)).await;

    let check = http(
        server.addr,
        "GET",
        &format!("/api/auth/activation/{}", boot.token),
        &[],
    )
    .await;
    assert_eq!(
        check.json(),
        serde_json::json!({ "valid": true, "username": "admin" })
    );
    server.stop().await;
}

#[tokio::test]
async fn the_public_origin_reaches_the_activation_links() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path(), None);
    let boot = ensure_bootstrap_admin(&lib).unwrap().unwrap();
    let mut env = env_for(dir.path(), 3_600_000);
    env.public_origin = Some("https://print.example.com".into());
    let server = start(lib, &env).await;

    // Activate through the API to get a session, then create a user and read the link.
    let body = r#"{"password":"a good long password","confirm":"a good long password"}"#;
    let activated = raw_post(
        server.addr,
        &format!("/api/auth/activation/{}", boot.token),
        &[("content-type", "application/json")],
        body,
    )
    .await;
    assert_eq!(activated.status, 200);
    let cookie = activated
        .header("set-cookie")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let created = raw_post(
        server.addr,
        "/api/users",
        &[("content-type", "application/json"), ("cookie", &cookie)],
        r#"{"username":"anna","displayName":"Anna"}"#,
    )
    .await;
    assert_eq!(created.status, 200, "{}", created.text());
    assert!(
        created.json()["activationUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://print.example.com/activate#")
    );
    server.stop().await;
}

async fn raw_post(
    addr: std::net::SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> crate::common::Response {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect();
    crate::common::Response {
        status,
        headers,
        body: rest.as_bytes().to_vec(),
    }
}

// ---- the startup sequence, on loopback ------------------------------------------------------
//
// `spm-server` itself binds every interface, which raises a firewall prompt on a developer's
// machine for each new test binary, so these drive `serve_on` and friends on 127.0.0.1.

use std::net::{IpAddr, Ipv4Addr, TcpListener};

use spm_core::log::{LogLevel, LogLevelSetting};
use spm_core::testing::LogCapture;
use spm_server::serve::{announce_bootstrap_to, serve_on, warn_removed_variables};

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn first_run_prints_a_working_activation_path_and_a_restart_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path(), None);
    let mut out = Vec::new();
    announce_bootstrap_to(&lib, &mut out).unwrap();
    let line = String::from_utf8(out).unwrap();

    // `First run: activate "admin" at /activate#<token>`
    assert!(
        line.starts_with("First run: activate \"admin\" at /activate#"),
        "{line}"
    );
    let token = line.trim_end().rsplit_once("/activate#").unwrap().1;
    assert_eq!(token.len(), 43, "{line}");
    // The printed token is the real one.
    let check =
        spm_core::auth::activation::check_activation_token(&lib, token, spm_core::clock::now_ms())
            .unwrap();
    assert!(check.valid);
    assert_eq!(check.username.as_deref(), Some("admin"));

    // Same library again: the admin exists, so there is nothing to announce.
    let mut again = Vec::new();
    announce_bootstrap_to(&lib, &mut again).unwrap();
    assert!(again.is_empty());
}

#[test]
fn the_first_run_line_does_not_depend_on_the_log_level() {
    // It is an instruction to the operator, not a log record: with logging off and no line, the
    // first run would be unrecoverable.
    let dir = tempfile::tempdir().unwrap();
    let capture = LogCapture::default();
    let lib = open(dir.path(), Some(capture.logger(LogLevelSetting::Silent)));
    let mut out = Vec::new();
    announce_bootstrap_to(&lib, &mut out).unwrap();
    assert!(
        String::from_utf8(out)
            .unwrap()
            .starts_with("First run: activate")
    );
    assert!(capture.records().is_empty());
}

#[test]
fn a_leftover_spm_max_step_mb_warns_and_nothing_else() {
    let capture = LogCapture::default();
    let log = capture.logger(LogLevelSetting::Trace);
    warn_removed_variables(&log, &|name| name == "SPM_MAX_STEP_MB");
    let warning = capture.records().pop().expect("a warning");
    assert_eq!(warning.level, LogLevel::Warn);
    assert!(warning.message.contains("SPM_MAX_STEP_MB is ignored"));

    capture.clear();
    warn_removed_variables(&log, &|_| false);
    assert!(capture.records().is_empty());
}

#[tokio::test]
async fn the_whole_startup_sequence_serves_and_stops_on_the_signal() {
    let dir = tempfile::tempdir().unwrap();
    let mut env = env_for(dir.path(), 3_600_000);
    env.port = free_port();
    let port = env.port;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(serve_on(env, IpAddr::V4(Ipv4Addr::LOCALHOST), async {
        let _ = stopped.await;
    }));

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut reply = None;
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            reply = Some(http(addr, "GET", "/api/capabilities", &[]).await);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(reply.expect("the server came up").status, 200);
    // The library was created and the admin bootstrapped by the sequence itself.
    assert!(dir.path().join(".spm").join("app.db").exists());
    assert!(dir.path().join("admin").is_dir());

    let _ = stop.send(());
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .expect("shuts down promptly")
        .unwrap();
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn a_port_that_is_taken_is_a_one_line_error() {
    let dir = tempfile::tempdir().unwrap();
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut env = env_for(dir.path(), 3_600_000);
    env.port = taken.local_addr().unwrap().port();
    let result = serve_on(
        env.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        std::future::pending(),
    )
    .await;
    let message = result.unwrap_err();
    assert!(
        message.starts_with(&format!("could not listen on port {}: ", env.port)),
        "{message}"
    );
    assert_eq!(message.lines().count(), 1);
}
