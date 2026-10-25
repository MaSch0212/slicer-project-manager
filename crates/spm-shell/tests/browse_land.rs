//! Ported from `browse-land.test.ts`: a staged download becoming a file of a project, in both
//! library modes and through the library's own API, plus the page-to-project match (which the
//! Electron build did in the renderer, with no registry rows).

mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::dto::{BrowseDownloadState, FileKind};
use spm_core::validate::CreateProjectInput;
use spm_core::{AppError, AppErrorCode, create_project, get_project};
use spm_shell::browse::api::{LibrarySource, LocalApi};
use spm_shell::browse::downloads::{
    DOWNLOAD_RECORD_NAME, Decision, DownloadRequest, Downloads, DownloadsOptions,
};
use spm_shell::browse::land::{BrowseLanding, match_projects};
use spm_shell::browse::notices::BrowseNotices;
use spm_shell::browse::registry::SiteRegistry;
use spm_shell::library::default_make_router;
use spm_shell::remote::RemoteHost;
use spm_shell::slicers::remote_files::{ProxyRemote, RemoteLibrary};
use support::slicers::{Env, StubRemote, blocking};
use support::{Upstream, answer};

const ZIP: &[u8] = b"PK\x03\x04 the bytes of a zip, as far as the library can tell";

struct Rig {
    env: Env,
    staging: PathBuf,
    downloads: Arc<Downloads>,
}

fn rig() -> Rig {
    let env = Env::new();
    let staging = env.dir("model-downloads");
    let mut options = DownloadsOptions::new(
        staging.clone(),
        Arc::new(BrowseNotices::new(Arc::new(|_| {}))),
        Arc::new(SiteRegistry::standard()),
    );
    let next = Arc::new(AtomicUsize::new(0));
    options.mint_id = Arc::new(move || format!("dl-{}", next.fetch_add(1, Ordering::SeqCst) + 1));
    Rig {
        env,
        staging,
        downloads: Downloads::new(options),
    }
}

