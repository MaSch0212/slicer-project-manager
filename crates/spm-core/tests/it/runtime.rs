//! The platform assumptions the code stands on, re-targeted from the legacy `node:sqlite` and
//! WebCrypto checks to their Rust equivalents.

use rusqlite::{Connection, params};
use spm_core::auth::password::hash_password_with;

#[test]
fn sqlite_is_present_and_round_trips_a_blob() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, payload BLOB NOT NULL)")
        .unwrap();
    conn.execute(
        "INSERT INTO t (id, payload) VALUES (?, ?)",
        params!["a", vec![1u8, 2, 3]],
    )
    .unwrap();
    let payload: Vec<u8> = conn
        .query_row("SELECT payload FROM t WHERE id = ?", params!["a"], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(payload, [1, 2, 3]);
}

#[test]
fn sqlite_enforces_foreign_keys_once_the_pragma_is_on() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(
        "CREATE TABLE parent (id TEXT PRIMARY KEY);
         CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);",
    )
    .unwrap();
    assert!(
        conn.execute("INSERT INTO child VALUES (?, ?)", params!["c", "nope"])
            .is_err()
    );
}

#[test]
fn pbkdf2_sha256_derives_a_32_byte_key() {
    let derived = hash_password_with("correct horse", 1000);
    assert_eq!(derived.hash.len(), 32);
    assert_eq!(derived.algo, "pbkdf2-sha256");
}
