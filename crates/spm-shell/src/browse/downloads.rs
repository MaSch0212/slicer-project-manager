//! Where a download goes, the record beside it, and the rules for believing what is on disk.
//!
//! `<data dir>/model-downloads/<downloadId>/` holds **two** files: the downloaded bytes and
//! `download.json` beside them. Taking only the first half (which a first draft of the spec did)
//! is a defect with a measurement behind it: the browser writes **straight to the final path**
//! with no marker distinguishing a truncated file from a complete one, so a sweep with only a
//! directory listing would offer a half-written archive and `land` would upload it into the user's
//! project, silently. The record outlives the process that knew what the file was meant to be.
//!
//! **The decision is made inside `on_download`'s `Requested` arm, synchronously.** The download URL
//! may be a `blob:` (Thingiverse's is), so "capture the URL and fetch it later" fails on exactly
//! the site where a download was ever measured; redirecting the destination in the handler is the
//! only mechanism that works. Refusal is all-or-nothing and there is nothing to await.
//!
//! **What WebView2 does not tell us, and what that changed.** It reports `Requested { url,
//! destination }` and `Finished { path, success }`, and nothing else: no content length, no MIME
//! type, no user-gesture flag, no progress. So `total_bytes`, `mime_type` and `had_user_gesture`
//! are what they were when the request arrived (`0`, empty, `false`) unless the caller knows
//! better; a progressing download's `received_bytes` is the size of what is on disk beside its
//! record; and **the record's `total_bytes` becomes the size the download ended with** when it
//! finished successfully, which is what lets the sweep tell a complete file from one that was
//! truncated afterwards. A record that never reached `completed` is still a process that died
//! mid-download and is still unverifiable, which is the case the original rule exists for.
//!
//! The three caps are judgements, labelled as such: nothing in the spike bears on them. They are
//! constants in one place and not settings, because a user has no basis for choosing them. The
//! concurrency and total-staged caps are enforced when a download is requested; with no content
//! length the **single-download cap can only be enforced when it finishes**, where the oversized
//! file is removed and a notice says so. (A download cannot be cancelled once it has started, so
//! the bound on a page that streams forever is the disk, not this module. That is a Tauri
//! limitation, recorded here and in the report.)

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::dto::{BrowseDownloadDto, BrowseDownloadState, BrowseNoticeKind};
use spm_core::files::paths::safe_join;
use spm_core::{AppError, validate};

use super::notices::BrowseNotices;
use super::registry::SiteRegistry;
use crate::json_store::{FsIo, JsonStoreIo, write_json_file_with};

/// Under the data directory.
pub const MODEL_DOWNLOADS_DIR: &str = "model-downloads";
pub const DOWNLOAD_RECORD_NAME: &str = "download.json";
pub const FALLBACK_DOWNLOAD_NAME: &str = "download";

pub const MAX_CONCURRENT_DOWNLOADS: usize = 4;
pub const MAX_STAGED_BYTES: i64 = 4 * 1024 * 1024 * 1024;
pub const MAX_DOWNLOAD_BYTES: i64 = 2 * 1024 * 1024 * 1024;

/// The longest string of a stranger's (a URL, a MIME type) the record carries.
pub const MAX_RECORDED_TEXT: usize = 2048;

/// The three caps, as one value so a test can lower them.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_concurrent: usize,
    pub max_staged_bytes: i64,
    pub max_download_bytes: i64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_concurrent: MAX_CONCURRENT_DOWNLOADS,
            max_staged_bytes: MAX_STAGED_BYTES,
            max_download_bytes: MAX_DOWNLOAD_BYTES,
        }
    }
}

/// `download.json`. No `version` key: it is written once and only ever read, so a reader that does
/// not understand a record can say so from the fields it finds.
#[derive(Debug, Clone, PartialEq)]
pub struct DownloadRecord {
    pub download_id: String,
    pub started_at: i64,
    pub file_name: String,
    pub source_url: String,
    pub page_url: Option<String>,
    pub site_id: Option<String>,
    pub mime_type: String,
    pub had_user_gesture: bool,
    pub total_bytes: i64,
    pub state: BrowseDownloadState,
    pub received_bytes: i64,
    pub library: Option<String>,
}

