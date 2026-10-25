//! Ported from the Electron shell's `previews.test.ts`. The Electron shell had its own timer
//! around the queue (`startPreviewTicker`); here the loop is `spm_core::PreviewWorker`, which is
//! tested on its own in `spm-core`, so what is the *shell's* to test is how it configures and uses
//! one. The cases that were about the timer's own bookkeeping have no equivalent and are listed in
//! the migration report.

mod support;

use std::fs;
use std::thread;
use std::time::{Duration, Instant};

use spm_core::previews::MeshLimits;
use spm_core::{Library, OpenOptions, PreviewWorker, ensure_local_user, rescan};
use spm_shell::library::{
    LibraryHost, LibraryHostOptions, PREVIEW_BATCH_LIMIT, PREVIEW_CONCURRENCY, PREVIEW_INTERVAL,
    preview_config,
};
use support::{ScriptedPrompts, fixtures};

struct Row {
    name: String,
    state: String,
    error: Option<String>,
}

fn rows(lib: &Library) -> Vec<Row> {
    let conn = lib.db();
    let mut statement = conn
        .prepare(
            "SELECT f.rel_path, pv.state, pv.error FROM previews pv JOIN files f ON f.id = pv.file_id
             ORDER BY f.rel_path",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(Row {
                name: row.get(0)?,
                state: row.get(1)?,
                error: row.get(2)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if check() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

fn seeded_library(files: &[(&str, Vec<u8>)]) -> (tempfile::TempDir, Library) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("lib");
    fs::create_dir_all(dir.join("Project")).unwrap();
    for (name, bytes) in files {
        fs::write(dir.join("Project").join(name), bytes).unwrap();
    }
    let lib = Library::open(&dir, OpenOptions::default()).unwrap();
    let ctx = ensure_local_user(&lib).unwrap();
    rescan(&lib, &ctx, None).unwrap();
    (root, lib)
}

#[test]
fn the_shell_runs_previews_one_at_a_time_in_small_batches_every_five_seconds() {
    let config = preview_config();
    assert_eq!(
        config.concurrency, 1,
        "a desktop app next to a slicer: one render at a time"
    );
    assert_eq!(PREVIEW_CONCURRENCY, 1);
    assert_eq!(config.limit, 20);
    assert_eq!(PREVIEW_BATCH_LIMIT, 20);
    assert_eq!(PREVIEW_INTERVAL, Duration::from_secs(5));
    // The mesh ceiling is core's own default: the shell does not pick a second one.
    assert_eq!(config.limits, MeshLimits::default());
}

#[test]
fn the_first_run_starts_at_once_without_waiting_for_the_interval() {
    let (_root, lib) = seeded_library(&[
        ("a.stl", fixtures::cube_stl()),
        ("b.stl", fixtures::cube_stl()),
        ("c.stl", fixtures::cube_stl()),
    ]);
    // The shell's own settings, with the interval stretched far past the test: only the immediate
    // first run can have rendered anything.
    let worker = PreviewWorker::spawn(lib.clone(), preview_config(), Duration::from_secs(600));
    wait_until("all three previews to be ready", || {
        rows(&lib).iter().filter(|row| row.state == "ready").count() == 3
    });
    worker.stop();
}

#[test]
fn the_host_starts_the_real_worker_when_a_folder_opens_and_it_renders_without_being_asked() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("lib");
    fs::create_dir_all(dir.join("Project")).unwrap();
    fs::write(dir.join("Project").join("cube.stl"), fixtures::cube_stl()).unwrap();
    let host = LibraryHost::new(LibraryHostOptions::new(
        root.path().join("state.json"),
        ScriptedPrompts::new(),
    ));
    host.open(&dir, false).unwrap();
    let lib = host.session().unwrap().lib;
    // The folder was adopted by the rescan and the first worker run rendered it: well inside the
    // five second interval.
    let started = Instant::now();
    wait_until("the preview", || {
        rows(&lib).iter().any(|row| row.state == "ready")
    });
    assert!(started.elapsed() < PREVIEW_INTERVAL + Duration::from_secs(20));
    assert!(host.shutdown(Duration::from_secs(30)));
}

#[test]
fn a_stopped_worker_never_runs_again() {
    let (_root, lib) = seeded_library(&[("first.stl", fixtures::cube_stl())]);
    let worker = PreviewWorker::spawn(lib.clone(), preview_config(), Duration::from_millis(20));
    wait_until("the first preview", || {
        rows(&lib).iter().any(|row| row.state == "ready")
    });
    worker.stop();

    // A file indexed after the stop stays pending however long we wait.
    let ctx = ensure_local_user(&lib).unwrap();
    fs::write(
        lib.dir().join("Project").join("second.stl"),
        fixtures::cube_stl(),
    )
    .unwrap();
    rescan(&lib, &ctx, None).unwrap();
    thread::sleep(Duration::from_millis(400));
    let second = rows(&lib)
        .into_iter()
        .find(|row| row.name.ends_with("second.stl"))
        .unwrap();
    assert_eq!(second.state, "pending");
}

#[test]
fn a_model_that_cannot_be_rendered_is_marked_failed_and_the_worker_goes_on_to_the_next() {
    let (_root, lib) = seeded_library(&[
        ("a-broken.stl", b"this is not a mesh at all".to_vec()),
        ("b-good.stl", fixtures::cube_stl()),
    ]);
    let worker = PreviewWorker::spawn(lib.clone(), preview_config(), Duration::from_millis(20));
    wait_until("both rows to settle", || {
        rows(&lib)
            .iter()
            .all(|row| row.state == "ready" || row.state == "failed")
    });
    worker.stop();
    let rows = rows(&lib);
    let broken = rows
        .iter()
        .find(|row| row.name.ends_with("a-broken.stl"))
        .unwrap();
    let good = rows
        .iter()
        .find(|row| row.name.ends_with("b-good.stl"))
        .unwrap();
    // The bad one failed with a reason (or, for a format core cannot read at all, was set aside);
    // it did not stop the good one behind it from rendering.
    assert!(
        matches!(broken.state.as_str(), "failed" | "unsupported"),
        "{}",
        broken.state
    );
    assert!(broken.state == "unsupported" || broken.error.is_some());
    assert_eq!(good.state, "ready");
}
