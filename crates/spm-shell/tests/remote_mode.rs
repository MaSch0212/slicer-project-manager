//! Remote-server mode, end to end: the app's loopback listener in front of a **real** `spm-http`
//! server (sessions, quotas, previews), the cases of the Electron shell's `remote.spec.ts`. The
//! Electron suite drove a real Deno server through a real window; this drives the real Rust server
//! through the real listener, over sockets, with no window.

mod support;

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::time::Duration;

use reqwest::Method;
use serde_json::{Value, json};
use spm_core::testing::TempLibrary;
use spm_core::{PreviewConfig, ensure_bootstrap_admin, run_preview_batch};
use spm_http::{AppState, AuthMode, HttpOptions, router};
use spm_shell::library::PromptTrigger;
use spm_shell::shell::ActiveMode;
use support::{Client, Upstream, World, answer, fixtures, no_env, serve};

const PASSWORD: &str = "a good long password";

/// A real server: its library, a socket, and the admin's activation token.
struct RealServer {
    library: TempLibrary,
    origin: String,
    token: String,
    task: tokio::task::JoinHandle<()>,
}

impl RealServer {
    async fn start() -> RealServer {
        let library = TempLibrary::new();
        let token = ensure_bootstrap_admin(&library)
            .unwrap()
            .expect("an empty library gets a bootstrap admin")
            .token;
        let state = AppState::new(
            (*library).clone(),
            HttpOptions {
                auth: AuthMode::Sessions,
                ..HttpOptions::default()
            },
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        RealServer {
            library,
            origin: format!("http://{addr}"),
            token,
            task,
        }
    }
}

impl Drop for RealServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A shell connected to `server`, behind a listener, with the page's cookie.
struct Connected {
    world: World,
    client: Client,
    _listener: spm_shell::server::DesktopServer,
}

async fn connect_to(server: &RealServer) -> Connected {
    let world = World::new();
    world.prompts.will_confirm(true);
    world
        .shell
        .connect_remote(&server.origin)
        .unwrap()
        .expect("connected");
    let listener = serve(&world.shell).await;
    let client = Client::handshake(&listener).await;
    Connected {
        world,
        client,
        _listener: listener,
    }
}

async fn activate(connected: &Connected, server: &RealServer) {
    let reply = connected
        .client
        .post_json(
            &format!("/api/auth/activation/{}", server.token),
            &json!({ "password": PASSWORD, "confirm": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
}

#[tokio::test]
async fn remote_mode_reaches_a_real_server_signs_in_and_lists_what_is_on_it() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    assert_eq!(connected.world.shell.mode(), ActiveMode::Remote);

    // Not signed in: the server's own answer, through the proxy.
    let anonymous = connected.client.get("/api/projects").await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.error_code(), "Unauthorized");

    activate(&connected, &server).await;
    // The session cookie never reached the page, but the shell carries it.
    assert!(connected.world.shell.remote().unwrap().has_session());
    let created = connected
        .client
        .post_json("/api/projects", &json!({ "name": "On The Server" }))
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    // Created on the server's own disk, not on this machine.
    assert!(
        server
            .library
            .path()
            .join("admin")
            .join("On The Server")
            .is_dir()
    );
    let list = connected.client.get("/api/projects").await.json();
    assert_eq!(list[0]["name"], "On The Server");
}

#[tokio::test]
async fn the_capability_set_in_remote_mode_is_the_union_and_the_page_keys_off_it() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    let caps = connected.client.get("/api/capabilities").await.json();
    assert_eq!(caps["requiresAuth"], true, "the server needs a login");
    assert_eq!(caps["canManageUsers"], true, "the server hosts users");
    assert_eq!(
        caps["canPickLocalFolder"], false,
        "the library on screen is the server's"
    );
    // The flags parts 2 and 3 light are the shell's to add: absent from the server, present here
    // once the shell has them. Today both columns say false.
    for flag in [
        "canLaunchSlicer",
        "canConfigureSlicers",
        "canBrowseModelSites",
    ] {
        assert_eq!(caps[flag], false, "{flag}");
    }
}

#[tokio::test]
async fn a_restart_keeps_the_server_but_deliberately_not_the_session() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    activate(&connected, &server).await;
    assert_eq!(connected.client.get("/api/account").await.status, 200);

