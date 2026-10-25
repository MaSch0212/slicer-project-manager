//! Ported from the legacy `previews.test.ts`: embedded-thumbnail extraction and the preview queue
//! (claiming, the attempts counter, leases, the handler chain, and a rescan landing mid-render).
//!
//! The queue is synchronous here, so the legacy tests that held a promise open to model a render
//! still in flight run the queue on a second thread and gate the handler with a channel. The
//! Rust-only cases at the bottom cover what the legacy suite had no way to ask: a panicking
//! handler, a real multi-threaded batch, the batch entry point and the background worker.

use std::fs::{self, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use rusqlite::params;
use spm_core::clock::now_ms;
use spm_core::dto::{FileKind, PreviewState, ProjectQuery};
use spm_core::previews::embedded::extract_embedded_thumbnail;
use spm_core::previews::png::read_png_size;
use spm_core::previews::{
    BatchResult, DEFAULT_CONCURRENCY, MAX_PREVIEW_ATTEMPTS, PREVIEW_LEASE_MS, PreviewConfig,
    PreviewOutput, PreviewSource, PreviewWorker, QueueOptions, SharedHandler,
    claim_pending_previews, embedded_handler, handler_from_fn, run_preview_batch,
    run_preview_queue,
};
use spm_core::testing::TempLibrary;
use spm_core::{AppError, Library, get_project, list_projects, rescan};
use tempfile::tempdir;

use crate::fixtures::{
    bambu_lineage_project, cura_project, plain_mesh_3mf, prusa_project, stored, write_zip,
};
use crate::mesh_fixtures::make_png;
use crate::preview_support::{
    PreviewRow, counts, exec, only_row, png_on_disk, preview_rows, run_with, seed_project_dir,
};

const SLICER_PROJECT: &[FileKind] = &[FileKind::SlicerProject];

fn set_mtime(path: &Path, time: SystemTime) {
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

/// Rewrites a project file and moves its mtime forward, so the next rescan sees a changed file
/// whatever the file system's timestamp granularity.
fn rewrite_cura(path: &Path, width: u32, height: u32) {
    cura_project(path, Some(&make_png(width, height)));
    set_mtime(path, SystemTime::now() + Duration::from_secs(5));
}

fn extract(path: &Path) -> Option<spm_core::previews::embedded::EmbeddedThumbnail> {
    extract_embedded_thumbnail(path).unwrap()
}

#[test]
fn read_png_size_reads_ihdr_and_rejects_non_png_bytes() {
    assert_eq!(read_png_size(&make_png(300, 200)), Some((300, 200)));
    assert_eq!(read_png_size(b"not a png at all really"), None);
    assert_eq!(read_png_size(&[0u8; 4]), None);
}

#[test]
fn the_cura_thumbnail_is_extracted_at_its_measured_size() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.3mf");
    cura_project(&path, Some(&make_png(300, 300)));
    let found = extract(&path).unwrap();
    assert_eq!((found.width, found.height), (300, 300));
}

#[test]
fn the_prusaslicer_thumbnail_is_extracted() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.3mf");
    prusa_project(&path, Some(&make_png(256, 256)));
    assert_eq!(extract(&path).unwrap().width, 256);
}

#[test]
fn the_bambu_lineage_uses_plate_1_png_not_its_smaller_or_unlit_siblings() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.3mf");
    write_zip(
        &path,
        &[
            stored("Metadata/slice_info.config", "<config><header/></config>"),
            stored("Metadata/plate_1_small.png", make_png(128, 128)),
            stored("Metadata/plate_no_light_1.png", make_png(512, 512)),
            stored("Metadata/top_1.png", make_png(512, 512)),
            stored("Metadata/pick_1.png", make_png(512, 512)),
            stored("Metadata/plate_1.png", make_png(511, 509)),
        ],
        None,
    );
    // 511x509 is deliberately unique so only plate_1.png can satisfy this assertion.
    let found = extract(&path).unwrap();
    assert_eq!((found.width, found.height), (511, 509));
}

#[test]
fn a_project_file_with_no_embedded_thumbnail_yields_none() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.3mf");
    bambu_lineage_project(&path, &["X-BBL-Client-Type"], None);
    assert_eq!(extract(&path), None);
}

