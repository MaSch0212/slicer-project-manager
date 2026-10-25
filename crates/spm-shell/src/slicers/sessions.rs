//! What became of the files this app handed to slicers: the watch, the comparison, the sweeps and
//! the reconcile (spec D 6.3 and 7.2 to 7.4).
//!
//! # The one rule everything here is arranged around
//!
//! **Nothing is deleted that the app has not compared and the user has not seen** (constraint 10).
//! This is also the lifetime rule for the stripped copy a new project is started from: it is a
//! temporary file in a launch directory under the app's data directory, never stored in the project,
//! and **it must not be deleted while the slicer may still have it open**. There is no dependable
//! "slicer closed" signal and no sweep can manufacture one: with `single_instance` on, the process
//! this app spawned hands the file over and exits while the slicer stays open, so an exit is a
//! reason to start watching a clock and never a conclusion. Two rules replace the tempting third:
//!
//! 1. **Only the user's answer, or an observed-and-settled exit, removes a file.** The exit sweep
//!    may delete only a file that is *still byte-identical to what this app itself wrote there*
//!    after a settle period, so what it deletes is a copy whose every byte the app can reproduce
//!    and the user loses nothing even when the slicer really was still open. **The sweep at next
//!    start surfaces and deletes nothing that holds a file.**
//! 2. **A file with no record is an unfinished session, not litter.** Whatever the app deletes, the
//!    next Ctrl+S can put back complete at the same path (measured), so a file found here with
//!    nothing to explain it is offered to the user rather than swept.
//!
//! And `launch.json` outlives the file it describes, gaining a `sweptAt`, for
//! [`SWEPT_RECORD_TTL_MS`]: a file recreated at that path then lands beside a record naming its
//! project, its source file and its slicer.
//!
//! # The watch is an optimisation; the comparison is the mechanism of record
//!
//! The directory watch and the poll do exactly one thing that matters: they make the answer
//! *ready*. What decides whether anything came back is [`entry_hash`] over the decompressed
//! entries, and [`SlicerSessions::list`] recomputes it from disk every time. A missed watch event
//! therefore costs promptness and never correctness. **The poll is not redundant with the watch**
//! and must not be removed as such: it is the mechanism of record's scheduler, and the watch is the
//! thing that makes it feel instant. mtime is used in exactly one place, deciding whether a poll
//! tick should bother hashing, and never as an answer.
//!
//! # Two modes, one loop
//!
//! A launch directory holds a real local file whichever mode the library is in. Only the *ends*
//! differ: remote mode downloaded the file through the proxy (see [`crate::slicers::launch`]), and
//! an import pushes it back the same way instead of calling core. Both are streamed process-side;
//! the bytes never round-trip through the window.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use spm_core::dto::{EntryDiff, FileDto, FileState, SlicerId, SlicerLaunchMode, SlicerSessionDto};
use spm_core::files::classify::classify_file;
use spm_core::files::entry_hash::{diff_digests, entry_digests, entry_hash};
use spm_core::files::zip::reads_as_zip;
use spm_core::{AppError, content_type_for, get_project, upload_file};

use super::host::now_ms;
use super::launch::{
    LAUNCH_RECORD_NAME, LaunchedSession, SlicerLaunchRecord, library_key_of, same_library,
};
use super::remote_files::{RemoteLibrary, remote_project, remote_upload, require_remote};
use super::sched::{
    DirectoryWatcher, NotifyWatcher, Scheduler, ThreadScheduler, TimerId, WatchHandle,
};
use crate::diag;
use crate::json_store::write_json_file;
use crate::library::DesktopSession;

// ---------------------------------------------------------------------------------------------
// The numbers, and which of them are measurements
// ---------------------------------------------------------------------------------------------

/// How long a `launch.json` outlives the file it describes. **A judgement, not a measurement.**
/// What it buys: a file recreated at the launch path (which the next Ctrl+S will do) lands beside
/// something that still says which project and which source file it came from. What it costs: a
/// few hundred bytes per launch.
pub const SWEPT_RECORD_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// How long a file may go on being unreadable before the app says so rather than waiting. **The
/// scale is Cura's non-atomic write**: measured at 0 bytes and an exclusive lock for at least six
/// seconds. Sixty seconds is an order of magnitude past the only measurement there is, which is the
/// right side to err on: the cost of waiting too long is a stale label, and the cost of giving up
/// too early is reporting a live save as a broken file.
pub const SETTLE_WINDOW_MS: i64 = 60_000;

/// How often the settle loop re-reads a file that is mid-write.
pub const SETTLE_INTERVAL_MS: u64 = 500;

/// How long after the spawned process exits the exit sweep waits before comparing. **A judgement
/// chosen against Cura's six-second lock.** Even at the end of it the comparison is not proof the
/// slicer has finished: rule 1 above is what actually makes the deletion safe.
pub const EXIT_SETTLE_MS: u64 = 10_000;

/// The low-frequency poll, while a session is live. Deliberately slow: it is a backstop.
pub const POLL_INTERVAL_MS: u64 = 5_000;

/// How long after a watch event the first comparison runs. A slicer writing an archive produces a
/// burst of events, and comparing on the first of them is guaranteed to read a partial file.
pub const WATCH_DEBOUNCE_MS: u64 = 400;

/// Every ZIP begins with these two bytes.
const ZIP_MAGIC: [u8; 2] = [0x50, 0x4b];

type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub struct SlicerSessionsOptions {
    /// `<data>/slicer-sessions`. May not exist; nothing here creates it.
    pub sessions_dir: PathBuf,
    /// The library open **right now**, resolved per call, exactly as the launcher resolves it.
    pub session: Arc<dyn Fn() -> Option<DesktopSession> + Send + Sync>,
    /// Whether the shell is pointed at a server rather than at a folder.
    pub is_remote: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The server, for the remote import and for [`library_key_of`]. `None` in local mode.
    pub remote: Arc<dyn Fn() -> Option<Arc<dyn RemoteLibrary>> + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub watcher: Arc<dyn DirectoryWatcher>,
    pub scheduler: Arc<dyn Scheduler>,
    pub settle_window_ms: i64,
    pub settle_interval_ms: u64,
    pub exit_settle_ms: u64,
    pub poll_interval_ms: u64,
    pub watch_debounce_ms: u64,
    /// Where the lifecycle's own words go (stderr by default).
    pub log: Log,
}

