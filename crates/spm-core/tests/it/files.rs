//! Ported from the legacy `files.test.ts`: the file use cases (upload, rename, delete, resolve).
//!
//! The legacy upload took a web `ReadableStream`; here it takes any `impl Read`. The three
//! stream-specific legacy cases are adapted to what a reader can express (see the comments on
//! each), and the coverage table in the porting report says how.

use std::fs;
use std::io::{self, Cursor, Read};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::params;
use spm_core::dto::{PreviewState, ProjectState};
use spm_core::files::classify::CLASSIFIER_VERSION;
use spm_core::testing::{TempLibrary, seed_user};
use spm_core::validate::CreateProjectInput;
use spm_core::{
    AppError, AppErrorCode, Ctx, Library, assert_within_quota, content_type_for, create_project,
    delete_file, get_project, new_id, rename_file, resolve_file_path, resolve_preview_path,
    upload_file,
};

use crate::common::code_of;

fn project(lib: &Library, ctx: &Ctx, name: &str) -> String {
    create_project(
        lib,
        ctx,
        CreateProjectInput {
            name: name.to_owned(),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn upload_text(
    lib: &Library,
    ctx: &Ctx,
    project_id: &str,
    name: &str,
    text: &str,
) -> spm_core::Result<spm_core::dto::CoreFileDto> {
    upload_file(
        lib,
        ctx,
        project_id,
        name,
        text.len() as i64,
        Cursor::new(text.as_bytes().to_vec()),
    )
}

fn on_disk(lib: &Library, user: &str, project: &str, name: &str) -> PathBuf {
    lib.dir().join(user).join(project).join(name)
}

fn file_count(lib: &Library, ctx: &Ctx, project_id: &str) -> usize {
    get_project(lib, ctx, project_id).unwrap().files.len()
}

/// Delivers its chunks one `read` at a time and counts how many it handed out, so a test can see
/// whether a consumer stopped reading.
struct Chunked {
    chunks: Vec<Vec<u8>>,
    next: usize,
    handed_out: Arc<AtomicUsize>,
}

impl Chunked {
    fn new(chunks: &[&str]) -> (Chunked, i64, Arc<AtomicUsize>) {
        let handed_out = Arc::new(AtomicUsize::new(0));
        let chunks: Vec<Vec<u8>> = chunks.iter().map(|c| c.as_bytes().to_vec()).collect();
        let size = chunks.iter().map(Vec::len).sum::<usize>() as i64;
        (
            Chunked {
                chunks,
                next: 0,
                handed_out: Arc::clone(&handed_out),
            },
            size,
            handed_out,
        )
    }
}

impl Read for Chunked {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let Some(chunk) = self.chunks.get(self.next) else {
            return Ok(0);
        };
        self.next += 1;
        self.handed_out.fetch_add(1, Ordering::SeqCst);
        buf[..chunk.len()].copy_from_slice(chunk);
        Ok(chunk.len())
    }
}

/// A body that fails as soon as it is read, as a dropped connection does.
struct Broken;

impl Read for Broken {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::ConnectionReset, "reset"))
    }
}

#[test]
fn content_type_for_maps_the_formats_this_app_cares_about() {
    assert_eq!(content_type_for("a.stl"), "model/stl");
    assert_eq!(content_type_for("a.3MF"), "model/3mf");
    assert_eq!(content_type_for("a.png"), "image/png");
    assert_eq!(content_type_for("a.weird"), "application/octet-stream");
}

#[test]
fn upload_writes_the_file_indexes_it_and_queues_a_preview() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");

    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid benchy").unwrap();
    assert_eq!(dto.name, "benchy.stl");
    assert_eq!(dto.kind, spm_core::dto::FileKind::Model);
    assert_eq!(dto.preview_state, PreviewState::Pending);
    assert_eq!(dto.size_bytes, "solid benchy".len() as i64);

    assert_eq!(
        fs::read_to_string(on_disk(&lib, "marc", "Benchy", "benchy.stl")).unwrap(),
        "solid benchy"
    );
    assert_eq!(file_count(&lib, &ctx, &project_id), 1);

    // The fourth write site that sets `kind`, and the only one outside rescan. Left at the
    // column's `DEFAULT 0` this row would claim to predate a classifier that had just run on it,
    // and the next rescan would re-ask a question already answered: once per uploaded file, and
    // for an uploaded `.3mf` that is a zip read.
    let stamp: i64 = lib
        .db()
        .query_row("SELECT classified_by FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stamp, CLASSIFIER_VERSION);
}

