//! Local folder mode through the real loopback listener: the cases of the Electron shell's
//! `dispatch.test.ts`, `files.test.ts`, `files.spec.ts`, `bridge.spec.ts` and `library.spec.ts`
//! that were about the library API and file bytes. The IPC bridge they were written against is
//! gone; the same behaviours are asserted of the HTTP API the web app now uses, over a socket,
//! behind the launch secret.

mod support;

use std::fs;

use reqwest::Method;
use serde_json::{Value, json};
use spm_core::{PreviewConfig, run_preview_batch};
use support::{Client, World, fixtures, serve};

struct Local {
    world: World,
    client: Client,
    _server: spm_shell::server::DesktopServer,
}

impl Local {
    async fn new() -> Local {
        let world = World::new();
        world
            .shell
            .library()
            .open(&world.folder("lib"), true)
            .unwrap();
        world.shell.library().settle();
        let server = serve(&world.shell).await;
        let client = Client::handshake(&server).await;
        Local {
            world,
            client,
            _server: server,
        }
    }

    fn dir(&self) -> std::path::PathBuf {
        self.world.shell.library().dir().unwrap()
    }

    async fn project(&self, name: &str) -> Value {
        let reply = self
            .client
            .post_json("/api/projects", &json!({ "name": name }))
            .await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        reply.json()
    }

    async fn detail(&self, id: &str) -> Value {
        self.client.get(&format!("/api/projects/{id}")).await.json()
    }

    fn render_previews(&self) {
        let session = self.world.shell.session().unwrap();
        run_preview_batch(&session.lib, &PreviewConfig::default()).unwrap();
    }
}

fn file_named(detail: &Value, name: &str) -> Value {
    detail["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["name"] == name)
        .unwrap_or_else(|| panic!("no file {name} in {detail}"))
        .clone()
}

// ---- no library yet ---------------------------------------------------------------------------------------

#[tokio::test]
async fn capabilities_answer_without_a_library_and_say_auth_is_not_required() {
    let world = World::new();
    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    let reply = client.get("/api/capabilities").await;
    assert_eq!(reply.status, 200);
    let caps = reply.json();
    assert_eq!(caps["requiresAuth"], false);
    // The connect page can be reached: the shell can pick a folder before any library exists.
    assert_eq!(caps["canPickLocalFolder"], true);
}

#[tokio::test]
async fn every_library_backed_route_refuses_when_no_folder_is_open() {
    let world = World::new();
    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    for (method, path) in [
        (Method::GET, "/api/account"),
        (Method::GET, "/api/account/settings"),
        (Method::GET, "/api/projects"),
        (Method::POST, "/api/projects"),
        (Method::GET, "/api/projects/tags"),
        (Method::POST, "/api/projects/rescan"),
        (Method::GET, "/api/projects/p1"),
        (Method::POST, "/api/projects/p1/files"),
        (Method::GET, "/api/files/f1/raw"),
        (Method::GET, "/api/files/f1/thumb"),
        (Method::POST, "/api/import/curamanager"),
    ] {
        let reply = client.send(client.request(method.clone(), path)).await;
        assert_eq!(reply.status, 409, "{method} {path}");
        assert_eq!(reply.error_code(), "Conflict", "{method} {path}");
    }
}

// ---- the account --------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_account_is_the_single_local_user_and_not_an_administrator() {
    let local = Local::new().await;
    let me = local.client.get("/api/account").await.json();
    assert_eq!(me["username"], "local");
    assert_eq!(me["isAdmin"], false);
}

#[tokio::test]
async fn settings_round_trip_through_the_library_and_a_profile_update_is_seen_by_the_next_read() {
    let local = Local::new().await;
    let defaults = local.client.get("/api/account/settings").await.json();
    assert_eq!(defaults["theme"], "system");
    let put = local
        .client
        .put_json(
            "/api/account/settings",
            &json!({ "theme": "dark", "viewMode": "list" }),
        )
        .await;
    assert_eq!(put.status, 200, "{}", put.text());
    let read = local.client.get("/api/account/settings").await.json();
    assert_eq!(
        (read["theme"].as_str(), read["viewMode"].as_str()),
        (Some("dark"), Some("list"))
    );

    let patched = local
        .client
        .send(
            local
                .client
                .request(Method::PATCH, "/api/account")
                .json(&json!({ "displayName": "Marc" })),
        )
        .await;
    assert_eq!(patched.status, 200, "{}", patched.text());
    assert_eq!(
        local.client.get("/api/account").await.json()["displayName"],
        "Marc"
    );
}

