//! The loopback listener and its per-launch secret (migration spec 3.3), driven over real TCP the
//! way another process on this machine would meet it, plus the cases of the Electron shell's
//! `shell.spec.ts` that were about serving the app (its custom protocol is gone; the same
//! guarantees are asserted of the HTTP listener).

mod support;

use std::fs;
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use serde_json::{Value, json};
use spm_shell::gate::{COOKIE_NAME, HANDSHAKE_PATH, LaunchGate, TOKEN_PARAM};
use spm_shell::server::{CONTENT_SECURITY_POLICY, DesktopServer, Ui};
use spm_shell::shell::ShellRoute;
use spm_shell::web::EmbeddedAssets;
use support::{Client, World, http, serve, serve_dir};

async fn local_world() -> (World, DesktopServer) {
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    let server = serve(&world.shell).await;
    (world, server)
}

fn url(server: &DesktopServer, path: &str) -> String {
    format!("{}{path}", server.origin())
}

async fn status(request: reqwest::RequestBuilder) -> u16 {
    request.send().await.unwrap().status().as_u16()
}

// ---- the secret --------------------------------------------------------------------------------------

#[tokio::test]
async fn it_listens_on_loopback_and_nowhere_else() {
    let (_world, server) = local_world().await;
    assert_eq!(server.addr().ip(), IpAddr::from([127, 0, 0, 1]));
    assert_ne!(server.addr().port(), 0, "the OS assigned a port");

    // Best effort: through this machine's own LAN address, nothing answers. (Skipped where the
    // machine has no route to name an address with.)
    let lan = UdpSocket::bind("0.0.0.0:0").ok().and_then(|socket| {
        socket.connect("192.0.2.1:9").ok()?;
        socket.local_addr().ok()
    });
    if let Some(local) =
        lan.filter(|address| !address.ip().is_loopback() && !address.ip().is_unspecified())
    {
        let target = SocketAddr::new(local.ip(), server.addr().port());
        assert!(
            TcpStream::connect_timeout(&target, Duration::from_secs(2)).is_err(),
            "the listener answered on {target}"
        );
    }
}

#[tokio::test]
async fn a_request_without_the_launch_secret_is_refused_whatever_it_asks_for() {
    let (_world, server) = local_world().await;
    let http = http();
    for (method, path) in [
        (Method::GET, "/"),
        (Method::GET, "/index.html"),
        (Method::GET, "/api/capabilities"),
        (Method::GET, "/api/projects"),
        (Method::GET, "/api/account"),
        (Method::POST, "/api/projects"),
        (Method::DELETE, "/api/projects/anything"),
        (Method::GET, "/api/files/anything/raw"),
        (Method::GET, "/_spm/anything"),
        (Method::GET, "/no/such/page"),
        (Method::OPTIONS, "/api/projects"),
    ] {
        let reply = http
            .request(method.clone(), url(&server, path))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 403, "{method} {path}");
        assert_eq!(reply.text().await.unwrap(), "forbidden", "{method} {path}");
    }
    assert!(server.hits().is_empty(), "a refused request is not a hit");
}

#[tokio::test]
async fn a_made_up_cookie_or_the_handshake_token_used_as_a_cookie_is_refused() {
    let (_world, server) = local_world().await;
    let http = http();
    let token = server.gate().mint_token();
    for cookie in [
        format!("{COOKIE_NAME}=not-a-session"),
        format!("{COOKIE_NAME}={token}"),
        format!("{COOKIE_NAME}="),
        "spm_session=whatever".to_owned(),
        format!("other={token}"),
    ] {
        let reply = http
            .get(url(&server, "/api/capabilities"))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 403, "{cookie}");
    }
}