#[test]
fn upload_records_the_content_hash_of_exactly_the_bytes_written() {
    use sha2::{Digest, Sha256};
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let body = "solid hashed ".repeat(10_000);
    upload_text(&lib, &ctx, &project_id, "big.stl", &body).unwrap();

    let stored: Vec<u8> = lib
        .db()
        .query_row("SELECT content_hash FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, Sha256::digest(body.as_bytes()).to_vec());
}

#[test]
fn upload_refuses_a_duplicate_name_in_the_same_project() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();
    assert_eq!(
        code_of(upload_text(
            &lib,
            &ctx,
            &project_id,
            "benchy.stl",
            "solid again"
        )),
        AppErrorCode::Conflict
    );
}

#[test]
fn upload_refuses_a_path_segment_in_the_file_name() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    for name in ["../escape.stl", "sub/nested.stl", "sub\\nested.stl"] {
        assert_eq!(
            code_of(upload_text(&lib, &ctx, &project_id, name, "solid")),
            AppErrorCode::Forbidden,
            "name {name:?}"
        );
    }
    assert!(!lib.dir().join("marc").join("escape.stl").exists());
}

#[test]
fn upload_into_another_user_project_is_a_not_found() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    let project_id = project(&lib, &marc, "Benchy");
    assert_eq!(
        code_of(upload_text(&lib, &anna, &project_id, "a.stl", "solid")),
        AppErrorCode::NotFound
    );
}

#[test]
fn upload_into_a_missing_project_is_refused() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    lib.db()
        .execute(
            "UPDATE projects SET state = ? WHERE id = ?",
            params![ProjectState::Missing.as_str(), project_id],
        )
        .unwrap();
    assert_eq!(
        code_of(upload_text(&lib, &ctx, &project_id, "a.stl", "solid")),
        AppErrorCode::Conflict
    );
}

#[test]
fn a_null_quota_means_unlimited() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    assert_within_quota(&lib, &ctx, i64::MAX).unwrap();
}

#[test]
fn quota_is_checked_before_writing_and_reports_the_numbers() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    lib.db()
        .execute(
            "UPDATE users SET quota_bytes = 100 WHERE id = ?",
            params![ctx.user_id],
        )
        .unwrap();
    let project_id = project(&lib, &ctx, "Benchy");
    upload_text(&lib, &ctx, &project_id, "a.stl", &"x".repeat(90)).unwrap();

    let error: AppError =
        upload_text(&lib, &ctx, &project_id, "b.stl", &"x".repeat(20)).expect_err("over quota");
    assert_eq!(error.code, AppErrorCode::QuotaExceeded);
    let details = error.details.unwrap();
    assert_eq!(details["usageBytes"], 90);
    assert_eq!(details["quotaBytes"], 100);
    assert_eq!(details["incomingBytes"], 20);
    assert_eq!(details.len(), 3);
    // Nothing was written.
    assert!(!on_disk(&lib, "marc", "Benchy", "b.stl").exists());
}

#[test]
fn a_body_longer_than_its_declared_size_is_rejected_and_cleaned_up() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let body = "x".repeat(50);

    let result = upload_file(&lib, &ctx, &project_id, "a.stl", 10, Cursor::new(body));
    assert_eq!(code_of(result), AppErrorCode::Validation);
    assert!(!on_disk(&lib, "marc", "Benchy", "a.stl").exists());
    assert_eq!(file_count(&lib, &ctx, &project_id), 0);
}

#[test]
fn upload_accepts_a_body_delivered_across_multiple_chunks() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let chunks = ["solid ", "benchy ", "in three parts"];
    let (body, size, _) = Chunked::new(&chunks);

    let dto = upload_file(&lib, &ctx, &project_id, "benchy.stl", size, body).unwrap();
    assert_eq!(dto.size_bytes, size);
    assert_eq!(
        fs::read_to_string(on_disk(&lib, "marc", "Benchy", "benchy.stl")).unwrap(),
        chunks.concat()
    );
}

