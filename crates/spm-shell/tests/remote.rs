//! Ported from the Electron shell's `remote.test.ts`: the reverse proxy for remote-server mode,
//! driven against a real upstream server on loopback. (The Electron suite injected a fake `fetch`;
//! here the upstream is a real listener, so what is asserted is what a real server saw.)

mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use futures_util::StreamExt;
use serde_json::{Value, json};
use spm_shell::capabilities::REMOTE_SHELL_CAPABILITIES;
use spm_shell::remote::{
    RemoteHost, declared_upload_length, is_plaintext_to_another_machine, is_redirect,
    parse_remote_origin,
};
use support::{Upstream, answer, body_bytes, body_json, eventually, proxy_request};

fn json_reply(status: u16, body: &Value) -> axum::response::Response {
    answer(
        status,
        &[("content-type", "application/json")],
        body.to_string(),
    )
}

/// A body of `chunks`, delivered as a stream: no length, as a streamed upload has none.
fn streamed(chunks: Vec<Vec<u8>>) -> Body {
    Body::from_stream(futures_util::stream::iter(
        chunks.into_iter().map(Ok::<_, std::io::Error>),
    ))
}

fn capabilities_json(requires_auth: bool, can_manage_users: bool) -> Value {
    json!({
        "requiresAuth": requires_auth,
        "canManageUsers": can_manage_users,
        "canPickLocalFolder": false,
        "canLaunchSlicer": false,
        "canConfigureSlicers": false,
        "canBrowseModelSites": false,
    })
}

// ---- parse_remote_origin -------------------------------------------------------------------------

#[test]
fn a_server_url_is_reduced_to_an_origin_or_refused_with_a_reason() {
    for (typed, origin) in [
        ("https://print.example.com", "https://print.example.com"),
        (
            "  https://print.example.com/  ",
            "https://print.example.com",
        ),
        ("http://192.168.1.20:8080", "http://192.168.1.20:8080"),
        ("https://example.com:443", "https://example.com"),
        ("HTTPS://EXAMPLE.COM", "https://example.com"),
        ("http://[::1]:8080", "http://[::1]:8080"),
    ] {
        assert_eq!(parse_remote_origin(typed).unwrap(), origin, "{typed:?}");
    }
    for (typed, reason) in [
        ("", "a server URL is required"),
        ("   ", "a server URL is required"),
        ("not a url", "not a URL"),
        ("file:///etc/passwd", "must be http or https, not file:"),
        ("ftp://example.com", "must be http or https, not ftp:"),
        (
            "javascript:alert(1)",
            "must be http or https, not javascript:",
        ),
        ("data:text/html,hi", "must be http or https, not data:"),
        ("https://user:pw@example.com", "username or a password"),
        ("https://user@example.com", "username or a password"),
        ("https://example.com?x=1", "query string or a fragment"),
        ("https://example.com/#top", "query string or a fragment"),
        ("https://example.com/api", "an origin, not a path: /api"),
    ] {
        let error = parse_remote_origin(typed).unwrap_err();
        assert_eq!(error.code.as_str(), "Validation", "{typed:?}");
        assert!(
            error.message.contains(reason),
            "{typed:?}: {}",
            error.message
        );
    }
}

#[test]
fn plain_http_to_another_machine_is_warned_about_and_to_this_one_is_not() {
    for (origin, warned) in [
        ("http://192.168.1.20:8080", true),
        ("http://print.example.com", true),
        ("https://print.example.com", false),
        ("http://localhost:3000", false),
        ("http://127.0.0.1:3000", false),
        ("http://[::1]:3000", false),
    ] {
        assert_eq!(is_plaintext_to_another_machine(origin), warned, "{origin}");
    }
}

// ---- what reaches the server ---------------------------------------------------------------------

#[tokio::test]
async fn a_request_reaches_the_server_with_its_method_path_query_and_body() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({ "ok": true }))).await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request(
            "POST",
            "/api/projects?limit=5&q=a%20b",
            &[("content-type", "application/json")],
            r#"{"name":"Benchy"}"#,
        ))
        .await;
    assert_eq!(reply.status(), 200);
    let seen = upstream.last();
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.target, "/api/projects?limit=5&q=a%20b");
    assert_eq!(seen.body, br#"{"name":"Benchy"}"#);
}

