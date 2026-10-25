//! Ported from `legacy/server/test/projects.test.ts`. `parseProjectQuery` is `parse_project_query_
//! string` in `src/routes/projects.rs`, tested there.

use std::fs;

use serde_json::{Value, json};

use crate::support::{Req, TestServer};

async fn post_project(server: &TestServer, cookie: &str, body: Value) -> Value {
    let reply = server
        .fetch("/api/projects", Req::post().cookie(cookie).json(&body))
        .await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.json()
}

async fn names(server: &TestServer, cookie: &str, query: &str) -> Vec<String> {
    let reply = server
        .fetch(&format!("/api/projects{query}"), Req::get().cookie(cookie))
        .await;
    assert_eq!(reply.status, 200, "{query}: {}", reply.text());
    reply
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|project| project["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn projects_require_a_session() {
    let server = TestServer::new();
    assert_eq!(server.get("/api/projects").await.status, 401);
}

#[tokio::test]
async fn a_project_can_be_created_listed_fetched_patched_and_deleted() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;

    let project = post_project(
        &server,
        &cookie,
        json!({ "name": "Benchy", "tags": ["boat"], "website": "https://a.example" }),
    )
    .await;
    assert_eq!(project["tags"], json!(["boat"]));
    let id = project["id"].as_str().unwrap();

    let list = server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await
        .json();
    let ids: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [id]);

    let detail = server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(&cookie))
        .await
        .json();
    assert_eq!(detail["files"], json!([]));

    let patched = server
        .fetch(
            &format!("/api/projects/{id}"),
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "isArchived": true })),
        )
        .await;
    assert_eq!(patched.json()["isArchived"], true);

    let deleted = server
        .fetch(
            &format!("/api/projects/{id}?deleteFiles=true"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(deleted.status, 204);
    let after = server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await;
    assert_eq!(after.json(), json!([]));
    assert!(!server.dir().join("admin").join("Benchy").exists());
}

#[tokio::test]
async fn delete_without_delete_files_keeps_the_folder() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Keeper").await;
    let id = project["id"].as_str().unwrap();
    let deleted = server
        .fetch(
            &format!("/api/projects/{id}"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(deleted.status, 204);
    assert!(server.dir().join("admin").join("Keeper").exists());
}

#[tokio::test]
async fn query_parameters_map_onto_the_project_query() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    post_project(
        &server,
        &cookie,
        json!({ "name": "Benchy", "tags": ["boat", "petg"] }),
    )
    .await;
    post_project(
        &server,
        &cookie,
        json!({ "name": "Bracket", "tags": ["petg"] }),
    )
    .await;
    let archived = post_project(&server, &cookie, json!({ "name": "Old" })).await;
    server
        .fetch(
            &format!("/api/projects/{}", archived["id"].as_str().unwrap()),
            Req::patch()
                .cookie(&cookie)
                .json(&json!({ "isArchived": true })),
        )
        .await;

    assert_eq!(names(&server, &cookie, "?search=bench").await, ["Benchy"]);
    assert_eq!(
        names(&server, &cookie, "?tags=petg&tags=boat").await,
        ["Benchy"]
    );
    // Asserted in the server's own order and in both directions: sorting client-side, or
    // checking only asc, passes even when dir is ignored entirely.
    assert_eq!(
        names(&server, &cookie, "?sort=name&dir=asc").await,
        ["Benchy", "Bracket"]
    );
    assert_eq!(
        names(&server, &cookie, "?sort=name&dir=desc").await,
        ["Bracket", "Benchy"]
    );
    assert_eq!(
        names(&server, &cookie, "?includeArchived=true&sort=name&dir=asc").await,
        ["Benchy", "Bracket", "Old"]
    );
}

#[tokio::test]
async fn limit_and_offset_page_the_project_list_over_http() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    for name in ["Alpha", "Beta", "Gamma"] {
        server.new_project(&cookie, name).await;
    }
    // sort=name&dir=asc makes the three pages predictable: Alpha, Beta, Gamma.
    assert_eq!(
        names(&server, &cookie, "?sort=name&dir=asc&limit=2&offset=0").await,
        ["Alpha", "Beta"]
    );
    assert_eq!(
        names(&server, &cookie, "?sort=name&dir=asc&limit=2&offset=2").await,
        ["Gamma"]
    );
    // Past the end: empty, not an error.
    assert!(
        names(&server, &cookie, "?sort=name&dir=asc&limit=2&offset=10")
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_malformed_limit_is_refused_with_a_400_not_silently_answered_with_the_whole_library() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    server.new_project(&cookie, "Benchy").await;
    server.new_project(&cookie, "Bracket").await;

    // A non-numeric limit fails the whole query. It must be refused outright rather than falling
    // back to an empty query and answering 200 with every project, discarding the search with it.
    let reply = server
        .fetch(
            "/api/projects?search=bench&limit=abc",
            Req::get().cookie(&cookie),
        )
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), "Validation");
    assert!(reply.json()["error"]["details"]["issues"].is_array());

    for bad in ["limit=0", "limit=-1", "limit=201", "limit=1.5", "offset=-1"] {
        let reply = server
            .fetch(&format!("/api/projects?{bad}"), Req::get().cookie(&cookie))
            .await;
        assert_eq!(reply.status, 400, "{bad}");
    }
}