impl DownloadRecord {
    fn to_json(&self) -> Value {
        json!({
            "downloadId": self.download_id,
            "startedAt": self.started_at,
            "fileName": self.file_name,
            "sourceUrl": self.source_url,
            "pageUrl": self.page_url,
            "siteId": self.site_id,
            "mimeType": self.mime_type,
            "hadUserGesture": self.had_user_gesture,
            "totalBytes": self.total_bytes,
            "state": state_name(self.state),
            "receivedBytes": self.received_bytes,
            "library": self.library,
        })
    }
}

fn state_name(state: BrowseDownloadState) -> &'static str {
    match state {
        BrowseDownloadState::Progressing => "progressing",
        BrowseDownloadState::Completed => "completed",
        BrowseDownloadState::Cancelled => "cancelled",
        BrowseDownloadState::Interrupted => "interrupted",
    }
}

fn parse_state(value: &str) -> Option<BrowseDownloadState> {
    match value {
        "progressing" => Some(BrowseDownloadState::Progressing),
        "completed" => Some(BrowseDownloadState::Completed),
        "cancelled" => Some(BrowseDownloadState::Cancelled),
        "interrupted" => Some(BrowseDownloadState::Interrupted),
        _ => None,
    }
}

/// A staged download as `land` and `discard` see it.
#[derive(Debug, Clone)]
pub struct StagedDownload {
    pub record: DownloadRecord,
    pub directory: PathBuf,
    pub file_path: PathBuf,
    pub is_orphan: bool,
    pub is_verifiable: bool,
    /// Whether a record was read at all, which is what names the refusal.
    pub has_record: bool,
    pub bytes_on_disk: i64,
}

/// What the browser knows when a download is requested.
#[derive(Debug, Clone)]
pub struct DownloadRequest {
    /// The name the browser suggested. **A remote server chose it.**
    pub file_name: String,
    /// The download's own URL, which may be a `blob:`.
    pub url: String,
    /// The page the view was on. `None` for a webview that has not committed a document.
    pub page_url: Option<String>,
    pub mime_type: String,
    /// `0` when the length is not known, which under WebView2 is always.
    pub total_bytes: i64,
    pub had_user_gesture: bool,
}

/// The answer to a request. There is nothing in between: a refusal is final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Write the file here.
    Stage(PathBuf),
    /// Do not download it. A notice says why.
    Refuse,
}

/// The one filename rule: the browser's name, run through the rules `files.upload` applies,
/// because it came from a remote server. Anything unsafe, and the record's own name, becomes
/// [`FALLBACK_DOWNLOAD_NAME`].
pub fn staged_file_name(raw: &str) -> String {
    if validate::file_name(raw).is_err() || raw.to_lowercase() == DOWNLOAD_RECORD_NAME {
        FALLBACK_DOWNLOAD_NAME.to_owned()
    } else {
        raw.to_owned()
    }
}

/// Whether the record vouches for the bytes beside it.
///
/// Only a **completed** record can. With a recorded size the file must be exactly that size; with
/// none (`0`) the size cannot be checked at all, so an unknown is not a pass unless this process
/// watched the download finish (`observed_terminal`) and the bytes it saw are there.
pub fn vouches_for_the_bytes(
    record: &DownloadRecord,
    bytes_on_disk: i64,
    observed_terminal: bool,
) -> bool {
    if record.state != BrowseDownloadState::Completed {
        return false;
    }
    if record.total_bytes == 0 {
        return observed_terminal && bytes_on_disk > 0 && bytes_on_disk == record.received_bytes;
    }
    bytes_on_disk == record.total_bytes
}

struct Entry {
    record: DownloadRecord,
    is_orphan: bool,
    is_verifiable: bool,
    has_record: bool,
    bytes_on_disk: i64,
}

impl Entry {
    fn is_running(&self) -> bool {
        !self.is_orphan && self.record.state == BrowseDownloadState::Progressing
    }
}

pub struct DownloadsOptions {
    pub staging_dir: PathBuf,
    pub notices: Arc<BrowseNotices>,
    pub registry: Arc<SiteRegistry>,
    /// Which library this was staged against (`local:<folder>` or `remote:<origin>`).
    pub library_key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub is_view_attached: Arc<dyn Fn() -> bool + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub mint_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub io: Arc<dyn JsonStoreIo + Send + Sync>,
    pub limits: Limits,
}