#[test]
fn the_queue_only_claims_kinds_a_handler_covers() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    cura_project(&dir.join("benchy.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    let claimed = claim_pending_previews(&lib, &[embedded_handler()], 10, now_ms()).unwrap();
    assert_eq!(
        claimed.iter().map(|job| job.kind).collect::<Vec<_>>(),
        [FileKind::SlicerProject]
    );
}

#[test]
fn running_the_queue_makes_a_slicer_project_preview_ready_and_writes_the_png() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("benchy.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    let result = run_preview_queue(&lib, &QueueOptions::default()).unwrap();
    assert_eq!(result, counts(1, 0, 0, 1));

    let row = only_row(&lib);
    assert_eq!(row.state, "ready");
    assert_eq!(row.source.as_deref(), Some("embedded"));
    assert_eq!(row.width, Some(300));
    assert_eq!(
        row.png_path,
        Some(format!(".spm/previews/{}.png", row.file_id))
    );
    let on_disk = png_on_disk(&lib, &row.file_id);
    assert!(on_disk.exists());
    assert_eq!(read_png_size(&fs::read(&on_disk).unwrap()).unwrap().0, 300);
    assert_eq!(row.source_hash.as_ref().map(Vec::len), Some(32));

    // The ready preview becomes the project cover.
    let listed = list_projects(&lib, &ctx, &ProjectQuery::default()).unwrap();
    assert_eq!(
        listed[0].cover_file_id.as_deref(),
        Some(row.file_id.as_str())
    );
    assert_eq!(
        get_project(&lib, &ctx, &listed[0].id).unwrap().files[0].preview_state,
        PreviewState::Ready
    );
}

#[test]
fn a_project_file_with_no_thumbnail_is_unsupported_not_failed() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    bambu_lineage_project(&dir.join("a.3mf"), &["X-BBL-Client-Type"], None);
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(
        run_preview_queue(&lib, &QueueOptions::default()).unwrap(),
        counts(0, 0, 1, 1)
    );
    // Deterministic absence, so it is never retried.
    assert_eq!(only_row(&lib).state, "unsupported");
}

#[test]
fn model_files_stay_pending_until_a_rasterizer_handler_exists() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("benchy.stl"), "solid").unwrap();
    plain_mesh_3mf(&dir.join("mesh.3mf"));
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(
        run_preview_queue(&lib, &QueueOptions::default()).unwrap(),
        BatchResult::default()
    );
    let states: Vec<String> = preview_rows(&lib)
        .into_iter()
        .map(|row| row.state)
        .collect();
    assert_eq!(states, ["pending", "pending"]);
}

fn exploding(message: &'static str) -> SharedHandler {
    handler_from_fn(SLICER_PROJECT, move |_| Err(AppError::internal(message)))
}

#[test]
fn a_handler_that_fails_fails_the_row_and_stops_after_max_preview_attempts() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("a.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    let handler = exploding("boom");
    for _ in 0..MAX_PREVIEW_ATTEMPTS {
        // Rows are re-queued between attempts so the retry budget is what bounds the loop.
        exec(&lib, "UPDATE previews SET state = 'pending'");
        run_with(&lib, vec![handler.clone()]);
    }
    let row = only_row(&lib);
    assert_eq!(row.state, "failed");
    assert_eq!(row.attempts, MAX_PREVIEW_ATTEMPTS);
    assert!(row.error.unwrap().contains("boom"));

    exec(&lib, "UPDATE previews SET state = 'pending'");
    assert!(
        claim_pending_previews(&lib, &[handler], 10, now_ms())
            .unwrap()
            .is_empty()
    );
}

/// A handler over `slicer_project` that records the call and answers however `answer` says.
#[derive(Clone, Copy)]
enum Answer {
    Decline,
    Throw,
    Render,
}

fn spy_handler(
    seen: &Arc<Mutex<Vec<String>>>,
    name: &'static str,
    answer: Answer,
) -> SharedHandler {
    let seen = Arc::clone(seen);
    handler_from_fn(SLICER_PROJECT, move |_| {
        seen.lock().unwrap().push(name.to_owned());
        match answer {
            Answer::Throw => Err(AppError::validation(format!("boom from {name}"))),
            Answer::Decline => Ok(None),
            Answer::Render => Ok(Some(PreviewOutput {
                bytes: make_png(64, 64),
                width: 64,
                height: 64,
                source: PreviewSource::Rasterized,
            })),
        }
    })
}

