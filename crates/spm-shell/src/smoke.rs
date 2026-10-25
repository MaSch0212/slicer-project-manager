//! The hidden smoke run's checks: the loopback listener, from the outside, as another process
//! would meet it, and then as the app's own webview does.
//!
//! No window is needed for any of it; the desktop app's `SPM_DESKTOP_HIDDEN=1` run calls this
//! against its real listener and writes the report, and `tests/smoke.rs` runs it against a
//! listener it starts itself.

use std::net::SocketAddr;

use reqwest::header::{COOKIE, HeaderMap, HeaderValue, ORIGIN, SET_COOKIE};
use serde::Serialize;
use serde_json::Value;

use crate::gate::{COOKIE_NAME, HANDSHAKE_PATH, LaunchGate, TOKEN_PARAM};

/// One check and what it found.
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// What the smoke run found. `ok` is every check passing.
#[derive(Debug, Clone, Serialize)]
pub struct SmokeReport {
    pub origin: String,
    pub port: u16,
    pub ok: bool,
    pub checks: Vec<Check>,
}

/// What the run is checking against.
pub struct SmokeExpect {
    /// The listener serves a local folder (so `canPickLocalFolder` is true and `/api/projects`
    /// answers).
    pub local_library: bool,
    /// The web bundle is embedded, so `/` is the app and not a 404.
    pub ui_embedded: bool,
}

struct Recorder {
    checks: Vec<Check>,
}

impl Recorder {
    fn check(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        self.checks.push(Check {
            name: name.to_owned(),
            ok,
            detail: detail.into(),
        });
    }

    fn status(&mut self, name: &str, found: Result<u16, String>, wanted: u16) {
        match found {
            Ok(status) => self.check(
                name,
                status == wanted,
                format!("status {status}, wanted {wanted}"),
            ),
            Err(error) => self.check(name, false, error),
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent("spm-smoke")
        .build()
        .unwrap_or_default()
}

async fn status(client: &reqwest::Client, url: &str, headers: HeaderMap) -> Result<u16, String> {
    client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map(|response| response.status().as_u16())
        .map_err(|error| error.to_string())
}

fn cookie_headers(session: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&format!("{COOKIE_NAME}={session}")) {
        headers.insert(COOKIE, value);
    }
    headers
}

/// Runs every check against the listener at `addr`, using `gate` to mint the handshake token
/// (the one thing a real client of the app would be handed).
pub async fn run(addr: SocketAddr, gate: &LaunchGate, expect: &SmokeExpect) -> SmokeReport {
    let origin = format!("http://{addr}");
    let client = client();
    let mut report = Recorder { checks: Vec::new() };

    report.check(
        "binds loopback only",
        addr.ip().is_loopback(),
        format!("bound {addr}"),
    );

    // What another process on this machine meets: nothing, without the secret.
    report.status(
        "no secret: the app is refused",
        status(&client, &format!("{origin}/"), HeaderMap::new()).await,
        403,
    );
    report.status(
        "no secret: the API is refused",
        status(
            &client,
            &format!("{origin}/api/capabilities"),
            HeaderMap::new(),
        )
        .await,
        403,
    );
    report.status(
        "a made-up cookie is refused",
        status(
            &client,
            &format!("{origin}/api/capabilities"),
            cookie_headers("not-a-session"),
        )
        .await,
        403,
    );
    report.status(
        "a made-up handshake token is refused",
        status(
            &client,
            &format!("{origin}{HANDSHAKE_PATH}?{TOKEN_PARAM}=not-a-token"),
            HeaderMap::new(),
        )
        .await,
        403,
    );

    // The handshake, as the webview does it.
    let token = gate.mint_token();
    let handshake_url = format!("{origin}{HANDSHAKE_PATH}?{TOKEN_PARAM}={token}&to=/");
    let mut session = None;
    match client.get(&handshake_url).send().await {
        Ok(response) => {
            let cookie = response
                .headers()
                .get(SET_COOKIE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let flags_ok = cookie.as_deref().is_some_and(|cookie| {
                cookie.contains("HttpOnly")
                    && cookie.contains("SameSite=Strict")
                    && cookie.starts_with(&format!("{COOKIE_NAME}="))
            });
            report.check(
                "the handshake sets an HttpOnly SameSite=Strict cookie and redirects",
                response.status().as_u16() == 303 && flags_ok && location.as_deref() == Some("/"),
                format!("status {}, location {location:?}", response.status()),
            );
            session = cookie.and_then(|cookie| {
                cookie
                    .split(';')
                    .next()
                    .and_then(|pair| pair.split_once('='))
                    .map(|(_, value)| value.to_owned())
            });
        }
        Err(error) => report.check("the handshake", false, error.to_string()),
    }
    report.status(
        "the handshake token is spent after one use",
        status(&client, &handshake_url, HeaderMap::new()).await,
        403,
    );

    let Some(session) = session else {
        return finish(origin, addr, report);
    };

    // With the secret.
    let mut foreign = cookie_headers(&session);
    foreign.insert(ORIGIN, HeaderValue::from_static("http://127.0.0.1:1"));
    report.status(
        "a request from another origin is refused even with the cookie",
        status(&client, &format!("{origin}/api/capabilities"), foreign).await,
        403,
    );

    match client
        .get(format!("{origin}/api/capabilities"))
        .headers(cookie_headers(&session))
        .send()
        .await
    {
        Ok(response) => {
            let ok_status = response.status().as_u16() == 200;
            let body: Value = response.json().await.unwrap_or(Value::Null);
            let pick = body.get("canPickLocalFolder").and_then(Value::as_bool);
            let auth = body.get("requiresAuth").and_then(Value::as_bool);
            let wanted = expect.local_library;
            report.check(
                "capabilities are answered with the secret, as the union",
                ok_status && (!wanted || (pick == Some(true) && auth == Some(false))),
                body.to_string(),
            );
        }
        Err(error) => report.check("capabilities", false, error.to_string()),
    }

    if expect.local_library {
        match client
            .get(format!("{origin}/api/projects"))
            .headers(cookie_headers(&session))
            .send()
            .await
        {
            Ok(response) => {
                let code = response.status().as_u16();
                let body: Value = response.json().await.unwrap_or(Value::Null);
                report.check(
                    "the local library answers /api/projects",
                    code == 200 && (body.is_array() || body.is_object()),
                    format!("status {code}, {} bytes of JSON", body.to_string().len()),
                );
            }
            Err(error) => report.check("projects", false, error.to_string()),
        }
    }

    match client
        .get(format!("{origin}/"))
        .headers(cookie_headers(&session))
        .send()
        .await
    {
        Ok(response) => {
            let code = response.status().as_u16();
            let csp = response.headers().get("content-security-policy").is_some();
            let wanted = if expect.ui_embedded { 200 } else { 404 };
            report.check(
                "the app is served with a content security policy",
                code == wanted && (csp || !expect.ui_embedded),
                format!("status {code}, csp {csp}"),
            );
        }
        Err(error) => report.check("ui", false, error.to_string()),
    }

    finish(origin, addr, report)
}

fn finish(origin: String, addr: SocketAddr, report: Recorder) -> SmokeReport {
    SmokeReport {
        origin,
        port: addr.port(),
        ok: report.checks.iter().all(|check| check.ok),
        checks: report.checks,
    }
}
