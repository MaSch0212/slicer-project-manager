//! Ported from `browse-downloads.test.ts`: the staging directory, its record, the three caps and
//! the sweep that refuses what it cannot vouch for.
//!
//! The Electron suite drove a fake `DownloadItem` through `will-download`/`updated`/`done`; the
//! Tauri events are `Requested { url, destination }` and `Finished { path, success }`, so the rig
//! drives [`Downloads::on_requested`] and [`Downloads::on_finished`] and writes the bytes itself,
//! the way the browser does. Cases that only existed because of a `DownloadItem` method with no
//! WebView2 counterpart are named in the comments at the end.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::AppErrorCode;
use spm_core::dto::{BrowseDownloadState, BrowseNoticeDto, BrowseNoticeKind};
use spm_shell::browse::downloads::{
    DOWNLOAD_RECORD_NAME, Decision, DownloadRequest, Downloads, DownloadsOptions,
    FALLBACK_DOWNLOAD_NAME, Limits, MAX_RECORDED_TEXT, staged_file_name,
};
use spm_shell::browse::notices::BrowseNotices;
use spm_shell::browse::registry::SiteRegistry;
use spm_shell::json_store::{FsIo, JsonStoreIo};

/// Counts the record writes (one rename each) and can refuse to write.
#[derive(Default)]
struct CountingIo {
    inner: FsIo,
    renames: AtomicUsize,
    fail_open: AtomicBool,
}

impl JsonStoreIo for CountingIo {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        if self.fail_open.load(Ordering::SeqCst) {
            // A directory is made by the write that is about to fail; this is what a read-only
            // staging area looks like.
            return Err(io::Error::other("the staging area is read-only"));
        }
        self.inner.create_dir_all(dir)
    }

    fn open(&self, path: &Path) -> io::Result<u64> {
        self.inner.open(path)
    }

    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()> {
        self.inner.write(handle, data)
    }

    fn fsync(&self, handle: u64) -> io::Result<()> {
        self.inner.fsync(handle)
    }

    fn close(&self, handle: u64) -> io::Result<()> {
        self.inner.close(handle)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.renames.fetch_add(1, Ordering::SeqCst);
        self.inner.rename(from, to)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        self.inner.remove(path)
    }
}

struct Rig {
    _root: tempfile::TempDir,
    staging: PathBuf,
    downloads: Arc<Downloads>,
    notices: Arc<BrowseNotices>,
    raised: Arc<Mutex<Vec<BrowseNoticeDto>>>,
    io: Arc<CountingIo>,
    attached: Arc<AtomicBool>,
    library: Arc<Mutex<Option<String>>>,
}

fn rig_with(limits: Limits) -> Rig {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("model-downloads");
    rig_in(root, staging, limits)
}

fn rig_in(root: tempfile::TempDir, staging: PathBuf, limits: Limits) -> Rig {
    let raised = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&raised);
    let notices = Arc::new(
        BrowseNotices::new(Arc::new(move |notice| {
            sink.lock().unwrap().push(notice.clone())
        }))
        .with_ids({
            let next = Arc::new(AtomicUsize::new(0));
            Arc::new(move || format!("notice-{}", next.fetch_add(1, Ordering::SeqCst) + 1))
        }),
    );
    let io = Arc::new(CountingIo::default());
    let attached = Arc::new(AtomicBool::new(false));
    let library = Arc::new(Mutex::new(Some("local:C:\\Library".to_owned())));
    let mut options = DownloadsOptions::new(
        staging.clone(),
        Arc::clone(&notices),
        Arc::new(SiteRegistry::standard()),
    );
    options.limits = limits;
    options.io = io.clone();
    options.now = Arc::new(|| 1_700_000_000_000);
    options.mint_id = {
        let next = Arc::new(AtomicUsize::new(0));
        Arc::new(move || format!("dl-{}", next.fetch_add(1, Ordering::SeqCst) + 1))
    };
    let flag = Arc::clone(&attached);
    options.is_view_attached = Arc::new(move || flag.load(Ordering::SeqCst));
    let key = Arc::clone(&library);
    options.library_key = Arc::new(move || key.lock().unwrap().clone());
    Rig {
        _root: root,
        staging,
        downloads: Downloads::new(options),
        notices,
        raised,
        io,
        attached,
        library,
    }
}