impl SlicerSessionsOptions {
    /// The real clock, timers and directory watch.
    pub fn new(
        sessions_dir: PathBuf,
        session: Arc<dyn Fn() -> Option<DesktopSession> + Send + Sync>,
        is_remote: Arc<dyn Fn() -> bool + Send + Sync>,
        remote: Arc<dyn Fn() -> Option<Arc<dyn RemoteLibrary>> + Send + Sync>,
    ) -> SlicerSessionsOptions {
        SlicerSessionsOptions {
            sessions_dir,
            session,
            is_remote,
            remote,
            now: Arc::new(now_ms),
            watcher: Arc::new(NotifyWatcher),
            scheduler: Arc::new(ThreadScheduler::new()),
            settle_window_ms: SETTLE_WINDOW_MS,
            settle_interval_ms: SETTLE_INTERVAL_MS,
            exit_settle_ms: EXIT_SETTLE_MS,
            poll_interval_ms: POLL_INTERVAL_MS,
            watch_debounce_ms: WATCH_DEBOUNCE_MS,
            log: Arc::new(diag::warn),
        }
    }
}

/// A session as the enumerator found it: the DTO plus the two things the DTO deliberately does not
/// carry (where the file is, and the record beside it).
///
/// **The path never crosses the transport boundary and is never accepted across it either.**
/// `resolve` looks its argument up in a freshly enumerated list rather than joining it onto the
/// sessions directory, so the only paths this module ever touches are ones it found itself
/// (constraint 4). There is no traversal to defend against because there is no arithmetic.
struct Session {
    dto: SlicerSessionDto,
    path: PathBuf,
    directory: PathBuf,
    record: Option<SlicerLaunchRecord>,
    /// Whether this session was launched from a library that is not the one open now.
    /// `slicer-sessions/` is per-*machine* while every id in a record is per-*library*: without
    /// this a folder switch listed every library the app had ever launched from, indistinguishably.
    /// Always false for an orphan and for a record written before the field existed: "cannot
    /// tell" is not "belongs to somebody else".
    foreign: bool,
}

/// What a read of the file on disk found.
enum Probe {
    Gone,
    Settling { why: String },
    Ready { hash: String, size_bytes: i64 },
}

struct Tracked {
    path: PathBuf,
    launched_hash: String,
    /// Whether the process this app spawned is still running. Never "the slicer is open".
    alive: bool,
    watcher: Option<Box<dyn WatchHandle>>,
    poll: Option<TimerId>,
    pending: Option<TimerId>,
    /// The last (mtime, size) a poll saw: the mtime *hint*, and nothing more.
    last_seen: Option<(u128, u64)>,
}

struct HashedOnce {
    key: String,
    hash: String,
}

pub struct SlicerSessions {
    options: SlicerSessionsOptions,
    me: Weak<SlicerSessions>,
    /// Live launches, by launch id. Empty at start-up: a previous run's sessions are not tracked.
    tracked: Mutex<HashMap<String, Tracked>>,
    /// When each path was first seen unreadable, which is what makes the settle window a *window*.
    /// It lives here rather than in `tracked` on purpose: an untracked session (one from a previous
    /// run, or an orphan) settles on exactly the same clock, driven by nothing more than the user
    /// looking at the list. Cleared the moment a read succeeds, so a file that goes unreadable
    /// twice gets a fresh window each time.
    unsettled_since: Mutex<HashMap<PathBuf, i64>>,
    /// The last hash computed for each path, against the (mtime, size) it had then.
    ///
    /// **`list()` is the hot path, and it re-hashed everything on every project page visit.** What
    /// it skips now is recomputing a hash for bytes whose modification time and size are both
    /// unchanged since the last read, the same use of mtime the poll makes. What it can miss, said
    /// rather than implied: a write that changes content while preserving mtime *and* size.
    /// Nothing measured does that (the four in-place savers either skip the write entirely when
    /// nothing is dirty, or write and move mtime), and the cost is bounded: the next write that
    /// does move mtime re-hashes. Invalidated by a mismatch and by a sweep.
    hashes: Mutex<HashMap<PathBuf, HashedOnce>>,
    comparisons: AtomicU64,
    hashed: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl SlicerSessions {
    pub fn new(options: SlicerSessionsOptions) -> Arc<SlicerSessions> {
        Arc::new_cyclic(|me| SlicerSessions {
            options,
            me: me.clone(),
            tracked: Mutex::new(HashMap::new()),
            unsettled_since: Mutex::new(HashMap::new()),
            hashes: Mutex::new(HashMap::new()),
            comparisons: AtomicU64::new(0),
            hashed: AtomicU64::new(0),
        })
    }

    fn now(&self) -> i64 {
        (self.options.now)()
    }

    // -----------------------------------------------------------------------------------------
    // Listing
    // -----------------------------------------------------------------------------------------

    /// Every session under `slicer-sessions/`, compared afresh: the mechanism of record. It reads
    /// the directory, re-hashes every file it finds (unless unchanged since the last read) and
    /// builds the answer from what is there. It consults the watch for exactly one field,
    /// `processAlive`, which is the one fact only the spawner can know.
    pub fn list(&self) -> Vec<SlicerSessionDto> {
        let all = self.scan();
        let total = all.len();
        let mine: Vec<SlicerSessionDto> = all
            .into_iter()
            .filter(|session| !session.foreign)
            .map(|session| session.dto)
            .collect();
        let foreign = total - mine.len();
        if foreign > 0 {
            // Not an error and not hidden work: they belong to a library that is not open, and
            // opening it brings them straight back. Said in the log because a count that silently
            // drops is the shape this exists to remove.
            (self.options.log)(&format!(
                "{foreign} slicer session(s) belong to a library that is not open, and are not listed"
            ));
        }
        mine
    }

    /// The sweep at next start: **it surfaces, and it deletes nothing that holds a file.**
    ///
    /// The two things it does remove are, by inspection, incapable of losing anything. A directory
    /// that is completely empty was a `mkdir` a crash interrupted before the copy. A `launch.json`
    /// whose file this app itself swept, more than [`SWEPT_RECORD_TTL_MS`] ago, is a memory whose
    /// file was byte-identical to what the app wrote when it went. **It never touches a directory
    /// that holds a file, however old.**
    ///
    /// **It counts by enumeration and deliberately does not call `list()`**: that re-hashes every
    /// file, and a remote `.stl` launch copies the mesh into a launch directory. Nothing above
    /// needs the answer; the count is a readdir.
    pub fn sweep_at_start(&self) -> usize {
        let dir = &self.options.sessions_dir;
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            let directory = entry.path();
            let Ok(contents) = std::fs::read_dir(&directory) else {
                continue;
            };
            let names: Vec<String> = contents
                .flatten()
                .map(|child| child.file_name().to_string_lossy().into_owned())
                .collect();
            if names.is_empty() {
                let _ = std::fs::remove_dir_all(&directory);
                continue;
            }
            if names.len() != 1 || names[0] != LAUNCH_RECORD_NAME {
                continue;
            }
            let Some(record) = self.read_record(&directory.join(LAUNCH_RECORD_NAME)) else {
                continue;
            };
            let since = record.swept_at.unwrap_or(record.started_at);
            if self.now() - since > SWEPT_RECORD_TTL_MS {
                let _ = std::fs::remove_dir_all(&directory);
            }
        }
        let surfaced = self.count_surfaced();
        if surfaced > 0 {
            (self.options.log)(&format!(
                "{surfaced} slicer session(s) are waiting to be answered; nothing was deleted"
            ));
        }
        surfaced
    }