/// The legacy case cancelled the web stream. A reader has no cancel: the caller drops it (the HTTP
/// layer drops the request body), so what is observable is that the upload **stops reading** the
/// moment the body is seen to be too long, rather than draining the rest of an unbounded stream.
#[test]
fn a_body_that_exceeds_its_declared_size_partway_stops_reading_and_cleans_up() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    // 3 chunks of 5 bytes each; the declared size (8) is only exceeded on the second chunk,
    // leaving the third unread: that unread remainder is what makes stopping observable.
    let (body, _, handed_out) = Chunked::new(&["xxxxx", "xxxxx", "xxxxx"]);

    let result = upload_file(&lib, &ctx, &project_id, "a.stl", 8, body);
    assert_eq!(code_of(result), AppErrorCode::Validation);
    assert!(!on_disk(&lib, "marc", "Benchy", "a.stl").exists());
    assert_eq!(file_count(&lib, &ctx, &project_id), 0);
    assert_eq!(handed_out.load(Ordering::SeqCst), 2);
}

/// The legacy case locked the stream so `getReader()` threw after the file had been created. The
/// reader equivalent is a body that fails on its very first read: the file `create_new` has
/// already made must not be left behind, empty, and no row may exist.
#[test]
fn a_body_that_cannot_be_read_leaves_no_file_or_row() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");

    let result = upload_file(&lib, &ctx, &project_id, "a.stl", 5, Broken);
    assert_eq!(code_of(result), AppErrorCode::Validation);
    assert!(!on_disk(&lib, "marc", "Benchy", "a.stl").exists());
    assert_eq!(file_count(&lib, &ctx, &project_id), 0);
    // And the name is free again.
    upload_text(&lib, &ctx, &project_id, "a.stl", "solid").unwrap();
}

/// The legacy case raced two promises on one thread. Here they are two threads, so the exclusive
/// create really is contended.
#[test]
fn two_uploads_racing_the_same_name_exactly_one_wins_the_other_is_a_conflict() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");

    // Deliberately different lengths, and asserted by content below: with equal lengths nothing
    // could tell the two bodies apart.
    let bodies = [
        "solid one".to_owned(),
        "solid two, and appreciably longer than the first".to_owned(),
    ];
    assert_ne!(bodies[0].len(), bodies[1].len());

    let results: Vec<spm_core::Result<spm_core::dto::CoreFileDto>> = std::thread::scope(|scope| {
        let handles: Vec<_> = bodies
            .iter()
            .map(|body| {
                let (lib, ctx, project_id) = (&*lib, &ctx, &project_id);
                scope.spawn(move || upload_text(lib, ctx, project_id, "a.stl", body))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    let winners: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
    let losers: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    assert_eq!(winners.len(), 1);
    assert_eq!(losers.len(), 1);
    assert_eq!(losers[0].code, AppErrorCode::Conflict);

    // The distinct lengths identify which body won; the file must then be exactly that body, not
    // a mixture and not the loser's.
    let winning_body = bodies
        .iter()
        .find(|body| body.len() as i64 == winners[0].size_bytes)
        .expect("a body matches the winner's size");
    assert_eq!(
        fs::read_to_string(on_disk(&lib, "marc", "Benchy", "a.stl")).unwrap(),
        *winning_body
    );
    assert_eq!(file_count(&lib, &ctx, &project_id), 1);
}

#[test]
fn rename_moves_the_file_on_disk_and_keeps_its_folder() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    let renamed = rename_file(&lib, &ctx, &dto.id, "benchy-v2.stl").unwrap();
    assert_eq!(renamed.name, "benchy-v2.stl");
    assert!(on_disk(&lib, "marc", "Benchy", "benchy-v2.stl").exists());
    assert!(!on_disk(&lib, "marc", "Benchy", "benchy.stl").exists());
}

#[test]
fn rename_of_a_nested_file_changes_only_its_last_path_segment() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    // Rescan is what actually produces nested rel_paths; recreate that shape by hand rather than
    // pulling rescan into this test.
    let sub = lib.dir().join("marc").join("Benchy").join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("a.stl"), "solid").unwrap();
    let id = spm_core::testing::seed_file_row(&lib, &project_id, "sub/a.stl", "model", "pending");

    let renamed = rename_file(&lib, &ctx, &id, "b.stl").unwrap();
    assert_eq!(renamed.name, "sub/b.stl");
    assert!(sub.join("b.stl").exists());
    assert!(!sub.join("a.stl").exists());
}

