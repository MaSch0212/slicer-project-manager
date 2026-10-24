use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::Connection;

use super::migrate::run_migrations;
use crate::error::Result;
use crate::log::Logger;

pub const SPM_DIR: &str = ".spm";
pub const PREVIEWS_DIR: &str = "previews";
pub const DB_FILE: &str = "app.db";

/// How long a write waits for a lock another connection holds before giving up.
///
/// One library file is opened by several processes at once by design: the server, the desktop app
/// and the CuraManager import. SQLite's default `busy_timeout` is **0**, a contended write fails
/// immediately with no retry at all, so the very first overlap between, say, the server's preview
/// tick and a long-running import would kill one of them with "database is locked". Every write is
/// its own short statement (milliseconds), so a lock is never held anywhere near this long; a wait
/// that actually reaches five seconds means something is genuinely wedged and an error is right.
///
/// This only works because nothing opens an explicit deferred transaction that later upgrades to a
/// write: `busy_timeout` cannot resolve a lock-upgrade deadlock between two of those, only plain
/// contention.
pub const BUSY_TIMEOUT_MS: u64 = 5000;

#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    /// Defaults to [`BUSY_TIMEOUT_MS`].
    pub busy_timeout_ms: Option<u64>,
    /// Defaults to silence: opening a library must not print anything the host did not ask for.
    pub logger: Option<Logger>,
}

struct Inner {
    dir: PathBuf,
    conn: Mutex<Connection>,
    log: Logger,
}

/// An open library: its folder, its database and its logger. **The handle every use case takes.**
///
/// It is cheap to clone (a reference count) and `Send + Sync`, so the HTTP layer keeps one in its
/// shared state and a Tauri app keeps one in managed state. The database connection sits behind a
/// mutex: SQLite serialises writers anyway, every statement here is milliseconds, and a single
/// connection keeps `PRAGMA` state, prepared-statement caching and "read your own write" simple.
/// Code that does something slow (hash a password, stream a file, rasterise a mesh) must do it
/// **without** holding the guard from [`Library::db`]; the use cases in core take the lock for
/// their own queries only.
///
/// The synchronous API is deliberate: callers on an async runtime wrap a use case in
/// `spawn_blocking`.
#[derive(Clone)]
pub struct Library {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Library {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Library")
            .field("dir", &self.inner.dir)
            .finish_non_exhaustive()
    }
}

impl Library {
    /// Opens (creating if needed) the library at `library_dir`, migrating its database to the
    /// current schema. The database lives inside the library (`.spm/app.db`) so the folder is
    /// wholly self-describing.
    pub fn open(library_dir: impl AsRef<Path>, options: OpenOptions) -> Result<Library> {
        let dir = std::path::absolute(library_dir.as_ref())?;
        fs::create_dir_all(dir.join(SPM_DIR).join(PREVIEWS_DIR))?;
        let conn = Connection::open(dir.join(SPM_DIR).join(DB_FILE))?;
        // Both are per-connection, so they must be set on every connection, not once per file:
        // ON DELETE CASCADE in the schema is inert without foreign_keys, and a connection that
        // skipped busy_timeout would still die instantly on the first contended write.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_millis(
            options.busy_timeout_ms.unwrap_or(BUSY_TIMEOUT_MS),
        ))?;
        run_migrations(&conn)?;
        Ok(Library {
            inner: Arc::new(Inner {
                dir,
                conn: Mutex::new(conn),
                log: options.logger.unwrap_or_else(Logger::noop),
            }),
        })
    }

    /// The absolute path of the library folder.
    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    pub fn log(&self) -> &Logger {
        &self.inner.log
    }

    /// The database connection, locked for as long as the guard lives. Keep it short, and never
    /// call another use case while holding it (they lock too).
    ///
    /// A panic in another thread while it held the guard does not poison the library: the
    /// connection is still sound (SQLite rolls an unfinished transaction back), so the guard is
    /// handed out regardless.
    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.inner
            .conn
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// `<library>/.spm`.
    pub fn spm_dir(&self) -> PathBuf {
        self.inner.dir.join(SPM_DIR)
    }
}