#[tokio::test]
async fn the_handshake_redeems_a_token_once_and_hands_out_an_httponly_samesite_strict_cookie() {
    let (_world, server) = local_world().await;
    let http = http();

    // A made-up token.
    let wrong = http
        .get(url(
            &server,
            &format!("{HANDSHAKE_PATH}?{TOKEN_PARAM}=nope"),
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 403);
    assert!(wrong.headers().get("set-cookie").is_none());
    // No token at all.
    assert_eq!(status(http.get(url(&server, HANDSHAKE_PATH))).await, 403);

    let handshake = server.gate().handshake_url("/projects");
    let first = http.get(&handshake).send().await.unwrap();
    assert_eq!(first.status(), 303);
    assert_eq!(first.headers()["location"], "/projects");
    assert_eq!(first.headers()["cache-control"], "no-store");
    let cookie = first.headers()["set-cookie"].to_str().unwrap().to_owned();
    assert!(cookie.starts_with(&format!("{COOKIE_NAME}=")), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Strict"), "{cookie}");
    assert!(cookie.contains("Path=/"), "{cookie}");
    // The cookie is not the token.
    assert!(!handshake.contains(cookie.split(';').next().unwrap().split('=').nth(1).unwrap()));

    // Spent: replaying the URL does nothing, which is what makes a leaked URL harmless.
    assert_eq!(status(http.get(&handshake)).await, 403);

    // And the cookie it handed out works.
    let session = cookie.split(';').next().unwrap();
    let reply = http
        .get(url(&server, "/api/capabilities"))
        .header("cookie", session)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 200);
}

#[tokio::test]
async fn the_secret_is_long_random_and_different_every_time() {
    let gate = LaunchGate::new("127.0.0.1:1");
    let tokens: Vec<String> = (0..20).map(|_| gate.mint_token()).collect();
    for token in &tokens {
        assert_eq!(token.len(), 64, "32 random bytes, hex");
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    let unique: std::collections::HashSet<_> = tokens.iter().collect();
    assert_eq!(unique.len(), tokens.len());
    // Only a handful are kept unspent (a launch makes one per window load): the oldest goes first.
    assert!(
        gate.redeem(&tokens[0]).is_none(),
        "the oldest unspent token was dropped"
    );
    let newest = tokens.last().unwrap();
    let session = gate.redeem(newest).unwrap();
    assert_eq!(session.len(), 64);
    assert_ne!(&session, newest);
    assert!(gate.is_session(&session) && !gate.is_session(&tokens[1]));
    assert!(gate.redeem(newest).is_none(), "spent");
}

#[tokio::test]
async fn another_launch_s_cookie_means_nothing_here() {
    let (_world, first) = local_world().await;
    let (_other_world, second) = local_world().await;
    let client = Client::handshake(&first).await;
    // Cookies are scoped by host, not port, so a browser would send the first launch's cookie to
    // the second launch's port. The second launch knows nothing of it.
    let reply = http()
        .get(url(&second, "/api/capabilities"))
        .header("cookie", &client.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 403);
}

#[tokio::test]
async fn a_page_on_another_origin_cannot_use_the_cookie_it_would_carry() {
    let (_world, server) = local_world().await;
    let client = Client::handshake(&server).await;
    // `SameSite` treats two ports on 127.0.0.1 as one site, so what stops a page served by some
    // other local process is the origin check.
    for (header, value) in [
        ("origin", "http://127.0.0.1:1"),
        ("origin", "http://localhost"),
        ("origin", "https://evil.example"),
        ("origin", "null"),
        ("sec-fetch-site", "same-site"),
        ("sec-fetch-site", "cross-site"),
    ] {
        let reply = client
            .send(
                client
                    .request(Method::POST, "/api/projects")
                    .header(header, value)
                    .json(&json!({ "name": "x" })),
            )
            .await;
        assert_eq!(reply.status, 403, "{header}: {value}");
    }
    // Its own origin, and a typed-in address (`none`), are fine.
    for (header, value) in [
        ("origin", server.origin()),
        ("sec-fetch-site", "same-origin".to_owned()),
        ("sec-fetch-site", "none".to_owned()),
    ] {
        let reply = client
            .send(
                client
                    .request(Method::GET, "/api/capabilities")
                    .header(header, value),
            )
            .await;
        assert_eq!(reply.status, 200, "{header}");
    }
    let nothing_created = client.get("/api/projects").await.json();
    assert_eq!(nothing_created, json!([]));
}

#[tokio::test]
async fn a_rebound_host_name_is_refused_even_with_the_cookie() {
    let (_world, server) = local_world().await;
    let client = Client::handshake(&server).await;
    for host in [
        "evil.example",
        "evil.example:80",
        "localhost",
        "127.0.0.1:1",
        "",
    ] {
        let reply = client
            .send(
                client
                    .request(Method::GET, "/api/capabilities")
                    .header("host", host),
            )
            .await;
        assert_eq!(reply.status, 403, "{host:?}");
    }
}

#[tokio::test]
async fn the_handshake_only_ever_redirects_to_a_path_on_this_origin() {
    let (_world, server) = local_world().await;
    for target in [
        "//evil.example/x",
        "https://evil.example",
        "\\\\evil.example",
        "evil",
        "/\\evil",
    ] {
        let token = server.gate().mint_token();
        let reply = http()
            .get(format!(
                "{}{HANDSHAKE_PATH}?{TOKEN_PARAM}={token}&to={}",
                server.origin(),
                target.replace('\\', "%5C")
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 303, "{target}");
        // Never what was asked for: the mode's own home.
        assert_eq!(reply.headers()["location"], "/", "{target}");
    }
}

#[tokio::test]
async fn the_handshake_lands_on_the_route_the_mode_calls_for() {
    // Nothing open yet: the connect page. A library open: home.
    let world = World::new();
    let server = serve(&world.shell).await;
    let token = server.gate().mint_token();
    let reply = http()
        .get(format!(
            "{}{HANDSHAKE_PATH}?{TOKEN_PARAM}={token}",
            server.origin()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.headers()["location"], ShellRoute::Connect.path());
    assert!(
        server.initial_url().contains("to=%2F")
            || server.initial_url().contains("to=/desktop/connect")
    );

    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    let token = server.gate().mint_token();
    let reply = http()
        .get(format!(
            "{}{HANDSHAKE_PATH}?{TOKEN_PARAM}={token}",
            server.origin()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(reply.headers()["location"], "/");
}

#[tokio::test]
async fn requests_that_passed_the_gate_are_recorded_and_say_who_they_were() {
    let (_world, server) = local_world().await;
    let client = Client::handshake(&server).await;
    client.get("/api/capabilities").await;
    client
        .send(
            client
                .request(Method::GET, "/api/capabilities")
                .header("user-agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/156"),
        )
        .await;
    let hits = server.hits();
    assert!(
        hits.iter()
            .any(|hit| hit.path == "/api/capabilities" && !hit.browser)
    );
    assert!(
        hits.iter()
            .any(|hit| hit.path == "/api/capabilities" && hit.browser)
    );
    assert!(hits.iter().any(|hit| hit.path == HANDSHAKE_PATH));
}

#[tokio::test]
async fn every_response_carries_the_hardening_headers_and_none_carry_cors() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>app</title>",
    )
    .unwrap();
    fs::write(dir.path().join("app.js"), "console.log(1)").unwrap();
    let world = World::new();
    world
        .shell
        .library()
        .open(&world.folder("lib"), true)
        .unwrap();
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;

    for path in [
        "/",
        "/app.js",
        "/api/capabilities",
        "/api/nope",
        "/_spm/x",
        "/projects/deep",
    ] {
        let reply = client
            .send(
                client
                    .request(Method::GET, path)
                    .header("origin", server.origin()),
            )
            .await;
        assert_eq!(
            reply.header("x-content-type-options").as_deref(),
            Some("nosniff"),
            "{path}"
        );
        assert_eq!(
            reply.header("referrer-policy").as_deref(),
            Some("no-referrer"),
            "{path}"
        );
        assert_eq!(
            reply.header("cross-origin-resource-policy").as_deref(),
            Some("same-origin"),
            "{path}"
        );
        assert!(
            reply
                .headers
                .keys()
                .all(|name| !name.as_str().starts_with("access-control-")),
            "{path}: CORS headers"
        );
    }
    // The policy is on documents, and says what the page may do.
    let index = client.get("/").await;
    let csp = index
        .header("content-security-policy")
        .expect("a CSP on the document");
    assert_eq!(csp, CONTENT_SECURITY_POLICY);
    for directive in [
        "default-src 'self'",
        "script-src 'self'",
        "connect-src 'self' ipc: http://ipc.localhost",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
    ] {
        assert!(csp.contains(directive), "{directive} in {csp}");
    }
    assert!(!csp.contains("unsafe-eval") && !csp.contains("script-src 'self' 'unsafe-inline'"));
    assert!(
        client
            .get("/api/capabilities")
            .await
            .header("content-security-policy")
            .is_none()
    );
}

// ---- serving the app (shell.spec) ----------------------------------------------------------------------

fn bundle() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>Slicer Project Manager</title><div id=root></div>",
    )
    .unwrap();
    fs::create_dir_all(dir.path().join("assets")).unwrap();
    fs::write(dir.path().join("assets").join("index-abc.js"), "export {}").unwrap();
    fs::write(dir.path().join("assets").join("index-abc.css"), "body{}").unwrap();
    fs::write(
        dir.path().join("favicon.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
    )
    .unwrap();
    fs::write(
        dir.path().join("manifest.webmanifest"),
        r#"{"name":"Slicer Project Manager"}"#,
    )
    .unwrap();
    // Next to the bundle, not in it.
    fs::write(
        dir.path().parent().unwrap().join("outside-the-bundle.txt"),
        "OUTSIDE",
    )
    .unwrap();
    dir
}

#[tokio::test]
async fn the_app_is_served_from_the_listener_and_the_router_can_navigate() {
    let dir = bundle();
    let world = World::new();
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;

    let root = client.get("/").await;
    assert_eq!(root.status, 200);
    assert!(
        root.header("content-type")
            .unwrap()
            .starts_with("text/html")
    );
    assert!(root.text().contains("Slicer Project Manager"));

    // A deep route is the app shell, so a reload or a typed address lands.
    for path in [
        "/projects/abc",
        "/settings",
        "/desktop/connect",
        "/admin/users",
    ] {
        let reply = client.get(path).await;
        assert_eq!(reply.status, 200, "{path}");
        assert!(reply.text().contains("id=root"), "{path}");
    }
    let script = client.get("/assets/index-abc.js").await;
    assert!(
        script
            .header("content-type")
            .unwrap()
            .contains("javascript")
    );
    let css = client.get("/assets/index-abc.css").await;
    assert!(css.header("content-type").unwrap().starts_with("text/css"));
}

#[tokio::test]
async fn a_request_that_escapes_the_bundle_gets_nothing_outside_it() {
    let dir = bundle();
    let world = World::new();
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;
    for path in [
        "/..%2foutside-the-bundle.txt",
        "/%2e%2e/outside-the-bundle.txt",
        "/..%5coutside-the-bundle.txt",
        "/assets/..%2f..%2foutside-the-bundle.txt",
        "/%2e%2e%2f%2e%2e%2foutside-the-bundle.txt",
        // Malformed percent-encoding is a miss, never a crash.
        "/%E0%A4%A",
        "/%",
        "/%00",
    ] {
        let reply = client.get(path).await;
        assert!(
            !reply.text().contains("OUTSIDE"),
            "{path} read a file outside the bundle"
        );
        assert!(
            reply.status == 404 || reply.text().contains("id=root"),
            "{path}: {}",
            reply.status
        );
    }
}

#[tokio::test]
async fn the_reserved_prefix_is_a_404_in_every_spelling_and_never_the_app_shell() {
    let dir = bundle();
    let world = World::new();
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;
    for path in [
        "/_spm/files/x/raw",
        "/_spm/anything",
        "/_spm/",
        "/%5Fspm/anything",
        "/%5fspm/anything",
        "/_SPM/anything",
        "//_spm/anything",
    ] {
        let reply = client.get(path).await;
        assert_eq!(reply.status, 404, "{path}");
        assert!(
            !reply.text().contains("id=root"),
            "{path} answered with the app shell"
        );
    }
    // Ordinary routes still get the shell.
    assert_eq!(client.get("/projects").await.status, 200);
}

#[tokio::test]
async fn only_get_and_head_reach_the_app_files() {
    let dir = bundle();
    let world = World::new();
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;
    for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
        let reply = client.send(client.request(method.clone(), "/")).await;
        assert_eq!(reply.status, 405, "{method}");
    }
}

#[tokio::test]
async fn an_unknown_api_path_is_a_json_404_never_the_app_shell() {
    let dir = bundle();
    let (world, _) = local_world().await;
    let server = serve_dir(&world.shell, dir.path()).await;
    let client = Client::handshake(&server).await;
    let reply = client.get("/api/definitely-not-a-route").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), "NotFound");
    // And in a mode with no library at all, the API says so rather than serving HTML.
    let unset = World::new();
    let server = serve_dir(&unset.shell, dir.path()).await;
    let client = Client::handshake(&server).await;
    let reply = client.get("/api/projects").await;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.error_code(), "Conflict");
}