#[tokio::test]
async fn only_the_three_allowed_request_headers_are_forwarded() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    host.proxy(proxy_request(
        "POST",
        "/api/projects",
        &[
            ("content-type", "application/json"),
            ("accept", "application/json"),
            ("x-spm-file-name", "benchy.stl"),
            ("x-forwarded-for", "10.0.0.9"),
            ("authorization", "Bearer secret"),
            ("cookie", "spm_launch=the-launch-secret; evil=1"),
            ("origin", "http://127.0.0.1:41234"),
            ("referer", "http://127.0.0.1:41234/projects"),
            ("x-custom", "1"),
        ],
        "{}",
    ))
    .await;
    let seen = upstream.last();
    for kept in ["content-type", "accept", "x-spm-file-name"] {
        assert!(seen.headers.contains_key(kept), "{kept} was dropped");
    }
    // The launch cookie must never leave the machine, and a server must see no `Origin` from this
    // app (so that no CORS decision is ever made about it).
    for dropped in [
        "x-forwarded-for",
        "authorization",
        "cookie",
        "origin",
        "referer",
        "x-custom",
    ] {
        assert!(!seen.headers.contains_key(dropped), "{dropped} leaked");
    }
}

#[tokio::test]
async fn a_status_and_body_the_server_answers_with_come_back_unchanged() {
    let envelope = json!({ "error": { "code": "QuotaExceeded", "message": "no", "details": {
        "usageBytes": 10, "quotaBytes": 5 } } });
    let expected = envelope.clone();
    let upstream = Upstream::start(move |_| json_reply(413, &envelope)).await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request("POST", "/api/projects/p/files", &[], "x"))
        .await;
    assert_eq!(reply.status(), 413);
    // The details survive the boundary: the UI builds its quota sentence out of them.
    assert_eq!(body_json(reply).await, expected);
}

#[tokio::test]
async fn a_server_that_cannot_be_reached_is_a_502_carrying_the_app_error_envelope() {
    let closed = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let origin = format!("http://127.0.0.1:{closed}");
    let host = RemoteHost::new(&origin);
    let reply = host
        .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
        .await;
    assert_eq!(reply.status(), 502);
    let body = body_json(reply).await;
    assert_eq!(body["error"]["code"], "Internal");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains(&format!("could not reach {origin}")),
        "{message}"
    );
}

#[tokio::test]
async fn nothing_outside_api_can_be_asked_for_through_the_proxy() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    for path in [
        "/projects",
        "/apifoo",
        "/api",
        "/",
        "/_spm/handshake",
        // Dot segments, in every spelling a URL parser would normalise out of `/api`.
        "/api/../admin",
        "/api/%2e%2e/admin",
        "/api/%2E%2E/admin",
        "/api/./x/../../admin",
    ] {
        let reply = host
            .proxy(proxy_request("GET", path, &[], Body::empty()))
            .await;
        assert_eq!(reply.status(), 404, "{path}");
    }
    assert!(
        upstream.requests().is_empty(),
        "no request left the machine"
    );
}

#[tokio::test]
async fn a_method_the_web_client_never_uses_is_refused_before_anything_leaves() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    for method in ["OPTIONS", "HEAD", "TRACE", "CONNECT"] {
        let reply = host
            .proxy(proxy_request(method, "/api/projects", &[], Body::empty()))
            .await;
        assert_eq!(reply.status(), 405, "{method}");
    }
    assert!(upstream.requests().is_empty());
}