#[tokio::test]
async fn the_auth_and_admin_routes_do_not_exist_because_local_mode_has_no_login() {
    let local = Local::new().await;
    for (method, path) in [
        (Method::POST, "/api/auth/login"),
        (Method::POST, "/api/auth/logout"),
        (Method::GET, "/api/auth/activation/anything"),
        (Method::POST, "/api/auth/activate"),
        (Method::GET, "/api/users"),
        (Method::POST, "/api/users"),
        (Method::PATCH, "/api/users/u1"),
        (Method::DELETE, "/api/users/u1"),
        (Method::POST, "/api/users/u1/invite"),
        (Method::POST, "/api/account/password"),
    ] {
        let reply = local
            .client
            .send(local.client.request(method.clone(), path))
            .await;
        assert_eq!(reply.status, 404, "{method} {path}");
    }
}

// ---- projects ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_project_can_be_created_found_tagged_listed_updated_and_deleted() {
    let local = Local::new().await;
    let created = local.project("Benchy").await;
    let id = created["id"].as_str().unwrap().to_owned();
    // A flat library: the folder is directly under the library root, with no user level.
    assert!(local.dir().join("Benchy").is_dir());

    let tagged = local
        .client
        .post_json(
            &format!("/api/projects/{id}/tags"),
            &json!({ "name": "boat" }),
        )
        .await;
    assert_eq!(tagged.status, 204, "{}", tagged.text());
    let list = local.client.get("/api/projects").await.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["tags"], json!(["boat"]));

    let updated = local
        .client
        .send(
            local
                .client
                .request(Method::PATCH, &format!("/api/projects/{id}"))
                .json(&json!({ "isArchived": true })),
        )
        .await;
    assert_eq!(updated.json()["isArchived"], true);

    let deleted = local.client.delete(&format!("/api/projects/{id}")).await;
    assert_eq!(deleted.status, 204);
    let gone = local.client.get(&format!("/api/projects/{id}")).await;
    assert_eq!(gone.status, 404);
    assert_eq!(gone.error_code(), "NotFound");
}

#[tokio::test]
async fn the_librarys_distinct_tags_come_back_sorted_case_insensitively() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for tag in ["Zebra", "apple", "Mango"] {
        local
            .client
            .post_json(&format!("/api/projects/{id}/tags"), &json!({ "name": tag }))
            .await;
    }
    assert_eq!(
        local.client.get("/api/projects/tags").await.json(),
        json!(["apple", "Mango", "Zebra"])
    );
}

#[tokio::test]
async fn a_bad_argument_is_refused_with_the_code_the_server_would_send_and_nothing_is_written() {
    let local = Local::new().await;
    let reply = local
        .client
        .post_json("/api/projects", &json!({ "name": "" }))
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), "Validation");
    // Malformed bodies of every shape are a 400, not a 500.
    for body in ["not json", "[]", "null", "{\"name\": 7}"] {
        let reply = local
            .client
            .send(
                local
                    .client
                    .request(Method::POST, "/api/projects")
                    .header("content-type", "application/json")
                    .body(body.to_owned()),
            )
            .await;
        assert_eq!(reply.status, 400, "{body}");
    }
    assert_eq!(local.client.get("/api/projects").await.json(), json!([]));
}

#[tokio::test]
async fn a_failure_keeps_its_code_across_the_boundary() {
    let local = Local::new().await;
    let not_found = local.client.get("/api/projects/nope").await;
    assert_eq!(
        (not_found.status, not_found.error_code().as_str()),
        (404, "NotFound")
    );
    let invalid = local.client.post_json("/api/projects", &json!({})).await;
    assert_eq!(
        (invalid.status, invalid.error_code().as_str()),
        (400, "Validation")
    );
    let missing_file = local.client.get("/api/files/nope/raw").await;
    assert_eq!(
        (missing_file.status, missing_file.error_code().as_str()),
        (404, "NotFound")
    );
    // The envelope is always the same shape: `{ error: { code, message, details } }`.
    let body = not_found.json();
    assert!(body["error"]["message"].is_string() && body["error"]["details"].is_object());
}