fn seen(list: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    list.lock().unwrap().clone()
}

fn one_cura_project(lib: &Library) {
    let (ctx, dir) = seed_project_dir(lib);
    cura_project(&dir.join("a.3mf"), Some(&make_png(300, 300)));
    rescan(lib, &ctx, None).unwrap();
}

#[test]
fn a_declining_handler_falls_through_to_the_next_and_the_first_non_null_answer_wins() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);

    // Before the chain existed the first matching handler's `None` ended the job as
    // `unsupported`, which is terminal: a later handler that could have rendered the file never
    // got the chance and no rescan ever gave it one.
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handlers = vec![
        spy_handler(&calls, "first", Answer::Decline),
        spy_handler(&calls, "second", Answer::Render),
        spy_handler(&calls, "third", Answer::Render),
    ];
    assert_eq!(run_with(&lib, handlers), counts(1, 0, 0, 1));
    // Third never ran: the chain stops at the first handler that produces something.
    assert_eq!(seen(&calls), ["first", "second"]);
    let row = only_row(&lib);
    assert_eq!(row.state, "ready");
    assert_eq!(row.source.as_deref(), Some("rasterized"));
    assert_eq!(row.width, Some(64));
}

#[test]
fn a_failure_fails_the_row_immediately_the_handlers_after_it_never_run() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);

    // The distinction the chain must not blur: `None` is "not my job", an error is "this file is
    // broken". Catching an error so it fell through to the next handler would turn a corrupt
    // model into a silent, never-retried `unsupported`, and here it would be masked completely,
    // because the handler after the failing one would have rendered it.
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handlers = vec![
        spy_handler(&calls, "first", Answer::Decline),
        spy_handler(&calls, "second", Answer::Throw),
        spy_handler(&calls, "third", Answer::Render),
    ];
    assert_eq!(run_with(&lib, handlers), counts(0, 1, 0, 1));
    assert_eq!(seen(&calls), ["first", "second"]);
    let row = only_row(&lib);
    assert_eq!(row.state, "failed");
    // The message survives, so the file is diagnosable from the row alone.
    assert!(row.error.as_deref().unwrap().contains("boom from second"));
    assert!(!png_on_disk(&lib, &row.file_id).exists());
}

#[test]
fn only_when_every_matching_handler_declines_is_the_job_unsupported() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);

    let calls = Arc::new(Mutex::new(Vec::new()));
    let handlers = vec![
        spy_handler(&calls, "first", Answer::Decline),
        spy_handler(&calls, "second", Answer::Decline),
        // Covers a different kind, so it is not part of this job's chain at all.
        handler_from_fn(&[FileKind::Model], |_| {
            Err(AppError::internal("wrong kind"))
        }),
    ];
    assert_eq!(run_with(&lib, handlers), counts(0, 0, 1, 1));
    assert_eq!(seen(&calls), ["first", "second"]);
    let row = only_row(&lib);
    assert_eq!(row.state, "unsupported");
    assert_eq!(row.error, None);
}

#[test]
fn the_default_concurrency_is_one_worker_which_is_a_memory_decision() {
    // Pinned where the constant lives, beside the doc comment carrying the reasoning that chose
    // it: each worker may hold one whole mesh, against a 500 MB budget on the deployment target.
    // Raising it is a deliberate act that has to redo that arithmetic and the README table, so it
    // fails here first.
    assert_eq!(DEFAULT_CONCURRENCY, 1);
    assert_eq!(QueueOptions::default().concurrency, 1);
    assert_eq!(PreviewConfig::default().concurrency, 1);
}

#[test]
fn the_queue_processes_a_batch_larger_than_its_concurrency() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    for i in 0..7 {
        cura_project(&dir.join(format!("p{i}.3mf")), Some(&make_png(64 + i, 64)));
    }
    rescan(&lib, &ctx, None).unwrap();

    let result = run_preview_queue(
        &lib,
        &QueueOptions {
            concurrency: 2,
            ..QueueOptions::default()
        },
    )
    .unwrap();
    assert_eq!(result, counts(7, 0, 0, 7));
}

