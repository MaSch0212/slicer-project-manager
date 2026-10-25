//! Forwards non-API requests to a running Vite dev server.
//!
//! Without this the two halves of the app cannot be served at once: `vite` owns the UI on its own
//! port but knows nothing about `/api`, and this server owns `/api` but can only serve a bundle
//! that has already been built. With `SPM_DEV_UI_ORIGIN` set, one origin serves both: the API
//! locally, everything else from the dev server, hot reload included.
//!
//! A development affordance, off unless the variable is set. It is never a production path.
//!
//! The upstream client speaks plain HTTP only, which is what Vite serves; an `https://` dev origin
//! is accepted by [`resolve_dev_ui_origin`] (the variable's validation is unchanged) but every
//! request to it answers 502, with the reason logged. Carrying a TLS stack in the NAS binary for a
//! development proxy was not worth it.

use axum::body::Body;
use axum::extract::FromRequestParts;
use axum::extract::ws::{CloseFrame, Message as ClientMessage, WebSocket, WebSocketUpgrade};
use axum::http::header::{CONTENT_TYPE, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use spm_core::{AppError, Logger, fields};
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use url::Url;

/// The command that starts the dev server, quoted in the 502 so the fix is a second terminal
/// rather than anything in this codebase.
pub const START_COMMAND: &str = "pnpm --filter @spm/web dev";

/// Validated at startup so a typo fails immediately rather than on the first page load. Unset or
/// empty is `None` (the proxy is off); anything else must be an absolute http(s) URL and is
/// reduced to its origin.
pub fn resolve_dev_ui_origin(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let parsed = Url::parse(raw)
        .map_err(|_| AppError::validation(format!("SPM_DEV_UI_ORIGIN is not a URL: {raw}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::validation(format!(
            "SPM_DEV_UI_ORIGIN must be http(s): {raw}"
        )));
    }
    Ok(Some(parsed.origin().ascii_serialization()))
}

/// Hop-by-hop headers belong to a single connection and must not be forwarded (RFC 9110 7.6.1).
/// `host` is dropped so the client derives the right one for the upstream origin, and
/// `content-length` because the body is re-framed.
const HOP_BY_HOP: [&str; 10] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

