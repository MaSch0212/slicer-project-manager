//! Ported from the former TypeScript server test `dev-proxy.test.ts` (the two origin-resolution cases are unit
//! tests in `src/dev_proxy.rs`).
//!
//! The legacy suite injected `fetch` and fake sockets. Here the upstream is a real listener the
//! test controls byte for byte, so what is asserted is what a dev server would actually receive.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use spm_core::log::LogLevel;
use spm_http::dev_proxy::START_COMMAND;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{
    Request as WsRequest, Response as WsResponse,
};

use crate::support::{Req, Setup, TestServer, serve};

/// A one-shot HTTP upstream: reads one request (headers and body), reports it as text, answers
/// with `response` verbatim, and closes.
async fn raw_upstream(response: &'static str) -> (SocketAddr, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = mpsc::channel(1);
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            seen.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&seen).into_owned();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .to_ascii_lowercase()
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: ").map(str::to_owned))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if seen.len() >= end + 4 + length || read == 0 {
                    break;
                }
            } else if read == 0 {
                break;
            }
        }
        sent.send(String::from_utf8_lossy(&seen).into_owned())
            .await
            .unwrap();
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    (address, received)
}

fn proxied(origin: &str, logging: bool) -> TestServer {
    TestServer::with(Setup {
        logging,
        proxy: Some(origin.to_owned()),
        ..Setup::default()
    })
}

fn header_of<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

#[tokio::test]
async fn a_request_is_forwarded_to_the_dev_server_with_its_path_query_and_method() {
    let (address, mut received) =
        raw_upstream("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok")
            .await;
    let server = proxied(&format!("http://{address}"), false);

    let reply = server.get("/main.js?v=2").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "ok");
    let request = received.recv().await.unwrap();
    assert!(
        request.starts_with("GET /main.js?v=2 HTTP/1.1\r\n"),
        "{request}"
    );

    // And a method with a body keeps both.
    let (address, mut received) =
        raw_upstream("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n").await;
    let server = proxied(&format!("http://{address}"), false);
    let reply = server.fetch("/save", Req::post().bytes("payload")).await;
    assert_eq!(reply.status, 204);
    let request = received.recv().await.unwrap();
    assert!(request.starts_with("POST /save HTTP/1.1\r\n"), "{request}");
    assert!(request.ends_with("payload"), "{request}");
    assert_eq!(header_of(&request, "content-length"), Some("7"));
}

#[tokio::test]
async fn hop_by_hop_headers_are_stripped_in_both_directions() {
    let (address, mut received) = raw_upstream(concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/javascript\r\n",
        "Connection: close\r\n",
        "Keep-Alive: timeout=5\r\n",
        "Transfer-Encoding: chunked\r\n\r\n",
        "2\r\nok\r\n0\r\n\r\n",
    ))
    .await;
    let server = proxied(&format!("http://{address}"), false);

    let reply = server
        .fetch(
            "/main.js",
            Req::get()
                .host(Some("localhost:8000"))
                .header("accept", "text/javascript")
                .header("connection", "keep-alive")
                .header("keep-alive", "timeout=9")
                .header("te", "trailers"),
        )
        .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "ok");

    let request = received.recv().await.unwrap();
    // A forwarded `host` would point the dev server at the proxy's own origin.
    assert_eq!(
        header_of(&request, "host"),
        Some(address.to_string().as_str()),
        "{request}"
    );
    assert_eq!(header_of(&request, "keep-alive"), None, "{request}");
    assert_eq!(header_of(&request, "te"), None, "{request}");
    assert_eq!(header_of(&request, "accept"), Some("text/javascript"));

    assert!(reply.header("connection").is_none());
    assert!(reply.header("keep-alive").is_none());
    assert!(reply.header("transfer-encoding").is_none());
    assert_eq!(
        reply.header("content-type").as_deref(),
        Some("text/javascript")
    );
}

#[tokio::test]
async fn an_unreachable_dev_server_answers_502_saying_how_to_start_it() {
    // A port nothing listens on: bind, note, drop.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };
    let origin = format!("http://{closed}");
    let server = proxied(&origin, true);
    server.logs.clear();

    let reply = server.get("/").await;
    assert_eq!(reply.status, 502);
    let body = reply.text();
    // The fix is a second terminal, not a code change, so the response has to say so.
    assert!(body.contains(START_COMMAND), "{body}");
    assert!(body.contains(&origin), "{body}");
    assert_eq!(
        reply.content_type().as_deref(),
        Some("text/plain; charset=utf-8")
    );
    let warning = server
        .logs
        .records()
        .into_iter()
        .find(|record| record.message.contains("could not reach"))
        .expect("a warning");
    assert_eq!(warning.level, LogLevel::Warn);
}

#[tokio::test]
async fn an_https_dev_origin_is_accepted_but_answers_502() {
    // Documented limit: the upstream client speaks plain http only.
    let server = proxied("https://localhost:5173", false);
    let reply = server.get("/").await;
    assert_eq!(reply.status, 502);
}

// ---- websockets -----------------------------------------------------------------------------

/// What the fake upstream saw of the handshake, and everything it received afterwards.
struct Upstream {
    address: SocketAddr,
    handshake: mpsc::Receiver<(String, Option<String>)>,
    messages: mpsc::Receiver<Message>,
    /// Messages for the upstream to send once connected.
    to_client: mpsc::Sender<Message>,
}