/// Two 3mf files with embedded thumbnails, both queued pending.
fn seed_two_queued(lib: &Library) {
    let (ctx, dir) = seed_project_dir(lib);
    cura_project(&dir.join("a.3mf"), Some(&make_png(300, 300)));
    cura_project(&dir.join("b.3mf"), Some(&make_png(301, 300)));
    rescan(lib, &ctx, None).unwrap();
}

#[test]
fn a_run_in_flight_holds_its_rows_an_overlapping_tick_claims_nothing_and_redoes_nothing() {
    let lib = TempLibrary::new();
    seed_two_queued(&lib);

    let (started_tx, started_rx) = mpsc::channel::<String>();
    let slow = handler_from_fn(SLICER_PROJECT, move |job| {
        started_tx.send(job.file_id.clone()).unwrap();
        // Stands in for a rasterizer run that outlives one queue interval.
        thread::sleep(Duration::from_millis(80));
        Ok(None)
    });

    // The host fires the batch on a fixed interval. A render outlives one interval, so the next
    // tick must not re-select the same rows.
    let first = {
        let lib: Library = (*lib).clone();
        let slow = slow.clone();
        thread::spawn(move || {
            run_preview_queue(
                &lib,
                &QueueOptions {
                    concurrency: 2,
                    handlers: vec![slow],
                    ..QueueOptions::default()
                },
            )
            .unwrap()
        })
    };
    // The first run has claimed both rows before its first handler call, so once one call has
    // begun the overlapping tick has nothing left to take.
    let mut started = vec![started_rx.recv().unwrap()];
    let overlapping = run_with(&lib, vec![slow]);
    first.join().unwrap();
    started.extend(started_rx.try_iter());

    assert_eq!(overlapping, BatchResult::default());
    assert_eq!(started.len(), 2);
    assert_eq!(
        started
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        2
    );
}