#[tokio::test]
async fn a_redirect_is_refused_named_and_never_followed() {
    let elsewhere = Upstream::start(|_| json_reply(200, &json!({ "secret": "other host" }))).await;
    for status in [301u16, 302, 303, 307, 308] {
        let target = format!("{}/_cluster/health", elsewhere.origin);
        let location = target.clone();
        let upstream = Upstream::start(move |_| {
            answer(
                status,
                &[("location", &location), ("set-cookie", "x=1")],
                "moved",
            )
        })
        .await;
        let host = RemoteHost::new(&upstream.origin);
        let reply = host
            .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
            .await;
        assert_eq!(reply.status(), 502, "{status}");
        assert!(
            reply.headers().get("location").is_none(),
            "{status}: location leaked"
        );
        let body = body_json(reply).await;
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains(&target), "{status}: {message}");
        assert!(message.contains("does not follow redirects"), "{message}");
        assert!(
            !host.has_session(),
            "a refused redirect's cookie is not taken"
        );
    }
    assert!(
        elsewhere.requests().is_empty(),
        "the target was never fetched"
    );
}

#[tokio::test]
async fn a_304_is_passed_through_because_it_is_not_a_redirect() {
    let upstream = Upstream::start(|_| answer(304, &[], Body::empty())).await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request(
            "GET",
            "/api/files/f/thumb",
            &[],
            Body::empty(),
        ))
        .await;
    assert_eq!(reply.status(), 304);
    for status in [300u16, 301, 302, 303, 307, 308] {
        assert!(is_redirect(status), "{status}");
    }
    for status in [200u16, 204, 304, 400, 404, 500] {
        assert!(!is_redirect(status), "{status}");
    }
}

// ---- the session ---------------------------------------------------------------------------------

#[tokio::test]
async fn the_session_is_carried_by_the_shell_replayed_and_never_handed_back() {
    let upstream = Upstream::start(|seen| {
        if seen.target == "/api/auth/login" {
            answer(
                200,
                &[
                    ("content-type", "application/json"),
                    (
                        "set-cookie",
                        "spm_session=token123; Path=/; HttpOnly; SameSite=Lax; Secure",
                    ),
                ],
                "{}",
            )
        } else {
            json_reply(200, &json!({ "cookie": seen.header("cookie") }))
        }
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);

    let login = host
        .proxy(proxy_request("POST", "/api/auth/login", &[], "{}"))
        .await;
    // Neither `Secure` nor `SameSite` can matter: the cookie never reaches the webview at all.
    assert!(login.headers().get("set-cookie").is_none());
    assert!(host.has_session());

    // A cookie the webview tries to send is not what the server sees: the jar's is.
    let next = host
        .proxy(proxy_request(
            "GET",
            "/api/account",
            &[("cookie", "spm_session=forged; other=1")],
            Body::empty(),
        ))
        .await;
    assert_eq!(
        body_json(next).await["cookie"],
        json!("spm_session=token123")
    );
}

#[tokio::test]
async fn a_logout_clears_the_session_by_any_of_the_spellings_the_server_uses() {
    for clearing in [
        "spm_session=; Max-Age=0; Path=/",
        "spm_session=; Path=/",
        "spm_session=token123; Max-Age=0; Path=/",
    ] {
        let upstream = Upstream::start(move |seen| match seen.target.as_str() {
            "/api/auth/login" => answer(200, &[("set-cookie", "spm_session=token123")], "{}"),
            "/api/auth/logout" => answer(200, &[("set-cookie", clearing)], "{}"),
            _ => json_reply(200, &json!({})),
        })
        .await;
        let host = RemoteHost::new(&upstream.origin);
        host.proxy(proxy_request("POST", "/api/auth/login", &[], "{}"))
            .await;
        assert!(host.has_session());
        host.proxy(proxy_request("POST", "/api/auth/logout", &[], "{}"))
            .await;
        assert!(!host.has_session(), "{clearing}");
        host.proxy(proxy_request("GET", "/api/account", &[], Body::empty()))
            .await;
        assert!(upstream.last().header("cookie").is_none(), "{clearing}");
    }
}

#[tokio::test]
async fn the_session_dies_with_the_host_and_a_new_one_starts_logged_out() {
    let upstream = Upstream::start(|seen| {
        if seen.target == "/api/auth/login" {
            answer(200, &[("set-cookie", "spm_session=token123")], "{}")
        } else {
            json_reply(200, &json!({}))
        }
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);
    host.proxy(proxy_request("POST", "/api/auth/login", &[], "{}"))
        .await;
    assert!(host.has_session());
    host.close();
    assert!(!host.has_session());

    let fresh = RemoteHost::new(&upstream.origin);
    fresh
        .proxy(proxy_request("GET", "/api/account", &[], Body::empty()))
        .await;
    assert!(upstream.last().header("cookie").is_none());
}

#[tokio::test]
async fn closing_a_host_cancels_the_request_it_still_has_in_flight() {
    let upstream = Upstream::start_async(|_| Box::pin(std::future::pending())).await;
    let host = Arc::new(RemoteHost::new(&upstream.origin));
    let pending = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
                .await
        })
    };
    eventually(
        Duration::from_secs(5),
        "the request reached the server",
        || !upstream.requests().is_empty(),
    )
    .await;
    host.close();
    let reply = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .expect("a closed host does not leave a request hanging")
        .unwrap();
    assert_eq!(reply.status(), 502);
    assert_eq!(body_json(reply).await["error"]["code"], "Internal");
}

