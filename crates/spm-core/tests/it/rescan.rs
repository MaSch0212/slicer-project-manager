//! Ported from the legacy `rescan.test.ts`, plus the explicit rescan edge cases parent spec 8.2
//! asks for (adopt, missing folder, changed file, dot-folder skipping) in the Rust-only tests at
//! the bottom.
//!
//! The legacy suite ran its `.step` cases against bytes that were never parsed: classification
//! reads the extension only, so a text stand-in is the same input here. Mesh parsing of STEP is
//! gone (migration spec 4.1) and none of these cases depended on it.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::params;
use spm_core::dto::{FileKind, ProjectQuery, ProjectState};
use spm_core::files::classify::CLASSIFIER_VERSION;
use spm_core::projects::rescan::RescanProgress;
use spm_core::testing::{TempLibrary, seed_user, seed_user_in};
use spm_core::{Ctx, Library, list_projects, rescan};

use crate::fixtures::cura_project;

fn root(lib: &Library, username: &str) -> PathBuf {
    lib.dir().join(username)
}

fn marc(lib: &Library) -> Ctx {
    seed_user(lib, "marc")
}

fn list(lib: &Library, ctx: &Ctx) -> Vec<spm_core::dto::CoreProjectDto> {
    list_projects(lib, ctx, &ProjectQuery::default()).unwrap()
}

fn set_mtime(path: &Path, time: SystemTime) {
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

fn five_seconds_later() -> SystemTime {
    SystemTime::now() + Duration::from_secs(5)
}

fn count(lib: &Library, table: &str) -> i64 {
    lib.db()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// Every `files` row's classification stamp, keyed by relative path.
fn classified_by(lib: &Library) -> Vec<(String, i64)> {
    let conn = lib.db();
    let mut statement = conn
        .prepare("SELECT rel_path, classified_by FROM files ORDER BY rel_path")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

type KindAndPreview = (String, String, Option<String>, i64);

/// Every file row's kind joined to its preview row, which is what an unstamped bump would move.
fn kinds_and_previews(lib: &Library) -> Vec<KindAndPreview> {
    let conn = lib.db();
    let mut statement = conn
        .prepare(
            "SELECT f.kind, p.state, p.png_path, p.attempts FROM files f
             JOIN previews p ON p.file_id = f.id ORDER BY f.rel_path",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn a_folder_with_no_row_is_adopted_taking_its_name_from_the_folder() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    fs::create_dir(root(&lib, "marc").join("Gridfinity Bin")).unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.adopted, 1);
    let projects = list(&lib, &ctx);
    assert_eq!(projects[0].name, "Gridfinity Bin");
    assert_eq!(projects[0].state, ProjectState::Ok);
}

#[test]
fn dot_folders_are_skipped_at_every_level() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let top = root(&lib, "marc");
    fs::create_dir_all(top.join(".git")).unwrap();
    fs::create_dir_all(top.join("Benchy").join(".cache")).unwrap();
    fs::write(top.join("Benchy").join(".cache").join("junk.stl"), "solid").unwrap();
    fs::write(top.join("Benchy").join(".hidden.stl"), "solid").unwrap();
    fs::write(top.join("Benchy").join("benchy.stl"), "solid").unwrap();

    rescan(&lib, &ctx, None).unwrap();
    let names: Vec<String> = list(&lib, &ctx).into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["Benchy"]);
    let conn = lib.db();
    let mut statement = conn.prepare("SELECT rel_path FROM files").unwrap();
    let rows: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, ["benchy.stl"]);
}

#[test]
fn the_spm_folder_is_never_adopted_even_in_a_flat_library() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "local", ".", None);
    fs::create_dir(lib.dir().join("Benchy")).unwrap();

    rescan(&lib, &ctx, None).unwrap();
    let names: Vec<String> = list(&lib, &ctx).into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["Benchy"]);
}

#[test]
fn files_are_indexed_with_their_classification_and_a_pending_preview() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid benchy").unwrap();
    fs::write(dir.join("notes.txt"), "PETG").unwrap();
    cura_project(&dir.join("benchy.3mf"), None);

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.files_added, 3);
    assert_eq!(result.previews_queued, 3);

    let rows: Vec<(String, String, Option<String>)> = {
        let conn = lib.db();
        let mut statement = conn
            .prepare("SELECT rel_path, kind, slicer FROM files ORDER BY rel_path")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        rows,
        [
            (
                "benchy.3mf".to_owned(),
                "slicer_project".to_owned(),
                Some("cura".to_owned())
            ),
            ("benchy.stl".to_owned(), "model".to_owned(), None),
            ("notes.txt".to_owned(), "other".to_owned(), None),
        ]
    );
    let pending: i64 = lib
        .db()
        .query_row(
            "SELECT COUNT(*) FROM previews WHERE state = 'pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 3);
}