#[test]
fn claiming_a_row_increments_attempts_so_a_crash_mid_job_still_burns_the_budget() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);

    // A handler still running is the hung case; a killed process is the same thing from the row's
    // point of view. Neither ever reaches the failure branch, so `attempts` has to move at claim
    // time or the file is retried forever (spec 7.3).
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let gate = Mutex::new(release_rx);
    let hanging = handler_from_fn(SLICER_PROJECT, move |_| {
        started_tx.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
        Ok(None)
    });
    let in_flight = {
        let lib: Library = (*lib).clone();
        let hanging = hanging.clone();
        thread::spawn(move || {
            run_preview_queue(
                &lib,
                &QueueOptions {
                    handlers: vec![hanging],
                    ..QueueOptions::default()
                },
            )
            .unwrap()
        })
    };
    started_rx.recv().unwrap();
    let row = only_row(&lib);
    assert_eq!(row.attempts, 1);
    assert_eq!(row.state, "pending");
    release_tx.send(()).unwrap();
    in_flight.join().unwrap();

    // Back to pending for the remaining budget, the way a restart would find it.
    exec(&lib, "UPDATE previews SET state = 'pending'");
    for i in 1..MAX_PREVIEW_ATTEMPTS {
        // A restart releases the abandoned lease; the retry budget is what bounds it.
        exec(&lib, "UPDATE previews SET claimed_at = NULL");
        assert_eq!(
            claim_pending_previews(&lib, std::slice::from_ref(&hanging), 10, now_ms())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(only_row(&lib).attempts, i + 1);
    }

    exec(&lib, "UPDATE previews SET claimed_at = NULL");
    assert!(
        claim_pending_previews(&lib, &[hanging], 10, now_ms())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_expired_lease_is_reclaimable_so_a_crash_does_not_strand_the_row_forever() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);
    let handlers = [embedded_handler()];

    assert_eq!(
        claim_pending_previews(&lib, &handlers, 10, now_ms())
            .unwrap()
            .len(),
        1
    );
    // Still leased: nothing else may take it.
    assert!(
        claim_pending_previews(&lib, &handlers, 10, now_ms())
            .unwrap()
            .is_empty()
    );

    lib.db()
        .execute(
            "UPDATE previews SET claimed_at = ?",
            params![now_ms() - PREVIEW_LEASE_MS - 1_000],
        )
        .unwrap();
    assert_eq!(
        claim_pending_previews(&lib, &handlers, 10, now_ms())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(only_row(&lib).attempts, 2);
}

#[test]
fn a_failing_handler_does_not_double_count_the_attempt_it_was_claimed_with() {
    let lib = TempLibrary::new();
    one_cura_project(&lib);

    assert_eq!(run_with(&lib, vec![exploding("boom")]), counts(0, 1, 0, 1));
    assert_eq!(only_row(&lib).attempts, 1);
}

#[test]
fn rescan_re_queueing_a_changed_file_releases_any_stale_claim_with_the_retry_budget() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("a.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();
    run_preview_queue(&lib, &QueueOptions::default()).unwrap();

    // The file changes on disk, so rescan re-queues it: `attempts` AND the lease both reset,
    // otherwise a file edited MAX_PREVIEW_ATTEMPTS times would stop previewing.
    rewrite_cura(&dir.join("a.3mf"), 320, 320);
    rescan(&lib, &ctx, None).unwrap();
    let row = only_row(&lib);
    assert_eq!(
        (row.state.as_str(), row.attempts, row.claimed_at),
        ("pending", 0, None)
    );
}

#[test]
fn a_rescan_mid_render_wins_the_stale_result_is_dropped_not_written_over_the_reset_row() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    let path = dir.join("a.3mf");
    cura_project(&path, Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    // A render that is still going when the user saves over the file: the rasterizer against a
    // large mesh is minutes (spec 7.1), and the desktop shell runs the queue every few seconds,
    // so a rescan landing inside one is ordinary rather than exotic.
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let gate = Mutex::new(release_rx);
    let slow = handler_from_fn(SLICER_PROJECT, move |_| {
        started_tx.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
        Ok(Some(PreviewOutput {
            bytes: make_png(300, 300),
            width: 300,
            height: 300,
            source: PreviewSource::Embedded,
        }))
    });
    let in_flight = {
        let lib: Library = (*lib).clone();
        thread::spawn(move || {
            run_preview_queue(
                &lib,
                &QueueOptions {
                    handlers: vec![slow],
                    ..QueueOptions::default()
                },
            )
            .unwrap()
        })
    };
    started_rx.recv().unwrap();

    rewrite_cura(&path, 120, 120);
    assert_eq!(rescan(&lib, &ctx, None).unwrap().previews_queued, 1);
    let row = only_row(&lib);
    assert_eq!(
        (row.state.as_str(), row.attempts, row.claimed_at),
        ("pending", 0, None)
    );

    // The job finishes holding a lease the row no longer carries, so it records nothing, and says
    // so in its counts, which is what stops `preview batch` reporting work it did not do.
    release_tx.send(()).unwrap();
    let dropped = in_flight.join().unwrap();
    assert_eq!(
        (dropped.ready, dropped.failed, dropped.unsupported),
        (0, 0, 0)
    );

    // Measured before the guard existed: this row read `ready` with the *old* render's 300x300
    // and the old `source_hash`, and it stayed that way for good: the rescan above had already
    // written the new size and mtime, so the next rescan takes the stat-match path and re-queues
    // nothing. The user's edited model kept its pre-edit thumbnail.
    let row = only_row(&lib);
    assert_eq!(
        (row.state.as_str(), row.attempts, row.claimed_at),
        ("pending", 0, None)
    );
    assert_eq!(rescan(&lib, &ctx, None).unwrap().previews_queued, 0);

    // Still pending means still claimable, so the next run renders the bytes that are there.
    assert_eq!(
        run_preview_queue(&lib, &QueueOptions::default()).unwrap(),
        counts(1, 0, 0, 1)
    );
    let row = only_row(&lib);
    assert_eq!((row.width, row.height), (Some(120), Some(120)));
}

// --- Rust-only: what the legacy single-threaded queue could not be asked --------------------

#[test]
fn a_panicking_handler_fails_its_row_instead_of_taking_the_batch_down() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("a.3mf"), Some(&make_png(300, 300)));
    cura_project(&dir.join("b.3mf"), Some(&make_png(301, 300)));
    rescan(&lib, &ctx, None).unwrap();

    let first = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&first);
    let handler = handler_from_fn(SLICER_PROJECT, move |_| {
        assert!(
            counter.fetch_add(1, Ordering::SeqCst) != 0,
            "a bug in a handler"
        );
        Ok(Some(PreviewOutput {
            bytes: make_png(64, 64),
            width: 64,
            height: 64,
            source: PreviewSource::Rasterized,
        }))
    });
    assert_eq!(run_with(&lib, vec![handler]), counts(1, 1, 0, 2));
    let failed: Vec<PreviewRow> = preview_rows(&lib)
        .into_iter()
        .filter(|row| row.state == "failed")
        .collect();
    assert_eq!(failed.len(), 1);
    assert!(
        failed[0]
            .error
            .as_deref()
            .unwrap()
            .contains("a bug in a handler"),
        "{:?}",
        failed[0].error
    );
}

