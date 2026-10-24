//! Test support, behind the `testing` feature so no release build carries it. The other crates'
//! integration tests use it too (`spm-core = { features = ["testing"] }` in their dev-dependencies).

use std::fs;
use std::ops::Deref;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use tempfile::TempDir;

use crate::ctx::Ctx;
use crate::db::ids::new_id;
use crate::db::{Library, OpenOptions};
use crate::log::{LogLevelSetting, LogRecord, Logger};

/// A library in a fresh temporary directory, removed when this is dropped.
pub struct TempLibrary {
    lib: Library,
    dir: TempDir,
}

impl Deref for TempLibrary {
    type Target = Library;

    fn deref(&self) -> &Library {
        &self.lib
    }
}

impl TempLibrary {
    pub fn new() -> TempLibrary {
        TempLibrary::with_options(OpenOptions::default())
    }

    pub fn with_options(options: OpenOptions) -> TempLibrary {
        let dir = tempfile::Builder::new()
            .prefix("spm-test-")
            .tempdir()
            .expect("a temp dir");
        let lib =
            Library::open(dir.path(), options).expect("a library opens in an empty directory");
        TempLibrary { lib, dir }
    }

    /// A library whose logger records everything at `trace`, for asserting on what core logs.
    pub fn logged() -> (TempLibrary, LogCapture) {
        let capture = LogCapture::default();
        let library = TempLibrary::with_options(OpenOptions {
            logger: Some(capture.logger(LogLevelSetting::Trace)),
            ..OpenOptions::default()
        });
        (library, capture)
    }

    /// The temporary directory the library lives in (also `lib.dir()`).
    pub fn path(&self) -> &std::path::Path {
        self.dir.path()
    }
}

impl Default for TempLibrary {
    fn default() -> Self {
        TempLibrary::new()
    }
}

/// Collects the records a logger emits.
#[derive(Clone, Default)]
pub struct LogCapture {
    records: Arc<Mutex<Vec<LogRecord>>>,
}

impl LogCapture {
    pub fn logger(&self, level: LogLevelSetting) -> Logger {
        let records = Arc::clone(&self.records);
        Logger::with_sink(
            level,
            Arc::new(move |record| {
                records
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(record.clone());
            }),
        )
    }

    pub fn records(&self) -> Vec<LogRecord> {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn clear(&self) {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    /// The first record with exactly this message.
    pub fn find(&self, message: &str) -> Option<LogRecord> {
        self.records()
            .into_iter()
            .find(|record| record.message == message)
    }
}

/// What [`seed_user_row`] inserts.
#[derive(Debug, Clone)]
pub struct SeedUser<'a> {
    pub username: &'a str,
    pub is_admin: bool,
    pub status: &'a str,
}

impl Default for SeedUser<'_> {
    fn default() -> Self {
        SeedUser {
            username: "marc",
            is_admin: false,
            status: "active",
        }
    }
}

/// Inserts a bare user row (no password, no folder) and returns its id.
pub fn seed_user_row(lib: &Library, user: &SeedUser<'_>) -> String {
    let id = new_id();
    lib.db()
        .execute(
            "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0)",
            params![id, user.username, user.username, user.username, user.is_admin, user.status],
        )
        .expect("a user row inserts");
    id
}

/// An active, non-admin user with a folder in the library, as a `Ctx`.
pub fn seed_user(lib: &Library, username: &str) -> Ctx {
    let user_id = seed_user_row(
        lib,
        &SeedUser {
            username,
            ..SeedUser::default()
        },
    );
    fs::create_dir_all(lib.dir().join(username)).expect("the user folder is created");
    Ctx {
        user_id,
        is_admin: false,
    }
}