#[test]
fn nested_files_keep_a_forward_slash_relative_path() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let variants = root(&lib, "marc").join("Benchy").join("variants");
    fs::create_dir_all(&variants).unwrap();
    fs::write(variants.join("small.stl"), "solid").unwrap();

    rescan(&lib, &ctx, None).unwrap();
    let rel_path: String = lib
        .db()
        .query_row("SELECT rel_path FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rel_path, "variants/small.stl");
}

#[test]
fn a_project_whose_folder_disappeared_is_marked_missing_and_keeps_its_files() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    fs::remove_dir_all(&dir).unwrap();
    let result = rescan(&lib, &ctx, None).unwrap();

    assert_eq!(result.marked_missing, 1);
    assert_eq!(result.files_removed, 0);
    let project = &list(&lib, &ctx)[0];
    assert_eq!(project.state, ProjectState::Missing);
    // The drive may simply be unmounted: a thousand tags must not evaporate.
    assert_eq!(project.file_counts.model, 1);

    // marked_missing is reported to the user: a still-missing project must not be re-counted.
    let again = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(again.marked_missing, 0);
}

#[test]
fn an_absent_library_root_degrades_to_missing_projects_instead_of_failing() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    // Not just the project folder: the whole user root is gone (an unmounted network drive),
    // which is exactly the not-found case the folder listing must swallow.
    fs::remove_dir_all(root(&lib, "marc")).unwrap();
    let result = rescan(&lib, &ctx, None).unwrap();

    assert_eq!(result.marked_missing, 1);
    assert_eq!(result.files_removed, 0);
    let project = &list(&lib, &ctx)[0];
    assert_eq!(project.state, ProjectState::Missing);
    assert_eq!(project.file_counts.model, 1);
}

#[test]
fn a_folder_that_comes_back_is_marked_ok_again() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    rescan(&lib, &ctx, None).unwrap();
    fs::remove_dir_all(&dir).unwrap();
    rescan(&lib, &ctx, None).unwrap();
    fs::create_dir(&dir).unwrap();

    rescan(&lib, &ctx, None).unwrap();
    assert_eq!(list(&lib, &ctx)[0].state, ProjectState::Ok);
}

#[test]
fn a_file_removed_from_a_present_project_loses_its_row_and_preview() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    fs::remove_file(dir.join("benchy.stl")).unwrap();
    let result = rescan(&lib, &ctx, None).unwrap();

    assert_eq!(result.files_removed, 1);
    assert_eq!(count(&lib, "files"), 0);
    assert_eq!(count(&lib, "previews"), 0);
}

#[test]
fn a_changed_file_resets_its_preview_to_pending_and_updates_its_hash() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("benchy.stl");
    fs::write(&file, "solid one").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    // Stand in for a finished preview so the reset is observable.
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', source_hash = X'00'",
            [],
        )
        .unwrap();

    fs::write(&file, "solid one but longer now").unwrap();
    set_mtime(&file, five_seconds_later());

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 1);
    let state: String = lib
        .db()
        .query_row("SELECT state FROM previews", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "pending");
    let (hash, size): (Vec<u8>, i64) = lib
        .db()
        .query_row("SELECT content_hash, size_bytes FROM files", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(size, "solid one but longer now".len() as i64);
    assert_eq!(hash.len(), 32);
}

#[test]
fn a_same_size_edit_is_still_detected_by_its_changed_mtime() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("benchy.stl");
    // Same length, different content: an in-place slicer re-save often looks exactly like this,
    // and size_bytes alone would never notice it.
    fs::write(&file, "solid one").unwrap();
    rescan(&lib, &ctx, None).unwrap();
    let before: Vec<u8> = lib
        .db()
        .query_row("SELECT content_hash FROM files", [], |row| row.get(0))
        .unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', source_hash = X'00'",
            [],
        )
        .unwrap();

    fs::write(&file, "solid TWO").unwrap();
    assert_eq!("solid one".len(), "solid TWO".len());
    set_mtime(&file, five_seconds_later());

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 1);
    let state: String = lib
        .db()
        .query_row("SELECT state FROM previews", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "pending");
    let (after, size): (Vec<u8>, i64) = lib
        .db()
        .query_row("SELECT content_hash, size_bytes FROM files", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(size, "solid TWO".len() as i64);
    assert_ne!(after, before);
}

