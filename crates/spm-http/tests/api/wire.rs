//! What only a real socket can show: the peer address behind the rate limiter, and a body that
//! arrives in frames.

use std::net::{IpAddr, SocketAddr};

use axum::body::{Body, Bytes};
use axum::http::{Method, Request};
use futures_util::stream;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

use crate::support::{PASSWORD, TestServer, serve};

fn client_from(local: Option<&str>) -> Client<HttpConnector, Body> {
    let mut connector = HttpConnector::new();
    if let Some(local) = local {
        connector.set_local_address(Some(local.parse::<IpAddr>().unwrap()));
    }
    Client::builder(TokioExecutor::new()).build(connector)
}

async fn login_attempt(
    client: &Client<HttpConnector, Body>,
    server: SocketAddr,
    forwarded_for: &str,
) -> u16 {
    let body = serde_json::to_vec(&json!({
        "username": "admin",
        "password": "the wrong password entirely",
    }))
    .unwrap();
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("http://{server}/api/auth/login"))
        .header("content-type", "application/json")
        .header("x-forwarded-for", forwarded_for)
        .header("content-length", body.len())
        .body(Body::from(body))
        .unwrap();
    client.request(request).await.unwrap().status().as_u16()
}

#[tokio::test]
async fn the_rate_limiter_keys_on_the_tcp_peer_address_and_ignores_forwarded_for() {
    let server = TestServer::new();
    let address = serve(server.router.clone()).await;
    let client = client_from(None);

    // Ten attempts, each claiming to be somebody else: they all count against the one real peer.
    for attempt in 0..10 {
        let status = login_attempt(&client, address, &format!("203.0.113.{attempt}")).await;
        assert_eq!(status, 401);
    }
    assert_eq!(login_attempt(&client, address, "198.51.100.1").await, 429);

    // A different peer address is a different budget. The whole of 127.0.0.0/8 is loopback, so a
    // second client can connect from 127.0.0.2 without anything outside this machine.
    let other = client_from(Some("127.0.0.2"));
    assert_eq!(login_attempt(&other, address, "198.51.100.1").await, 401);
}

#[tokio::test]
async fn an_upload_streams_a_large_body_over_a_real_socket() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Big").await;
    let address = serve(server.router.clone()).await;

    // 48 MiB in 1 MiB frames, with the length declared up front.
    const FRAME: usize = 1024 * 1024;
    const FRAMES: usize = 48;
    let frames = (0..FRAMES).map(|index| {
        Ok::<_, std::convert::Infallible>(Bytes::from(vec![(index % 251) as u8; FRAME]))
    });
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "http://{address}/api/projects/{}/files",
            project["id"].as_str().unwrap()
        ))
        .header("cookie", &cookie)
        .header("x-spm-file-name", "big.stl")
        .header("content-length", FRAME * FRAMES)
        .body(Body::from_stream(stream::iter(frames)))
        .unwrap();
    let response = client_from(None).request(request).await.unwrap();
    assert_eq!(response.status(), 200);

    let stored = server.dir().join("admin").join("Big").join("big.stl");
    assert_eq!(
        std::fs::metadata(&stored).unwrap().len(),
        (FRAME * FRAMES) as u64
    );
    let bytes = std::fs::read(&stored).unwrap();
    for index in [0, 1, 17, 47] {
        assert_eq!(bytes[index * FRAME], (index % 251) as u8);
        assert_eq!(bytes[(index + 1) * FRAME - 1], (index % 251) as u8);
    }

    // And back out again, streamed, with the right length.
    let file: Value = {
        let list = server
            .get_json_with_cookie(
                &format!("/api/projects/{}", project["id"].as_str().unwrap()),
                &cookie,
            )
            .await;
        list["files"][0].clone()
    };
    let raw = Request::builder()
        .uri(format!(
            "http://{address}{}",
            file["rawUrl"].as_str().unwrap()
        ))
        .header("cookie", &cookie)
        .body(Body::empty())
        .unwrap();
    let response = client_from(None).request(raw).await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-length"],
        (FRAME * FRAMES).to_string().as_str()
    );
    let body = axum::body::to_bytes(Body::new(response.into_body()), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body.len(), FRAME * FRAMES);
    let _ = PASSWORD;
}

#[tokio::test]
async fn an_upload_that_ends_short_of_its_declared_length_leaves_nothing_behind() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Short").await;
    let address = serve(server.router.clone()).await;

    let frames = vec![Ok::<_, std::io::Error>(Bytes::from_static(b"solid short"))];
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "http://{address}/api/projects/{}/files",
            project["id"].as_str().unwrap()
        ))
        .header("cookie", &cookie)
        .header("x-spm-file-name", "short.stl")
        .header("content-length", 1000)
        .body(Body::from_stream(stream::iter(frames)))
        .unwrap();
    // The client stops after 11 of the 1000 bytes it promised. Whatever the client library
    // reports, the server must not keep a half-written file.
    let _ = client_from(None).request(request).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        !server
            .dir()
            .join("admin")
            .join("Short")
            .join("short.stl")
            .exists()
    );
}
