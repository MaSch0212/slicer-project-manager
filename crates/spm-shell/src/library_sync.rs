//! Keeping a folder on this computer in step with a server's library, both ways, the way a cloud
//! drive does: every model file is on the disk, a slicer opens and saves it in place, and a folder
//! made in Explorer becomes a project.
//!
//! **One pass ([`sync_once`]) is a three-way comparison** of the server's manifest, the folder as it
//! is now, and the *base*: what both sides held when they last agreed, kept in
//! `<folder>/.spm-sync/state.json`. Per file:
//!
//! - the same on both sides: nothing to do (the base catches up);
//! - changed on one side only: that side's version is copied to the other, a deletion included;
//! - changed on both: **both are kept**. The server's version takes the name, this computer's is
//!   renamed to `name (conflict from HOST).ext` and uploaded as a file of its own. A deletion
//!   against an edit loses: the edit comes back.
//!
//! Every write and delete on the server names the version it replaces (see
//! [`spm_core::library_sync`]), so a change that lands on the server between the manifest and the
//! write is a 409 the next pass resolves, never an overwrite. Deleted things go to a trash on both
//! sides (`.spm/trash` on the server, `.spm-sync/trash` here) rather than away.
//!
//! **What starts a pass**: the folder's watcher once a burst of changes has settled, a timer
//! ([`POLL_INTERVAL`]) for changes made on the server, and [`SyncEngine::kick`] after the page wrote
//! something through the proxy. Passes never overlap: one worker thread runs them.
//!
//! Projects map to top-level folders by id in the base, so a folder keeps its project even when the
//! server's folder of the same project has another name. A folder whose project is gone from the
//! server is moved to the trash, unless something in it changed here, in which case it is uploaded
//! again as a new project: nothing anybody changed is ever thrown away by a sync.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, UNIX_EPOCH};

use axum::body::Body;
use axum::http::Request;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use spm_core::AppError;
use spm_core::files::hash::file_content_hash;
use spm_core::library_sync::{BaseVersion, SyncFile, SyncManifest, parse_hex, to_hex};
use spm_core::watch::{LibraryWatch, is_transient_name};
use tokio_util::io::ReaderStream;

use crate::diag;
use crate::remote::{RemoteHost, UPLOAD_LENGTH_HEADER};
use crate::slicers::remote_files::{RemoteResponse, failure_of, percent_encode};

/// The folder inside the synced folder that holds the base and the local trash. A dot name, so the
/// watcher and the server's rescan both pass over it.
pub const SYNC_STATE_DIR: &str = ".spm-sync";
const STATE_FILE: &str = "state.json";
const TRASH_DIR: &str = "trash";
const STATE_VERSION: u32 = 1;

/// How often the server is asked for changes when nothing else starts a pass.
pub const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// How often a worker without a session looks again (no request is made meanwhile).
const SIGN_IN_POLL: Duration = Duration::from_secs(2);

// ---- the server ---------------------------------------------------------------------------------

/// Why a call to the server did not do what it was asked.
#[derive(Debug)]
pub enum SyncError {
    /// The server has a different version than the one named: the next pass decides again.
    Conflict,
    /// No session (signed out, or it expired): the worker waits for a sign-in.
    Unauthorized,
    Other(AppError),
}

impl SyncError {
    fn message(&self) -> String {
        match self {
            SyncError::Conflict => "changed on the server meanwhile".to_owned(),
            SyncError::Unauthorized => "not signed in".to_owned(),
            SyncError::Other(error) => error.message.clone(),
        }
    }
}

impl From<std::io::Error> for SyncError {
    fn from(error: std::io::Error) -> SyncError {
        SyncError::Other(AppError::internal(error))
    }
}

impl From<AppError> for SyncError {
    fn from(error: AppError) -> SyncError {
        SyncError::Other(error)
    }
}

/// What a pass needs from the server. Blocking: passes run on the sync worker's own thread.
pub trait SyncServer: Send + Sync {
    /// Whether there is a session to make requests with.
    fn has_session(&self) -> bool;
    fn manifest(&self) -> Result<SyncManifest, SyncError>;
    /// Creates a project for a folder made here; returns its id.
    fn create_project(&self, name: &str) -> Result<String, SyncError>;
    /// Streams a file's bytes into `destination` (a new file).
    fn download(&self, file_id: &str, destination: &Path) -> Result<(), SyncError>;
    fn put_file(
        &self,
        project_id: &str,
        rel_path: &str,
        base: BaseVersion,
        file: &Path,
        size_bytes: u64,
    ) -> Result<SyncFile, SyncError>;
    fn trash_file(&self, file_id: &str, base: BaseVersion) -> Result<(), SyncError>;
    fn trash_project(&self, project_id: &str) -> Result<(), SyncError>;
}