/// A websocket dev server that echoes the first subprotocol it was offered, optionally dawdling
/// before it answers the handshake.
#[allow(clippy::result_large_err)] // tungstenite fixes the callback's error type
async fn ws_upstream(delay: Duration) -> Upstream {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (handshake_tx, handshake) = mpsc::channel(1);
    let (message_tx, messages) = mpsc::channel(64);
    let (to_client, mut outgoing) = mpsc::channel::<Message>(8);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(delay).await;
        let socket = tokio_tungstenite::accept_hdr_async(
            stream,
            move |request: &WsRequest, mut response: WsResponse| {
                let protocol = request
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let _ = handshake_tx.try_send((request.uri().to_string(), protocol.clone()));
                if let Some(first) = protocol.as_deref().and_then(|p| p.split(',').next()) {
                    response
                        .headers_mut()
                        .insert("sec-websocket-protocol", first.trim().parse().unwrap());
                }
                Ok(response)
            },
        )
        .await
        .unwrap();
        let (mut tx, mut rx) = socket.split();
        loop {
            tokio::select! {
                incoming = rx.next() => match incoming {
                    Some(Ok(message)) => {
                        let closing = matches!(message, Message::Close(_));
                        let _ = message_tx.send(message).await;
                        if closing { break; }
                    }
                    _ => {
                        let _ = message_tx.send(Message::Close(None)).await;
                        break;
                    }
                },
                outgoing = outgoing.recv() => match outgoing {
                    Some(message) => {
                        let closing = matches!(message, Message::Close(_));
                        let _ = tx.send(message).await;
                        if closing { break; }
                    }
                    None => break,
                },
            }
        }
    });
    Upstream {
        address,
        handshake,
        messages,
        to_client,
    }
}

async fn connect_through(
    proxy: SocketAddr,
    path: &str,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::handshake::client::Response,
) {
    let mut request = format!("ws://{proxy}{path}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap()
}

async fn proxy_to(origin: String) -> SocketAddr {
    let server = proxied(&origin, false);
    let router = server.router.clone();
    // The library must outlive the listener; leaking it is fine for the length of a test process.
    std::mem::forget(server);
    serve(router).await
}

#[tokio::test]
async fn a_websocket_upgrade_echoes_the_requested_subprotocol_to_both_sides() {
    let mut upstream = ws_upstream(Duration::ZERO).await;
    let proxy = proxy_to(format!("http://{}", upstream.address)).await;

    let (_socket, response) = connect_through(proxy, "/?token=abc").await;

    // Omitting it from the 101 makes the browser fail the connection even though the handshake
    // looked fine server-side; omitting it upstream makes Vite ignore the request. (The client
    // library itself refuses a 101 that does not echo what it offered, so reaching here proves
    // the first half.)
    assert_eq!(response.status(), 101);
    assert_eq!(
        response.headers()["sec-websocket-protocol"]
            .to_str()
            .unwrap(),
        "vite-hmr"
    );
    let (uri, protocol) = upstream.handshake.recv().await.unwrap();
    assert_eq!(uri, "/?token=abc");
    assert_eq!(protocol.as_deref(), Some("vite-hmr"));
}

#[tokio::test]
async fn messages_sent_before_the_upstream_opens_are_queued_then_flushed_in_order() {
    // The upstream takes its time over the handshake; Vite's HMR client talks immediately.
    let mut upstream = ws_upstream(Duration::from_millis(300)).await;
    let proxy = proxy_to(format!("http://{}", upstream.address)).await;

    let (mut socket, _) = connect_through(proxy, "/").await;
    socket.send(Message::text("first")).await.unwrap();
    socket.send(Message::text("second")).await.unwrap();

    assert_eq!(
        upstream.messages.recv().await.unwrap(),
        Message::text("first")
    );
    assert_eq!(
        upstream.messages.recv().await.unwrap(),
        Message::text("second")
    );

    // And after opening, traffic passes straight through in both directions.
    socket.send(Message::text("third")).await.unwrap();
    assert_eq!(
        upstream.messages.recv().await.unwrap(),
        Message::text("third")
    );
    upstream
        .to_client
        .send(Message::text("reply"))
        .await
        .unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply, Message::text("reply"));
}

#[tokio::test]
async fn either_side_closing_tears_down_the_other() {
    // The client closes: the upstream sees it.
    let mut upstream = ws_upstream(Duration::ZERO).await;
    let proxy = proxy_to(format!("http://{}", upstream.address)).await;
    let (mut socket, _) = connect_through(proxy, "/").await;
    socket.send(Message::text("hello")).await.unwrap();
    assert_eq!(
        upstream.messages.recv().await.unwrap(),
        Message::text("hello")
    );
    socket.close(None).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), upstream.messages.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(closed, Message::Close(_)), "{closed:?}");

    // The upstream closes (a dev-server restart): the browser must not be left holding a socket
    // that will never speak again.
    let upstream = ws_upstream(Duration::ZERO).await;
    let proxy = proxy_to(format!("http://{}", upstream.address)).await;
    let (mut socket, _) = connect_through(proxy, "/").await;
    socket.send(Message::text("hello")).await.unwrap();
    upstream.to_client.send(Message::Close(None)).await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the client socket stayed open");
}
