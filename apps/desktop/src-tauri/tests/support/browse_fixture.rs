//! A stand-in for a model site, on `127.0.0.1` only.
//!
//! The automated tests must not depend on Thingiverse, Printables, MakerWorld or Cults3D
//! (Cloudflare's mood, consent banners, the network). This serves pages that behave the way the
//! measured sites do: a `blob:` download by each of the three DOM idioms, an attachment, a redirect
//! into a custom scheme, `target=_blank`, a deferred `window.open`, and the pages the security
//! checks run in (the bridge, geolocation, storage). A page reports to the app through its
//! document title (`PROBE:{json}`), which needs no permission.

use std::net::SocketAddr;

use axum::Router;
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::net::TcpListener;

pub struct Fixture {
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    pub async fn start() -> Fixture {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(page);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Fixture { addr, task }
    }

    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// `thingiverse=127.0.0.1:<port>`: what makes this server a model site to the app.
    pub fn as_a_site(&self) -> String {
        format!("thingiverse={}", self.addr)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn html(title: &str, script: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title><h1>{title}</h1>\
         <a id=l target=_blank href=/second>link</a><script>{script}</script>"
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

const BLOB: &str =
    "const blob = new Blob([new Uint8Array(4096).fill(7)], { type: 'application/octet-stream' });";

const REPORT: &str =
    "const report = (value) => { document.title = 'PROBE:' + JSON.stringify(value); };";

async fn page(request: Request<axum::body::Body>) -> Response {
    let path = request.uri().path().to_owned();
    match path.as_str() {
        "/thing:7401409" | "/thing:7401409/files" | "/thing:999" => html("fixture:thing", ""),
        "/thing:7401409/dl" => html(
            "fixture:thing",
            &format!(
                "{BLOB} const a = document.createElement('a'); a.href = URL.createObjectURL(blob); \
                 a.download = 'model-files.bin'; document.body.append(a); a.click();"
            ),
        ),
        "/second" => html("fixture:second", ""),
        "/blob-anchor" => html(
            "fixture:blob-anchor",
            &format!(
                "{BLOB} const a = document.createElement('a'); a.href = URL.createObjectURL(blob); \
                 a.download = 'anchor.bin'; document.body.append(a); a.click();"
            ),
        ),
        "/blob-href" => html(
            "fixture:blob-href",
            &format!("{BLOB} location.href = URL.createObjectURL(blob);"),
        ),
        "/blob-open" => html(
            "fixture:blob-open",
            &format!("{BLOB} window.open(URL.createObjectURL(blob));"),
        ),
        "/attachment-page" => html("fixture:attachment", "location.href = '/attachment';"),
        "/attachment" => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"served.bin\"",
                ),
            ],
            vec![9u8; 2048],
        )
            .into_response(),
        "/custom-scheme" => html(
            "fixture:custom",
            "location.href = 'bambustudio://open?model=1';",
        ),
        "/go-redirect-custom" => html("fixture:go-redirect", "location.href = '/redirect-custom';"),
        "/redirect-custom" => redirect("bambustudio://open?model=1"),
        "/go-redirect-ok" => html("fixture:go-redirect-ok", "location.href = '/redirect-ok';"),
        "/redirect-ok" => redirect("/thing:7401409"),
        "/open-link" => html("fixture:open-link", "document.getElementById('l').click();"),
        "/deferred" => html(
            "fixture:deferred",
            "const w = window.open(); document.title = 'fixture:deferred:' + (w === null ? 'null' : 'window');",
        ),
        "/bridge" => html(
            "fixture:bridge",
            &format!(
                "{REPORT}
(async () => {{
  const call = async (command, args) => {{
    try {{
      return {{ ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) }};
    }} catch (error) {{
      return {{ ok: false, error: typeof error === 'string' ? error : JSON.stringify(error) }};
    }}
  }};
  const main = new URLSearchParams(location.search).get('main');
  let mainFetch;
  try {{
    await fetch(main + '/api/browse-probe-from-child', {{ credentials: 'include' }});
    mainFetch = 'resolved';
  }} catch (error) {{
    mainFetch = 'blocked: ' + error.message;
  }}
  report({{
    step: 'bridge',
    bridge: typeof window.__TAURI_INTERNALS__,
    library: await call('desktop_library_state'),
    browse: await call('desktop_browse_state'),
    slicers: await call('desktop_slicers_get'),
    plugin: await call('plugin:app|version'),
    missing: await call('no_such_command'),
    cookie: document.cookie,
    mainFetch,
  }});
}})();"
            ),
        ),
        "/geo" => html(
            "fixture:geo",
            &format!(
                "{REPORT}
navigator.geolocation.getCurrentPosition(
  () => report({{ step: 'geo', geolocation: 'granted' }}),
  (error) => report({{ step: 'geo', geolocation: 'error ' + error.code }}),
  {{ timeout: 8000 }},
);"
            ),
        ),
        "/storage-set" => html(
            "fixture:storage-set",
            &format!(
                "{REPORT}
document.cookie = 'childmark=1; path=/; max-age=3600';
localStorage.setItem('childmark', '1');
report({{ step: 'storage-set', wrote: true }});"
            ),
        ),
        "/storage-get" => html(
            "fixture:storage-get",
            &format!(
                "{REPORT}
const params = new URLSearchParams(location.search);
const answer = {{
  step: 'storage-' + params.get('report'),
  childCookie: document.cookie.includes('childmark=1'),
  childLocal: localStorage.getItem('childmark') === '1',
  sideCookie: document.cookie.includes('sidemark=1'),
  sideLocal: localStorage.getItem('sidemark') === '1',
}};
if (params.get('then') === 'set-side') {{
  document.cookie = 'sidemark=1; path=/; max-age=3600';
  localStorage.setItem('sidemark', '1');
}}
report(answer);"
            ),
        ),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn redirect(to: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, to.to_owned())]).into_response()
}
