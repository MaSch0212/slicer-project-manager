//! Data compatibility (migration spec 3.5): a library created by the legacy Deno app opens as-is.
//!
//! The database below is built the way the legacy app built it: the three migration files applied
//! in order and `PRAGMA user_version = 3`, then rows in the shapes legacy code wrote. The password
//! hashes and token hashes are **vectors computed by an independent implementation** (Node's
//! `crypto.pbkdf2Sync` and `createHash`, with the legacy NFKC normalisation), not by this crate,
//! so a verify that passes proves the algorithm and parameters agree, not merely that Rust agrees
//! with itself.

use std::fs;
use std::path::Path;

use rusqlite::{Connection, params};
use spm_core::auth::activation::check_activation_token;
use spm_core::auth::password::PW_ITERATIONS;
use spm_core::auth::sessions::resolve_session;
use spm_core::dto::{DEFAULT_SETTINGS, Theme, UserStatus};
use spm_core::{AppErrorCode, Ctx, Library, OpenOptions, activate_account, get_settings, login};

use crate::common::code_of;

/// PBKDF2-HMAC-SHA256("a good long password", salt = 01..10, 600000 iterations).
const STRONG_HASH: &str = "47f836b70358ca7d739dbdd931082f56d693a0eb4c7ca48487d2b99cc61a7eb9";
/// PBKDF2-HMAC-SHA256("correct horse", salt = 01..10, 1000 iterations): a hash from before the
/// iteration count was raised.
const WEAK_HASH: &str = "63029f34cae71cb733eb39646121c236d84c994566464a6566dc4274066057c3";
/// PBKDF2-HMAC-SHA256(NFKC("p\u{e4}ssw\u{f6}rd \u{fb01}nal \u{2460}"), salt = 01..10, 600000).
/// The NFKC form is "p\u{e4}ssw\u{f6}rd final 1": the ligature and the circled digit fold.
const UNICODE_HASH: &str = "2d5a373b62b60d43ab0852be8a2c14156b7970288653fc9fce9e3062c35488a8";
/// SHA-256("abc"): the stored form of a session whose raw token is `abc`.
const SESSION_TOKEN_HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
/// SHA-256("legacy-invite-token"): the stored form of a pending user's invite.
const INVITE_TOKEN_HASH: &str = "3641e8d8a8a97e4cc9ec32932a53203139bf824be0d0935178d1b087f3ab2da4";

const SALT: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn insert_user(
    conn: &Connection,
    id: &str,
    username: &str,
    hash: Option<(&str, i64)>,
    status: &str,
) {
    let (pw_hash, pw_salt, iterations, algo) = match hash {
        Some((hex, iterations)) => (
            Some(unhex(hex)),
            Some(SALT.to_vec()),
            Some(iterations),
            Some("pbkdf2-sha256"),
        ),
        None => (None, None, None, None),
    };
    conn.execute(
        "INSERT INTO users (id, username, display_name, library_dir, pw_hash, pw_salt, pw_iterations,
                            pw_algo, is_admin, status, quota_bytes, created_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1700000000000, ?)",
        params![
            id,
            username,
            username.to_uppercase(),
            username,
            pw_hash,
            pw_salt,
            iterations,
            algo,
            i64::from(username == "marc"),
            status,
            if username == "marc" { Some(1_000_000_000i64) } else { None },
            (status == "active").then_some(1_700_000_100_000i64),
        ],
    )
    .unwrap();
}