    // Nothing that could be used to sign in is on disk.
    let state = std::fs::read_to_string(connected.world.state_file()).unwrap();
    assert!(state.contains(&server.origin));
    for secret in ["spm_session", PASSWORD, &server.token] {
        assert!(
            !state.contains(secret),
            "{secret} was written to state.json"
        );
    }

    // The next launch reconnects without asking, and starts signed out.
    connected.world.shell.shutdown(Duration::from_secs(5));
    let next = connected.world.relaunch();
    assert!(matches!(
        next.shell.start(&no_env).unwrap(),
        spm_shell::shell::StartOutcome::Opened
    ));
    assert_eq!(next.shell.remote().unwrap().origin(), server.origin);
    assert!(!next.shell.remote().unwrap().has_session());
    let listener = serve(&next.shell).await;
    let client = Client::handshake(&listener).await;
    assert_eq!(client.get("/api/account").await.status, 401);
}

#[tokio::test]
async fn switching_to_a_local_folder_leaves_nothing_of_the_server_behind() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    activate(&connected, &server).await;
    let remote = connected.world.shell.remote().unwrap();

    connected
        .world
        .prompts
        .will_pick(Some(&connected.world.folder("lib")));
    connected
        .world
        .shell
        .pick_local_folder(PromptTrigger::User)
        .unwrap();
    assert_eq!(connected.world.shell.mode(), ActiveMode::Local);
    assert!(remote.is_closed());

    // `/api` is the local library now: there is no login route in local mode, and the account is
    // the local user, not the server's admin.
    assert_eq!(
        connected
            .client
            .post_json(
                "/api/auth/login",
                &json!({ "username": "admin", "password": PASSWORD })
            )
            .await
            .status,
        404
    );
    assert_eq!(
        connected.client.get("/api/account").await.json()["username"],
        "local"
    );
    let caps = connected.client.get("/api/capabilities").await.json();
    assert_eq!(caps["requiresAuth"], false);
    assert_eq!(caps["canPickLocalFolder"], true);
}