// ---- the library on disk -----------------------------------------------------------------------------------

#[tokio::test]
async fn the_project_list_renders_the_library_that_was_on_disk_before_the_app_started() {
    let world = World::new();
    let dir = world.folder("lib");
    for (name, files) in [("Benchy", 2usize), ("Calibration Cube", 1)] {
        fs::create_dir_all(dir.join(name)).unwrap();
        for index in 0..files {
            fs::write(
                dir.join(name).join(format!("part-{index}.stl")),
                fixtures::cube_stl(),
            )
            .unwrap();
        }
    }
    world.shell.library().open(&dir, true).unwrap();
    world.shell.library().settle();
    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    let list = client.get("/api/projects").await.json();
    let mut found: Vec<(String, i64)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|project| {
            (
                project["name"].as_str().unwrap().to_owned(),
                project["fileCounts"]["model"].as_i64().unwrap_or_default(),
            )
        })
        .collect();
    found.sort();
    assert_eq!(
        found,
        [("Benchy".to_owned(), 2), ("Calibration Cube".to_owned(), 1)]
    );
}

#[tokio::test]
async fn a_value_written_through_the_api_is_on_disk_and_comes_back_on_the_next_launch() {
    let local = Local::new().await;
    local.project("Written").await;
    assert!(local.dir().join("Written").is_dir());
    local
        .world
        .shell
        .shutdown(std::time::Duration::from_secs(10));

    // The next launch, on the same folder.
    let next = local.world.relaunch();
    assert!(matches!(
        next.shell.start(&support::no_env).unwrap(),
        spm_shell::shell::StartOutcome::Opened
    ));
    let server = serve(&next.shell).await;
    let client = Client::handshake(&server).await;
    let list = client.get("/api/projects").await.json();
    assert_eq!(list[0]["name"], "Written");
}

#[tokio::test]
async fn rescan_adopts_a_folder_that_was_dropped_into_the_library() {
    let local = Local::new().await;
    fs::create_dir_all(local.dir().join("Dropped In")).unwrap();
    fs::write(
        local.dir().join("Dropped In").join("a.stl"),
        fixtures::cube_stl(),
    )
    .unwrap();
    let rescanned = local
        .client
        .send(local.client.request(Method::POST, "/api/projects/rescan"))
        .await;
    assert_eq!(rescanned.status, 200, "{}", rescanned.text());
    let list = local.client.get("/api/projects").await.json();
    assert_eq!(list[0]["name"], "Dropped In");
}

// ---- files ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn files_upload_rename_and_delete_and_their_urls_point_at_the_api() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let uploaded = local
        .client
        .upload(&id, "benchy.stl", fixtures::cube_stl())
        .await;
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());
    let file = uploaded.json();
    let file_id = file["id"].as_str().unwrap().to_owned();
    assert_eq!(file["rawUrl"], format!("/api/files/{file_id}/raw"));
    // The bytes are in the project folder, under the declared name.
    assert_eq!(
        fs::read(local.dir().join("Benchy").join("benchy.stl")).unwrap(),
        fixtures::cube_stl()
    );

    let renamed = local
        .client
        .send(
            local
                .client
                .request(Method::PATCH, &format!("/api/files/{file_id}"))
                .json(&json!({ "name": "boat.stl" })),
        )
        .await;
    assert_eq!(
        renamed.json()["rawUrl"],
        format!("/api/files/{file_id}/raw"),
        "rename keeps the URL"
    );
    assert!(local.dir().join("Benchy").join("boat.stl").is_file());

    assert_eq!(
        local
            .client
            .delete(&format!("/api/files/{file_id}"))
            .await
            .status,
        204
    );
    assert!(!local.dir().join("Benchy").join("boat.stl").exists());
}