    /// How many sessions `list()` would produce, without reading a byte of any of them. It walks
    /// the same two shapes `scan` does: a session is one file that is not a `launch.json`,
    /// wherever it sits.
    fn count_surfaced(&self) -> usize {
        let Ok(entries) = std::fs::read_dir(&self.options.sessions_dir) else {
            return 0;
        };
        let mut count = 0;
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() {
                count += 1;
            } else if kind.is_dir()
                && let Ok(children) = std::fs::read_dir(entry.path())
            {
                count += children
                    .flatten()
                    .filter(|child| {
                        child.file_type().is_ok_and(|kind| kind.is_file())
                            && child.file_name() != LAUNCH_RECORD_NAME
                    })
                    .count();
            }
        }
        count
    }

    // -----------------------------------------------------------------------------------------
    // Answering a session
    // -----------------------------------------------------------------------------------------

    /// The user's answer, which is the only thing besides an observed-and-settled exit that
    /// removes a file from a launch directory.
    ///
    /// `import` adds the file to a project as a **new** file and then sweeps it; `discard` sweeps
    /// it without adding it. Nothing here substitutes: the returning file lands under a derived
    /// non-clashing name, and deleting the original is a separate action with a control that
    /// already exists. A cross-slicer round trip is lossy, so replacing the original would destroy
    /// the only copy of something the user may not have meant to convert.
    ///
    /// A file that is still settling, or that has been unreadable for the whole window, is refused
    /// rather than imported: uploading half a write is the exact failure the settle window exists
    /// to prevent.
    pub fn resolve(
        &self,
        launch_id: &str,
        action: SessionAction,
        project_id: Option<&str>,
    ) -> Result<Option<FileDto>, AppError> {
        let session = self.require(launch_id)?;
        if action == SessionAction::Discard {
            self.sweep(&session);
            return Ok(None);
        }
        if !matches!(
            session.dto.file_state,
            FileState::Changed | FileState::Unchanged
        ) {
            let settling = session.dto.file_state == FileState::Settling;
            return Err(AppError::conflict(if settling {
                "that file is still being written; try again in a moment"
            } else {
                "that file could not be read, so there is nothing to add to the library"
            })
            .with_details(details("fileState", state_name(session.dto.file_state))));
        }
        // The record's project when there is one, and the user's answer only for a file with
        // nothing beside it to say where it belongs.
        let project_id = if session.dto.project_id.is_empty() {
            project_id.unwrap_or("")
        } else {
            session.dto.project_id.as_str()
        };
        if project_id.is_empty() {
            return Err(AppError::validation(
                "say which project this file belongs to",
            ));
        }
        let added = self.import(&session, project_id)?;
        // Only now. A sweep before the upload is a file destroyed on a failed upload, and this
        // order is the same reasoning that makes the reconcile add-then-delete.
        self.sweep(&session);
        Ok(Some(added))
    }

    /// The bulk answer, over the stale ones. A session that has already gone is not a failure.
    ///
    /// **One enumeration for the whole list, and not one per id**: `scan()` hashes every file, the
    /// command permits 500 ids, and discarding fifty stale sessions was fifty full enumerations.
    /// Scanning once is equivalent because a sweep only ever *removes* a session.
    pub fn discard_many(&self, launch_ids: &[String]) -> usize {
        let wanted: HashSet<&str> = launch_ids.iter().map(String::as_str).collect();
        // `!foreign` for the same reason `require` refuses one: a session belonging to a library
        // that is not open is not this window's to answer, and a bulk action is the last place to
        // make an exception to that.
        let found: Vec<Session> = self
            .scan()
            .into_iter()
            .filter(|session| wanted.contains(session.dto.launch_id.as_str()) && !session.foreign)
            .collect();
        for session in &found {
            self.sweep(session);
        }
        found.len()
    }

    // -----------------------------------------------------------------------------------------
    // The watch
    // -----------------------------------------------------------------------------------------

    /// Starts watching a launch this process just made.
    ///
    /// Everything it starts is an optimisation, so every failure in here is logged and swallowed:
    /// a directory that has already gone, a filesystem the watch is unsupported on, an error long
    /// after it was created. None of those is a reason to fail a launch that has already happened,
    /// and none costs correctness, because `list()` reads the disk.
    pub fn track(&self, launch: LaunchedSession) {
        let launch_id = launch.launch_id.clone();
        self.untrack(&launch_id);
        let me = self.me.clone();
        let watcher = {
            let me = me.clone();
            let launch_id = launch_id.clone();
            match self.options.watcher.watch(
                &launch.directory,
                Arc::new(move || {
                    if let Some(sessions) = me.upgrade() {
                        sessions.on_changed(&launch_id);
                    }
                }),
            ) {
                Ok(handle) => Some(handle),
                Err(error) => {
                    (self.options.log)(&format!(
                        "could not watch a slicer launch directory: {error}"
                    ));
                    None
                }
            }
        };
        let poll = {
            let me = me.clone();
            let launch_id = launch_id.clone();
            self.options.scheduler.every(
                self.options.poll_interval_ms,
                Arc::new(move || {
                    if let Some(sessions) = me.upgrade() {
                        sessions.on_poll(&launch_id);
                    }
                }),
            )
        };
        lock(&self.tracked).insert(
            launch_id.clone(),
            Tracked {
                path: launch.path,
                launched_hash: launch.launched_hash,
                alive: true,
                watcher,
                poll: Some(poll),
                pending: None,
                last_seen: None,
            },
        );
        // The exit is an observation, not a conclusion: it starts a settle period, and what the
        // sweep at the end of it may delete is bounded by `exit_sweep`.
        if let Some(exit) = launch.exit {
            exit.on_exit(Box::new(move || {
                if let Some(sessions) = me.upgrade() {
                    sessions.on_exit(&launch_id);
                }
            }));
        }
    }

    /// Stops every watcher and timer. Called when the shell is going away.
    pub fn close(&self) {
        let ids: Vec<String> = lock(&self.tracked).keys().cloned().collect();
        for id in ids {
            self.untrack(&id);
        }
    }

    /// How many launches are being watched right now.
    pub fn tracked_count(&self) -> usize {
        lock(&self.tracked).len()
    }

    /// How many comparisons the watch and the poll have run between them. It exists because the
    /// mtime hint has no other observable consequence: a poll tick that decides not to hash
    /// produces exactly the same `list()` as one that hashes and finds nothing. `list()` does not
    /// touch this.
    pub fn comparison_count(&self) -> u64 {
        self.comparisons.load(Ordering::Relaxed)
    }

    /// How many times a file has actually been hashed rather than answered from the memo.
    pub fn hash_count(&self) -> u64 {
        self.hashed.load(Ordering::Relaxed)
    }

    fn on_changed(&self, launch_id: &str) {
        let delay = self.options.watch_debounce_ms;
        {
            let mut tracked = lock(&self.tracked);
            let Some(entry) = tracked.get_mut(launch_id) else {
                return;
            };
            if entry.pending.is_some() {
                return;
            }
            let me = self.me.clone();
            let id = launch_id.to_owned();
            entry.pending = Some(self.options.scheduler.after(
                delay,
                Box::new(move || {
                    if let Some(sessions) = me.upgrade() {
                        if let Some(entry) = lock(&sessions.tracked).get_mut(&id) {
                            entry.pending = None;
                        }
                        sessions.settle_step(&id);
                    }
                }),
            ));
        }
    }

    /// One comparison, and another one scheduled if the file is still being written. The loop
    /// terminates by itself: `state_of` turns a read that has been failing for the whole settle
    /// window into `unreadable`, which is not `settling`, so the last tick is the one that gives
    /// up. Nothing here records the result (`list()` recomputes it): this exists to spend the
    /// window, so that by the time anybody asks the answer is not "wait".
    fn settle_step(&self, launch_id: &str) {
        let (path, launched_hash) = {
            let tracked = lock(&self.tracked);
            let Some(entry) = tracked.get(launch_id) else {
                return;
            };
            (entry.path.clone(), entry.launched_hash.clone())
        };
        self.comparisons.fetch_add(1, Ordering::Relaxed);
        let state = self.state_of(&path, Some(&launched_hash));
        if state != FileState::Settling {
            return;
        }
        let mut tracked = lock(&self.tracked);
        let Some(entry) = tracked.get_mut(launch_id) else {
            return;
        };
        if entry.pending.is_some() {
            return;
        }
        let me = self.me.clone();
        let id = launch_id.to_owned();
        entry.pending = Some(self.options.scheduler.after(
            self.options.settle_interval_ms,
            Box::new(move || {
                if let Some(sessions) = me.upgrade() {
                    if let Some(entry) = lock(&sessions.tracked).get_mut(&id) {
                        entry.pending = None;
                    }
                    sessions.settle_step(&id);
                }
            }),
        ));
    }

    /// The poll, and the one place mtime is consulted. It is a **hint about whether to bother
    /// hashing**, never an answer: a tick that sees the same (mtime, size) as the last one does
    /// nothing, and a tick that sees a difference runs the real comparison.
    fn on_poll(&self, launch_id: &str) {
        let path = {
            let tracked = lock(&self.tracked);
            match tracked.get(launch_id) {
                Some(entry) => entry.path.clone(),
                None => return,
            }
        };
        // Gone, or momentarily unreadable. Either way there is nothing to compare this tick.
        let Ok(metadata) = std::fs::metadata(&path) else {
            return;
        };
        let seen = (mtime_nanos(&metadata), metadata.len());
        {
            let mut tracked = lock(&self.tracked);
            let Some(entry) = tracked.get_mut(launch_id) else {
                return;
            };
            let last = entry.last_seen.replace(seen);
            if last == Some(seen) {
                return;
            }
        }
        self.settle_step(launch_id);
    }

    fn on_exit(&self, launch_id: &str) {
        {
            let mut tracked = lock(&self.tracked);
            let Some(entry) = tracked.get_mut(launch_id) else {
                return;
            };
            entry.alive = false;
        }
        let me = self.me.clone();
        let id = launch_id.to_owned();
        self.options.scheduler.after(
            self.options.exit_settle_ms,
            Box::new(move || {
                if let Some(sessions) = me.upgrade() {
                    sessions.exit_sweep(&id);
                }
            }),
        );
    }

    /// The exit sweep: the one deletion the user did not ask for, and the narrowest one available.
    ///
    /// It removes the file **only** when the file is still byte-identical to what this app wrote
    /// there, after the settle period. That is not a proof the slicer has finished, and it is not
    /// meant to be: it is a guarantee that what is being deleted is a copy the app can reproduce,
    /// so the user loses nothing if the slicer is in fact still open. A file that came back
    /// changed, one still being written, and one that could not be read are all left exactly where
    /// they are, to be answered by a person. The record stays and gains a `sweptAt`.
    fn exit_sweep(&self, launch_id: &str) {
        let (path, launched_hash) = {
            let tracked = lock(&self.tracked);
            let Some(entry) = tracked.get(launch_id) else {
                return;
            };
            (entry.path.clone(), entry.launched_hash.clone())
        };
        if self.state_of(&path, Some(&launched_hash)) != FileState::Unchanged {
            return;
        }
        let session = self
            .scan()
            .into_iter()
            .find(|candidate| candidate.dto.launch_id == launch_id);
        if let Some(session) = session {
            self.sweep(&session);
        }
    }

    fn untrack(&self, launch_id: &str) {
        let removed = lock(&self.tracked).remove(launch_id);
        let Some(entry) = removed else {
            return;
        };
        drop(entry.watcher);
        if let Some(poll) = entry.poll {
            self.options.scheduler.cancel(poll);
        }
        if let Some(pending) = entry.pending {
            self.options.scheduler.cancel(pending);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Enumeration
    // -----------------------------------------------------------------------------------------

    /// Every session there is, built from the directory as it is right now.
    ///
    /// Two shapes reach here. A **directory** is one launch: its `launch.json` names the file that
    /// was handed over, and that file is the session. A **loose file** directly under
    /// `slicer-sessions/` has no launch it could belong to and is an orphan on its own. And the
    /// third case: a file inside a launch directory that is neither `launch.json` nor the file that
    /// was launched. It is **reported, not adopted**, never mistaken for the file the record
    /// describes. The commonest way to produce one is a Cura Save-As aimed at the launch directory
    /// under a name of the user's choosing; another is anything a slicer writes at a relative path,
    /// since the launch directory is the child's working directory. Only a *loose* one: a relative
    /// write into a subdirectory is invisible to this scan.
    fn scan(&self) -> Vec<Session> {
        let sessions_dir = &self.options.sessions_dir;
        let Ok(entries) = std::fs::read_dir(sessions_dir) else {
            return Vec::new();
        };
        // Once per enumeration, not once per session: it resolves a path and reads two accessors.
        let session = (self.options.session)();
        let remote = (self.options.remote)();
        let library = library_key_of(
            (self.options.is_remote)(),
            session.as_ref(),
            remote.as_deref().map(RemoteLibrary::origin),
        );
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        let mut sessions = Vec::new();
        for entry in entries {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_file() {
                sessions.push(self.orphan(&name, sessions_dir, &name, None, library.as_deref()));
                continue;
            }
            if !kind.is_dir() {
                continue;
            }
            let directory = entry.path();
            let record = self.read_record(&directory.join(LAUNCH_RECORD_NAME));
            let Ok(children) = std::fs::read_dir(&directory) else {
                continue;
            };
            let mut files: Vec<String> = children
                .flatten()
                .filter(|child| child.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|child| child.file_name().to_string_lossy().into_owned())
                .filter(|child| child != LAUNCH_RECORD_NAME)
                .collect();
            files.sort();
            for file in files {
                match &record {
                    Some(record) if file == record.file_name => {
                        sessions.push(self.launched(&name, &directory, record, library.as_deref()));
                    }
                    _ => {
                        if record.is_some() {
                            (self.options.log)(&format!(
                                "{name} holds \"{file}\", which is not the file it was launched with; it is listed as a session of its own rather than adopted"
                            ));
                        }
                        sessions.push(self.orphan(
                            &format!("{name}/{file}"),
                            &directory,
                            &file,
                            record.as_ref(),
                            library.as_deref(),
                        ));
                    }
                }
            }
        }
        sessions
    }

    /// The file a `launch.json` describes: everything the DTO can carry is known for this one.
    fn launched(
        &self,
        launch_id: &str,
        directory: &Path,
        record: &SlicerLaunchRecord,
        library: Option<&str>,
    ) -> Session {
        let path = directory.join(&record.file_name);
        let (file_state, size_bytes) = self.inspect(&path, Some(&record.launched_hash));
        let settled = matches!(file_state, FileState::Unchanged | FileState::Changed);
        let returned = settled.then(|| classify_file(&path).slicer);
        let source_slicer = record.source_slicer;
        let returned_as = match (file_state, returned) {
            (FileState::Changed, Some(returned)) if returned != source_slicer => Some(returned),
            _ => None,
        };
        let entry_diff = if file_state == FileState::Changed {
            record
                .launched_entries
                .as_ref()
                .and_then(|launched| diff_of(launched, &path))
        } else {
            None
        };
        let dto = SlicerSessionDto {
            launch_id: launch_id.to_owned(),
            project_id: record.project_id.clone(),
            file_id: record.file_id.clone(),
            file_name: record.file_name.clone(),
            slicer_id: Some(record.slicer_id),
            started_at: record.started_at,
            process_alive: lock(&self.tracked)
                .get(launch_id)
                .is_some_and(|entry| entry.alive),
            file_state,
            is_orphan: false,
            source_slicer: Some(source_slicer),
            returned_as,
            source_size_bytes: record.source_size_bytes,
            // From the same read the state came from, rather than a second `stat`: a file that
            // vanished between the two would otherwise take every other session down with it.
            returned_size_bytes: size_bytes,
            entry_diff,
        };
        Session {
            dto,
            path,
            directory: directory.to_path_buf(),
            record: Some(record.clone()),
            foreign: !same_library(record.library.as_deref(), library),
        }
    }

    /// A file with no record of its own.
    ///
    /// `record` is the record of the launch whose directory it turned up in, when there is one: a
    /// Cura Save-As under a different name knows which project it came from even though it is not
    /// the file that was launched. `is_orphan` stays true either way, because what makes it an
    /// orphan is having no record *of its own*.
    ///
    /// **But only when that record belongs to the library that is open.** A `projectId` is
    /// per-library, and inheriting one from a *foreign* record is the exact bug the library key was
    /// added to remove: the row would arrive pre-answered with another library's project and Import
    /// would resolve another library's id against this one. Blanked to `''` instead, which makes
    /// the row a question the user can answer.
    ///
    /// `slicer_id` is the file's own classification and the one place this DTO can be `None`: an
    /// `.stl` that came back names no slicer at all. Dropping it from the list instead is what
    /// sweep rule 2 forbids.
    fn orphan(
        &self,
        launch_id: &str,
        directory: &Path,
        name: &str,
        record: Option<&SlicerLaunchRecord>,
        library: Option<&str>,
    ) -> Session {
        let inherited = record.filter(|record| same_library(record.library.as_deref(), library));
        let path = directory.join(name);
        let (file_state, returned_size_bytes) = self.inspect(&path, None);
        // When it appeared, which is the only "started" an orphan has. On the same terms as the
        // project: a foreign record's launch time would age this row against a clock belonging to
        // another library.
        let started_at = match inherited {
            Some(record) => record.started_at,
            None => std::fs::metadata(&path)
                .map(|metadata| (mtime_nanos(&metadata) / 1_000_000) as i64)
                .unwrap_or(0),
        };
        let dto = SlicerSessionDto {
            launch_id: launch_id.to_owned(),
            project_id: inherited.map_or_else(String::new, |record| record.project_id.clone()),
            file_id: String::new(),
            file_name: name.to_owned(),
            slicer_id: matches!(file_state, FileState::Unchanged | FileState::Changed)
                .then(|| classify_file(&path).slicer)
                .flatten(),
            started_at,
            process_alive: false,
            file_state,
            is_orphan: true,
            source_slicer: None,
            returned_as: None,
            source_size_bytes: None,
            returned_size_bytes,
            entry_diff: None,
        };
        // Never foreign: a file nothing can explain is exactly what sweep rule 2 says must always
        // be offered to somebody, whosever directory it turned up in.
        Session {
            dto,
            path,
            directory: directory.to_path_buf(),
            record: record.cloned(),
            foreign: false,
        }
    }

    fn require(&self, launch_id: &str) -> Result<Session, AppError> {
        let session = self
            .scan()
            .into_iter()
            .find(|candidate| candidate.dto.launch_id == launch_id)
            .ok_or_else(|| {
                AppError::not_found("no such slicer session")
                    .with_details(details("launchId", launch_id))
            })?;
        // Named rather than answered `NotFound`: the session is there, it simply is not this
        // library's, and "that file came from a different library" is something a person can act
        // on where "no such session" would send them looking for a bug.
        if session.foreign {
            return Err(AppError::conflict(
                "that file was launched from a different library; open that library again to answer it",
            )
            .with_details(details("launchId", launch_id)));
        }
        Ok(session)
    }

    // -----------------------------------------------------------------------------------------
    // The comparison
    // -----------------------------------------------------------------------------------------

    /// What the file at `path` is, against the hash of what was launched. The settle window lives
    /// here rather than in the watch, so a session nothing is tracking (one left by a previous run,
    /// an orphan) ages on exactly the same clock, driven by nothing more than somebody looking at
    /// the list. `launched_hash` is `None` for an orphan, which has nothing to be compared against:
    /// `changed` is the honest answer, since something is there and the app did not put it there.
    fn state_of(&self, path: &Path, launched_hash: Option<&str>) -> FileState {
        self.inspect(path, launched_hash).0
    }

    /// The same answer, with the size the read already found. `None` unless it settled.
    fn inspect(&self, path: &Path, launched_hash: Option<&str>) -> (FileState, Option<i64>) {
        match self.probe(path) {
            Probe::Settling { why } => {
                let since = *lock(&self.unsettled_since)
                    .entry(path.to_path_buf())
                    .or_insert_with(|| self.now());
                if self.now() - since < self.options.settle_window_ms {
                    return (FileState::Settling, None);
                }
                (self.options.log)(&format!(
                    "gave up reading {} after the settle window: {why}",
                    path.file_name()
                        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
                ));
                (FileState::Unreadable, None)
            }
            // A file that vanished under the enumerator. Nothing can be said about it, and it will
            // be absent from the next list.
            Probe::Gone => {
                lock(&self.unsettled_since).remove(path);
                (FileState::Unreadable, None)
            }
            Probe::Ready { hash, size_bytes } => {
                lock(&self.unsettled_since).remove(path);
                let state = match launched_hash {
                    None => FileState::Changed,
                    Some(launched) if launched == hash => FileState::Unchanged,
                    Some(_) => FileState::Changed,
                };
                (state, Some(size_bytes))
            }
        }
    }

    /// One read of the file, and the three ways it can mean "not settled yet".
    ///
    /// - **0 bytes.** Cura's write was measured sitting at exactly this for at least six seconds.
    /// - **A read that fails.** `EBUSY` and `EACCES` while another process holds the file, and an
    ///   archive whose central directory parses but whose payload does not: `entry_hash` fails for
    ///   the last of those rather than inventing a hash, which is what makes it usable here.
    /// - **A file whose first bytes say ZIP and whose central directory does not parse.** This one
    ///   is the trap: `entry_hash` falls back to a plain SHA-256 of the bytes when a file is not a
    ///   readable ZIP, which is exactly right for an `.stl` and exactly wrong for a `.3mf` a slicer
    ///   is halfway through writing.
    ///
    /// The ZIP question is asked only of a file whose first two bytes claim to be one, so an `.stl`
    /// and an `.obj` take the plain-hash path and never settle for ever. The bytes and not the
    /// extension, because the extension is the user's and the magic is the writer's.
    fn probe(&self, path: &Path) -> Probe {
        let Ok(metadata) = std::fs::metadata(path) else {
            return Probe::Gone;
        };
        if !metadata.is_file() {
            return Probe::Gone;
        }
        let size = metadata.len();
        if size == 0 {
            return Probe::Settling {
                why: "the file is still empty".to_owned(),
            };
        }
        let size_bytes = i64::try_from(size).unwrap_or(i64::MAX);
        let key = format!("{}:{size}", mtime_nanos(&metadata));
        if let Some(cached) = lock(&self.hashes).get(path)
            && cached.key == key
        {
            return Probe::Ready {
                hash: cached.hash.clone(),
                size_bytes,
            };
        }
        match looks_like_zip(path) {
            Ok(true) if !reads_as_zip(path) => {
                return Probe::Settling {
                    why: "the archive directory does not parse yet".to_owned(),
                };
            }
            Ok(_) => {}
            Err(error) => {
                return Probe::Settling {
                    why: error.to_string(),
                };
            }
        }
        self.hashed.fetch_add(1, Ordering::Relaxed);
        match entry_hash(path) {
            Ok(hash) => {
                lock(&self.hashes).insert(
                    path.to_path_buf(),
                    HashedOnce {
                        key,
                        hash: hash.clone(),
                    },
                );
                Probe::Ready { hash, size_bytes }
            }
            // Not cached: a read that failed says nothing about what the bytes will be once it
            // succeeds.
            Err(error) => Probe::Settling { why: error.message },
        }
    }

    // -----------------------------------------------------------------------------------------
    // Import and sweep
    // -----------------------------------------------------------------------------------------

    /// Adds the returning file to a project, under a derived name that does not clash.
    ///
    /// Two implementations of one operation, because in remote mode the bytes are already
    /// process-side and must not detour through the window: locally this is core's own
    /// `upload_file`, and remotely it is a proxied `POST /api/projects/:id/files`. Both stream off
    /// disk, and both land on the same core use case with the same quota check.
    fn import(&self, session: &Session, project_id: &str) -> Result<FileDto, AppError> {
        let mut taken = self.names_in(project_id)?;
        let size_bytes = std::fs::metadata(&session.path)
            .map_err(AppError::internal)?
            .len();
        let slicer = self.slicer_for(session);
        let mut name = derived_name(&session.dto.file_name, slicer, &taken)?;
        // The probe above is not atomic with the write, and the upload's own `Conflict` is the
        // backstop that makes that safe: nothing is written when it fires, so the answer is to
        // take the next ordinal and try again. Bounded, because a `Conflict` that is *not* about
        // the name would otherwise be an infinite loop.
        let mut attempt = 0;
        loop {
            match self.upload(project_id, &name, &session.path, size_bytes) {
                Ok(added) => return Ok(added),
                Err(error) if attempt < 8 && error.code == spm_core::AppErrorCode::Conflict => {
                    attempt += 1;
                    taken.insert(name);
                    name = derived_name(&session.dto.file_name, slicer, &taken)?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Which slicer the derived name is attributed to: **the returning file's, not the record's**.
    /// A round trip can change what a file *is*: a Bambu project opened in Orca and saved comes
    /// back classified `orca`, and calling the result `bracket (bambu).3mf` because that is what
    /// the record says would put the wrong product's name on it. The record's own slicer is the
    /// fallback for a file whose classification names nothing at all (a stripped project, a mesh);
    /// an orphan has no record and falls through to no suffix.
    fn slicer_for(&self, session: &Session) -> Option<SlicerId> {
        classify_file(&session.path)
            .slicer
            .or_else(|| session.record.as_ref().map(|record| record.slicer_id))
    }

    fn names_in(&self, project_id: &str) -> Result<HashSet<String>, AppError> {
        if (self.options.is_remote)() {
            let remote = require_remote((self.options.remote)())?;
            return Ok(remote_project(&*remote, project_id)?
                .into_iter()
                .map(|file| file.name)
                .collect());
        }
        let session = self.require_library()?;
        Ok(get_project(&session.lib, &session.ctx, project_id)?
            .files
            .into_iter()
            .map(|file| file.name)
            .collect())
    }

    fn upload(
        &self,
        project_id: &str,
        name: &str,
        path: &Path,
        size_bytes: u64,
    ) -> Result<FileDto, AppError> {
        if (self.options.is_remote)() {
            let remote = require_remote((self.options.remote)())?;
            let value = remote_upload(
                &*remote,
                project_id,
                name,
                path,
                size_bytes,
                content_type_for(name),
            )?;
            return serde_json::from_value(value)
                .map_err(|_| AppError::internal("that server did not answer with a file"));
        }
        let session = self.require_library()?;
        let file = File::open(path).map_err(AppError::internal)?;
        let core = upload_file(
            &session.lib,
            &session.ctx,
            project_id,
            name,
            i64::try_from(size_bytes).unwrap_or(i64::MAX),
            file,
        )?;
        Ok(spm_http::decorate::decorate_file(&core))
    }

    /// Removes the file, and keeps the record that explains it.
    ///
    /// The record gaining a `sweptAt` rather than going with the file is the whole of the "a
    /// recreated file lands beside a record" rule: four of five slicers save back in place, so the
    /// next Ctrl+S puts a complete file at exactly this path, and what it finds beside it decides
    /// whether the app can say which project it belongs to or has to ask. An orphan has no record
    /// to keep, so the directory it was in is removed once it holds nothing, which cannot lose
    /// anything.
    fn sweep(&self, session: &Session) {
        let _ = std::fs::remove_file(&session.path);
        lock(&self.unsettled_since).remove(&session.path);
        // Hygiene first, and correctness only in a case nothing can provoke: the path is gone, so
        // its entry can never be hit again by that file, and without this the map grows by one
        // entry per swept launch for the life of the process.
        lock(&self.hashes).remove(&session.path);
        self.untrack(&session.dto.launch_id);
        if let Some(record) = &session.record
            && !session.dto.is_orphan
        {
            let swept = SlicerLaunchRecord {
                swept_at: Some(self.now()),
                ..record.clone()
            };
            if let Ok(value) = serde_json::to_value(&swept)
                && let Err(error) =
                    write_json_file(&session.directory.join(LAUNCH_RECORD_NAME), &value)
            {
                (self.options.log)(&format!("could not update a launch record: {error}"));
            }
            return;
        }
        if session.directory == self.options.sessions_dir {
            return;
        }
        let empty =
            std::fs::read_dir(&session.directory).is_ok_and(|mut entries| entries.next().is_none());
        if empty {
            let _ = std::fs::remove_dir_all(&session.directory);
        }
    }

    fn require_library(&self) -> Result<DesktopSession, AppError> {
        (self.options.session)().ok_or_else(|| AppError::conflict("no library folder is open"))
    }

    /// The record beside a launched file, or `None` where there is none this build can read.
    fn read_record(&self, path: &Path) -> Option<SlicerLaunchRecord> {
        read_record_with(path, &*self.options.log)
    }
}

/// What a session's answer is: add the file to a project, or throw it away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAction {
    Import,
    Discard,
}

fn state_name(state: FileState) -> &'static str {
    match state {
        FileState::Unchanged => "unchanged",
        FileState::Changed => "changed",
        FileState::Settling => "settling",
        FileState::Unreadable => "unreadable",
    }
}

fn details(key: &str, value: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(key.to_owned(), Value::from(value));
    map
}

fn mtime_nanos(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos())
}

/// Whether the first two bytes are `PK`. An `Err` is what `probe` treats as "not settled yet".
fn looks_like_zip(path: &Path) -> std::io::Result<bool> {
    let mut head = [0u8; 2];
    let mut file = File::open(path)?;
    let mut read = 0;
    while read < head.len() {
        match file.read(&mut head[read..])? {
            0 => break,
            n => read += n,
        }
    }
    Ok(read == head.len() && head == ZIP_MAGIC)
}

/// The record beside a launched file, or `None`. A record that is absent, or half-written by a
/// crash, makes the files beside it orphans, which is the safe reading: an orphan is offered to the
/// user and never swept.
///
/// Only the fields the reconcile cannot work without are required. Everything added after the
/// first version is optional on read, because a record written by a build that did not have it is
/// still a record this one understands: the session shows less, never something wrong. This file
/// lives in the app's own data directory and the threat model is a person hand-editing it, not an
/// attacker, so those fields pass through unvalidated, except `library`, where a wrong *type* is
/// dropped to "cannot tell".
pub fn read_record_with(path: &Path, log: &dyn Fn(&str)) -> Option<SlicerLaunchRecord> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    let text_of = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(launch_id), Some(project_id), Some(file_id), Some(file_name), Some(launched_hash)) = (
        text_of("launchId"),
        text_of("projectId"),
        text_of("fileId"),
        text_of("fileName"),
        text_of("launchedHash"),
    ) else {
        log(&format!(
            "{} is not a launch record this build can read",
            path.display()
        ));
        return None;
    };
    let started_at = object.get("startedAt").and_then(Value::as_f64);
    let slicer_id = object
        .get("slicerId")
        .and_then(Value::as_str)
        .and_then(SlicerId::parse);
    let (Some(started_at), Some(slicer_id)) = (started_at, slicer_id) else {
        log(&format!(
            "{} is not a launch record this build can read",
            path.display()
        ));
        return None;
    };
    let library = match object.get("library") {
        None | Some(Value::Null) => None,
        Some(Value::String(library)) => Some(library.clone()),
        Some(_) => {
            log(&format!(
                "ignoring a non-string library in {}",
                path.display()
            ));
            None
        }
    };
    Some(SlicerLaunchRecord {
        launch_id,
        mode: match object.get("mode").and_then(Value::as_str) {
            Some("as-is") => SlicerLaunchMode::AsIs,
            _ => SlicerLaunchMode::NewProject,
        },
        project_id,
        file_id,
        slicer_id,
        install_id: text_of("installId").unwrap_or_default(),
        file_name,
        launched_hash,
        started_at: started_at as i64,
        library,
        source_slicer: object
            .get("sourceSlicer")
            .and_then(Value::as_str)
            .and_then(SlicerId::parse),
        source_size_bytes: object.get("sourceSizeBytes").and_then(Value::as_i64),
        launched_entries: object
            .get("launchedEntries")
            .and_then(Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|(name, digest)| Some((name.clone(), digest.as_str()?.to_owned())))
                    .collect()
            }),
        swept_at: object.get("sweptAt").and_then(Value::as_i64),
    })
}