#[tokio::test]
async fn a_closed_host_refuses_rather_than_reaching_the_server_it_has_been_let_go_of() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    host.close();
    let reply = host
        .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
        .await;
    assert_eq!(reply.status(), 503);
    assert!(upstream.requests().is_empty());
}

// ---- uploads -------------------------------------------------------------------------------------

#[tokio::test]
async fn a_declared_upload_length_becomes_a_real_content_length_upstream() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    let chunks = vec![vec![1u8; 25_000]; 4];
    host.proxy(proxy_request(
        "POST",
        "/api/projects/p/files",
        &[
            ("x-spm-content-length", "100000"),
            ("x-spm-file-name", "a.stl"),
        ],
        streamed(chunks),
    ))
    .await;
    let seen = upstream.last();
    assert_eq!(seen.header("content-length").as_deref(), Some("100000"));
    assert!(seen.header("transfer-encoding").is_none(), "not chunked");
    assert!(
        !seen.headers.contains_key("x-spm-content-length"),
        "the declaration is not forwarded itself"
    );
    assert!(seen.complete);
    assert_eq!(seen.body.len(), 100_000);
}

#[tokio::test]
async fn the_content_length_a_webview_sets_on_a_blob_upload_is_honoured_too() {
    // A webview's `fetch` and `XMLHttpRequest` set a real `Content-Length` for a `Blob` body, so
    // no declaration header is needed; and the declaration wins when both are present.
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    host.proxy(proxy_request(
        "POST",
        "/api/projects/p/files",
        &[("content-length", "5")],
        streamed(vec![b"hello".to_vec()]),
    ))
    .await;
    let seen = upstream.last();
    assert_eq!(seen.header("content-length").as_deref(), Some("5"));
    assert!(seen.header("transfer-encoding").is_none());
    assert_eq!(seen.body, b"hello");
}

#[tokio::test]
async fn a_body_with_no_declared_length_is_streamed_and_the_server_sees_no_length() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    host.proxy(proxy_request(
        "POST",
        "/api/projects/p/files",
        &[],
        streamed(vec![b"abc".to_vec(), b"def".to_vec()]),
    ))
    .await;
    let seen = upstream.last();
    assert!(seen.header("content-length").is_none());
    assert_eq!(seen.header("transfer-encoding").as_deref(), Some("chunked"));
    assert_eq!(seen.body, b"abcdef");
}