/// The real [`SyncServer`]: the shell's [`RemoteHost`], whose proxy already carries the session,
/// refuses redirects and keeps every request on the one origin, called from the worker thread.
pub struct ProxySyncServer {
    host: Arc<RemoteHost>,
    handle: tokio::runtime::Handle,
}

const MAX_JSON_BYTES: usize = 256 * 1024 * 1024;

impl ProxySyncServer {
    pub fn new(host: Arc<RemoteHost>, handle: tokio::runtime::Handle) -> ProxySyncServer {
        ProxySyncServer { host, handle }
    }

    fn call(&self, request: Request<Body>) -> Result<RemoteResponse, SyncError> {
        self.handle.block_on(async {
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), MAX_JSON_BYTES)
                .await
                .map_err(|error| {
                    AppError::internal(format!("could not read the answer: {error}"))
                })?;
            Ok(RemoteResponse {
                status,
                body: body.to_vec(),
            })
        })
    }
}

fn checked(response: RemoteResponse, what: &str) -> Result<RemoteResponse, SyncError> {
    match response.status {
        200..=299 => Ok(response),
        401 => Err(SyncError::Unauthorized),
        409 => Err(SyncError::Conflict),
        _ => Err(SyncError::Other(failure_of(&response, what))),
    }
}

fn base_header(base: BaseVersion) -> String {
    match base {
        BaseVersion::Absent => "absent".to_owned(),
        BaseVersion::Any => "*".to_owned(),
        BaseVersion::Hash(hash) => to_hex(&hash),
    }
}

fn request(method: &str, path: &str) -> axum::http::request::Builder {
    Request::builder().method(method).uri(path)
}

impl SyncServer for ProxySyncServer {
    fn has_session(&self) -> bool {
        self.host.has_session() && !self.host.is_closed()
    }

    fn manifest(&self) -> Result<SyncManifest, SyncError> {
        let request = request("GET", "/api/sync/manifest")
            .body(Body::empty())
            .map_err(AppError::internal)?;
        let response = checked(self.call(request)?, "the server sent no manifest")?;
        serde_json::from_slice(&response.body).map_err(|error| {
            SyncError::Other(AppError::internal(format!(
                "the server's manifest is not one this app reads ({error}); is it a newer version?"
            )))
        })
    }

    fn create_project(&self, name: &str) -> Result<String, SyncError> {
        let body =
            serde_json::to_vec(&serde_json::json!({ "name": name })).map_err(AppError::internal)?;
        let request = request("POST", "/api/projects")
            .header("content-type", "application/json")
            .header(UPLOAD_LENGTH_HEADER, body.len().to_string())
            .body(Body::from(body))
            .map_err(AppError::internal)?;
        let response = checked(self.call(request)?, "the project could not be created")?;
        let value: serde_json::Value =
            serde_json::from_slice(&response.body).map_err(AppError::internal)?;
        value["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| SyncError::Other(AppError::internal("the new project has no id")))
    }

    fn download(&self, file_id: &str, destination: &Path) -> Result<(), SyncError> {
        let request = request(
            "GET",
            &format!("/api/files/{}/raw", percent_encode(file_id)),
        )
        .body(Body::empty())
        .map_err(AppError::internal)?;
        self.handle.block_on(async {
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap_or_default();
                checked(
                    RemoteResponse {
                        status,
                        body: body.to_vec(),
                    },
                    "the file could not be downloaded",
                )?;
                return Ok(());
            }
            let mut file = fs::File::create_new(destination)?;
            let mut stream = response.into_body().into_data_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    AppError::internal(format!("the download broke off: {error}"))
                })?;
                file.write_all(&chunk)?;
            }
            file.flush()?;
            Ok(())
        })
    }

    fn put_file(
        &self,
        project_id: &str,
        rel_path: &str,
        base: BaseVersion,
        file: &Path,
        size_bytes: u64,
    ) -> Result<SyncFile, SyncError> {
        let response = self.handle.block_on(async {
            let file = tokio::fs::File::open(file).await?;
            let request = request(
                "PUT",
                &format!("/api/sync/projects/{}/file", percent_encode(project_id)),
            )
            .header("content-type", "application/octet-stream")
            .header("x-spm-sync-path", percent_encode(rel_path))
            .header("x-spm-sync-base", base_header(base))
            .header(UPLOAD_LENGTH_HEADER, size_bytes.to_string())
            .body(Body::from_stream(ReaderStream::new(file)))
            .map_err(AppError::internal)?;
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap_or_default();
            Ok::<_, SyncError>(RemoteResponse {
                status,
                body: body.to_vec(),
            })
        })?;
        let response = checked(response, "the file could not be uploaded")?;
        serde_json::from_slice(&response.body)
            .map_err(|error| SyncError::Other(AppError::internal(error)))
    }

    fn trash_file(&self, file_id: &str, base: BaseVersion) -> Result<(), SyncError> {
        let request = request(
            "DELETE",
            &format!("/api/sync/files/{}", percent_encode(file_id)),
        )
        .header("x-spm-sync-base", base_header(base))
        .body(Body::empty())
        .map_err(AppError::internal)?;
        checked(self.call(request)?, "the file could not be deleted")?;
        Ok(())
    }

    fn trash_project(&self, project_id: &str) -> Result<(), SyncError> {
        let request = request(
            "DELETE",
            &format!("/api/sync/projects/{}", percent_encode(project_id)),
        )
        .body(Body::empty())
        .map_err(AppError::internal)?;
        checked(self.call(request)?, "the project could not be deleted")?;
        Ok(())
    }
}