impl Rig {
    /// A watched, complete download (verifiable), with `bytes` in it.
    fn staged(&self, name: &str, bytes: &[u8]) -> String {
        let request = DownloadRequest {
            file_name: name.to_owned(),
            url: "blob:https://www.thingiverse.com/x".to_owned(),
            page_url: Some("https://www.thingiverse.com/thing:1".to_owned()),
            mime_type: String::new(),
            total_bytes: 0,
            had_user_gesture: true,
        };
        let Decision::Stage(path) = self.downloads.on_requested(&request) else {
            panic!("refused");
        };
        std::fs::write(&path, bytes).unwrap();
        self.downloads.on_finished(&request.url, Some(&path), true);
        path.parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    /// A directory a previous run left.
    fn orphan(&self, id: &str, record: Option<Value>, file: Option<(&str, &[u8])>) {
        let directory = self.staging.join(id);
        std::fs::create_dir_all(&directory).unwrap();
        if let Some(record) = record {
            std::fs::write(directory.join(DOWNLOAD_RECORD_NAME), record.to_string()).unwrap();
        }
        if let Some((name, bytes)) = file {
            std::fs::write(directory.join(name), bytes).unwrap();
        }
    }

    fn local_library(&self, handle: tokio::runtime::Handle) -> LibrarySource {
        let router = default_make_router()(&self.env.session());
        Arc::new(move || {
            Ok(Arc::new(LocalApi::new(router.clone(), handle.clone())) as Arc<dyn RemoteLibrary>)
        })
    }

    fn landing(&self, library: LibrarySource) -> Arc<BrowseLanding> {
        Arc::new(BrowseLanding::new(Arc::clone(&self.downloads), library))
    }

    fn project_files(&self, project_id: &str) -> Vec<(String, FileKind)> {
        get_project(self.env.lib(), &self.env.ctx, project_id)
            .unwrap()
            .files
            .into_iter()
            .map(|file| (file.name, file.kind))
            .collect()
    }
}

fn completed(total: u64) -> Value {
    json!({
        "fileName": "benchy.zip", "sourceUrl": "", "pageUrl": null, "siteId": null,
        "mimeType": "", "hadUserGesture": false, "startedAt": 1,
        "totalBytes": total, "receivedBytes": total, "state": "completed", "library": null,
    })
}

async fn land(
    landing: &Arc<BrowseLanding>,
    id: &str,
    project: &str,
    name: Option<&str>,
) -> Result<spm_core::dto::FileDto, AppError> {
    let landing = Arc::clone(landing);
    let (id, project, name) = (id.to_owned(), project.to_owned(), name.map(str::to_owned));
    blocking(move || landing.land(&id, &project, name.as_deref())).await
}

fn counting_library() -> (LibrarySource, Arc<StubRemote>) {
    let stub = StubRemote::new("https://stub.example");
    let handed = Arc::clone(&stub);
    (
        Arc::new(move || Ok(Arc::clone(&handed) as Arc<dyn RemoteLibrary>)),
        stub,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn land_refuses_all_five_unverifiable_records_without_reading_a_byte_and_lands_the_sixth() {
    let rig = rig();
    let (library, stub) = counting_library();
    let landing = rig.landing(library);
    rig.orphan("no-record", None, Some(("a.zip", b"12345")));
    rig.orphan("corrupt", None, Some(("a.zip", b"12345")));
    std::fs::write(rig.staging.join("corrupt").join(DOWNLOAD_RECORD_NAME), "{").unwrap();
    rig.orphan(
        "progressing",
        Some(json!({"state": "progressing", "fileName": "a.zip", "totalBytes": 5})),
        Some(("a.zip", b"12345")),
    );
    rig.orphan(
        "short",
        Some({
            let mut record = completed(100);
            record["fileName"] = json!("a.zip");
            record
        }),
        Some(("a.zip", b"12345")),
    );
    rig.orphan(
        "unknown-size",
        Some({
            let mut record = completed(0);
            record["fileName"] = json!("a.zip");
            record
        }),
        Some(("a.zip", b"12345")),
    );
    rig.orphan(
        "good",
        Some({
            let mut record = completed(5);
            record["fileName"] = json!("a.zip");
            record
        }),
        Some(("a.zip", b"12345")),
    );
    rig.downloads.sweep();
    for id in [
        "no-record",
        "corrupt",
        "progressing",
        "short",
        "unknown-size",
    ] {
        let error = land(&landing, id, "p-1", None).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::Conflict, "{id}");
        assert!(
            rig.staging.join(id).join("a.zip").is_file(),
            "{id} was kept"
        );
    }
    assert!(stub.posts().is_empty(), "nothing was uploaded");
    land(&landing, "good", "p-1", None).await.unwrap();
    assert_eq!(stub.posts().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_staged_file_edited_since_the_verdict_is_refused_and_nothing_reaches_the_upload() {
    let rig = rig();
    let (library, stub) = counting_library();
    let landing = rig.landing(library);
    let shrunk = rig.staged("shrunk.zip", b"12345");
    let grown = rig.staged("grown.zip", b"12345");
    let control = rig.staged("control.zip", b"12345");
    std::fs::write(rig.staging.join(&shrunk).join("shrunk.zip"), b"123").unwrap();
    std::fs::write(rig.staging.join(&grown).join("grown.zip"), b"1234567").unwrap();
    for id in [&shrunk, &grown] {
        assert_eq!(
            land(&landing, id, "p-1", None).await.unwrap_err().code,
            AppErrorCode::Conflict
        );
    }
    assert!(stub.posts().is_empty());
    land(&landing, &control, "p-1", None).await.unwrap();
    assert_eq!(stub.posts().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn land_answers_not_found_for_an_id_it_never_staged_and_joins_it_onto_nothing() {
    let rig = rig();
    let (library, stub) = counting_library();
    let landing = rig.landing(library);
    let good = rig.staged("good.zip", b"12345");
    let secret = rig.env.dir("elsewhere").join("secret.zip");
    std::fs::write(&secret, b"secret").unwrap();
    for id in [
        "no-such".to_owned(),
        "../elsewhere".to_owned(),
        secret.to_string_lossy().into_owned(),
        r"..\..\x".to_owned(),
    ] {
        assert_eq!(
            land(&landing, &id, "p-1", None).await.unwrap_err().code,
            AppErrorCode::NotFound,
            "{id}"
        );
    }
    assert!(stub.posts().is_empty());
    land(&landing, &good, "p-1", None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_staged_file_lands_as_a_new_file_byte_identical_and_the_staging_directory_goes() {
    let rig = rig();
    let landing = rig.landing(rig.local_library(tokio::runtime::Handle::current()));
    let project = rig.env.project("Landing");
    let id = rig.staged("benchy.zip", ZIP);
    let file = land(&landing, &id, &project, None).await.unwrap();
    assert_eq!(file.name, "benchy.zip");
    assert_eq!(file.kind, FileKind::Other);
    assert_eq!(file.size_bytes, i64::try_from(ZIP.len()).unwrap());
    assert_eq!(
        rig.project_files(&project),
        [("benchy.zip".to_owned(), FileKind::Other)]
    );
    let resolved = spm_core::resolve_file_path(rig.env.lib(), &rig.env.ctx, &file.id).unwrap();
    assert_eq!(std::fs::read(resolved.abs_path).unwrap(), ZIP);
    assert!(
        !rig.staging.join(&id).exists(),
        "removed once the upload returned"
    );
    assert!(rig.downloads.find(&id).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_clash_is_reported_and_leaves_the_staging_directory_and_the_project_alone() {
    let rig = rig();
    let landing = rig.landing(rig.local_library(tokio::runtime::Handle::current()));
    let project = rig.env.project("Clash");
    let first = rig.staged("benchy.zip", ZIP);
    land(&landing, &first, &project, None).await.unwrap();
    let second = rig.staged("benchy.zip", b"PK another one");
    let error = land(&landing, &second, &project, None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert_eq!(
        rig.project_files(&project).len(),
        1,
        "no auto-suffixed twin"
    );
    assert!(rig.staging.join(&second).join("benchy.zip").is_file());
    // The user renames; nothing is renamed for them.
    land(&landing, &second, &project, Some("benchy-2.zip"))
        .await
        .unwrap();
    assert_eq!(rig.project_files(&project).len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_name_is_the_records_unless_the_caller_gives_one_and_is_a_file_name_either_way() {
    let rig = rig();
    let landing = rig.landing(rig.local_library(tokio::runtime::Handle::current()));
    let project = rig.env.project("Names");
    let id = rig.staged("benchy.zip", ZIP);
    for bad in ["../evil.zip", "a/b.zip", "CON", ".hidden", "", "what?.zip"] {
        let error = land(&landing, &id, &project, Some(bad)).await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::Validation, "{bad:?}");
    }
    assert!(rig.project_files(&project).is_empty());
    let file = land(&landing, &id, &project, Some("renamed.zip"))
        .await
        .unwrap();
    assert_eq!(file.name, "renamed.zip");
    let other = rig.staged("kept-name.zip", ZIP);
    assert_eq!(
        land(&landing, &other, &project, None).await.unwrap().name,
        "kept-name.zip"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_staged_file_that_has_gone_since_the_verdict_is_a_not_found_not_a_shorter_upload() {
    let rig = rig();
    let landing = rig.landing(rig.local_library(tokio::runtime::Handle::current()));
    let project = rig.env.project("Gone");
    let id = rig.staged("benchy.zip", ZIP);
    std::fs::remove_file(rig.staging.join(&id).join("benchy.zip")).unwrap();
    assert_eq!(
        land(&landing, &id, &project, None).await.unwrap_err().code,
        AppErrorCode::NotFound
    );
    assert!(rig.project_files(&project).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_no_library_open_landing_refuses_rather_than_dereferencing_nothing() {
    let rig = rig();
    let landing = rig.landing(Arc::new(|| {
        Err(AppError::conflict("no library folder is open"))
    }));
    let id = rig.staged("benchy.zip", ZIP);
    let error = land(&landing, &id, "p-1", None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("library folder"));
    assert!(rig.staging.join(&id).join("benchy.zip").is_file());
}

fn remote_library(upstream: &Upstream) -> LibrarySource {
    let host = Arc::new(RemoteHost::new(&upstream.origin));
    let handle = tokio::runtime::Handle::current();
    Arc::new(move || {
        Ok(Arc::new(ProxyRemote::new(Arc::clone(&host), handle.clone())) as Arc<dyn RemoteLibrary>)
    })
}

fn file_json(name: &str) -> Value {
    json!({
        "id": "f-new", "name": name, "kind": "other", "sizeBytes": 1,
        "previewState": "unsupported", "rawUrl": "/api/files/f-new/raw",
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_landing_posts_to_the_project_with_the_real_size_and_the_encoded_name_then_removes_staging()
 {
    let rig = rig();
    let upstream = Upstream::start(|_| {
        answer(
            200,
            &[("content-type", "application/json")],
            file_json("Modell – Größe.zip").to_string(),
        )
    })
    .await;
    let landing = rig.landing(remote_library(&upstream));
    let id = rig.staged("Modell – Größe.zip", ZIP);
    let file = land(&landing, &id, "p-1", None).await.unwrap();
    assert_eq!(file.id, "f-new");
    let seen = upstream.last();
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.target, "/api/projects/p-1/files");
    assert_eq!(
        seen.header("content-length").unwrap(),
        ZIP.len().to_string()
    );
    let name = seen.header("x-spm-file-name").unwrap();
    assert_eq!(name, "Modell%20%E2%80%93%20Gr%C3%B6%C3%9Fe.zip");
    assert!(
        seen.header("content-type")
            .unwrap()
            .starts_with("application/")
    );
    assert!(!rig.staging.join(&id).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_landing_keeps_the_staging_directory_when_the_server_refuses() {
    let rig = rig();
    let upstream = Upstream::start(|_| {
        answer(
            413,
            &[("content-type", "application/json")],
            json!({"error": {"code": "QuotaExceeded", "message": "That would take the library over its quota.",
                "details": {"usageBytes": 9, "quotaBytes": 10}}})
            .to_string(),
        )
    })
    .await;
    let landing = rig.landing(remote_library(&upstream));
    let id = rig.staged("benchy.zip", ZIP);
    let error = land(&landing, &id, "p-1", None).await.unwrap_err();
    assert_eq!(error.code, AppErrorCode::QuotaExceeded);
    assert!(error.message.contains("quota"));
    assert!(rig.staging.join(&id).join("benchy.zip").is_file());
    assert!(rig.downloads.find(&id).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bytes_on_the_wire_are_the_staged_bytes_read_off_the_request_the_proxy_sent() {
    let rig = rig();
    let upstream = Upstream::start(|_| {
        answer(
            200,
            &[("content-type", "application/json")],
            file_json("big.zip").to_string(),
        )
    })
    .await;
    let landing = rig.landing(remote_library(&upstream));
    let bytes: Vec<u8> = (0..300_000u32).map(|n| (n % 251) as u8).collect();
    let id = rig.staged("big.zip", &bytes);
    land(&landing, &id, "p-1", None).await.unwrap();
    let seen = upstream.last();
    assert!(seen.complete);
    assert_eq!(seen.body, bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_reports_whether_a_record_was_read_which_is_what_names_the_refusal() {
    let rig = rig();
    rig.orphan(
        "fine",
        Some({
            let mut record = completed(5);
            record["fileName"] = json!("a.zip");
            record
        }),
        Some(("a.zip", b"12345")),
    );
    rig.orphan("missing", None, Some(("a.zip", b"12345")));
    rig.orphan("garbled", None, Some(("a.zip", b"12345")));
    std::fs::write(
        rig.staging.join("garbled").join(DOWNLOAD_RECORD_NAME),
        "nope",
    )
    .unwrap();
    rig.downloads.sweep();
    assert!(rig.downloads.find("fine").unwrap().has_record);
    for id in ["missing", "garbled"] {
        let found = rig.downloads.find(id).unwrap();
        assert!(!found.has_record);
        assert_eq!(found.record.state, BrowseDownloadState::Interrupted);
    }
    let (library, _) = counting_library();
    let landing = rig.landing(library);
    let error = land(&landing, "missing", "p-1", None).await.unwrap_err();
    assert!(error.message.contains("no record"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_local_landing_answers_a_decorated_file_with_the_api_url_the_page_uses() {
    let rig = rig();
    let landing = rig.landing(rig.local_library(tokio::runtime::Handle::current()));
    let project = rig.env.project("Decorated");
    let id = rig.staged("benchy.zip", ZIP);
    let file = land(&landing, &id, &project, None).await.unwrap();
    assert_eq!(file.raw_url, format!("/api/files/{}/raw", file.id));
}

// ---- matching a page to projects ---------------------------------------------------------------

fn website_project(rig: &Rig, name: &str, website: Option<&str>) -> String {
    create_project(
        rig.env.lib(),
        &rig.env.ctx,
        CreateProjectInput {
            name: name.to_owned(),
            website: website.map(str::to_owned),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

async fn matches(rig: &Rig, url: Option<&str>) -> spm_core::dto::BrowseMatchDto {
    let library = rig.local_library(tokio::runtime::Handle::current());
    let registry = SiteRegistry::standard();
    let url = url.map(str::to_owned);
    blocking(move || match_projects(&registry, &library, url.as_deref()).unwrap()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_matches_the_project_whose_website_has_its_key_across_locale_and_sub_paths() {
    let rig = rig();
    let thing = website_project(
        &rig,
        "Thing",
        Some("https://www.thingiverse.com/thing:7401409"),
    );
    let maker = website_project(
        &rig,
        "Maker",
        Some("https://makerworld.com/en/models/2093108-dji-neo-2-the-box"),
    );
    website_project(&rig, "Other", Some("https://www.thingiverse.com/thing:1"));
    website_project(&rig, "No website", None);
    let answer = matches(
        &rig,
        Some("https://www.thingiverse.com/thing:7401409/files?x=1#y"),
    )
    .await;
    assert_eq!(answer.key.as_deref(), Some("thingiverse:7401409"));
    assert_eq!(
        answer
            .projects
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        [thing.as_str()]
    );
    // The registry rows are Rust's now, so MakerWorld's locale segment is spanned (the renderer's
    // match could not do this).
    let answer = matches(&rig, Some("https://makerworld.com/de/models/2093108")).await;
    assert_eq!(
        answer
            .projects
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        [maker.as_str()]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_matching_is_an_honest_empty_answer_and_not_an_error() {
    let rig = rig();
    website_project(
        &rig,
        "Elsewhere",
        Some("https://www.thingiverse.com/thing:1"),
    );
    let answer = matches(&rig, Some("https://www.thingiverse.com/thing:2")).await;
    assert_eq!(answer.key.as_deref(), Some("thingiverse:2"));
    assert!(answer.projects.is_empty());
    assert_eq!(
        answer.url.as_deref(),
        Some("https://www.thingiverse.com/thing:2")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_popup_download_with_no_page_and_a_non_http_page_are_not_keyed_at_all() {
    let rig = rig();
    website_project(&rig, "Any", Some("https://www.thingiverse.com/thing:1"));
    for url in [
        None,
        Some("data:text/html,x"),
        Some("blob:https://x/1"),
        Some(""),
        Some("javascript:alert(1)"),
    ] {
        let answer = matches(&rig, url).await;
        assert_eq!(answer.key, None, "{url:?}");
        assert_eq!(answer.url, None);
        assert!(answer.projects.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_projects_sharing_a_key_are_all_offered_ordered_by_name_and_archived_ones_count() {
    let rig = rig();
    let site = "https://www.thingiverse.com/thing:5";
    let zed = website_project(&rig, "zed", Some(site));
    let alpha = website_project(&rig, "Alpha", Some("https://thingiverse.com/thing:5/files"));
    let archived = website_project(&rig, "Middle (archived)", Some(site));
    spm_core::update_project(
        rig.env.lib(),
        &rig.env.ctx,
        &archived,
        spm_core::validate::ProjectPatch {
            is_archived: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let answer = matches(&rig, Some(site)).await;
    let ids: Vec<&str> = answer.projects.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, [alpha.as_str(), archived.as_str(), zed.as_str()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_whose_website_is_not_a_web_page_is_never_a_match() {
    let rig = rig();
    website_project(&rig, "Scripted", Some("javascript:alert(1)"));
    let answer = matches(&rig, Some("https://example.com/a")).await;
    assert!(answer.projects.is_empty());
    let _ = Mutex::new(());
}
