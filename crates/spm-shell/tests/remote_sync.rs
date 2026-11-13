//! The library sync end to end: a shell connected to a **real** `spm-http` server over a socket,
//! syncing through the very proxy the page uses, signed in by the page. Files go both ways and a
//! folder made here becomes a project there.

mod support;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use spm_core::ensure_bootstrap_admin;
use spm_core::testing::TempLibrary;
use spm_http::{AppState, AuthMode, HttpOptions, router};
use spm_shell::library_sync::SyncPhase;
use spm_shell::shell::SyncSetup;
use support::{Client, World, serve};

const PASSWORD: &str = "a good long password";

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

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connected_server_is_synced_into_a_folder_both_ways_through_the_proxy() {
    let server = RealServer::start().await;
    let sync_root = tempfile::tempdir().unwrap();
    let root: PathBuf = sync_root.path().join("print.example.com");
    let default_root = root.clone();
    let world = World::with(|options| {
        let mut setup = SyncSetup::new(
            tokio::runtime::Handle::current(),
            Arc::new(move |_| default_root.clone()),
        );
        setup.poll = Duration::from_millis(500);
        options.sync = Some(setup);
    });
    world.prompts.will_confirm(true);
    world
        .shell
        .connect_remote(&server.origin)
        .unwrap()
        .expect("connected");
    let listener = serve(&world.shell).await;
    let client = Client::handshake(&listener).await;

    // Not signed in yet: the sync waits, and asks the server nothing.
    let shell = Arc::clone(&world.shell);
    eventually("the sync to wait for a sign-in", || {
        shell
            .sync_status()
            .is_some_and(|status| status.phase == SyncPhase::WaitingForSignIn)
    })
    .await;

    // The page signs in and makes a project with a file, through the proxy.
    let reply = client
        .post_json(
            &format!("/api/auth/activation/{}", server.token),
            &json!({ "password": PASSWORD, "confirm": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let id = client
        .post_json("/api/projects", &json!({ "name": "Robot" }))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let uploaded = client.upload(&id, "arm.stl", b"solid arm".to_vec()).await;
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());

    // It comes down into the folder.
    let arm = root.join("Robot").join("arm.stl");
    eventually("the uploaded file to come down", || arm.is_file()).await;
    assert_eq!(std::fs::read(&arm).unwrap(), b"solid arm");
    let file_id = uploaded.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(
        world
            .shell
            .synced_path_of(&file_id)
            .map(|path| std::fs::canonicalize(path).unwrap()),
        Some(std::fs::canonicalize(&arm).unwrap())
    );

    // A folder made here goes up as a project, with a nested file.
    std::fs::create_dir_all(root.join("Made Here").join("parts")).unwrap();
    std::fs::write(
        root.join("Made Here").join("parts").join("leg.stl"),
        b"solid leg",
    )
    .unwrap();
    let on_server = server
        .library
        .path()
        .join("admin")
        .join("Made Here")
        .join("parts")
        .join("leg.stl");
    eventually("the new folder to reach the server", || on_server.is_file()).await;
    let projects = client.get("/api/projects").await.json();
    let names: Vec<&str> = projects
        .as_array()
        .unwrap()
        .iter()
        .map(|project| project["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Made Here"), "{names:?}");

    // An edit here reaches the server's disk.
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::write(&arm, b"solid arm, edited").unwrap();
    let server_arm = server
        .library
        .path()
        .join("admin")
        .join("Robot")
        .join("arm.stl");
    eventually("the edit to reach the server", || {
        std::fs::read(&server_arm).ok().as_deref() == Some(b"solid arm, edited".as_slice())
    })
    .await;

    // Signing out pauses it.
    let out = client.post_json("/api/auth/logout", &json!({})).await;
    assert!(out.status < 300, "{}", out.text());
    eventually("the sync to wait for a sign-in again", || {
        shell
            .sync_status()
            .is_some_and(|status| status.phase == SyncPhase::WaitingForSignIn)
    })
    .await;
    world.shell.shutdown(Duration::from_secs(5));
}