#[tokio::test]
async fn the_embedded_bundle_serves_its_root_level_icons_and_manifest_with_their_own_types() {
    // Only where the build embedded a bundle (it is built by `pnpm --filter @spm/web build`).
    if !EmbeddedAssets::has_index() {
        eprintln!("no web bundle was embedded in this build: skipping");
        return;
    }
    let world = World::new();
    let server = DesktopServer::start(
        Arc::clone(&world.shell),
        Ui::Assets(EmbeddedAssets::shared()),
    )
    .await
    .unwrap();
    let client = Client::handshake(&server).await;
    for (path, content_type, magic) in [
        ("/favicon.svg", "image/svg+xml", &b"<?xml"[..]),
        ("/favicon.ico", "image/x-icon", &[0, 0, 1, 0][..]),
        ("/icon-192.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
        ("/icon-512.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
        (
            "/apple-touch-icon.png",
            "image/png",
            &[0x89, b'P', b'N', b'G'][..],
        ),
    ] {
        let reply = client.get(path).await;
        assert_eq!(reply.status, 200, "{path}");
        let found = reply.header("content-type").unwrap();
        assert!(
            found.starts_with(content_type)
                || (content_type == "image/x-icon" && found.contains("icon")),
            "{path}: {found}"
        );
        assert!(reply.body.starts_with(magic), "{path}: not the real file");
    }
    // The manifest parses, and names the app and its two icons.
    let manifest = client.get("/manifest.webmanifest").await;
    assert_eq!(manifest.status, 200);
    assert!(
        manifest
            .header("content-type")
            .unwrap()
            .contains("manifest")
    );
    let manifest: Value = manifest.json();
    assert_eq!(manifest["name"], "Slicer Project Manager");
    assert_eq!(manifest["icons"].as_array().unwrap().len(), 2);
    for icon in manifest["icons"].as_array().unwrap() {
        let src = icon["src"].as_str().unwrap();
        assert_eq!(
            client
                .get(&format!("/{}", src.trim_start_matches('/')))
                .await
                .status,
            200
        );
    }
}