#[test]
fn an_untouched_file_is_not_re_queued() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    rescan(&lib, &ctx, None).unwrap();
    lib.db()
        .execute("UPDATE previews SET state = 'ready'", [])
        .unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 0);
    assert_eq!(result.files_added, 0);
    let state: String = lib
        .db()
        .query_row("SELECT state FROM previews", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "ready");
}

#[test]
fn rescan_indexes_files_even_when_the_user_is_over_quota() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "marc", "marc", Some(1));
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid and definitely over one byte").unwrap();

    // Refusing to index existing files would hide a user's own files from them (5.6).
    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.files_added, 1);
}

#[test]
fn rescan_only_ever_touches_the_calling_user_library() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    fs::create_dir(root(&lib, "anna").join("Bin")).unwrap();

    let result = rescan(&lib, &marc, None).unwrap();
    assert_eq!(result.adopted, 0);
    assert_eq!(rescan(&lib, &anna, None).unwrap().adopted, 1);
}

/// The headline case: a row an older build wrote comes back reclassified, **without its bytes
/// moving**.
///
/// The "untouched" is the whole test. A fixture that rewrote the file would pass against the
/// broken behaviour too, because the stat mismatch alone would have reclassified it: so the file
/// is written once, indexed, forced back to the shape an older build left (`kind: other`,
/// `classified_by = 0`) and rescanned with nothing on disk changed at all.
#[test]
fn a_file_classified_by_an_older_version_is_re_asked_its_bytes_untouched() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Bracket");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("part.step"), "ISO-10303-21;").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    // The row exactly as a build without migration 003 left it, and its preview row rendered.
    lib.db()
        .execute(
            "UPDATE files SET kind = 'other', slicer = NULL, classified_by = 0",
            [],
        )
        .unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = 'x.png'",
            [],
        )
        .unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 1);
    assert_eq!(result.files_added, 0);
    let (kind, stamp): (String, i64) = lib
        .db()
        .query_row("SELECT kind, classified_by FROM files", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(kind, FileKind::Model.as_str());
    assert_eq!(stamp, CLASSIFIER_VERSION);
    let (state, png): (String, Option<String>) = lib
        .db()
        .query_row("SELECT state, png_path FROM previews", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((state.as_str(), png), ("pending", None));
}

/// All three write sites, three assertions and not one.
///
/// A first-sight insert, a stat-mismatch update and a version-mismatch reclassify each set `kind`,
/// and each must stamp the version beside it. Leaving any one of them alone is invisible until the
/// next rescan (the row simply stays stale for ever), which is why one combined assertion at the
/// end would not locate it.
#[test]
fn all_three_rescan_write_sites_stamp_the_classifier_version() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    for name in ["fresh.stl", "edited.stl", "stale.stl"] {
        fs::write(dir.join(name), "solid").unwrap();
    }
    let all_current = || {
        ["edited.stl", "fresh.stl", "stale.stl"]
            .map(|name| (name.to_owned(), CLASSIFIER_VERSION))
            .to_vec()
    };

    // 1. The insert.
    rescan(&lib, &ctx, None).unwrap();
    assert_eq!(classified_by(&lib), all_current());

    // 2. The stat-mismatch update, and 3. the version-mismatch reclassify, in one pass so a site
    //    that writes nothing is caught by the row it leaves behind rather than by the other's.
    lib.db()
        .execute(
            "UPDATE files SET classified_by = 0 WHERE rel_path IN ('edited.stl', 'stale.stl')",
            [],
        )
        .unwrap();
    fs::write(
        dir.join("edited.stl"),
        "solid, and now rather longer than it was",
    )
    .unwrap();
    rescan(&lib, &ctx, None).unwrap();
    assert_eq!(classified_by(&lib), all_current());
}

