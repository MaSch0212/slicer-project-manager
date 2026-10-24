use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use spm_core::db::migrate::{SCHEMA_VERSION, run_migrations};
use spm_core::db::{BUSY_TIMEOUT_MS, DB_FILE, Library, OpenOptions, SPM_DIR};
use spm_core::files::classify::CLASSIFIER_VERSION;
use spm_core::new_id;
use spm_core::testing::TempLibrary;

const TABLES: [&str; 9] = [
    "users",
    "activation_tokens",
    "sessions",
    "projects",
    "tags",
    "project_tags",
    "files",
    "previews",
    "user_settings",
];

const INSERT_USER: &str =
    "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
     VALUES (?, ?, ?, ?, 0, 'active', 0)";
const INSERT_PROJECT: &str =
    "INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0)";

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

#[test]
fn open_library_creates_spm_app_db_and_previews() {
    let lib = TempLibrary::new();
    assert!(lib.dir().join(".spm").join("app.db").exists());
    assert!(lib.dir().join(".spm").join("previews").is_dir());
    assert_eq!((SPM_DIR, DB_FILE), (".spm", "app.db"));
}

#[test]
fn migrations_create_every_table_and_set_user_version() {
    let lib = TempLibrary::new();
    let conn = lib.db();
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for table in TABLES {
        assert!(
            names.iter().any(|name| name == table),
            "missing table {table}"
        );
    }
    assert_eq!(user_version(&conn), 3);
    assert_eq!(SCHEMA_VERSION, 3);
}

#[test]
fn run_migrations_is_idempotent() {
    let lib = TempLibrary::new();
    let conn = lib.db();
    assert_eq!(run_migrations(&conn).unwrap(), 3);
    assert_eq!(run_migrations(&conn).unwrap(), 3);
}

/// Migration 003 backfills a sentinel *below* the shipping classifier version, and that is the
/// mechanism: every row that predates it must read `classified_by = 0`, or a classifier bump finds
/// nothing stale. The second assertion is the other half: the sentinel is strictly below the
/// shipping classifier version, so every pre-existing row reads as stale. It is not pinned to
/// today's value, so it survives a bump (the classifier snapshot test is the one built to break).
#[test]
fn migration_003_marks_every_pre_existing_row_as_predating_the_classifier() {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(dir.path().join("v2.db")).unwrap();
    // A database as an older build left it: schema 001 + 002, user_version 2, rows already in it.
    conn.execute_batch(include_str!("../../src/db/migrations/001_init.sql"))
        .unwrap();
    conn.execute_batch(include_str!(
        "../../src/db/migrations/002_preview_claim.sql"
    ))
    .unwrap();
    conn.execute_batch("PRAGMA user_version = 2").unwrap();
    conn.execute(INSERT_USER, params!["u", "marc", "Marc", "marc"])
        .unwrap();
    conn.execute(INSERT_PROJECT, params!["p", "u", "Benchy", "Benchy"])
        .unwrap();
    conn.execute_batch(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms)
         VALUES ('f1', 'p', 'part.step', 'other', 10, 0), ('f2', 'p', 'benchy.stl', 'model', 10, 0)",
    )
    .unwrap();

    assert_eq!(run_migrations(&conn).unwrap(), 3);

    let marks: Vec<i64> = conn
        .prepare("SELECT classified_by FROM files ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(marks, [0, 0]);
    assert!(marks.iter().all(|&mark| mark < CLASSIFIER_VERSION));
}

#[test]
fn usernames_are_unique_case_insensitively() {
    let lib = TempLibrary::new();
    let conn = lib.db();
    conn.execute(INSERT_USER, params![new_id(), "Marc", "Marc", "marc"])
        .unwrap();
    assert!(
        conn.execute(
            INSERT_USER,
            params![new_id(), "marc", "Marc again", "marc2"]
        )
        .is_err()
    );
}

#[test]
fn deleting_a_user_cascades_to_projects_files_and_previews() {
    let lib = TempLibrary::new();
    let conn = lib.db();
    let (user, project, file) = (new_id(), new_id(), new_id());
    conn.execute(INSERT_USER, params![user, "marc", "Marc", "marc"])
        .unwrap();
    conn.execute(INSERT_PROJECT, params![project, user, "Benchy", "Benchy"])
        .unwrap();
    conn.execute(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms)
         VALUES (?, ?, 'benchy.stl', 'model', 10, 0)",
        params![file, project],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', 0)",
        params![file],
    )
    .unwrap();

    conn.execute("DELETE FROM users WHERE id = ?", params![user])
        .unwrap();

    for table in ["projects", "files", "previews"] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} was not cascaded");
    }
}

#[test]
fn a_project_folder_name_is_unique_per_owner() {
    let lib = TempLibrary::new();
    let conn = lib.db();
    let user = new_id();
    conn.execute(INSERT_USER, params![user, "marc", "Marc", "marc"])
        .unwrap();
    conn.execute(INSERT_PROJECT, params![new_id(), user, "Benchy", "Benchy"])
        .unwrap();
    assert!(
        conn.execute(
            INSERT_PROJECT,
            params![new_id(), user, "Benchy again", "Benchy"]
        )
        .is_err()
    );
}

// SPM is a multi-process design over one library file: the server, the desktop app and the
// import all open the same `app.db`. SQLite's default `busy_timeout` is 0, zero retries, so the
// first moment two of them write at once one dies outright with "database is locked". These two
// tests pin the retry behaviour that makes concurrent access work at all.
#[test]
fn open_library_sets_a_non_zero_busy_timeout() {
    let lib = TempLibrary::new();
    let timeout: i64 = lib
        .db()
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(timeout, i64::try_from(BUSY_TIMEOUT_MS).unwrap());
    const { assert!(BUSY_TIMEOUT_MS > 0) };
}

#[test]
fn a_write_contending_with_another_connection_retries_instead_of_failing_instantly() {
    let dir = tempfile::tempdir().unwrap();
    // 300ms rather than the 5s default purely so the test is quick; the behaviour under test,
    // that SQLite waits and retries at all, is identical at either value.
    let lib = Library::open(
        dir.path(),
        OpenOptions {
            busy_timeout_ms: Some(300),
            ..Default::default()
        },
    )
    .unwrap();
    // Stands in for the running server holding a write lock. It never releases it, so the
    // contending write below must still fail in the end: what changes is *when*, instantly (the
    // bug) versus after exhausting the retry budget (the fix).
    let other = Connection::open(dir.path().join(".spm").join("app.db")).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();

    let started = Instant::now();
    let result = lib.db().execute_batch("CREATE TABLE contended (x)");
    let elapsed = started.elapsed();

    assert!(
        result.is_err(),
        "a permanently held lock must still surface as an error"
    );
    assert!(
        elapsed >= Duration::from_millis(250),
        "gave up after {elapsed:?}; expected it to retry for ~300ms"
    );
}