#[tokio::test]
async fn a_name_that_traverses_or_is_reserved_never_reaches_the_filesystem() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for name in [
        "../escape.stl",
        "..%2Fescape.stl",
        "%2E%2E%2Fescape.stl",
        "nested%2Fdir.stl",
        ".hidden",
        "CON",
        "nul.txt",
        "a%5Cb.stl",
        "",
    ] {
        let reply = local.client.upload(&id, name, b"solid".to_vec()).await;
        assert_eq!(reply.status, 400, "{name:?}: {}", reply.text());
    }
    // Nothing was written anywhere near the library, inside or out.
    let parent = local.dir().parent().unwrap().to_path_buf();
    assert!(!parent.join("escape.stl").exists() && !local.dir().join("escape.stl").exists());
    assert!(
        fs::read_dir(local.dir().join("Benchy"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn raw_answers_the_exact_bytes_on_disk_with_the_headers_the_server_sends() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = local
        .client
        .upload(&id, "benchy.stl", b"solid benchy".to_vec())
        .await
        .json();
    let raw = local.client.get(file["rawUrl"].as_str().unwrap()).await;
    assert_eq!(raw.status, 200);
    assert_eq!(raw.body, b"solid benchy");
    assert_eq!(raw.header("content-length").as_deref(), Some("12"));
    assert_eq!(
        raw.header("content-disposition").as_deref(),
        Some("inline; filename*=UTF-8''benchy.stl")
    );
    assert_eq!(
        raw.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    // An incoming Range is ignored: the whole file comes back with a 200.
    let ranged = local
        .client
        .send(
            local
                .client
                .request(Method::GET, file["rawUrl"].as_str().unwrap())
                .header("range", "bytes=2-5"),
        )
        .await;
    assert_eq!(ranged.status, 200);
    assert_eq!(ranged.body, b"solid benchy");
    assert!(ranged.header("content-range").is_none());
}

#[tokio::test]
async fn a_library_file_that_looks_like_a_web_page_is_served_so_it_downloads_and_never_runs() {
    let local = Local::new().await;
    let id = local.project("Pages").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (name, body) in [
        ("page.html", "<script>window.pwned=1</script>"),
        (
            "image.svg",
            "<svg xmlns='http://www.w3.org/2000/svg' onload='window.pwned=1'/>",
        ),
        ("page.xhtml", "<html xmlns='http://www.w3.org/1999/xhtml'/>"),
        ("data.xml", "<?xml version='1.0'?><a/>"),
        ("script.js", "window.pwned=1"),
        ("page.htm", "<script>1</script>"),
        ("page.mhtml", "From: x"),
    ] {
        let file = local
            .client
            .upload(&id, name, body.as_bytes().to_vec())
            .await
            .json();
        let raw = local.client.get(file["rawUrl"].as_str().unwrap()).await;
        assert_eq!(raw.status, 200, "{name}");
        assert_eq!(
            raw.header("content-type").as_deref(),
            Some("application/octet-stream"),
            "{name} would be executed by the webview"
        );
        assert_eq!(
            raw.header("x-content-type-options").as_deref(),
            Some("nosniff"),
            "{name}"
        );
        assert_eq!(raw.body, body.as_bytes(), "{name}");
    }
}

#[tokio::test]
async fn a_body_larger_than_one_stream_chunk_arrives_whole_and_in_order() {
    let local = Local::new().await;
    let id = local.project("Big").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let big: Vec<u8> = (0..3 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    let file = local
        .client
        .upload(&id, "big.bin", big.clone())
        .await
        .json();
    let raw = local.client.get(file["rawUrl"].as_str().unwrap()).await;
    assert_eq!(raw.body.len(), big.len());
    assert!(raw.body == big, "the bytes differ");
}

#[tokio::test]
async fn an_id_that_names_nothing_is_a_404_however_it_is_spelled_and_near_misses_are_not_file_requests()
 {
    let local = Local::new().await;
    for path in [
        "/api/files/nope/raw",
        "/api/files/nope/thumb",
        "/api/files/%2E%2E%2F%2E%2E%2Fsecret/raw",
        "/api/files/..%2f..%2fsecret/thumb",
        "/api/files/%00/raw",
        "/api/files/ID%20WITH%20SPACE/raw",
        // The one canonical spelling is a file request; these are not.
        "/api/files/nope/raw/",
        "/api/files//raw",
        "/api/files/nope",
        "/api/files/nope/raw/extra",
        "/api/FILES/nope/raw",
        "/api/file/nope/raw",
        "/api/files/nope/RAW",
        "/api/files/nope/original",
    ] {
        let reply = local.client.get(path).await;
        assert_eq!(
            reply.status,
            if path == "/api/files/nope" { 405 } else { 404 },
            "{path}"
        );
        assert_eq!(
            reply
                .header("content-type")
                .as_deref()
                .map(|t| t.starts_with("application/json")),
            Some(true),
            "{path}: not the error envelope"
        );
    }
}

#[tokio::test]
async fn a_file_whose_bytes_are_gone_is_a_404_not_a_200_with_a_torn_body() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = local
        .client
        .upload(&id, "gone.stl", b"solid".to_vec())
        .await
        .json();
    fs::remove_file(local.dir().join("Benchy").join("gone.stl")).unwrap();
    let raw = local.client.get(file["rawUrl"].as_str().unwrap()).await;
    assert_eq!(raw.status, 404);
    assert_eq!(raw.error_code(), "NotFound");
}

#[tokio::test]
async fn core_refusing_a_path_that_escapes_the_library_is_a_403_not_a_crash() {
    let local = Local::new().await;
    let id = local.project("Benchy").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = local
        .client
        .upload(&id, "a.stl", b"solid".to_vec())
        .await
        .json();
    let file_id = file["id"].as_str().unwrap().to_owned();
    // Poison the row: a path that climbs out of the library.
    let session = local.world.shell.session().unwrap();
    session
        .lib
        .db()
        .execute(
            "UPDATE files SET rel_path = ? WHERE id = ?",
            rusqlite_params(&["../../escape.stl", &file_id]),
        )
        .unwrap();
    let raw = local.client.get(&format!("/api/files/{file_id}/raw")).await;
    assert_eq!(raw.status, 403, "{}", raw.text());
    assert_eq!(raw.error_code(), "Forbidden");
}

fn rusqlite_params<'a>(values: &'a [&'a str]) -> impl rusqlite::Params + 'a {
    rusqlite::params_from_iter(values.iter())
}

// ---- thumbnails -------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_thumbnail_is_a_404_until_it_is_ready_then_a_png_with_a_private_cache_header() {
    let local = Local::new().await;
    let project = local.project("Benchy").await;
    let id = project["id"].as_str().unwrap().to_owned();
    fs::write(
        local.dir().join("Benchy").join("cube.stl"),
        fixtures::cube_stl(),
    )
    .unwrap();
    local
        .client
        .send(local.client.request(Method::POST, "/api/projects/rescan"))
        .await;
    let pending = file_named(&local.detail(&id).await, "cube.stl");
    assert_eq!(pending["previewState"], "pending");
    assert_eq!(
        local
            .client
            .get(&format!(
                "/api/files/{}/thumb",
                pending["id"].as_str().unwrap()
            ))
            .await
            .status,
        404
    );

    local.render_previews();

    let detail = local.detail(&id).await;
    let ready = file_named(&detail, "cube.stl");
    assert_eq!(ready["previewState"], "ready");
    let thumb_url = ready["thumbUrl"].as_str().unwrap();
    // The project's cover is the same URL (`coverThumbUrl` on the project card).
    assert_eq!(detail["coverThumbUrl"], thumb_url);
    let thumb = local.client.get(thumb_url).await;
    assert_eq!(thumb.status, 200);
    assert_eq!(thumb.header("content-type").as_deref(), Some("image/png"));
    assert_eq!(
        thumb.header("cache-control").as_deref(),
        Some("private, max-age=60")
    );
    assert_eq!(
        fixtures::png_size(&thumb.body),
        (256, 256),
        "the rasterizer's picture, decoded"
    );
}

#[tokio::test]
async fn the_queue_renders_a_3mf_s_embedded_thumbnail_from_a_folder_that_had_none() {
    // library.spec: "the app renders a thumbnail the queue produced, from a folder that had none".
    let world = World::new();
    let dir = world.folder("lib");
    fs::create_dir_all(dir.join("Cura Project")).unwrap();
    fs::write(
        dir.join("Cura Project").join("benchy.3mf"),
        fixtures::cura_project(&fixtures::png(300, 300)),
    )
    .unwrap();
    world.shell.library().open(&dir, true).unwrap();
    world.shell.library().settle();
    let session = world.shell.session().unwrap();
    run_preview_batch(&session.lib, &PreviewConfig::default()).unwrap();

    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    let list = client.get("/api/projects").await.json();
    let project = &list[0];
    let thumb = client
        .get(project["coverThumbUrl"].as_str().expect("a cover"))
        .await;
    assert_eq!(thumb.status, 200);
    assert_eq!(thumb.header("content-type").as_deref(), Some("image/png"));
    assert!(fixtures::png_size(&thumb.body).0 > 0);
}

#[tokio::test]
async fn the_real_preview_worker_renders_what_is_in_the_folder_without_being_asked() {
    // The shell's own worker (not a batch the test runs): open a folder with a model in it and its
    // thumbnail appears on its own.
    let world = support::World::with(|options| {
        options.start_previews = spm_shell::library::default_start_previews();
    });
    let dir = world.folder("lib");
    fs::create_dir_all(dir.join("Cube")).unwrap();
    fs::write(dir.join("Cube").join("cube.stl"), fixtures::cube_stl()).unwrap();
    world.shell.library().open(&dir, true).unwrap();
    let server = serve(&world.shell).await;
    let client = Client::handshake(&server).await;
    support::eventually(
        std::time::Duration::from_secs(30),
        "the worker rendered the thumbnail",
        || {
            // `block_in_place`-free polling: a synchronous peek at the database.
            let session = world.shell.session().unwrap();
            session
                .lib
                .db()
                .query_row(
                    "SELECT COUNT(*) FROM previews WHERE state = 'ready'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0
        },
    )
    .await;
    let list = client.get("/api/projects").await.json();
    assert!(list[0]["coverThumbUrl"].is_string(), "{list}");
    world.shell.shutdown(std::time::Duration::from_secs(30));
}

// ---- import --------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_curamanager_archive_is_imported_from_the_bytes_the_page_sends() {
    let local = Local::new().await;
    let archive = fixtures::zip(&[
        ("Imported Project/model.stl", &fixtures::cube_stl()[..]),
        ("Imported Project/notes.txt", b"hello"),
    ]);
    let reply = local
        .client
        .send(
            local
                .client
                .request(Method::POST, "/api/import/curamanager")
                .header("content-type", "application/zip")
                .body(archive),
        )
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let list = local.client.get("/api/projects").await.json();
    assert_eq!(list[0]["name"], "Imported Project");
    assert!(
        local
            .dir()
            .join("Imported Project")
            .join("model.stl")
            .is_file()
    );
}

#[tokio::test]
async fn a_rejected_import_leaves_no_staging_copy_behind() {
    let local = Local::new().await;
    let reply = local
        .client
        .send(
            local
                .client
                .request(Method::POST, "/api/import/curamanager")
                .header("content-type", "application/zip")
                .body(b"this is not a zip archive".to_vec()),
        )
        .await;
    assert!(reply.status >= 400, "{}", reply.status);
    // The failure keeps its code and the library is untouched.
    assert!(reply.json()["error"]["code"].is_string());
    // The upload is staged under `.spm/uploads`, and what was staged is gone.
    let staged = fs::read_dir(local.dir().join(".spm").join("uploads"))
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(staged, 0, "a rejected archive left its staging copy behind");
    assert_eq!(local.client.get("/api/projects").await.json(), json!([]));
}

#[tokio::test]
async fn opening_a_folder_migrates_it_and_seeds_exactly_one_local_user() {
    // shell.spec: "opens, migrates and seeds the library it was pointed at".
    let world = World::new();
    let dir = world.folder("lib");
    world.shell.library().open(&dir, true).unwrap();
    let session = world.shell.session().unwrap();
    let users: Vec<(String, bool)> = {
        let conn = session.lib.db();
        let mut statement = conn
            .prepare("SELECT username, is_admin FROM users")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(users, [("local".to_owned(), false)]);
    let version: i64 = session
        .lib
        .db()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3, "all three migrations are applied");
    assert!(dir.join(".spm").join("app.db").is_file());
}