#[tokio::test]
async fn a_declared_length_that_is_not_a_plain_integer_is_ignored_not_forwarded() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    for declared in ["-1", "1.5", "1e3", "0x10", "", "+5", "12 ", "٣"] {
        host.proxy(proxy_request(
            "POST",
            "/api/projects/p/files",
            &[("x-spm-content-length", declared)],
            streamed(vec![b"abc".to_vec()]),
        ))
        .await;
        let seen = upstream.last();
        assert!(
            seen.header("content-length").is_none(),
            "{declared:?} was forwarded as {:?}",
            seen.header("content-length")
        );
        assert_eq!(seen.body, b"abc", "{declared:?}");
    }
    // The parser, directly.
    let headers = |value: &str| {
        let mut map = axum::http::HeaderMap::new();
        map.insert("x-spm-content-length", value.parse().unwrap());
        map
    };
    assert_eq!(declared_upload_length(&headers("100000")), Some(100_000));
    assert_eq!(declared_upload_length(&headers("-1")), None);
    assert_eq!(declared_upload_length(&axum::http::HeaderMap::new()), None);
}

#[tokio::test]
async fn a_declared_length_that_disagrees_with_the_body_fails_the_request_not_the_server() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request(
            "POST",
            "/api/projects/p/files",
            &[("x-spm-content-length", "1000")],
            streamed(vec![b"ten bytes!".to_vec()]),
        ))
        .await;
    assert_eq!(reply.status(), 502);
    assert_eq!(body_json(reply).await["error"]["code"], "Internal");
    // Whatever the server saw, it did not see a complete 1000-byte upload.
    assert!(
        upstream
            .requests()
            .iter()
            .all(|seen| !(seen.complete && seen.body.len() == 1000)),
    );
    // And the host is still good for the next request.
    let next = host
        .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
        .await;
    assert_eq!(next.status(), 200);
}

// ---- what comes back -----------------------------------------------------------------------------

#[tokio::test]
async fn every_proxied_response_carries_the_forced_headers_whatever_the_server_said() {
    let upstream = Upstream::start(|seen| match seen.target.as_str() {
        "/api/files/f/raw" => answer(
            200,
            &[
                ("content-type", "text/html"),
                ("x-content-type-options", "sniff"),
                ("content-security-policy", "default-src *"),
            ],
            "<script>window.pwned = true</script>",
        ),
        _ => json_reply(
            500,
            &json!({ "error": { "code": "Internal", "message": "x" } }),
        ),
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);
    for target in ["/api/files/f/raw", "/api/projects"] {
        let reply = host
            .proxy(proxy_request("GET", target, &[], Body::empty()))
            .await;
        assert_eq!(
            reply.headers()["content-security-policy"],
            "default-src 'none'; sandbox",
            "{target}"
        );
        assert_eq!(
            reply.headers()["x-content-type-options"],
            "nosniff",
            "{target}"
        );
    }
    // The shell's own failures carry them too.
    let refused = host
        .proxy(proxy_request("GET", "/elsewhere", &[], Body::empty()))
        .await;
    assert_eq!(
        refused.headers()["content-security-policy"],
        "default-src 'none'; sandbox"
    );
}

#[tokio::test]
async fn the_server_gets_no_say_in_cors_and_the_app_adds_none() {
    let upstream = Upstream::start(|_| json_reply(200, &json!({}))).await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request("GET", "/api/projects", &[], Body::empty()))
        .await;
    assert!(
        reply
            .headers()
            .keys()
            .all(|name| !name.as_str().starts_with("access-control-"))
    );
    assert!(!upstream.last().headers.contains_key("origin"));
}