// ---- the base -----------------------------------------------------------------------------------

/// What both sides held when they last agreed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub version: u32,
    /// The account the folder is synced for, once a manifest has said.
    pub user_id: Option<String>,
    /// By project id.
    pub projects: BTreeMap<String, ProjectBase>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBase {
    /// The top-level folder the project lives in here.
    pub dir: String,
    /// By `/`-separated path relative to the project folder.
    pub files: BTreeMap<String, FileBase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBase {
    pub id: String,
    pub sha256: String,
    /// The local file's size and modification time when it was agreed on: while both still match,
    /// the file is taken to be unchanged and is not hashed again.
    pub size: u64,
    pub mtime_ms: i64,
}

impl SyncState {
    pub fn load(root: &Path) -> SyncState {
        let path = root.join(SYNC_STATE_DIR).join(STATE_FILE);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                diag::warn(&format!(
                    "the sync state in {} is unreadable ({error}); starting over (nothing is \
                     deleted on a first pass, only compared)",
                    path.display()
                ));
                SyncState::default()
            }),
            Err(_) => SyncState::default(),
        }
    }

    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let dir = root.join(SYNC_STATE_DIR);
        fs::create_dir_all(&dir)?;
        let mut state = self.clone();
        state.version = STATE_VERSION;
        let bytes = serde_json::to_vec_pretty(&state).map_err(std::io::Error::other)?;
        let partial = dir.join(format!("{STATE_FILE}.partial"));
        fs::write(&partial, bytes)?;
        fs::rename(partial, dir.join(STATE_FILE))
    }

    /// Where a server file is on this computer, if it has been synced.
    pub fn local_path_of(&self, root: &Path, file_id: &str) -> Option<PathBuf> {
        self.projects.values().find_map(|project| {
            project
                .files
                .iter()
                .find(|(_, file)| file.id == file_id)
                .map(|(rel_path, _)| join_rel(&root.join(&project.dir), rel_path))
        })
    }

    /// The local folder of a project, if it has been synced.
    pub fn local_dir_of(&self, root: &Path, project_id: &str) -> Option<PathBuf> {
        self.projects
            .get(project_id)
            .map(|project| root.join(&project.dir))
    }
}

fn join_rel(dir: &Path, rel_path: &str) -> PathBuf {
    rel_path
        .split('/')
        .fold(dir.to_path_buf(), |path, segment| path.join(segment))
}

// ---- the folder ---------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct LocalFile {
    abs: PathBuf,
    size: u64,
    mtime_ms: i64,
}

fn mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |after| {
            i64::try_from(after.as_millis()).unwrap_or(i64::MAX)
        })
}

fn is_skipped(name: &str) -> bool {
    is_transient_name(name)
}

/// The top-level folders of the synced folder: the projects as this computer sees them.
fn local_dirs(root: &Path) -> std::io::Result<BTreeSet<String>> {
    let mut dirs = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_skipped(&name) || !entry.file_type()?.is_dir() {
            continue;
        }
        dirs.insert(name);
    }
    Ok(dirs)
}