#[test]
fn rename_onto_an_existing_name_is_a_conflict() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let a = upload_text(&lib, &ctx, &project_id, "a.stl", "solid").unwrap();
    upload_text(&lib, &ctx, &project_id, "b.stl", "solid").unwrap();
    assert_eq!(
        code_of(rename_file(&lib, &ctx, &a.id, "b.stl")),
        AppErrorCode::Conflict
    );
}

#[test]
fn delete_removes_the_bytes_the_row_and_the_preview_png() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    let png = lib
        .dir()
        .join(".spm")
        .join("previews")
        .join(format!("{}.png", dto.id));
    fs::write(&png, "not really a png").unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?",
            params![format!(".spm/previews/{}.png", dto.id), dto.id],
        )
        .unwrap();

    delete_file(&lib, &ctx, &dto.id).unwrap();
    assert!(!on_disk(&lib, "marc", "Benchy", "benchy.stl").exists());
    assert!(!png.exists());
    assert_eq!(file_count(&lib, &ctx, &project_id), 0);
}

#[test]
fn resolve_file_path_is_scoped_to_the_owner() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    let project_id = project(&lib, &marc, "Benchy");
    let dto = upload_text(&lib, &marc, &project_id, "benchy.stl", "solid").unwrap();

    let resolved = resolve_file_path(&lib, &marc, &dto.id).unwrap();
    assert_eq!(
        resolved.abs_path,
        on_disk(&lib, "marc", "Benchy", "benchy.stl")
    );
    assert_eq!(resolved.name, "benchy.stl");
    assert_eq!(resolved.content_type, "model/stl");
    assert_eq!(resolved.size_bytes, 5);

    assert_eq!(
        code_of(resolve_file_path(&lib, &anna, &dto.id)),
        AppErrorCode::NotFound
    );
}

#[test]
fn resolve_preview_path_is_null_while_the_preview_is_still_pending() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    // upload leaves a freshly-queued preview row in state 'pending'.
    assert_eq!(resolve_preview_path(&lib, &ctx, &dto.id).unwrap(), None);
}

#[test]
fn resolve_preview_path_is_null_when_a_ready_previews_png_is_missing_from_disk() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?",
            params![format!(".spm/previews/{}.png", dto.id), dto.id],
        )
        .unwrap();
    // No file was ever written at that path.
    assert_eq!(resolve_preview_path(&lib, &ctx, &dto.id).unwrap(), None);
}

#[test]
fn resolve_preview_path_returns_the_absolute_path_for_a_ready_present_preview() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    let png = lib
        .dir()
        .join(".spm")
        .join("previews")
        .join(format!("{}.png", dto.id));
    fs::write(&png, "not really a png").unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?",
            params![format!(".spm/previews/{}.png", dto.id), dto.id],
        )
        .unwrap();

    assert_eq!(
        resolve_preview_path(&lib, &ctx, &dto.id).unwrap(),
        Some(png)
    );
}

/// Ruling C-13. The column is written by the preview queue from an id it generated, so this row
/// cannot arise from anything core does, which is exactly why a plain join would go unnoticed.
/// Both spellings of a way out are refused (the legacy suite generated one test for each).
fn assert_escaping_png_path_is_refused(absolute: bool) {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project_id = project(&lib, &ctx, "Benchy");
    let dto = upload_text(&lib, &ctx, &project_id, "benchy.stl", "solid").unwrap();

    // A real file at the escaped target, so the refusal cannot be an existence check answering
    // for an absent one. It sits beside the library folder, not in it.
    let outside = lib
        .dir()
        .parent()
        .unwrap()
        .join(format!("spm-outside-{}.png", new_id()));
    fs::write(&outside, "not really a png").unwrap();
    let spelling = if absolute {
        outside.to_string_lossy().into_owned()
    } else {
        format!("../{}", outside.file_name().unwrap().to_string_lossy())
    };
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?",
            params![spelling, dto.id],
        )
        .unwrap();

    let result = resolve_preview_path(&lib, &ctx, &dto.id);
    fs::remove_file(&outside).unwrap();
    assert_eq!(code_of(result), AppErrorCode::Forbidden);
}

#[test]
fn resolve_preview_path_refuses_a_relative_png_path_that_escapes_the_library() {
    assert_escaping_png_path_is_refused(false);
}

#[test]
fn resolve_preview_path_refuses_an_absolute_png_path_that_escapes_the_library() {
    assert_escaping_png_path_is_refused(true);
}