/// The entry-level diff between the file as launched and the file as it is now.
///
/// It is computed against the digests in the record rather than against the library original,
/// because those are two different questions and only one of them is the user's. A `new-project`
/// launch hands over a *stripped* copy, so a diff against the original would report the app's own
/// strip as something the slicer did: every removed configuration entry attributed to the wrong
/// actor, in a list the user is about to make a decision from.
fn diff_of(
    launched: &std::collections::BTreeMap<String, String>,
    path: &Path,
) -> Option<EntryDiff> {
    let now = entry_digests(path).ok()?;
    let diff = diff_digests(launched, &now);
    Some(EntryDiff {
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
    })
}

/// `bracket.3mf` from Orca becomes `bracket (orca).3mf`, then `bracket (orca) (2).3mf`.
///
/// **Derived and non-clashing, never a substitution**: a cross-slicer round trip is measurably
/// lossy, so replacing the original would destroy the only copy of something the user may not have
/// meant to convert. The ordinal starts at 2 and counts up, which is what makes a *second* round
/// trip through the same slicer work. The extension is preserved rather than assumed.
pub fn derived_name(
    file_name: &str,
    slicer_id: Option<SlicerId>,
    taken: &HashSet<String>,
) -> Result<String, AppError> {
    let (stem, extension) = match file_name.rfind('.') {
        Some(at) if at > 0 => (&file_name[..at], &file_name[at..]),
        _ => (file_name, ""),
    };
    let base = match slicer_id {
        None => stem.to_owned(),
        Some(slicer_id) => format!("{stem} ({})", slicer_id.as_str()),
    };
    for ordinal in 1..1000 {
        let candidate = if ordinal == 1 {
            format!("{base}{extension}")
        } else {
            format!("{base} ({ordinal}){extension}")
        };
        if taken.contains(&candidate) {
            continue;
        }
        if spm_core::validate::file_name(&candidate).is_err() {
            return Err(AppError::validation(format!(
                "{candidate} is not a name this library can hold"
            )));
        }
        return Ok(candidate);
    }
    Err(AppError::conflict(format!(
        "there are already too many files called \"{base}\""
    )))
}