/// Idempotence: a second pass over an untouched library re-asks nothing and re-pends nothing.
///
/// A row whose `classified_by` is never written is reclassified on **every** tick for ever.
///
/// `previews_queued == 0` cannot see that on its own, because only a *changed* kind re-pends: the
/// wasted work leaves no trace in any result field. So the stamp is asserted directly after the
/// first pass, and a probe makes "was the classifier asked again?" observable: the 3MF's bytes are
/// replaced with the same number of bytes that are not a zip and its mtime is put back, so its stat
/// is unchanged and a re-ask would now answer `other` where it answered `slicer_project`.
#[test]
fn a_second_rescan_over_an_untouched_library_reclassifies_and_queues_nothing() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("part.step"), "ISO-10303-21;").unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    cura_project(&dir.join("benchy.3mf"), None);

    assert_eq!(rescan(&lib, &ctx, None).unwrap().previews_queued, 3);
    // Nothing is stale, which is what makes the second pass cheap rather than merely quiet.
    assert_eq!(
        classified_by(&lib),
        [
            ("benchy.3mf".to_owned(), CLASSIFIER_VERSION),
            ("benchy.stl".to_owned(), CLASSIFIER_VERSION),
            ("part.step".to_owned(), CLASSIFIER_VERSION),
        ]
    );
    lib.db()
        .execute("UPDATE previews SET state = 'ready'", [])
        .unwrap();

    let three_mf = dir.join("benchy.3mf");
    let metadata = fs::metadata(&three_mf).unwrap();
    fs::write(&three_mf, vec![0u8; metadata.len() as usize]).unwrap();
    set_mtime(&three_mf, metadata.modified().unwrap());

    let second = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(second.previews_queued, 0);
    assert_eq!(second.files_added, 0);
    let states: Vec<String> = {
        let conn = lib.db();
        let mut statement = conn.prepare("SELECT state FROM previews").unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(states, ["ready", "ready", "ready"]);
    let kind: String = lib
        .db()
        .query_row(
            "SELECT kind FROM files WHERE rel_path = 'benchy.3mf'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kind, "slicer_project");
}

/// A reclassification that lands on the kind the row already had re-pends nothing.
///
/// A version bump made for a `.step` change must not re-render every STL in a library. The row's
/// own `state`, `png_path` and `attempts` are compared, not just the counter: a reset that ran
/// without incrementing it would leave a counter assertion green and the thumbnail gone.
#[test]
fn a_reclassification_to_the_same_kind_leaves_the_preview_row_exactly_as_it_was() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    rescan(&lib, &ctx, None).unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = 'benchy.png', attempts = 2",
            [],
        )
        .unwrap();
    lib.db()
        .execute("UPDATE files SET classified_by = 0", [])
        .unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 0);
    let row: (String, Option<String>, i64) = lib
        .db()
        .query_row(
            "SELECT state, png_path, attempts FROM previews",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("ready".to_owned(), Some("benchy.png".to_owned()), 2));
    // And the stamp was still written, or the row would be reclassified again on the next tick.
    assert_eq!(
        classified_by(&lib),
        [("benchy.stl".to_owned(), CLASSIFIER_VERSION)]
    );
}

/// A `.3mf` the bump pass could not open keeps its kind **and** its stamp, and is asked again.
///
/// `classify_3mf` answers `other` for a file it cannot open at all, which on the stat-mismatch path
/// is self-healing (the next edit re-asks). On the version-mismatch branch it is not: the
/// reclassify would stamp the current version in the same statement, and nothing re-asks a row
/// whose stamp is current until its bytes move.
///
/// The lock is a rename, which is what makes this a test rather than a story: the progress callback
/// fires immediately before the file is classified, so moving the file aside from inside it
/// produces, at the same call, the same thing a real lock produces: an open that fails. It is
/// moved rather than deleted so it comes back with its size and mtime intact, which makes the
/// second pass take this same branch rather than the stat-mismatch one.
#[test]
fn a_3mf_that_could_not_be_opened_during_a_bump_keeps_its_kind_and_its_stamp() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    let project = dir.join("benchy.3mf");
    cura_project(&project, None);
    rescan(&lib, &ctx, None).unwrap();
    lib.db()
        .execute(
            "UPDATE previews SET state = 'ready', png_path = 'benchy.png', attempts = 1",
            [],
        )
        .unwrap();
    lib.db()
        .execute("UPDATE files SET classified_by = 0", [])
        .unwrap();

    let parked = lib.dir().join("parked.3mf");
    let mut park = |progress: &RescanProgress| {
        if progress.files_seen == 1 {
            fs::rename(&project, &parked).unwrap();
        }
    };
    let locked = rescan(&lib, &ctx, Some(&mut park)).unwrap();
    fs::rename(&parked, &project).unwrap();

    let ready = |attempts| {
        vec![(
            "slicer_project".to_owned(),
            "ready".to_owned(),
            Some("benchy.png".to_owned()),
            attempts,
        )]
    };
    assert_eq!(locked.previews_queued, 0);
    assert_eq!(classified_by(&lib), [("benchy.3mf".to_owned(), 0)]);
    assert_eq!(kinds_and_previews(&lib), ready(1));

    // And the next pass, with the file back and its stat untouched, asks the question it skipped.
    let second = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(second.previews_queued, 0);
    assert_eq!(
        classified_by(&lib),
        [("benchy.3mf".to_owned(), CLASSIFIER_VERSION)]
    );
    assert_eq!(kinds_and_previews(&lib), ready(1));
}