/// Every file under a project folder, by relative path. Symbolic links are not followed.
fn scan(dir: &Path) -> std::io::Result<BTreeMap<String, LocalFile>> {
    fn walk(
        dir: &Path,
        prefix: &str,
        out: &mut BTreeMap<String, LocalFile>,
    ) -> std::io::Result<()> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_skipped(&name) {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                walk(&entry.path(), &rel, out)?;
            } else if file_type.is_file() {
                let metadata = entry.metadata()?;
                out.insert(
                    rel,
                    LocalFile {
                        abs: entry.path(),
                        size: metadata.len(),
                        mtime_ms: mtime_ms(&metadata),
                    },
                );
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(dir, "", &mut out)?;
    Ok(out)
}

fn local_hash(base: Option<&FileBase>, file: &LocalFile) -> std::io::Result<String> {
    if let Some(base) = base
        && base.size == file.size
        && base.mtime_ms == file.mtime_ms
    {
        return Ok(base.sha256.clone());
    }
    file_content_hash(&file.abs)
        .map(|hash| to_hex(&hash))
        .map_err(|error| std::io::Error::other(error.message))
}

fn base_of_hash(hash: Option<&str>) -> BaseVersion {
    match hash.and_then(parse_hex) {
        Some(hash) => BaseVersion::Hash(hash),
        None => BaseVersion::Absent,
    }
}

/// A name for this computer in a conflict copy's name.
fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\', ':']))
        .unwrap_or_else(|| "this computer".to_owned())
}

/// `parts/arm.stl` → `parts/arm (conflict from HOST).stl`, or ` (2)` and on until it is free.
fn conflict_rel_path(dir: &Path, rel_path: &str, host: &str) -> String {
    let (folder, name) = match rel_path.rsplit_once('/') {
        Some((folder, name)) => (Some(folder), name),
        None => (None, rel_path),
    };
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let suffix = if n == 1 {
            format!(" (conflict from {host})")
        } else {
            format!(" (conflict from {host}) ({n})")
        };
        let candidate = format!("{stem}{suffix}{extension}");
        let rel = match folder {
            Some(folder) => format!("{folder}/{candidate}"),
            None => candidate,
        };
        if !join_rel(dir, &rel).exists() {
            return rel;
        }
        n += 1;
    }
}

/// A fresh slot in the local trash.
fn local_trash_slot(root: &Path) -> std::io::Result<PathBuf> {
    let slot = root.join(SYNC_STATE_DIR).join(TRASH_DIR).join(format!(
        "{}-{}",
        spm_core::clock::now_ms(),
        spm_core::new_id()
    ));
    fs::create_dir_all(&slot)?;
    Ok(slot)
}

fn move_to_local_trash(root: &Path, path: &Path) -> std::io::Result<()> {
    let slot = local_trash_slot(root)?;
    let name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "item".into());
    fs::rename(path, slot.join(name))
}

// ---- one pass -----------------------------------------------------------------------------------

/// What a pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_here: usize,
    pub deleted_there: usize,
    pub conflicts: usize,
    pub projects_created: usize,
    /// Changes the server refused because it had moved on (409): the next pass decides again.
    pub deferred: usize,
}

impl SyncReport {
    pub fn changed_anything(&self) -> bool {
        self.uploaded
            + self.downloaded
            + self.deleted_here
            + self.deleted_there
            + self.conflicts
            + self.projects_created
            > 0
    }
}

struct Pass<'a> {
    server: &'a dyn SyncServer,
    root: &'a Path,
    host: String,
    report: SyncReport,
}