#[tokio::test]
async fn a_body_the_server_sends_is_passed_on_as_it_arrives_and_undecoded() {
    // Streaming: the first chunk is in the webview's hands while the server is still producing.
    let slow = Upstream::start_async(|_| {
        Box::pin(async {
            let stream = futures_util::stream::unfold(0u8, |step| async move {
                if step >= 3 {
                    return None;
                }
                if step > 0 {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
                Some((Ok::<_, std::io::Error>(vec![b'a' + step; 4]), step + 1))
            });
            answer(
                200,
                &[("content-type", "application/octet-stream")],
                Body::from_stream(stream),
            )
        })
    })
    .await;
    let host = RemoteHost::new(&slow.origin);
    let started = std::time::Instant::now();
    let reply = host
        .proxy(proxy_request("GET", "/api/files/f/raw", &[], Body::empty()))
        .await;
    let mut body = reply.into_body().into_data_stream();
    let first = body.next().await.unwrap().unwrap();
    assert_eq!(&first[..], b"aaaa");
    assert!(
        started.elapsed() < Duration::from_millis(700),
        "the first chunk waited for the last: {:?}",
        started.elapsed()
    );
    let mut rest = Vec::new();
    while let Some(chunk) = body.next().await {
        rest.extend(chunk.unwrap());
    }
    assert_eq!(rest, b"bbbbcccc");

    // Undecoded: a gzip body with its `content-encoding` and `content-length` arrives as sent.
    let gzipped = {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"the same bytes").unwrap();
        encoder.finish().unwrap()
    };
    let wire = gzipped.clone();
    let upstream = Upstream::start(move |_| {
        answer(
            200,
            &[
                ("content-encoding", "gzip"),
                ("content-length", &wire.len().to_string()),
            ],
            wire.clone(),
        )
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request("GET", "/api/files/f/raw", &[], Body::empty()))
        .await;
    assert_eq!(reply.headers()["content-encoding"], "gzip");
    assert_eq!(
        reply.headers()["content-length"],
        gzipped.len().to_string().as_str()
    );
    assert_eq!(body_bytes(reply).await, gzipped);
    assert!(upstream.last().header("accept-encoding").is_none());
}

// ---- capabilities --------------------------------------------------------------------------------

#[tokio::test]
async fn capabilities_come_back_as_the_union_of_the_shell_column_and_the_server_one() {
    let upstream = Upstream::start(|_| json_reply(200, &capabilities_json(true, true))).await;
    let host = RemoteHost::new(&upstream.origin);

    let proxied = host
        .proxy(proxy_request(
            "GET",
            "/api/capabilities",
            &[],
            Body::empty(),
        ))
        .await;
    assert_eq!(proxied.status(), 200);
    let proxied = body_json(proxied).await;
    // The server's flags merged with the shell's remote column.
    let mut expected = serde_json::to_value(REMOTE_SHELL_CAPABILITIES).unwrap();
    expected["requiresAuth"] = json!(true);
    expected["canManageUsers"] = json!(true);
    assert_eq!(proxied, expected);

    // The direct call answers the same.
    let direct = host.capabilities().await.unwrap();
    assert_eq!(serde_json::to_value(direct).unwrap(), expected);
}

#[tokio::test]
async fn a_capabilities_answer_that_is_not_one_is_passed_through_rather_than_unioned() {
    let upstream = Upstream::start(|_| {
        json_reply(
            200,
            &json!({ "message": "welcome to a proxy's error page" }),
        )
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);
    let reply = host
        .proxy(proxy_request(
            "GET",
            "/api/capabilities",
            &[],
            Body::empty(),
        ))
        .await;
    assert_eq!(reply.status(), 200);
    assert_eq!(
        body_json(reply).await,
        json!({ "message": "welcome to a proxy's error page" })
    );
    // The direct call, which the shell relies on, rejects it.
    let error = host.capabilities().await.unwrap_err();
    assert_eq!(error.code.as_str(), "Internal");
    assert!(
        error.message.contains(&upstream.origin),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn only_a_200_get_on_the_capabilities_path_is_unioned() {
    let upstream = Upstream::start(|seen| {
        if seen.method == "POST" {
            json_reply(200, &capabilities_json(true, true))
        } else {
            json_reply(500, &capabilities_json(true, true))
        }
    })
    .await;
    let host = RemoteHost::new(&upstream.origin);
    let failed = host
        .proxy(proxy_request(
            "GET",
            "/api/capabilities",
            &[],
            Body::empty(),
        ))
        .await;
    assert_eq!(failed.status(), 500);
    assert_eq!(body_json(failed).await, capabilities_json(true, true));

    let posted = host
        .proxy(proxy_request("POST", "/api/capabilities", &[], "{}"))
        .await;
    assert_eq!(posted.status(), 200);
    // Not merged: the shell's column has no `canPickLocalFolder`, and the body is the server's.
    assert_eq!(body_json(posted).await, capabilities_json(true, true));
}