/// A library folder as the legacy app left it, closed.
fn legacy_library(dir: &Path) {
    fs::create_dir_all(dir.join(".spm").join("previews")).unwrap();
    let conn = Connection::open(dir.join(".spm").join("app.db")).unwrap();
    conn.execute_batch(include_str!("../../src/db/migrations/001_init.sql"))
        .unwrap();
    conn.execute_batch(include_str!(
        "../../src/db/migrations/002_preview_claim.sql"
    ))
    .unwrap();
    conn.execute_batch(include_str!(
        "../../src/db/migrations/003_classifier_version.sql"
    ))
    .unwrap();
    conn.execute_batch("PRAGMA user_version = 3").unwrap();

    insert_user(
        &conn,
        "u-marc",
        "marc",
        Some((STRONG_HASH, 600_000)),
        "active",
    );
    insert_user(&conn, "u-old", "old", Some((WEAK_HASH, 1000)), "active");
    insert_user(
        &conn,
        "u-uni",
        "uni",
        Some((UNICODE_HASH, 600_000)),
        "active",
    );
    insert_user(&conn, "u-new", "newcomer", None, "pending");

    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent)
         VALUES (?, 'u-marc', 1700000000000, 1700000000000, 9999999999999, 'legacy-agent')",
        params![unhex(SESSION_TOKEN_HASH)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO activation_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ('t1', 'u-new', ?, 9999999999999, 1700000000000)",
        params![unhex(INVITE_TOKEN_HASH)],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
           VALUES ('p1', 'u-marc', 'Benchy', 'Benchy', 1, 2);
         INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms, classified_by)
           VALUES ('f1', 'p1', 'benchy.stl', 'model', 4096, 0, 1);
         INSERT INTO previews (file_id, state, source, png_path, width, height, attempts, updated_at)
           VALUES ('f1', 'ready', 'rasterized', 'f1.png', 256, 256, 1, 0);
         INSERT INTO user_settings (user_id, key, value) VALUES
           ('u-marc', 'theme', 'dark'), ('u-marc', 'navCollapsed', '1'),
           ('u-marc', 'filterTags', '[\"petg\",\"functional\"]');",
    )
    .unwrap();
}

fn open(dir: &Path) -> Library {
    Library::open(dir, OpenOptions::default()).expect("a legacy library opens unchanged")
}

fn stored_hash(lib: &Library, user: &str) -> (i64, Vec<u8>) {
    lib.db()
        .query_row(
            "SELECT pw_iterations, pw_hash FROM users WHERE id = ?",
            params![user],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

#[test]
fn a_legacy_library_opens_without_migrating_or_losing_anything() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    let version: i64 = lib
        .db()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3);
    for (table, expected) in [
        ("users", 4),
        ("sessions", 1),
        ("activation_tokens", 1),
        ("projects", 1),
        ("files", 1),
    ] {
        let count: i64 = lib
            .db()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, expected, "{table}");
    }
}

#[test]
fn a_legacy_password_hash_verifies_and_a_wrong_password_does_not() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    let result = login(&lib, "marc", "a good long password", Some("ua")).unwrap();
    assert_eq!(result.user.id, "u-marc");
    assert_eq!(result.user.username, "marc");
    assert_eq!(result.user.display_name, "MARC");
    assert!(result.user.is_admin);
    assert_eq!(result.user.status, UserStatus::Active);
    assert_eq!(result.user.quota_bytes, Some(1_000_000_000));
    assert_eq!(result.user.disk_usage_bytes, 4096);
    assert_eq!(result.user.created_at, 1_700_000_000_000);
    assert_eq!(result.user.activated_at, Some(1_700_000_100_000));

    assert_eq!(
        code_of(login(&lib, "marc", "a good long passworD", None)),
        AppErrorCode::Unauthorized
    );
    // Case-insensitive usernames, as the column's collation always made them.
    assert!(login(&lib, "MARC", "a good long password", None).is_ok());
    // A hash at current parameters is left exactly as it was.
    assert_eq!(
        stored_hash(&lib, "u-marc"),
        (i64::from(PW_ITERATIONS), unhex(STRONG_HASH))
    );
}