#[tokio::test]
async fn an_upload_in_remote_mode_reaches_the_server_length_and_all() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    activate(&connected, &server).await;
    let id = connected
        .client
        .post_json("/api/projects", &json!({ "name": "Uploads" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let bytes: Vec<u8> = (0..2 * 1024 * 1024u32).map(|n| (n % 253) as u8).collect();
    let reply = connected.client.upload(&id, "big.bin", bytes.clone()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let on_server = std::fs::read(
        server
            .library
            .path()
            .join("admin")
            .join("Uploads")
            .join("big.bin"),
    )
    .unwrap();
    assert_eq!(on_server.len(), bytes.len());
    assert!(on_server == bytes, "the bytes differ on the server's disk");

    // A body with no length of its own (a streamed one) is refused by the server, as it is for a
    // browser: the proxy does not paper over that.
    let chunks = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(vec![1u8; 10])]);
    let streamed = connected
        .client
        .send(
            connected
                .client
                .request(Method::POST, &format!("/api/projects/{id}/files"))
                .header("x-spm-file-name", "streamed.bin")
                .body(reqwest::Body::wrap_stream(chunks)),
        )
        .await;
    assert_eq!(streamed.status, 411, "{}", streamed.text());
    assert_eq!(streamed.error_code(), "LengthRequired");
}

#[tokio::test]
async fn an_error_arrives_with_its_code_and_details_intact_through_the_proxy() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    activate(&connected, &server).await;
    let me = connected.client.get("/api/account").await.json();
    let id = connected
        .client
        .post_json("/api/projects", &json!({ "name": "Quota" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // A quota of 10 bytes on the account, then a 100-byte upload.
    let limited = connected
        .client
        .send(
            connected
                .client
                .request(
                    Method::PATCH,
                    &format!("/api/users/{}", me["id"].as_str().unwrap()),
                )
                .json(&json!({ "quotaBytes": 10 })),
        )
        .await;
    assert_eq!(limited.status, 200, "{}", limited.text());
    let reply = connected
        .client
        .upload(&id, "too-big.bin", vec![0u8; 100])
        .await;
    assert_eq!(reply.status, 413);
    let body = reply.json();
    assert_eq!(body["error"]["code"], "QuotaExceeded");
    assert_eq!(body["error"]["details"]["quotaBytes"], 10);
    assert!(body["error"]["details"]["usageBytes"].is_number());
}

#[tokio::test]
async fn a_real_thumbnail_and_a_real_download_come_through_the_forced_headers_intact() {
    let server = RealServer::start().await;
    let connected = connect_to(&server).await;
    activate(&connected, &server).await;
    let id = connected
        .client
        .post_json("/api/projects", &json!({ "name": "Pictures" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let stl = fixtures::cube_stl();
    let file = connected
        .client
        .upload(&id, "cube.stl", stl.clone())
        .await
        .json();
    run_preview_batch(&server.library, &PreviewConfig::default()).unwrap();

    let detail: Value = connected
        .client
        .get(&format!("/api/projects/{id}"))
        .await
        .json();
    let thumb_url = detail["files"][0]["thumbUrl"]
        .as_str()
        .expect("a preview was rendered");
    // A relative URL the server decorated: it resolves on the app's own origin, through the proxy.
    assert!(thumb_url.starts_with("/api/files/"));
    let thumb = connected.client.get(thumb_url).await;
    assert_eq!(thumb.status, 200);
    assert_eq!(fixtures::png_size(&thumb.body), (256, 256));
    assert_eq!(
        thumb.header("content-security-policy").as_deref(),
        Some("default-src 'none'; sandbox")
    );
    assert_eq!(
        thumb.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );

    let raw = connected.client.get(file["rawUrl"].as_str().unwrap()).await;
    assert_eq!(raw.status, 200);
    assert_eq!(raw.body, stl);
    assert_eq!(
        raw.header("content-security-policy").as_deref(),
        Some("default-src 'none'; sandbox")
    );
}

#[tokio::test]
async fn a_proxied_response_cannot_become_a_document_in_the_origin_that_holds_the_bridge() {
    // A hostile server answers a file URL with a page. It reaches the webview with a policy that
    // gives the document an opaque origin, no script and no forms: nothing to hold the bridge with.
    let hostile = Upstream::start(|_| {
        answer(
            200,
            &[
                ("content-type", "text/html"),
                ("content-security-policy", "default-src *"),
            ],
            "<script>window.__pwned = true</script>",
        )
    })
    .await;
    let world = World::new();
    world.prompts.will_confirm(true);
    world
        .shell
        .connect_remote(&hostile.origin)
        .unwrap()
        .unwrap();
    let listener = serve(&world.shell).await;
    let client = Client::handshake(&listener).await;
    let reply = client.get("/api/files/x/raw").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type").as_deref(), Some("text/html"));
    assert_eq!(
        reply.header("content-security-policy").as_deref(),
        Some("default-src 'none'; sandbox")
    );
    assert_eq!(
        reply.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    // The listener's own hardening headers are there too (and never replace the server-forced CSP).
    assert_eq!(
        reply.header("referrer-policy").as_deref(),
        Some("no-referrer")
    );
}

#[tokio::test]
async fn the_page_never_learns_the_servers_origin_and_the_server_never_learns_the_app_s() {
    let server_stub = Upstream::start(|_| {
        answer(
            200,
            &[
                ("content-type", "application/json"),
                ("set-cookie", "spm_session=abc; Path=/; HttpOnly"),
            ],
            r#"{"name":"x"}"#,
        )
    })
    .await;
    let world = World::new();
    world.prompts.will_confirm(true);
    world
        .shell
        .connect_remote(&server_stub.origin)
        .unwrap()
        .unwrap();
    let listener = serve(&world.shell).await;
    let client = Client::handshake(&listener).await;
    let reply = client.get("/api/projects").await;
    assert!(reply.header("set-cookie").is_none());
    assert!(!reply.text().contains(&server_stub.origin));
    let seen = server_stub.last();
    // No cookie of the launch secret, no origin, no referer reach the server.
    assert!(seen.header("cookie").is_none());
    assert!(seen.header("origin").is_none() && seen.header("referer").is_none());
    assert_eq!(
        seen.header("host").as_deref(),
        Some(server_stub.addr.to_string().as_str())
    );
    let _ = world.prompts.confirm_calls.load(Ordering::SeqCst);
}