#[tokio::test]
async fn tags_are_added_by_body_and_removed_by_path() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let id = project["id"].as_str().unwrap();

    let added = server
        .fetch(
            &format!("/api/projects/{id}/tags"),
            Req::post()
                .cookie(&cookie)
                .json(&json!({ "name": "needs support" })),
        )
        .await;
    assert_eq!(added.status, 204);
    let detail = server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(&cookie))
        .await;
    assert_eq!(detail.json()["tags"], json!(["needs support"]));

    // The name is in the path, so there is no DELETE body.
    let removed = server
        .fetch(
            &format!("/api/projects/{id}/tags/needs%20support"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(removed.status, 204);
    let detail = server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(&cookie))
        .await;
    assert_eq!(detail.json()["tags"], json!([]));
}

#[tokio::test]
async fn a_tag_name_containing_a_literal_percent_sign_round_trips_through_the_path_route() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let id = project["id"].as_str().unwrap();

    let added = server
        .fetch(
            &format!("/api/projects/{id}/tags"),
            Req::post()
                .cookie(&cookie)
                .json(&json!({ "name": "100% infill" })),
        )
        .await;
    assert_eq!(added.status, 204);
    let detail = server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(&cookie))
        .await;
    assert_eq!(detail.json()["tags"], json!(["100% infill"]));

    let removed = server
        .fetch(
            &format!("/api/projects/{id}/tags/100%25%20infill"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(removed.status, 204);
    let detail = server
        .fetch(&format!("/api/projects/{id}"), Req::get().cookie(&cookie))
        .await;
    assert_eq!(detail.json()["tags"], json!([]));
}

#[tokio::test]
async fn a_malformed_percent_escape_in_the_tag_name_path_segment_is_a_400_not_a_500() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let project = server.new_project(&cookie, "Benchy").await;
    let id = project["id"].as_str().unwrap();

    let reply = server
        .fetch(
            &format!("/api/projects/{id}/tags/%"),
            Req::delete().cookie(&cookie),
        )
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), "Validation");
}

#[tokio::test]
async fn get_tags_returns_the_tag_list_sorted_case_insensitively() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    post_project(
        &server,
        &cookie,
        json!({ "name": "Benchy", "tags": ["Zebra"] }),
    )
    .await;
    post_project(
        &server,
        &cookie,
        json!({ "name": "Bracket", "tags": ["apple", "functional"] }),
    )
    .await;

    let reply = server
        .fetch("/api/projects/tags", Req::get().cookie(&cookie))
        .await;
    // Also proves this hits the tag list and not /api/projects/{id}, which would answer 404 for
    // an id of "tags": the collision the literal-path-first routing exists to avoid.
    assert_eq!(reply.status, 200);
    // `Zebra` sorts before `apple` under plain ordering, so this only passes with
    // case-insensitive sorting genuinely applied.
    assert_eq!(reply.json(), json!(["apple", "functional", "Zebra"]));
}

#[tokio::test]
async fn another_users_tags_are_not_returned_by_get_tags() {
    let server = TestServer::new();
    let admin = server.login_as_admin().await;
    let (anna, _) = server.create_active_user(&admin, "anna").await;
    post_project(&server, &admin, json!({ "name": "Mine", "tags": ["petg"] })).await;

    let hers = server
        .fetch("/api/projects/tags", Req::get().cookie(&anna))
        .await;
    assert_eq!(hers.json(), json!([]));
    let mine = server
        .fetch("/api/projects/tags", Req::get().cookie(&admin))
        .await;
    assert_eq!(mine.json(), json!(["petg"]));
}

#[tokio::test]
async fn rescan_adopts_folders_and_reports_what_it_did() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let folder = server.dir().join("admin").join("Gridfinity Bin");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("bin.stl"), "solid").unwrap();

    let reply = server
        .fetch("/api/projects/rescan", Req::post().cookie(&cookie))
        .await;
    assert_eq!(reply.status, 200);
    let result = reply.json();
    assert_eq!(result["adopted"], 1);
    assert_eq!(result["filesAdded"], 1);
    assert_eq!(result["previewsQueued"], 1);

    let list = server
        .fetch("/api/projects", Req::get().cookie(&cookie))
        .await
        .json();
    assert_eq!(list[0]["name"], "Gridfinity Bin");
    assert_eq!(
        list[0]["fileCounts"],
        json!({ "model": 1, "slicerProject": 0, "other": 0 })
    );
}

#[tokio::test]
async fn another_users_project_is_a_404_not_a_403() {
    let server = TestServer::new();
    let admin = server.login_as_admin().await;
    let (anna, _) = server.create_active_user(&admin, "anna").await;
    let mine = server.new_project(&admin, "Benchy").await;

    // Admins administer users; they never see other users' projects.
    let reply = server
        .fetch(
            &format!("/api/projects/{}", mine["id"].as_str().unwrap()),
            Req::get().cookie(&anna),
        )
        .await;
    assert_eq!(reply.status, 404);
    let list = server
        .fetch("/api/projects", Req::get().cookie(&anna))
        .await;
    assert_eq!(list.json(), json!([]));
}

#[tokio::test]
async fn a_project_body_that_fails_validation_is_a_400_with_issues() {
    let server = TestServer::new();
    let cookie = server.login_as_admin().await;
    let reply = server
        .fetch(
            "/api/projects",
            Req::post()
                .cookie(&cookie)
                .json(&json!({ "name": "x", "website": "not a url" })),
        )
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(
        reply.json()["error"]["details"]["issues"][0]["path"],
        json!(["website"])
    );
}