/// One pass over the whole folder. `state` is updated as the pass goes, so whatever it got done
/// before a failure is remembered; the caller saves it either way.
pub fn sync_once(
    server: &dyn SyncServer,
    root: &Path,
    state: &mut SyncState,
) -> Result<SyncReport, SyncError> {
    if !root.is_dir() {
        return Err(SyncError::Other(AppError::internal(format!(
            "the sync folder {} is not there",
            root.display()
        ))));
    }
    let manifest = server.manifest()?;
    match &state.user_id {
        Some(user) if *user != manifest.user_id => {
            return Err(SyncError::Other(AppError::conflict(
                "this folder is synced for another account; choose another sync folder",
            )));
        }
        _ => state.user_id = Some(manifest.user_id.clone()),
    }
    let dirs = local_dirs(root)?;
    // A folder that comes back empty while the base knows projects is far likelier an unplugged
    // drive or a wrong path than the user deleting every project at once: refuse to act on it.
    if dirs.is_empty() && !state.projects.is_empty() {
        return Err(SyncError::Other(AppError::internal(
            "the sync folder is empty although projects were synced into it; nothing was \
             deleted. Check the folder, or choose it again",
        )));
    }

    let mut pass = Pass {
        server,
        root,
        host: host_name(),
        report: SyncReport::default(),
    };
    let remote: HashMap<&str, &spm_core::library_sync::SyncProject> = manifest
        .projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();

    // 1. The projects synced before. Every one of them is settled here, also the ones this step
    // deletes: the manifest still lists those, and step 2 must not bring them back.
    let known: Vec<String> = state.projects.keys().cloned().collect();
    let settled: HashSet<String> = known.iter().cloned().collect();
    for id in known {
        let Some(base) = state.projects.get(&id).cloned() else {
            continue;
        };
        let here = dirs.contains(&base.dir);
        match remote.get(id.as_str()) {
            Some(project) if here => {
                let entry = state.projects.get_mut(&id).expect("known");
                pass.sync_files(&id, entry, &project.files)?;
            }
            Some(project) => {
                // The folder was deleted here. If the server's copy is still what was agreed, the
                // deletion goes up; if somebody changed it there meanwhile, it comes back down.
                let unchanged = project.files.len() == base.files.len()
                    && project.files.iter().all(|file| {
                        base.files
                            .get(&file.rel_path)
                            .is_some_and(|known| known.sha256 == file.sha256)
                    });
                if unchanged {
                    match server.trash_project(&id) {
                        Ok(()) => {
                            state.projects.remove(&id);
                            pass.report.deleted_there += 1;
                        }
                        Err(SyncError::Conflict) => pass.report.deferred += 1,
                        Err(error) => return Err(error),
                    }
                } else {
                    let entry = state.projects.get_mut(&id).expect("known");
                    entry.files.clear();
                    fs::create_dir_all(root.join(&entry.dir))?;
                    pass.sync_files(&id, entry, &project.files)?;
                }
            }
            None if here => {
                // Gone from the server. Unchanged here: it goes to the trash here too. Changed
                // here: it is let go of, and step 3 uploads it again as a new project.
                let dir = root.join(&base.dir);
                let local = scan(&dir)?;
                let unchanged = local.len() == base.files.len()
                    && local.iter().all(|(rel, file)| {
                        base.files.get(rel).is_some_and(|known| {
                            local_hash(Some(known), file).ok().as_deref()
                                == Some(known.sha256.as_str())
                        })
                    });
                state.projects.remove(&id);
                if unchanged {
                    move_to_local_trash(root, &dir)?;
                    pass.report.deleted_here += 1;
                }
            }
            None => {
                state.projects.remove(&id);
            }
        }
    }

    // 2. Projects new on the server.
    let mut claimed: HashSet<String> = state
        .projects
        .values()
        .map(|project| project.dir.to_lowercase())
        .collect();
    for project in &manifest.projects {
        if settled.contains(&project.id) {
            continue;
        }
        let dir = free_dir_name(root, &project.dir_name, &claimed, &dirs);
        claimed.insert(dir.to_lowercase());
        fs::create_dir_all(root.join(&dir))?;
        state.projects.insert(
            project.id.clone(),
            ProjectBase {
                dir,
                files: BTreeMap::new(),
            },
        );
        let entry = state.projects.get_mut(&project.id).expect("inserted");
        pass.sync_files(&project.id, entry, &project.files)?;
    }

    // 3. Folders new here.
    for dir in &dirs {
        if claimed.contains(&dir.to_lowercase()) || !root.join(dir).is_dir() {
            continue;
        }
        let id = server.create_project(dir)?;
        pass.report.projects_created += 1;
        claimed.insert(dir.to_lowercase());
        state.projects.insert(
            id.clone(),
            ProjectBase {
                dir: dir.clone(),
                files: BTreeMap::new(),
            },
        );
        let entry = state.projects.get_mut(&id).expect("inserted");
        pass.sync_files(&id, entry, &[])?;
    }

    Ok(pass.report)
}