#[test]
fn a_legacy_hash_made_with_fewer_iterations_still_logs_in_and_is_upgraded() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());
    assert_eq!(stored_hash(&lib, "u-old").0, 1000);

    login(&lib, "old", "correct horse", None).unwrap();

    let (iterations, hash) = stored_hash(&lib, "u-old");
    assert_eq!(iterations, i64::from(PW_ITERATIONS));
    assert_ne!(hash, unhex(WEAK_HASH));
    // And the upgraded row still authenticates.
    assert!(login(&lib, "old", "correct horse", None).is_ok());
}

#[test]
fn a_legacy_hash_over_a_unicode_password_verifies_whichever_way_it_is_typed() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    // Composed, decomposed (a + combining diaeresis) and already-folded spellings of one password.
    for typed in [
        "p\u{e4}ssw\u{f6}rd \u{fb01}nal \u{2460}",
        "pa\u{308}sswo\u{308}rd \u{fb01}nal \u{2460}",
        "p\u{e4}ssw\u{f6}rd final 1",
    ] {
        assert!(login(&lib, "uni", typed, None).is_ok(), "{typed:?}");
    }
    assert!(login(&lib, "uni", "passwort final 1", None).is_err());
}

#[test]
fn a_legacy_session_token_still_resolves() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    let ctx = resolve_session(&lib, "abc", 1_700_000_001_000).unwrap();
    assert_eq!(
        ctx,
        Some(Ctx {
            user_id: "u-marc".to_owned(),
            is_admin: true
        })
    );
    assert_eq!(
        resolve_session(&lib, "abd", 1_700_000_001_000).unwrap(),
        None
    );
}

#[test]
fn a_legacy_pending_invite_still_activates_the_account() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    let check = check_activation_token(&lib, "legacy-invite-token", 1_700_000_001_000).unwrap();
    assert!(check.valid);
    assert_eq!(check.username.as_deref(), Some("newcomer"));

    let result =
        activate_account(&lib, "legacy-invite-token", "a brand new password", None).unwrap();
    assert_eq!(result.user.status, UserStatus::Active);
    assert!(login(&lib, "newcomer", "a brand new password", None).is_ok());
}

#[test]
fn legacy_settings_rows_read_back() {
    let dir = tempfile::tempdir().unwrap();
    legacy_library(dir.path());
    let lib = open(dir.path());

    let settings = get_settings(
        &lib,
        &Ctx {
            user_id: "u-marc".to_owned(),
            is_admin: true,
        },
    )
    .unwrap();
    assert_eq!(settings.theme, Theme::Dark);
    assert!(settings.nav_collapsed);
    assert_eq!(settings.filter_tags, ["petg", "functional"]);
    assert_eq!(settings.language, DEFAULT_SETTINGS.language);
    // A user with no rows gets the shipped defaults.
    let none = get_settings(
        &lib,
        &Ctx {
            user_id: "u-old".to_owned(),
            is_admin: false,
        },
    )
    .unwrap();
    assert_eq!(none, DEFAULT_SETTINGS);
}

#[test]
fn the_migration_files_are_the_legacy_ones_byte_for_byte() {
    // Pinned by length and a content fingerprint so an accidental edit (or a CRLF rewrite) of a
    // frozen migration is caught here rather than on a user's database. The files are the repo
    // versions of legacy/core/src/db/migrations/00{1,2,3}_*.sql.
    let files = [
        include_str!("../../src/db/migrations/001_init.sql"),
        include_str!("../../src/db/migrations/002_preview_claim.sql"),
        include_str!("../../src/db/migrations/003_classifier_version.sql"),
    ];
    for sql in files {
        assert!(!sql.contains('\r'), "migration files are LF");
    }
    assert!(files[0].starts_with("CREATE TABLE users ("));
    assert!(
        files[1]
            .trim_end()
            .ends_with("ALTER TABLE previews ADD COLUMN claimed_at INTEGER;")
    );
    assert!(
        files[2]
            .trim_end()
            .ends_with("ALTER TABLE files ADD COLUMN classified_by INTEGER NOT NULL DEFAULT 0;")
    );
}