/// The insert-preview fallback beside the reset, which is not defensive padding.
///
/// `UPDATE previews ... WHERE file_id = ?` against a row that is not there updates nothing and
/// reports nothing, so a file whose preview row is missing (a database restored without it, a row
/// deleted by hand) would reclassify to `model` and then never render.
#[test]
fn a_version_stale_file_whose_preview_row_was_deleted_gets_a_pending_one() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Bracket");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("part.step"), "ISO-10303-21;").unwrap();
    rescan(&lib, &ctx, None).unwrap();
    lib.db()
        .execute(
            "UPDATE files SET kind = 'other', slicer = NULL, classified_by = 0",
            [],
        )
        .unwrap();
    lib.db().execute("DELETE FROM previews", []).unwrap();

    assert_eq!(rescan(&lib, &ctx, None).unwrap().previews_queued, 1);
    let state: String = lib
        .db()
        .query_row("SELECT state FROM previews", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "pending");
}

// ---------------------------------------------------------------------------------------------
// Beyond the legacy suite: the parent spec 8.2 edge cases, each as its own explicit test
// ---------------------------------------------------------------------------------------------

/// Adopt: a folder with files is adopted with its files indexed in the same pass, and a user's own
/// project metadata survives a later rescan.
#[test]
fn adopting_a_populated_folder_indexes_it_and_a_later_rescan_keeps_the_users_edits() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Found");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("a.stl"), "solid").unwrap();

    let first = rescan(&lib, &ctx, None).unwrap();
    assert_eq!((first.adopted, first.files_added), (1, 1));
    let project = list(&lib, &ctx).remove(0);
    lib.db()
        .execute(
            "UPDATE projects SET name = 'Renamed', notes = 'mine' WHERE id = ?",
            params![project.id],
        )
        .unwrap();

    let second = rescan(&lib, &ctx, None).unwrap();
    assert_eq!((second.adopted, second.files_added), (0, 0));
    let project = list(&lib, &ctx).remove(0);
    assert_eq!(project.name, "Renamed");
    assert_eq!(project.notes.as_deref(), Some("mine"));
}

/// Missing folder: the rescan summary counts it once, and the project row and its tags stay.
#[test]
fn a_missing_folder_keeps_the_projects_tags_and_row() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let created = spm_core::create_project(
        &lib,
        &ctx,
        spm_core::validate::CreateProjectInput {
            name: "Gone".to_owned(),
            tags: Some(vec!["petg".to_owned()]),
            ..Default::default()
        },
    )
    .unwrap();
    fs::remove_dir_all(root(&lib, "marc").join("Gone")).unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.marked_missing, 1);
    let listed = list(&lib, &ctx).remove(0);
    assert_eq!(listed.id, created.id);
    assert_eq!(listed.state, ProjectState::Missing);
    assert_eq!(listed.tags, ["petg"]);
}

/// Changed file: an edit to a `.3mf` that changes its slicer is reclassified, not just re-hashed.
#[test]
fn a_saved_3mf_that_changes_slicer_is_reclassified() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    let file = dir.join("benchy.3mf");
    cura_project(&file, None);
    rescan(&lib, &ctx, None).unwrap();

    crate::fixtures::prusa_project(&file, None);
    set_mtime(&file, five_seconds_later());
    rescan(&lib, &ctx, None).unwrap();

    let slicer: Option<String> = lib
        .db()
        .query_row("SELECT slicer FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(slicer.as_deref(), Some("prusaslicer"));
}

/// Dot-folder skipping applies to project folders too: a hidden folder at the root is not a
/// project.
#[test]
fn a_hidden_project_folder_is_never_adopted() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    fs::create_dir(root(&lib, "marc").join(".trash")).unwrap();
    assert_eq!(rescan(&lib, &ctx, None).unwrap().adopted, 0);
    assert!(list(&lib, &ctx).is_empty());
}

/// Progress callbacks run with no database lock held, so a callback may call back into the library.
#[test]
fn a_progress_callback_may_use_the_library() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let dir = root(&lib, "marc").join("Benchy");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("a.stl"), "solid").unwrap();

    let mut seen_projects = 0;
    let mut probe = |_: &RescanProgress| {
        seen_projects = list_projects(&lib, &ctx, &ProjectQuery::default())
            .unwrap()
            .len();
    };
    rescan(&lib, &ctx, Some(&mut probe)).unwrap();
    assert_eq!(seen_projects, 1);
}