/// The server's folder name, unless another synced project already has it here: then ` (2)` and
/// on. A folder of that name that no project has yet is *adopted* (its files are merged).
fn free_dir_name(
    root: &Path,
    wanted: &str,
    claimed: &HashSet<String>,
    existing: &BTreeSet<String>,
) -> String {
    let _ = existing;
    if !claimed.contains(&wanted.to_lowercase()) {
        return wanted.to_owned();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{wanted} ({n})");
        if !claimed.contains(&candidate.to_lowercase()) && !root.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

impl Pass<'_> {
    fn sync_files(
        &mut self,
        project_id: &str,
        base: &mut ProjectBase,
        remote_files: &[SyncFile],
    ) -> Result<(), SyncError> {
        let dir = self.root.join(&base.dir);
        let local = scan(&dir)?;
        let remote: BTreeMap<&str, &SyncFile> = remote_files
            .iter()
            .map(|file| (file.rel_path.as_str(), file))
            .collect();
        let mut paths: BTreeSet<String> = local.keys().cloned().collect();
        paths.extend(remote.keys().map(|rel| (*rel).to_owned()));
        paths.extend(base.files.keys().cloned());

        for rel in paths {
            let known = base.files.get(&rel).cloned();
            let here = local.get(&rel);
            let l_hash = match here {
                Some(file) => Some(local_hash(known.as_ref(), file)?),
                None => None,
            };
            let there = remote.get(rel.as_str()).copied();
            let r_hash = there.map(|file| file.sha256.clone());
            let b_hash = known.as_ref().map(|file| file.sha256.clone());

            if l_hash == r_hash {
                match (there, here) {
                    (Some(there), Some(here)) => {
                        base.files.insert(rel, agreed(there, here));
                    }
                    _ => {
                        base.files.remove(&rel);
                    }
                }
                continue;
            }
            let changed_here = l_hash != b_hash;
            let changed_there = r_hash != b_hash;
            let outcome = match (changed_here, changed_there, here, there) {
                // Up: an edit or a new file.
                (true, false, Some(file), _) => {
                    self.upload(project_id, &rel, r_hash.as_deref(), file, base)
                }
                // Up: a deletion.
                (true, false, None, Some(there)) => {
                    match self
                        .server
                        .trash_file(&there.id, base_of_hash(Some(&there.sha256)))
                    {
                        Ok(()) => {
                            base.files.remove(&rel);
                            self.report.deleted_there += 1;
                            Ok(())
                        }
                        Err(error) => Err(error),
                    }
                }
                // Down: an edit or a new file, or a deleted file coming back because it was
                // edited on the server.
                (false, true, _, Some(there)) | (true, true, None, Some(there)) => {
                    self.download(&dir, &rel, there, here, base)
                }
                // Down: a deletion.
                (false, true, Some(file), None) => {
                    move_to_local_trash(self.root, &file.abs)?;
                    base.files.remove(&rel);
                    self.report.deleted_here += 1;
                    Ok(())
                }
                // A file deleted on the server but edited here: the edit wins and goes back up.
                (true, true, Some(file), None) => self.upload(project_id, &rel, None, file, base),
                // Both edited: keep both.
                (true, true, Some(file), Some(there)) => {
                    self.keep_both(project_id, &dir, &rel, file, there, base)
                }
                _ => Ok(()),
            };
            match outcome {
                Ok(()) => {}
                Err(SyncError::Conflict) => self.report.deferred += 1,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn upload(
        &mut self,
        project_id: &str,
        rel: &str,
        server_hash: Option<&str>,
        file: &LocalFile,
        base: &mut ProjectBase,
    ) -> Result<(), SyncError> {
        let synced = self.server.put_file(
            project_id,
            rel,
            base_of_hash(server_hash),
            &file.abs,
            file.size,
        )?;
        // The file may have changed while it was uploading: the base takes the stat from before
        // the upload, so a later edit still differs from it and goes up on the next pass.
        base.files.insert(
            rel.to_owned(),
            FileBase {
                id: synced.id,
                sha256: synced.sha256,
                size: file.size,
                mtime_ms: file.mtime_ms,
            },
        );
        self.report.uploaded += 1;
        Ok(())
    }

    fn download(
        &mut self,
        dir: &Path,
        rel: &str,
        there: &SyncFile,
        here: Option<&LocalFile>,
        base: &mut ProjectBase,
    ) -> Result<(), SyncError> {
        let target = join_rel(dir, rel);
        let parent = target
            .parent()
            .ok_or_else(|| AppError::internal("the file has no folder"))?;
        fs::create_dir_all(parent)?;
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let partial = parent.join(format!(".{name}.{}.spm-download", spm_core::new_id()));
        if let Err(error) = self.server.download(&there.id, &partial) {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        // Somebody may have saved over the file while it was downloading: then this pass leaves
        // it alone and the next one sees both sides changed.
        let still = match (here, fs::metadata(&target)) {
            (Some(file), Ok(metadata)) => {
                metadata.len() == file.size && mtime_ms(&metadata) == file.mtime_ms
            }
            (None, Err(_)) => true,
            _ => false,
        };
        if !still {
            let _ = fs::remove_file(&partial);
            return Ok(());
        }
        let downloaded = file_content_hash(&partial).map(|hash| to_hex(&hash));
        if downloaded.as_deref().ok() != Some(there.sha256.as_str()) {
            // The server changed it between the manifest and the download: next pass.
            let _ = fs::remove_file(&partial);
            return Err(SyncError::Conflict);
        }
        fs::rename(&partial, &target)?;
        let metadata = fs::metadata(&target)?;
        base.files.insert(
            rel.to_owned(),
            FileBase {
                id: there.id.clone(),
                sha256: there.sha256.clone(),
                size: metadata.len(),
                mtime_ms: mtime_ms(&metadata),
            },
        );
        self.report.downloaded += 1;
        Ok(())
    }

    fn keep_both(
        &mut self,
        project_id: &str,
        dir: &Path,
        rel: &str,
        file: &LocalFile,
        there: &SyncFile,
        base: &mut ProjectBase,
    ) -> Result<(), SyncError> {
        let copy_rel = conflict_rel_path(dir, rel, &self.host);
        let copy = join_rel(dir, &copy_rel);
        fs::rename(&file.abs, &copy)?;
        self.report.conflicts += 1;
        // The server's version takes the name...
        self.download(dir, rel, there, None, base)?;
        // ...and this computer's goes up as a file of its own.
        let metadata = fs::metadata(&copy)?;
        let moved = LocalFile {
            abs: copy,
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
        };
        self.upload(project_id, &copy_rel, None, &moved, base)
    }
}

fn agreed(there: &SyncFile, here: &LocalFile) -> FileBase {
    FileBase {
        id: there.id.clone(),
        sha256: there.sha256.clone(),
        size: here.size,
        mtime_ms: here.mtime_ms,
    }
}

// ---- the worker ---------------------------------------------------------------------------------

/// Where the worker is, for the settings page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub root: String,
    pub phase: SyncPhase,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    Starting,
    Syncing,
    Idle,
    WaitingForSignIn,
    Error,
}

#[derive(Default)]
struct Wake {
    kicked: bool,
    stopped: bool,
}

struct Shared {
    root: PathBuf,
    status: Mutex<SyncStatus>,
    state: Mutex<SyncState>,
    wake: Mutex<Wake>,
    signal: Condvar,
}

impl Shared {
    fn set_status(&self, change: impl FnOnce(&mut SyncStatus)) {
        change(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

/// A running sync of one folder with one server. Dropping it stops the worker after the pass it is
/// in, if any.
pub struct SyncEngine {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
    watch: Option<LibraryWatch>,
}

impl SyncEngine {
    /// Starts syncing `root` (created if need be) with `server`. `on_changed` is called after a
    /// pass that changed anything, on the worker's thread.
    pub fn start(
        server: Arc<dyn SyncServer>,
        root: PathBuf,
        poll: Duration,
        on_changed: Arc<dyn Fn() + Send + Sync>,
    ) -> std::io::Result<SyncEngine> {
        fs::create_dir_all(&root)?;
        let shared = Arc::new(Shared {
            status: Mutex::new(SyncStatus {
                root: root.display().to_string(),
                phase: SyncPhase::Starting,
                last_synced_at: None,
                last_error: None,
            }),
            state: Mutex::new(SyncState::load(&root)),
            root,
            wake: Mutex::new(Wake {
                kicked: true,
                stopped: false,
            }),
            signal: Condvar::new(),
        });
        let watched = Arc::clone(&shared);
        let watch = match LibraryWatch::start(&shared.root, move || kick(&watched)) {
            Ok(watch) => Some(watch),
            Err(error) => {
                diag::warn(&format!(
                    "the sync folder {} is not watched ({error}); changes there are picked up \
                     every {} seconds",
                    shared.root.display(),
                    poll.as_secs()
                ));
                None
            }
        };
        let worker = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("spm-library-sync".to_owned())
            .spawn(move || run(worker, server, poll, on_changed))?;
        Ok(SyncEngine {
            shared,
            thread: Some(thread),
            watch,
        })
    }

    pub fn root(&self) -> &Path {
        &self.shared.root
    }

    /// Runs a pass as soon as the worker is free.
    pub fn kick(&self) {
        kick(&self.shared);
    }

    pub fn status(&self) -> SyncStatus {
        self.shared
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Where a server file is on this computer, if it has been synced and is there.
    pub fn local_path_of(&self, file_id: &str) -> Option<PathBuf> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .local_path_of(&self.shared.root, file_id)
            .filter(|path| path.is_file())
    }

    /// The local folder of a server project, if it has been synced and is there.
    pub fn local_dir_of(&self, project_id: &str) -> Option<PathBuf> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .local_dir_of(&self.shared.root, project_id)
            .filter(|path| path.is_dir())
    }
}

fn kick(shared: &Shared) {
    shared.wake.lock().unwrap_or_else(|e| e.into_inner()).kicked = true;
    shared.signal.notify_all();
}

impl Drop for SyncEngine {
    fn drop(&mut self) {
        drop(self.watch.take());
        self.shared
            .wake
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stopped = true;
        self.shared.signal.notify_all();
        if let Some(thread) = self.thread.take()
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

fn run(
    shared: Arc<Shared>,
    server: Arc<dyn SyncServer>,
    poll: Duration,
    on_changed: Arc<dyn Fn() + Send + Sync>,
) {
    let mut waiting_for_session = false;
    loop {
        {
            let wait = if waiting_for_session {
                SIGN_IN_POLL.min(poll)
            } else {
                poll
            };
            let wake = shared.wake.lock().unwrap_or_else(|e| e.into_inner());
            let (mut wake, _) = shared
                .signal
                .wait_timeout_while(wake, wait, |wake| !wake.kicked && !wake.stopped)
                .unwrap_or_else(|e| e.into_inner());
            if wake.stopped {
                return;
            }
            wake.kicked = false;
        }
        if !server.has_session() {
            waiting_for_session = true;
            shared.set_status(|status| status.phase = SyncPhase::WaitingForSignIn);
            continue;
        }
        waiting_for_session = false;
        shared.set_status(|status| status.phase = SyncPhase::Syncing);
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let result = sync_once(server.as_ref(), &shared.root, &mut state);
        if let Err(error) = state.save(&shared.root) {
            diag::warn(&format!("could not save the sync state: {error}"));
        }
        *shared.state.lock().unwrap_or_else(|e| e.into_inner()) = state;
        match result {
            Ok(report) => {
                shared.set_status(|status| {
                    status.phase = SyncPhase::Idle;
                    status.last_synced_at = Some(spm_core::clock::now_ms());
                    status.last_error = None;
                });
                if report.changed_anything() {
                    on_changed();
                }
                if report.deferred > 0 {
                    // Something changed on the server under this pass: look again soon.
                    kick(&shared);
                }
            }
            Err(SyncError::Unauthorized) => {
                waiting_for_session = true;
                shared.set_status(|status| status.phase = SyncPhase::WaitingForSignIn);
            }
            Err(error) => {
                let message = error.message();
                diag::warn(&format!("the library sync failed: {message}"));
                shared.set_status(|status| {
                    status.phase = SyncPhase::Error;
                    status.last_error = Some(message);
                });
                // Whatever a pass did before failing may have changed what the page shows.
                on_changed();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conflict_copy_is_named_after_this_computer_and_never_taken() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            conflict_rel_path(dir.path(), "parts/arm.stl", "PC"),
            "parts/arm (conflict from PC).stl"
        );
        fs::write(dir.path().join("notes (conflict from PC)"), b"").unwrap();
        assert_eq!(
            conflict_rel_path(dir.path(), "notes", "PC"),
            "notes (conflict from PC) (2)"
        );
    }

    #[test]
    fn the_scan_skips_dot_entries_and_temporaries_and_walks_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("parts")).unwrap();
        fs::create_dir_all(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("a.stl"), b"a").unwrap();
        fs::write(dir.path().join("parts").join("b.stl"), b"b").unwrap();
        fs::write(dir.path().join("c.stl.part"), b"c").unwrap();
        fs::write(dir.path().join(".hidden").join("d.stl"), b"d").unwrap();
        let found: Vec<String> = scan(dir.path()).unwrap().into_keys().collect();
        assert_eq!(found, ["a.stl", "parts/b.stl"]);
    }
}