fn forwardable(source: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in source {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

#[derive(Clone)]
pub struct DevProxy {
    origin: String,
    client: Client<HttpConnector, Body>,
    log: Logger,
}

impl DevProxy {
    /// `origin` must come from [`resolve_dev_ui_origin`].
    pub fn new(origin: String, log: Logger) -> DevProxy {
        DevProxy {
            origin,
            client: Client::builder(TokioExecutor::new()).build_http(),
            log,
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub async fn handle(&self, request: Request<Body>) -> Response {
        let path = request.uri().path().to_owned();
        let target = format!(
            "{}{}",
            self.origin,
            request
                .uri()
                .path_and_query()
                .map_or("/", axum::http::uri::PathAndQuery::as_str)
        );

        let is_upgrade = request
            .headers()
            .get(UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
        if is_upgrade {
            return self.upgrade(request, &target, &path).await;
        }

        let (parts, body) = request.into_parts();
        let Ok(uri) = target.parse::<Uri>() else {
            return self.unreachable_response("the target is not a URI");
        };
        let mut outgoing = Request::new(body);
        *outgoing.method_mut() = parts.method.clone();
        *outgoing.uri_mut() = uri;
        *outgoing.headers_mut() = forwardable(&parts.headers);

        match self.client.request(outgoing).await {
            Ok(upstream) => {
                self.log.debug(
                    "dev proxy",
                    fields![
                        "method" => parts.method.as_str(),
                        "path" => &path,
                        "status" => i64::from(upstream.status().as_u16()),
                    ],
                );
                let (head, body) = upstream.into_parts();
                let mut response = Response::new(Body::new(body));
                *response.status_mut() = head.status;
                *response.headers_mut() = forwardable(&head.headers);
                response
            }
            Err(error) => self.unreachable_response(&error.to_string()),
        }
    }

    /// Almost always "the dev server is not running yet". Saying so beats a bare 500.
    fn unreachable_response(&self, reason: &str) -> Response {
        self.log.warn(
            "dev proxy could not reach the UI dev server",
            fields!["origin" => &self.origin, "err" => reason],
        );
        let mut response = Response::new(Body::from(format!(
            "Cannot reach the UI dev server at {origin}.\n\
             Start it with: {START_COMMAND}\n\
             Or unset SPM_DEV_UI_ORIGIN to serve the built bundle instead.\n",
            origin = self.origin
        )));
        *response.status_mut() = StatusCode::BAD_GATEWAY;
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        response
    }

    /// Vite's hot reload runs over a websocket; without this every edit would need a manual
    /// refresh. The 101 echoes the first subprotocol the client offered (the browser fails the
    /// connection if it does not, even though the handshake looked fine), and the same offer goes
    /// upstream (Vite ignores a handshake that omits it).
    async fn upgrade(&self, request: Request<Body>, target: &str, path: &str) -> Response {
        let protocols: Vec<String> = request
            .headers()
            .get_all(SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|entry| entry.trim().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect();

        let (mut parts, _body) = request.into_parts();
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => upgrade,
            Err(rejection) => return rejection.into_response(),
        };
        let upgrade = match protocols.first() {
            Some(first) => upgrade.protocols([first.clone()]),
            None => upgrade,
        };

        let upstream_url = target.replacen("http", "ws", 1);
        let log = self.log.clone();
        let origin = self.origin.clone();
        self.log
            .debug("dev proxy websocket", fields!["path" => path]);
        upgrade.on_upgrade(move |client| async move {
            // Connecting happens here, after the browser has its 101. Anything the client sends
            // meanwhile waits unread in the socket, in order, which is the queue the legacy
            // bridge kept by hand.
            let upstream = match connect_upstream(&upstream_url, &protocols).await {
                Ok(upstream) => upstream,
                Err(error) => {
                    log.warn(
                        "dev proxy could not reach the UI dev server",
                        fields!["origin" => origin, "err" => error],
                    );
                    return;
                }
            };
            bridge(client, upstream).await;
        })
    }
}

type Upstream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_upstream(url: &str, protocols: &[String]) -> Result<Upstream, String> {
    let mut request = url
        .into_client_request()
        .map_err(|error| error.to_string())?;
    if !protocols.is_empty() {
        let value =
            HeaderValue::from_str(&protocols.join(", ")).map_err(|error| error.to_string())?;
        request
            .headers_mut()
            .insert(HeaderName::from_static("sec-websocket-protocol"), value);
    }
    let (stream, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

/// Pipes a client websocket and an upstream one together until either end closes; a close on
/// either side tears down the other, so a dev-server restart does not leave the browser holding a
/// socket that will never speak again.
async fn bridge(client: WebSocket, upstream: Upstream) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let to_upstream = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let forwarded = match message {
                ClientMessage::Text(text) => UpstreamMessage::text(text.as_str().to_owned()),
                ClientMessage::Binary(bytes) => UpstreamMessage::binary(bytes),
                ClientMessage::Close(frame) => {
                    UpstreamMessage::Close(frame.map(|frame| UpstreamCloseFrame {
                        code: CloseCode::from(frame.code),
                        reason: frame.reason.as_str().to_owned().into(),
                    }))
                }
                // Each side answers its own pings.
                ClientMessage::Ping(_) | ClientMessage::Pong(_) => continue,
            };
            let closing = matches!(forwarded, UpstreamMessage::Close(_));
            if upstream_tx.send(forwarded).await.is_err() || closing {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let to_client = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let forwarded = match message {
                UpstreamMessage::Text(text) => ClientMessage::Text(text.as_str().to_owned().into()),
                UpstreamMessage::Binary(bytes) => ClientMessage::Binary(bytes),
                UpstreamMessage::Close(frame) => {
                    ClientMessage::Close(frame.map(|frame| CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.as_str().to_owned().into(),
                    }))
                }
                UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_) | UpstreamMessage::Frame(_) => {
                    continue;
                }
            };
            let closing = matches!(forwarded, ClientMessage::Close(_));
            if client_tx.send(forwarded).await.is_err() || closing {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    // Whichever direction ends first ends the bridge, which drops (closes) the other half.
    tokio::select! {
        () = to_upstream => {}
        () = to_client => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_dev_ui_origin_accepts_an_http_url_and_reduces_it_to_a_bare_origin() {
        assert_eq!(
            resolve_dev_ui_origin(Some("http://localhost:5173/some/path")).unwrap(),
            Some("http://localhost:5173".to_owned())
        );
        assert_eq!(
            resolve_dev_ui_origin(Some("https://ui.example.com")).unwrap(),
            Some("https://ui.example.com".to_owned())
        );
    }

    #[test]
    fn resolve_dev_ui_origin_is_off_when_unset_and_refuses_anything_unusable() {
        assert_eq!(resolve_dev_ui_origin(None).unwrap(), None);
        assert_eq!(resolve_dev_ui_origin(Some("")).unwrap(), None);
        // A typo must fail at startup rather than 502 on the first page load.
        let schemeless = resolve_dev_ui_origin(Some("localhost:5173")).unwrap_err();
        assert!(schemeless.message.starts_with("SPM_DEV_UI_ORIGIN"));
        let ftp = resolve_dev_ui_origin(Some("ftp://localhost:5173")).unwrap_err();
        assert!(ftp.message.starts_with("SPM_DEV_UI_ORIGIN"));
        assert!(ftp.message.contains("ftp://localhost:5173"));
    }

    #[test]
    fn hop_by_hop_headers_are_not_forwardable() {
        let mut headers = HeaderMap::new();
        for name in HOP_BY_HOP {
            headers.insert(HeaderName::from_static(name), HeaderValue::from_static("x"));
        }
        headers.insert("accept", HeaderValue::from_static("text/javascript"));
        let kept = forwardable(&headers);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept["accept"], "text/javascript");
    }
}
