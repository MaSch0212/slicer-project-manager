//! What the preview-queue tests share: a user with a project folder, and a view of the `previews`
//! table.

#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use spm_core::previews::{BatchResult, QueueOptions, SharedHandler, run_preview_queue};
use spm_core::testing::seed_user;
use spm_core::{Ctx, Library};

/// Creates the user and the project folder (`marc/Benchy`) every test writes model files into.
pub fn seed_project_dir(lib: &Library) -> (Ctx, PathBuf) {
    let ctx = seed_user(lib, "marc");
    let dir = lib.dir().join("marc").join("Benchy");
    fs::create_dir_all(&dir).unwrap();
    (ctx, dir)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreviewRow {
    pub file_id: String,
    pub state: String,
    pub source: Option<String>,
    pub png_path: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub attempts: i64,
    pub error: Option<String>,
    pub claimed_at: Option<i64>,
    pub source_hash: Option<Vec<u8>>,
}

/// Every preview row, in file path order.
pub fn preview_rows(lib: &Library) -> Vec<PreviewRow> {
    let conn = lib.db();
    let mut statement = conn
        .prepare(
            "SELECT pv.file_id, pv.state, pv.source, pv.png_path, pv.width, pv.height,
                    pv.attempts, pv.error, pv.claimed_at, pv.source_hash
             FROM previews pv JOIN files f ON f.id = pv.file_id ORDER BY f.rel_path",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(PreviewRow {
                file_id: row.get(0)?,
                state: row.get(1)?,
                source: row.get(2)?,
                png_path: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
                attempts: row.get(6)?,
                error: row.get(7)?,
                claimed_at: row.get(8)?,
                source_hash: row.get(9)?,
            })
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The one preview row of a test that has one file.
pub fn only_row(lib: &Library) -> PreviewRow {
    let mut rows = preview_rows(lib);
    assert_eq!(rows.len(), 1, "expected exactly one preview row");
    rows.remove(0)
}

pub fn png_on_disk(lib: &Library, file_id: &str) -> PathBuf {
    lib.dir()
        .join(".spm")
        .join("previews")
        .join(format!("{file_id}.png"))
}

/// A batch of `handlers` with the options a test usually wants.
pub fn run_with(lib: &Library, handlers: Vec<SharedHandler>) -> BatchResult {
    run_preview_queue(
        lib,
        &QueueOptions {
            handlers,
            ..QueueOptions::default()
        },
    )
    .unwrap()
}

/// `{ ready, failed, unsupported }`, as the legacy tests wrote the counts they expected.
pub fn counts(ready: usize, failed: usize, unsupported: usize, claimed: usize) -> BatchResult {
    BatchResult {
        claimed,
        ready,
        failed,
        unsupported,
    }
}

/// Runs `sql` against the previews table, for the tests that put a row into a state a run would.
pub fn exec(lib: &Library, sql: &str) {
    lib.db().execute(sql, []).unwrap();
}