fn rig() -> Rig {
    rig_with(Limits::default())
}

fn request(name: &str) -> DownloadRequest {
    DownloadRequest {
        file_name: name.to_owned(),
        url: "blob:https://www.thingiverse.com/ae5e".to_owned(),
        page_url: Some("https://www.thingiverse.com/thing:7401409/files".to_owned()),
        mime_type: "application/zip".to_owned(),
        total_bytes: 0,
        had_user_gesture: true,
    }
}

impl Rig {
    /// Requests a download and, as the browser does, writes `bytes` to the destination it was
    /// given. Returns the id and the path.
    fn start(&self, request: &DownloadRequest) -> (String, PathBuf) {
        let Decision::Stage(path) = self.downloads.on_requested(request) else {
            panic!(
                "the download was refused: {:?}",
                self.raised.lock().unwrap()
            );
        };
        let id = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (id, path)
    }

    fn finish(&self, request: &DownloadRequest, path: &Path, bytes: &[u8], success: bool) {
        std::fs::write(path, bytes).unwrap();
        self.downloads
            .on_finished(&request.url, Some(path), success);
    }

    /// A complete download, watched to the end.
    fn complete(&self, name: &str, bytes: &[u8]) -> String {
        let request = request(name);
        let (id, path) = self.start(&request);
        self.finish(&request, &path, bytes, true);
        id
    }

    fn record(&self, id: &str) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(self.staging.join(id).join(DOWNLOAD_RECORD_NAME)).unwrap(),
        )
        .unwrap()
    }

    fn notice_count(&self) -> usize {
        self.raised.lock().unwrap().len()
    }

    fn last_notice(&self) -> BrowseNoticeDto {
        self.raised.lock().unwrap().last().cloned().unwrap()
    }

    /// "The next launch": a fresh `Downloads` over the same directory, swept.
    fn relaunch(&self) -> Arc<Downloads> {
        let mut options = DownloadsOptions::new(
            self.staging.clone(),
            Arc::clone(&self.notices),
            Arc::new(SiteRegistry::standard()),
        );
        options.io = self.io.clone();
        let next = Downloads::new(options);
        next.sweep();
        next
    }
}

/// A directory the way a previous run left it.
fn orphan(rig: &Rig, id: &str, record: Option<Value>, file: Option<(&str, &[u8])>) {
    let directory = rig.staging.join(id);
    std::fs::create_dir_all(&directory).unwrap();
    if let Some(record) = record {
        std::fs::write(directory.join(DOWNLOAD_RECORD_NAME), record.to_string()).unwrap();
    }
    if let Some((name, bytes)) = file {
        std::fs::write(directory.join(name), bytes).unwrap();
    }
}

fn record_json(state: &str, total: u64, extra: Value) -> Value {
    let mut record = json!({
        "downloadId": "ignored",
        "startedAt": 1,
        "fileName": "benchy.zip",
        "sourceUrl": "blob:https://www.thingiverse.com/x",
        "pageUrl": "https://www.thingiverse.com/thing:1",
        "siteId": "thingiverse",
        "mimeType": "application/zip",
        "hadUserGesture": true,
        "totalBytes": total,
        "state": state,
        "receivedBytes": total,
        "library": null,
    });
    record
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().cloned().unwrap_or_default());
    record
}

// ---- the sweep ---------------------------------------------------------------------------------

#[test]
fn a_staged_directory_with_bytes_and_no_record_cannot_be_vouched_for() {
    let rig = rig();
    orphan(&rig, "a", None, Some(("benchy.zip", b"12345")));
    rig.downloads.sweep();
    let listed = rig.downloads.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].file_name, "benchy.zip");
    assert!(listed[0].is_orphan && !listed[0].is_verifiable);
    assert_eq!(listed[0].state, BrowseDownloadState::Interrupted);
    assert!(!rig.downloads.find("a").unwrap().has_record);
}