impl DownloadsOptions {
    pub fn new(
        staging_dir: PathBuf,
        notices: Arc<BrowseNotices>,
        registry: Arc<SiteRegistry>,
    ) -> DownloadsOptions {
        DownloadsOptions {
            staging_dir,
            notices,
            registry,
            library_key: Arc::new(|| None),
            is_view_attached: Arc::new(|| false),
            now: Arc::new(spm_core::clock::now_ms),
            mint_id: Arc::new(spm_core::new_id),
            io: Arc::new(FsIo::default()),
            limits: Limits::default(),
        }
    }
}

/// The staging directory, in memory and on disk.
pub struct Downloads {
    options: DownloadsOptions,
    staged: Mutex<Vec<Entry>>,
}

impl Downloads {
    pub fn new(options: DownloadsOptions) -> Arc<Downloads> {
        Arc::new(Downloads {
            options,
            staged: Mutex::new(Vec::new()),
        })
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.staged.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A download was requested: stage it, or refuse it.
    ///
    /// **Called inside the browser's own `Requested` handler, on the thread that raised it, so it
    /// must be quick and must not wait on anything.**
    pub fn on_requested(&self, request: &DownloadRequest) -> Decision {
        if let Some(why) = self.cap_refusal(request.total_bytes) {
            self.options
                .notices
                .add(BrowseNoticeKind::Refused, &request.file_name, &why);
            return Decision::Refuse;
        }

        let download_id = (self.options.mint_id)();
        let directory = self.options.staging_dir.join(&download_id);
        let file_name = staged_file_name(&request.file_name);
        let Ok(save_path) = safe_join(&directory, &[&file_name]) else {
            self.options.notices.add(
                BrowseNoticeKind::Refused,
                &request.file_name,
                "this download could not be started, and nothing was staged for it",
            );
            return Decision::Refuse;
        };
        let page_url = request
            .page_url
            .as_deref()
            .filter(|url| !url.is_empty())
            .map(bounded);
        let record = DownloadRecord {
            site_id: page_url
                .as_deref()
                .and_then(|url| self.options.registry.site_for_url(url))
                .map(|site| site.id.to_owned()),
            download_id: download_id.clone(),
            started_at: (self.options.now)(),
            file_name,
            source_url: bounded(&request.url),
            page_url,
            mime_type: bounded(&request.mime_type),
            had_user_gesture: request.had_user_gesture,
            total_bytes: request.total_bytes.max(0),
            state: BrowseDownloadState::Progressing,
            received_bytes: 0,
            library: (self.options.library_key)(),
        };

        // The record is on disk saying `progressing` **before** the destination is handed back,
        // so a kill one millisecond later still leaves a directory that explains itself. If it
        // cannot be written the download is refused rather than staging bytes alone.
        if !self.write_record(&directory, &record) {
            self.options.notices.add(
                BrowseNoticeKind::Refused,
                &request.file_name,
                "this download could not be recorded, so it was not started",
            );
            remove_if_empty(&directory);
            return Decision::Refuse;
        }
        self.entries().push(Entry {
            record,
            is_orphan: false,
            is_verifiable: false,
            has_record: true,
            bytes_on_disk: 0,
        });
        Decision::Stage(save_path)
    }

    /// Progress, when a caller has any. WebView2 reports none; the record carries what was last
    /// told and is **not** rewritten for it (five fsyncs on a 21 MB download for a number the poll
    /// already has).
    pub fn on_progress(&self, download_id: &str, received_bytes: i64) {
        if let Some(entry) = self
            .entries()
            .iter_mut()
            .find(|entry| entry.record.download_id == download_id)
        {
            entry.record.received_bytes = received_bytes.max(0);
        }
    }

    /// The download ended. `path` is where the browser says it wrote; the entry is found by that
    /// path, or failing that by the URL of the only download still running for it.
    ///
    /// Rewrites the record **once**, with the state it ended in and the size it ended with.
    pub fn on_finished(&self, url: &str, path: Option<&Path>, success: bool) {
        let Some((download_id, directory, file_path, notice_name)) = self.locate_running(url, path)
        else {
            return;
        };
        let size = size_of(&file_path);
        if success && size > self.options.limits.max_download_bytes {
            // No content length means the single-download cap can only be enforced here.
            self.remove_entry(&download_id);
            self.options.notices.add(
                BrowseNoticeKind::Refused,
                &notice_name,
                &format!(
                    "this download was larger than the {} limit for a single file ({size} bytes) and was removed",
                    as_gib(self.options.limits.max_download_bytes)
                ),
            );
            return;
        }
        let completed;
        let record = {
            let mut entries = self.entries();
            let Some(entry) = entries
                .iter_mut()
                .find(|entry| entry.record.download_id == download_id)
            else {
                return;
            };
            entry.record.state = if success {
                BrowseDownloadState::Completed
            } else {
                BrowseDownloadState::Interrupted
            };
            entry.record.received_bytes = size;
            if success && entry.record.total_bytes == 0 {
                entry.record.total_bytes = size;
            }
            entry.bytes_on_disk = size;
            entry.is_verifiable = vouches_for_the_bytes(&entry.record, size, true);
            completed = entry.record.state == BrowseDownloadState::Completed;
            entry.record.clone()
        };
        self.write_record(&directory, &record);
        if completed && !(self.options.is_view_attached)() {
            self.options.notices.add(
                BrowseNoticeKind::Completed,
                &record.file_name,
                "this download finished in the background",
            );
        }
    }

    /// The running entry a `Finished` event is about: its id, directory, staged file and the name
    /// to put in a notice.
    fn locate_running(
        &self,
        url: &str,
        path: Option<&Path>,
    ) -> Option<(String, PathBuf, PathBuf, String)> {
        let entries = self.entries();
        let staged_at = |entry: &Entry| {
            let directory = self.options.staging_dir.join(&entry.record.download_id);
            let file = directory.join(&entry.record.file_name);
            (directory, file)
        };
        let by_path = path.and_then(|path| {
            entries
                .iter()
                .filter(|entry| entry.is_running())
                .find(|entry| same_path(&staged_at(entry).1, path))
        });
        let found = by_path.or_else(|| {
            let mut by_url = entries
                .iter()
                .filter(|entry| entry.is_running() && entry.record.source_url == bounded(url));
            let first = by_url.next();
            // Two running downloads of one URL cannot be told apart: neither is guessed at.
            if by_url.next().is_some() { None } else { first }
        })?;
        let (directory, file) = staged_at(found);
        Some((
            found.record.download_id.clone(),
            directory,
            file,
            found.record.file_name.clone(),
        ))
    }

    fn cap_refusal(&self, total_bytes: i64) -> Option<String> {
        let limits = self.options.limits;
        let entries = self.entries();
        let in_flight = entries.iter().filter(|entry| entry.is_running()).count();
        if in_flight >= limits.max_concurrent {
            return Some(format!(
                "{} downloads are already running; wait for one to finish",
                limits.max_concurrent
            ));
        }
        if total_bytes > limits.max_download_bytes {
            return Some(format!(
                "this download is larger than the {} limit for a single file ({total_bytes} bytes)",
                as_gib(limits.max_download_bytes)
            ));
        }
        let staged: i64 = entries
            .iter()
            .map(|entry| {
                if entry.is_running() {
                    entry.record.total_bytes.max(entry.record.received_bytes)
                } else {
                    entry.bytes_on_disk
                }
            })
            .sum();
        if staged.saturating_add(total_bytes) > limits.max_staged_bytes {
            return Some(format!(
                "staged downloads would go past the {} limit; discard some to make room",
                as_gib(limits.max_staged_bytes)
            ));
        }
        None
    }

    /// Writes the record through the shell's atomic writer. `false` when it could not.
    fn write_record(&self, directory: &Path, record: &DownloadRecord) -> bool {
        let file = directory.join(DOWNLOAD_RECORD_NAME);
        match write_json_file_with(&file, &record.to_json(), self.options.io.as_ref()) {
            Ok(()) => true,
            Err(error) => {
                crate::diag::warn(&format!(
                    "could not write {DOWNLOAD_RECORD_NAME} for a staged download: {error}"
                ));
                false
            }
        }
    }

    /// Reads the staging directory at start and **surfaces every download it finds**. It deletes
    /// nothing: a user who quit mid-decision gets the file back rather than losing it silently,
    /// and is told when what came back cannot be trusted. A directory that is not there yet is a
    /// first run.
    pub fn sweep(&self) {
        let Ok(read) = std::fs::read_dir(&self.options.staging_dir) else {
            return;
        };
        let mut names: Vec<String> = read
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for download_id in names {
            if self
                .entries()
                .iter()
                .any(|entry| entry.record.download_id == download_id)
            {
                continue;
            }
            let entry = self.sweep_one(&download_id);
            self.entries().push(entry);
        }
    }

    fn sweep_one(&self, download_id: &str) -> Entry {
        let directory = self.options.staging_dir.join(download_id);
        match read_record(&directory, download_id) {
            None => {
                let found = bytes_beside(&directory);
                Entry {
                    record: unrecorded_download(download_id, &directory, &found),
                    is_orphan: true,
                    is_verifiable: false,
                    has_record: false,
                    bytes_on_disk: found.size,
                }
            }
            Some(record) => {
                let bytes_on_disk = size_of(&directory.join(&record.file_name));
                Entry {
                    is_verifiable: vouches_for_the_bytes(&record, bytes_on_disk, false),
                    record,
                    is_orphan: true,
                    has_record: true,
                    bytes_on_disk,
                }
            }
        }
    }

    /// Everything staged, oldest first, including what previous runs left.
    pub fn list(&self) -> Vec<BrowseDownloadDto> {
        self.entries()
            .iter()
            .map(|entry| {
                let mut received = entry.record.received_bytes;
                if entry.is_running() {
                    // No progress event exists: what has arrived is what is on disk beside the
                    // record (the browser may be writing under a temporary name).
                    let directory = self.options.staging_dir.join(&entry.record.download_id);
                    received = received.max(bytes_beside(&directory).size);
                }
                BrowseDownloadDto {
                    download_id: entry.record.download_id.clone(),
                    file_name: entry.record.file_name.clone(),
                    source_url: entry.record.source_url.clone(),
                    page_url: entry.record.page_url.clone(),
                    site_id: entry.record.site_id.clone(),
                    mime_type: entry.record.mime_type.clone(),
                    state: entry.record.state,
                    received_bytes: received,
                    total_bytes: entry.record.total_bytes,
                    had_user_gesture: entry.record.had_user_gesture,
                    started_at: entry.record.started_at,
                    is_orphan: entry.is_orphan,
                    is_verifiable: entry.is_verifiable,
                }
            })
            .collect()
    }

    /// The path and the verdict for a download this module knows, and nothing for an id it does
    /// not (the id is looked up, never joined onto a path).
    pub fn find(&self, download_id: &str) -> Option<StagedDownload> {
        let entries = self.entries();
        let entry = entries
            .iter()
            .find(|entry| entry.record.download_id == download_id)?;
        let directory = self.options.staging_dir.join(&entry.record.download_id);
        let file_path = if entry.record.file_name.is_empty() {
            PathBuf::new()
        } else {
            directory.join(&entry.record.file_name)
        };
        Some(StagedDownload {
            record: entry.record.clone(),
            directory,
            file_path,
            is_orphan: entry.is_orphan,
            is_verifiable: entry.is_verifiable,
            has_record: entry.has_record,
            bytes_on_disk: entry.bytes_on_disk,
        })
    }

    /// Deletes a staged download and its directory. **The only thing that removes one** besides a
    /// successful landing.
    ///
    /// `Conflict` for one that is still running, which is `!is_orphan && state == progressing`:
    /// both halves. An orphan whose record still says `progressing` is what a kill mid-download
    /// leaves and is not running (nothing is writing to it and this call is its only exit).
    pub fn discard(&self, download_id: &str) -> Result<(), AppError> {
        let running = {
            let entries = self.entries();
            let entry = entries
                .iter()
                .find(|entry| entry.record.download_id == download_id)
                .ok_or_else(|| {
                    AppError::not_found("there is no staged download with that id")
                        .with_details(details(download_id))
                })?;
            entry.is_running()
        };
        if running {
            return Err(AppError::conflict("that download is still running")
                .with_details(details(download_id)));
        }
        self.remove(download_id);
        Ok(())
    }

    /// Removes a download's directory and forgets it. Quiet about one that is not there.
    pub fn remove(&self, download_id: &str) {
        self.remove_entry(download_id);
    }

    fn remove_entry(&self, download_id: &str) {
        let known = self
            .entries()
            .iter()
            .any(|entry| entry.record.download_id == download_id);
        if !known {
            return;
        }
        remove_dir_with_retries(&self.options.staging_dir.join(download_id));
        self.entries()
            .retain(|entry| entry.record.download_id != download_id);
    }

    /// Whether any download this process started is still running.
    pub fn any_running(&self) -> bool {
        self.entries().iter().any(Entry::is_running)
    }
}

fn details(download_id: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("downloadId".to_owned(), Value::from(download_id));
    map
}

fn as_gib(bytes: i64) -> String {
    format!("{} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

fn bounded(value: &str) -> String {
    value.chars().take(MAX_RECORDED_TEXT).collect()
}

fn size_of(file: &Path) -> i64 {
    std::fs::metadata(file)
        .map(|meta| i64::try_from(meta.len()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Windows compares paths without regard to case, and the browser may report a path in a spelling
/// of its own (a `\\?\` prefix, other slashes).
fn same_path(left: &Path, right: &Path) -> bool {
    let normal = |path: &Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_lowercase()
    };
    normal(left) == normal(right)
}

fn remove_if_empty(directory: &Path) {
    if std::fs::read_dir(directory).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = std::fs::remove_dir_all(directory);
    }
}

/// A browser may still hold a file for a moment after it reports it finished; a few tries.
fn remove_dir_with_retries(directory: &Path) {
    for attempt in 0..6 {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 5 => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(error) => {
                crate::diag::warn(&format!(
                    "could not remove a staged download ({}): {error}",
                    directory.display()
                ));
            }
        }
    }
}

// -----------------------------------------------------------------------------------------------
// Reading a directory back
// -----------------------------------------------------------------------------------------------

fn is_record_temp(name: &str) -> bool {
    // `download.json.<pid>.tmp`
    name.strip_prefix(&format!("{DOWNLOAD_RECORD_NAME}."))
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|pid| !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()))
}

struct Beside {
    name: String,
    size: i64,
}

/// The biggest file beside the record: what the directory holds when the record is missing, and
/// what has arrived so far for a download that is still coming down.
fn bytes_beside(directory: &Path) -> Beside {
    let mut best = Beside {
        name: String::new(),
        size: 0,
    };
    let Ok(read) = std::fs::read_dir(directory) else {
        return best;
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        if name == DOWNLOAD_RECORD_NAME || is_record_temp(&name) {
            continue;
        }
        let size = size_of(&directory.join(&name));
        if best.name.is_empty() || size > best.size {
            best = Beside { name, size };
        }
    }
    best
}

fn unrecorded_download(download_id: &str, directory: &Path, found: &Beside) -> DownloadRecord {
    DownloadRecord {
        download_id: download_id.to_owned(),
        started_at: modified_ms(directory),
        file_name: found.name.clone(),
        source_url: String::new(),
        page_url: None,
        site_id: None,
        mime_type: String::new(),
        had_user_gesture: false,
        total_bytes: 0,
        state: BrowseDownloadState::Interrupted,
        received_bytes: found.size,
        library: None,
    }
}

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// A record read back from disk: a file the user can edit is an input, so every string is
/// bounded and every number checked, and a record that is not recognisably one is `None`.
fn read_record(directory: &Path, download_id: &str) -> Option<DownloadRecord> {
    let text = std::fs::read_to_string(directory.join(DOWNLOAD_RECORD_NAME)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let value = parsed.as_object()?;
    let state = parse_state(value.get("state")?.as_str()?)?;
    let file_name = value.get("fileName")?.as_str()?;
    if staged_file_name(file_name) != file_name {
        return None;
    }
    let text_of = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(bounded)
            .unwrap_or_default()
    };
    let optional = |key: &str| value.get(key).and_then(Value::as_str).map(bounded);
    let number = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_i64)
            .filter(|number| *number >= 0)
            .unwrap_or(0)
    };
    Some(DownloadRecord {
        download_id: download_id.to_owned(),
        started_at: number("startedAt"),
        file_name: file_name.to_owned(),
        source_url: text_of("sourceUrl"),
        page_url: optional("pageUrl"),
        site_id: optional("siteId"),
        mime_type: text_of("mimeType"),
        had_user_gesture: value.get("hadUserGesture") == Some(&Value::Bool(true)),
        total_bytes: number("totalBytes"),
        state,
        received_bytes: number("receivedBytes"),
        library: value
            .get("library")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