#[test]
fn a_batch_on_several_threads_records_every_outcome_exactly_once() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    for i in 0..24 {
        cura_project(
            &dir.join(format!("p{i:02}.3mf")),
            Some(&make_png(64 + i, 64)),
        );
    }
    rescan(&lib, &ctx, None).unwrap();

    let result = run_preview_queue(
        &lib,
        &QueueOptions {
            concurrency: 4,
            ..QueueOptions::default()
        },
    )
    .unwrap();
    assert_eq!(result, counts(24, 0, 0, 24));
    let rows = preview_rows(&lib);
    assert!(
        rows.iter()
            .all(|row| row.state == "ready" && row.attempts == 1)
    );
    // Each row got its own picture: widths 64..88, one each.
    let mut widths: Vec<i64> = rows.iter().filter_map(|row| row.width).collect();
    widths.sort_unstable();
    assert_eq!(widths, (64..88).collect::<Vec<i64>>());
}

#[test]
fn the_batch_limit_bounds_how_many_rows_one_run_claims() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    for i in 0..5 {
        cura_project(&dir.join(format!("p{i}.3mf")), Some(&make_png(64 + i, 64)));
    }
    rescan(&lib, &ctx, None).unwrap();

    let options = QueueOptions {
        limit: 2,
        ..QueueOptions::default()
    };
    assert_eq!(run_preview_queue(&lib, &options).unwrap().claimed, 2);
    assert_eq!(run_preview_queue(&lib, &options).unwrap().claimed, 2);
    assert_eq!(run_preview_queue(&lib, &options).unwrap().claimed, 1);
    assert_eq!(run_preview_queue(&lib, &options).unwrap().claimed, 0);
}

#[test]
fn run_preview_batch_runs_the_production_chain_with_the_configured_ceiling() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("with-thumb.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    // The embedded thumbnail wins over the rasterizer, and no ceiling can refuse a picture that
    // was never parsed.
    let config = PreviewConfig {
        concurrency: 2,
        limits: spm_core::previews::MeshLimits { max_mesh_bytes: 1 },
        ..PreviewConfig::default()
    };
    assert_eq!(
        run_preview_batch(&lib, &config).unwrap(),
        counts(1, 0, 0, 1)
    );
    assert_eq!(only_row(&lib).source.as_deref(), Some("embedded"));
}

#[test]
fn the_background_worker_runs_the_queue_on_its_interval_and_stops_cleanly() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    cura_project(&dir.join("first.3mf"), Some(&make_png(300, 300)));
    rescan(&lib, &ctx, None).unwrap();

    let worker = PreviewWorker::spawn(
        (*lib).clone(),
        PreviewConfig::default(),
        Duration::from_millis(20),
    );
    let wait_until_ready = |expected: usize| {
        for _ in 0..500 {
            let ready = preview_rows(&lib)
                .iter()
                .filter(|row| row.state == "ready")
                .count();
            if ready == expected {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("the worker never produced {expected} ready previews");
    };
    wait_until_ready(1);

    // A file indexed while the worker is already running is picked up on a later tick.
    cura_project(&dir.join("second.3mf"), Some(&make_png(301, 300)));
    rescan(&lib, &ctx, None).unwrap();
    wait_until_ready(2);

    worker.stop();
    // Stopped means stopped: a third file is left pending however long we wait.
    cura_project(&dir.join("third.3mf"), Some(&make_png(302, 300)));
    rescan(&lib, &ctx, None).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        preview_rows(&lib)
            .iter()
            .filter(|row| row.state == "pending")
            .count(),
        1
    );
}