#[test]
fn a_leftover_record_temp_file_is_not_the_download_the_user_is_shown() {
    let rig = rig();
    orphan(&rig, "a", None, Some(("benchy.zip", b"12345")));
    std::fs::write(
        rig.staging.join("a").join("download.json.4242.tmp"),
        vec![0u8; 999],
    )
    .unwrap();
    rig.downloads.sweep();
    let listed = rig.downloads.list();
    assert_eq!(listed[0].file_name, "benchy.zip");
    assert_eq!(listed[0].received_bytes, 5);
}

#[test]
fn an_unparseable_record_cannot_be_vouched_for() {
    let rig = rig();
    orphan(&rig, "a", None, Some(("benchy.zip", b"12345")));
    std::fs::write(
        rig.staging.join("a").join(DOWNLOAD_RECORD_NAME),
        "{ not json",
    )
    .unwrap();
    rig.downloads.sweep();
    assert!(!rig.downloads.list()[0].is_verifiable);
}

#[test]
fn a_record_that_never_reached_a_terminal_state_cannot_be_vouched_for() {
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("progressing", 5, json!({}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    let listed = rig.downloads.list();
    assert!(!listed[0].is_verifiable);
    assert_eq!(listed[0].state, BrowseDownloadState::Progressing);
}

#[test]
fn a_record_still_saying_progressing_is_refused_even_when_its_bytes_add_up() {
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("progressing", 5, json!({"receivedBytes": 5}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    assert!(!rig.downloads.find("a").unwrap().is_verifiable);
}

#[test]
fn a_completed_record_whose_bytes_are_short_cannot_be_vouched_for() {
    let rig = rig();
    // The truncation case: the browser writes straight to the final path, so a file cut short is
    // indistinguishable from a complete one by its name.
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 100, json!({}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    assert!(!rig.downloads.find("a").unwrap().is_verifiable);
}

#[test]
fn a_completed_record_with_total_bytes_zero_cannot_be_vouched_for_because_an_unknown_is_not_a_pass()
{
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 0, json!({"receivedBytes": 5}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    assert!(!rig.downloads.find("a").unwrap().is_verifiable);
}

#[test]
fn a_completed_record_whose_bytes_agree_is_an_ordinary_staged_download_from_a_previous_run() {
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 5, json!({}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    let listed = rig.downloads.list();
    assert!(listed[0].is_verifiable && listed[0].is_orphan);
    assert_eq!(listed[0].site_id.as_deref(), Some("thingiverse"));
    assert_eq!(
        listed[0].page_url.as_deref(),
        Some("https://www.thingiverse.com/thing:1")
    );
    assert_eq!(listed[0].source_url, "blob:https://www.thingiverse.com/x");
    assert_eq!(
        listed[0].download_id, "a",
        "the id is the directory's, not the record's claim"
    );
}

#[test]
fn the_sweep_surfaces_and_never_deletes() {
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 5, json!({}))),
        Some(("benchy.zip", b"12345")),
    );
    orphan(&rig, "b", None, Some(("half.zip", b"1")));
    rig.downloads.sweep();
    assert_eq!(rig.downloads.list().len(), 2);
    assert!(rig.staging.join("a").join("benchy.zip").is_file());
    assert!(rig.staging.join("b").join("half.zip").is_file());
}

#[test]
fn a_staging_directory_that_is_not_there_yet_is_a_first_run_not_a_failure() {
    let rig = rig();
    assert!(!rig.staging.exists());
    rig.downloads.sweep();
    assert!(rig.downloads.list().is_empty());
}

// ---- discard -----------------------------------------------------------------------------------

#[test]
fn discard_is_the_only_thing_that_removes_a_staged_directory() {
    let rig = rig();
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 5, json!({}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    rig.downloads.discard("a").unwrap();
    assert!(!rig.staging.join("a").exists());
    assert!(rig.downloads.list().is_empty());
}

#[test]
fn an_unverifiable_download_can_still_be_discarded_because_that_is_the_way_out() {
    let rig = rig();
    orphan(&rig, "a", None, Some(("half.zip", b"1")));
    orphan(
        &rig,
        "b",
        Some(record_json("progressing", 99, json!({}))),
        Some(("x.zip", b"1")),
    );
    rig.downloads.sweep();
    // An orphan whose record still says `progressing` is what a kill leaves: not running.
    rig.downloads.discard("a").unwrap();
    rig.downloads.discard("b").unwrap();
    assert!(rig.downloads.list().is_empty());
}

#[test]
fn discard_refuses_an_id_it_did_not_enumerate() {
    let rig = rig();
    let outside = rig._root.path().join("precious");
    std::fs::create_dir_all(&outside).unwrap();
    for id in ["..", "../precious", "a/b", r"..\precious", "no-such-id", ""] {
        let error = rig.downloads.discard(id).unwrap_err();
        assert_eq!(error.code, AppErrorCode::NotFound, "{id}");
    }
    assert!(outside.is_dir());
}

#[test]
fn discard_refuses_a_download_this_process_is_still_writing() {
    let rig = rig();
    let request = request("benchy.zip");
    let (id, path) = rig.start(&request);
    assert_eq!(
        rig.downloads.discard(&id).unwrap_err().code,
        AppErrorCode::Conflict
    );
    rig.finish(&request, &path, b"12345", true);
    rig.downloads.discard(&id).unwrap();
}

// ---- staging (the Requested arm) ---------------------------------------------------------------

#[test]
fn the_record_is_on_disk_saying_progressing_before_the_destination_is_handed_back() {
    let rig = rig();
    let mut asked = request("benchy.zip");
    asked.total_bytes = 21_060_699;
    let (id, _) = rig.start(&asked);
    let record = rig.record(&id);
    assert_eq!(record["state"], "progressing");
    assert_eq!(record["totalBytes"], 21_060_699);
}

#[test]
fn the_staged_path_is_staging_id_file_name_and_that_is_the_handover() {
    let rig = rig();
    let (id, path) = rig.start(&request("benchy.zip"));
    assert_eq!(path, rig.staging.join(&id).join("benchy.zip"));
    assert!(rig.staging.join(&id).join(DOWNLOAD_RECORD_NAME).is_file());
}

#[test]
fn the_record_carries_every_field_has_no_version_key_and_names_the_library() {
    let rig = rig();
    let (id, _) = rig.start(&request("benchy.zip"));
    let record = rig.record(&id);
    let keys: Vec<&str> = record
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut keys = keys;
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "downloadId",
            "fileName",
            "hadUserGesture",
            "library",
            "mimeType",
            "pageUrl",
            "receivedBytes",
            "siteId",
            "sourceUrl",
            "startedAt",
            "state",
            "totalBytes"
        ]
    );
    assert_eq!(record["library"], "local:C:\\Library");
    assert_eq!(record["startedAt"], 1_700_000_000_000_i64);
    assert_eq!(record["hadUserGesture"], true);
}

#[test]
fn page_url_is_the_view_url_and_not_the_download_url_when_the_two_differ() {
    let rig = rig();
    let (id, _) = rig.start(&request("benchy.zip"));
    let record = rig.record(&id);
    assert_eq!(
        record["pageUrl"],
        "https://www.thingiverse.com/thing:7401409/files"
    );
    assert_eq!(record["siteId"], "thingiverse");
    assert_eq!(record["sourceUrl"], "blob:https://www.thingiverse.com/ae5e");
}

#[test]
fn the_strings_a_stranger_chose_are_bounded_on_the_way_onto_the_record() {
    let rig = rig();
    let long = "x".repeat(MAX_RECORDED_TEXT * 2);
    let mut asked = request("benchy.zip");
    asked.url = format!("https://e.com/{long}");
    asked.page_url = Some(format!("https://e.com/{long}"));
    asked.mime_type = long.clone();
    let (id, _) = rig.start(&asked);
    let record = rig.record(&id);
    for key in ["sourceUrl", "pageUrl", "mimeType"] {
        assert_eq!(
            record[key].as_str().unwrap().chars().count(),
            MAX_RECORDED_TEXT,
            "{key}"
        );
    }
    let listed = &rig.downloads.list()[0];
    assert_eq!(listed.source_url.chars().count(), MAX_RECORDED_TEXT);
    assert_eq!(listed.mime_type.chars().count(), MAX_RECORDED_TEXT);
}

#[test]
fn a_record_read_back_from_disk_is_bounded_too_because_the_data_directory_is_editable() {
    let rig = rig();
    let long = "y".repeat(MAX_RECORDED_TEXT * 3);
    orphan(
        &rig,
        "a",
        Some(record_json(
            "completed",
            5,
            json!({"sourceUrl": long, "pageUrl": long, "mimeType": long}),
        )),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    let listed = &rig.downloads.list()[0];
    assert_eq!(listed.source_url.chars().count(), MAX_RECORDED_TEXT);
    assert_eq!(
        listed.page_url.as_ref().unwrap().chars().count(),
        MAX_RECORDED_TEXT
    );
    assert_eq!(listed.mime_type.chars().count(), MAX_RECORDED_TEXT);
    assert!(listed.is_verifiable);
}

#[test]
fn a_site_id_read_back_from_disk_is_bounded_like_every_other_stranger_string() {
    let rig = rig();
    let long = "z".repeat(MAX_RECORDED_TEXT * 3);
    orphan(
        &rig,
        "a",
        Some(record_json("completed", 5, json!({"siteId": long}))),
        Some(("benchy.zip", b"12345")),
    );
    rig.downloads.sweep();
    let listed = &rig.downloads.list()[0];
    assert_eq!(
        listed.site_id.as_ref().unwrap().chars().count(),
        MAX_RECORDED_TEXT
    );
    assert!(listed.is_verifiable);
}

#[test]
fn a_webview_that_has_not_committed_a_document_is_no_page_at_all() {
    let rig = rig();
    let mut asked = request("benchy.zip");
    asked.page_url = Some(String::new());
    let (id, _) = rig.start(&asked);
    let record = rig.record(&id);
    assert!(record["pageUrl"].is_null() && record["siteId"].is_null());
    let mut none = request("two.zip");
    none.page_url = None;
    let (id, _) = rig.start(&none);
    assert!(rig.record(&id)["pageUrl"].is_null());
}

#[test]
fn had_user_gesture_is_recorded_and_never_acted_on() {
    let rig = rig();
    let mut asked = request("benchy.zip");
    asked.had_user_gesture = false;
    let (id, _) = rig.start(&asked);
    assert_eq!(rig.record(&id)["hadUserGesture"], false);
    assert_eq!(rig.notice_count(), 0);
}

#[test]
fn the_file_name_is_the_browsers_sanitised_through_the_rules_files_upload_applies() {
    assert_eq!(staged_file_name("benchy.zip"), "benchy.zip");
    assert_eq!(staged_file_name("my model (v2).stl"), "my model (v2).stl");
    for hostile in [
        "../../evil.exe",
        r"..\..\evil.exe",
        "a/b.zip",
        "CON",
        "nul.txt",
        ".hidden",
        "",
        &"a".repeat(300),
        "download.json",
        "Download.JSON",
        "what?.zip",
    ] {
        assert_eq!(
            staged_file_name(hostile),
            FALLBACK_DOWNLOAD_NAME,
            "{hostile}"
        );
    }
}

#[test]
fn a_hostile_file_name_never_reaches_the_staged_path() {
    let rig = rig();
    let (id, path) = rig.start(&request("../../evil.exe"));
    assert_eq!(path, rig.staging.join(&id).join(FALLBACK_DOWNLOAD_NAME));
    assert_eq!(rig.record(&id)["fileName"], FALLBACK_DOWNLOAD_NAME);
    assert!(path.starts_with(&rig.staging));
}

#[test]
fn library_is_the_remote_origin_in_remote_mode_and_none_with_nothing_open() {
    let rig = rig();
    *rig.library.lock().unwrap() = Some("remote:https://print.example.com".to_owned());
    let (id, _) = rig.start(&request("benchy.zip"));
    assert_eq!(
        rig.record(&id)["library"],
        "remote:https://print.example.com"
    );
    *rig.library.lock().unwrap() = None;
    let (id, _) = rig.start(&request("two.zip"));
    assert!(rig.record(&id)["library"].is_null());
}

// ---- finishing ---------------------------------------------------------------------------------

#[test]
fn done_rewrites_the_record_exactly_once_and_a_progress_tick_writes_nothing() {
    let rig = rig();
    let asked = request("benchy.zip");
    let (id, path) = rig.start(&asked);
    assert_eq!(rig.io.renames.load(Ordering::SeqCst), 1);
    rig.downloads.on_progress(&id, 2);
    rig.downloads.on_progress(&id, 4);
    assert_eq!(
        rig.io.renames.load(Ordering::SeqCst),
        1,
        "a tick is not an fsync"
    );
    rig.finish(&asked, &path, b"12345", true);
    assert_eq!(rig.io.renames.load(Ordering::SeqCst), 2);
    let record = rig.record(&id);
    assert_eq!(record["state"], "completed");
    assert_eq!(record["receivedBytes"], 5);
}

#[test]
fn a_download_this_process_watched_to_completion_is_landable_even_with_no_content_length() {
    let rig = rig();
    let id = rig.complete("benchy.zip", b"12345");
    let staged = rig.downloads.find(&id).unwrap();
    assert!(staged.is_verifiable && !staged.is_orphan);
    assert_eq!(staged.bytes_on_disk, 5);
    // WebView2 never says how long a download is; the record carries the size it ended with, so
    // the *next* launch can check the bytes too.
    assert_eq!(rig.record(&id)["totalBytes"], 5);
    let next = rig.relaunch();
    let listed = next.list();
    assert!(listed[0].is_orphan && listed[0].is_verifiable);
}

#[test]
fn a_file_cut_short_after_it_completed_is_unverifiable_at_the_next_launch() {
    let rig = rig();
    let id = rig.complete("benchy.zip", b"1234567890");
    std::fs::write(rig.staging.join(&id).join("benchy.zip"), b"123").unwrap();
    assert!(!rig.relaunch().list()[0].is_verifiable);
}

#[test]
fn with_no_content_length_a_watched_download_whose_bytes_are_not_there_is_still_refused() {
    let rig = rig();
    let missing = request("gone.zip");
    let (id, path) = rig.start(&missing);
    rig.downloads.on_finished(&missing.url, Some(&path), true);
    assert!(
        !rig.downloads.find(&id).unwrap().is_verifiable,
        "no bytes at all"
    );
    let empty = request("empty.zip");
    let (id, path) = rig.start(&empty);
    rig.finish(&empty, &path, b"", true);
    assert!(
        !rig.downloads.find(&id).unwrap().is_verifiable,
        "zero bytes"
    );
}

#[test]
fn a_download_that_ends_anywhere_but_completed_is_not_landable() {
    let rig = rig();
    let asked = request("benchy.zip");
    let (id, path) = rig.start(&asked);
    rig.finish(&asked, &path, b"123", false);
    let staged = rig.downloads.find(&id).unwrap();
    assert!(!staged.is_verifiable);
    assert_eq!(staged.record.state, BrowseDownloadState::Interrupted);
    assert_eq!(rig.record(&id)["state"], "interrupted");
}

#[test]
fn a_finish_is_matched_by_path_and_failing_that_by_a_url_only_one_download_has() {
    let rig = rig();
    let mut first = request("a.zip");
    first.url = "https://files.example.com/a.zip".to_owned();
    let mut second = request("b.zip");
    second.url = "https://files.example.com/b.zip".to_owned();
    let (a, a_path) = rig.start(&first);
    let (b, b_path) = rig.start(&second);
    std::fs::write(&a_path, b"A").unwrap();
    std::fs::write(&b_path, b"BB").unwrap();
    // A spelling of the path the browser might use: other case, other slashes.
    let spelled = PathBuf::from(b_path.to_string_lossy().replace('\\', "/").to_uppercase());
    rig.downloads.on_finished(&second.url, Some(&spelled), true);
    assert_eq!(
        rig.downloads.find(&b).unwrap().record.state,
        BrowseDownloadState::Completed
    );
    assert_eq!(
        rig.downloads.find(&a).unwrap().record.state,
        BrowseDownloadState::Progressing
    );
    // No path: the URL names the one download that is still running for it.
    rig.downloads.on_finished(&first.url, None, true);
    assert_eq!(
        rig.downloads.find(&a).unwrap().record.state,
        BrowseDownloadState::Completed
    );
    // A finish nobody asked for, and one repeated, change nothing.
    rig.downloads
        .on_finished("https://nowhere.example/", None, true);
    rig.downloads.on_finished(&first.url, None, false);
    assert_eq!(
        rig.downloads.find(&a).unwrap().record.state,
        BrowseDownloadState::Completed
    );
}

#[test]
fn a_completed_download_that_arrives_while_no_view_is_attached_raises_one_notice() {
    let rig = rig();
    rig.attached.store(false, Ordering::SeqCst);
    rig.complete("benchy.zip", b"12345");
    assert_eq!(rig.notice_count(), 1);
    let notice = rig.last_notice();
    assert_eq!(notice.kind, BrowseNoticeKind::Completed);
    assert_eq!(notice.file_name, "benchy.zip");
}

#[test]
fn a_completed_download_with_the_view_still_on_screen_interrupts_nobody() {
    let rig = rig();
    rig.attached.store(true, Ordering::SeqCst);
    rig.complete("benchy.zip", b"12345");
    assert_eq!(rig.notice_count(), 0);
}

#[test]
fn a_progressing_download_reports_what_is_on_disk_beside_its_record() {
    let rig = rig();
    let asked = request("benchy.zip");
    let (id, path) = rig.start(&asked);
    assert_eq!(rig.downloads.list()[0].received_bytes, 0);
    // The browser may be writing under a temporary name until it finishes.
    std::fs::write(path.with_file_name("Unconfirmed 1.crdownload"), b"123456").unwrap();
    let listed = rig.downloads.list();
    assert_eq!(listed[0].received_bytes, 6);
    assert_eq!(listed[0].state, BrowseDownloadState::Progressing);
    assert!(!listed[0].is_verifiable);
    assert!(rig.downloads.any_running());
    rig.finish(&asked, &path, b"123456", true);
    assert!(!rig.downloads.any_running());
    let _ = id;
}

// ---- the caps ----------------------------------------------------------------------------------

#[test]
fn the_fourth_concurrent_download_is_staged_and_the_fifth_is_refused() {
    let rig = rig();
    let mut started = Vec::new();
    for index in 0..4 {
        let asked = request(&format!("m{index}.zip"));
        started.push((asked.clone(), rig.start(&asked)));
    }
    assert_eq!(
        rig.downloads.on_requested(&request("fifth.zip")),
        Decision::Refuse
    );
    assert_eq!(rig.notice_count(), 1);
    assert!(
        rig.last_notice()
            .detail
            .contains("4 downloads are already running")
    );
    // A freed slot accepts again.
    let (asked, (_, path)) = &started[0];
    rig.finish(asked, path, b"1", true);
    assert!(matches!(
        rig.downloads.on_requested(&request("sixth.zip")),
        Decision::Stage(_)
    ));
}

#[test]
fn a_single_download_over_the_cap_is_refused_and_one_exactly_on_it_is_staged() {
    let gib = 1024_i64 * 1024 * 1024;
    let rig = rig();
    let mut on_it = request("on-it.zip");
    on_it.total_bytes = 2 * gib;
    assert!(matches!(
        rig.downloads.on_requested(&on_it),
        Decision::Stage(_)
    ));
    let mut over = request("over.zip");
    over.total_bytes = 2 * gib + 1;
    assert_eq!(rig.downloads.on_requested(&over), Decision::Refuse);
    assert!(rig.last_notice().detail.contains("2 GiB"));
}

#[test]
fn a_download_that_would_push_total_staged_bytes_past_the_cap_is_refused() {
    let gib = 1024_i64 * 1024 * 1024;
    let rig = rig();
    for index in 0..2 {
        let mut asked = request(&format!("m{index}.zip"));
        asked.total_bytes = 2 * gib;
        assert!(matches!(
            rig.downloads.on_requested(&asked),
            Decision::Stage(_)
        ));
    }
    // 4 GiB are now spoken for; a further byte is past the cap.
    let mut more = request("more.zip");
    more.total_bytes = 1;
    assert_eq!(rig.downloads.on_requested(&more), Decision::Refuse);
    assert!(rig.last_notice().detail.contains("4 GiB"));
}

#[test]
fn a_download_with_no_known_length_that_ends_over_the_single_cap_is_removed_and_says_so() {
    let rig = rig_with(Limits {
        max_download_bytes: 10,
        ..Limits::default()
    });
    let asked = request("big.zip");
    let (id, path) = rig.start(&asked);
    rig.finish(&asked, &path, &[0u8; 11], true);
    assert!(rig.downloads.find(&id).is_none());
    assert!(!rig.staging.join(&id).exists());
    assert_eq!(rig.notice_count(), 1);
    let notice = rig.last_notice();
    assert_eq!(notice.kind, BrowseNoticeKind::Refused);
    assert!(notice.detail.contains("was removed"));
    // Exactly on the cap is kept.
    let on_it = request("fits.zip");
    let (id, path) = rig.start(&on_it);
    rig.finish(&on_it, &path, &[0u8; 10], true);
    assert!(rig.downloads.find(&id).unwrap().is_verifiable);
}

#[test]
fn each_refusal_appends_exactly_one_notice_naming_the_download_and_the_cap_it_hit() {
    let rig = rig();
    for index in 0..4 {
        rig.start(&request(&format!("m{index}.zip")));
    }
    assert_eq!(rig.notice_count(), 0, "accepted downloads add none");
    rig.downloads.on_requested(&request("refused-one.zip"));
    assert_eq!(rig.notice_count(), 1);
    assert_eq!(rig.last_notice().file_name, "refused-one.zip");
    assert_eq!(rig.last_notice().kind, BrowseNoticeKind::Refused);
    rig.downloads.on_requested(&request("refused-two.zip"));
    assert_eq!(rig.notice_count(), 2);
}

#[test]
fn a_refused_download_leaves_no_directory_behind_at_all() {
    let rig = rig_with(Limits {
        max_concurrent: 0,
        ..Limits::default()
    });
    assert_eq!(
        rig.downloads.on_requested(&request("x.zip")),
        Decision::Refuse
    );
    assert!(!rig.staging.exists() || std::fs::read_dir(&rig.staging).unwrap().next().is_none());
}

#[test]
fn a_record_that_cannot_be_written_refuses_the_download_rather_than_staging_bytes_alone() {
    let rig = rig();
    rig.io.fail_open.store(true, Ordering::SeqCst);
    assert_eq!(
        rig.downloads.on_requested(&request("x.zip")),
        Decision::Refuse
    );
    assert_eq!(rig.notice_count(), 1);
    assert!(rig.last_notice().detail.contains("could not be recorded"));
    assert!(rig.downloads.list().is_empty());
}

#[test]
fn the_cleanup_after_a_failed_record_write_removes_only_an_empty_directory() {
    let rig = rig();
    // The directory the next download would use already holds something: it is not ours to delete.
    let squatter = rig.staging.join("dl-1");
    std::fs::create_dir_all(&squatter).unwrap();
    std::fs::write(squatter.join("keep.txt"), "mine").unwrap();
    rig.io.fail_open.store(true, Ordering::SeqCst);
    assert_eq!(
        rig.downloads.on_requested(&request("x.zip")),
        Decision::Refuse
    );
    assert!(squatter.join("keep.txt").is_file());
}

#[test]
fn find_answers_the_path_and_the_verdict_and_nothing_for_an_id_it_does_not_know() {
    let rig = rig();
    let id = rig.complete("benchy.zip", b"12345");
    let found = rig.downloads.find(&id).unwrap();
    assert_eq!(found.file_path, rig.staging.join(&id).join("benchy.zip"));
    assert!(found.is_verifiable);
    assert!(rig.downloads.find("nope").is_none());
    assert!(rig.downloads.find("../x").is_none());
}

// Not ported, with the reason:
// - "a setSavePath that throws holds neither cap, and leaves the directory for the sweep": there is
//   no `setSavePath`; the destination is a value returned from the handler and cannot fail.
// - "will-download is registered on the session once, however often attachTo is called": the
//   `on_download` hook is set once, on the one webview builder; there is no session to attach to.
// - "hadUserGesture ... a webContents that has not committed": covered above through `page_url`.
