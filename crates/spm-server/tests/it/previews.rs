//! The preview queue as the server runs it: on an interval, off the request path, and surviving
//! whatever a model does to it.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use spm_core::dto::FileKind;
use spm_core::log::{LogLevel, LogLevelSetting};
use spm_core::previews::{QueueOptions, handler_from_fn, run_preview_queue};
use spm_core::testing::{LogCapture, seed_user};
use spm_core::validate::CreateProjectInput;
use spm_core::{AppError, BatchResult, Ctx, Library, create_project, rescan};
use spm_server::serve::run_passes;

use crate::common::{cube_stl, env_for, http, open, start};

/// An owned project with one STL in it, indexed and waiting for a preview.
fn library_with_a_pending_model(dir: &std::path::Path) -> (Library, Ctx) {
    let lib = open(dir, None);
    let ctx = seed_user(&lib, "marc");
    let project = create_project(
        &lib,
        &ctx,
        CreateProjectInput {
            name: "Cube".into(),
            website: None,
            notes: None,
            tags: None,
        },
    )
    .unwrap();
    std::fs::write(dir.join("marc").join("Cube").join("cube.stl"), cube_stl()).unwrap();
    let result = rescan(&lib, &ctx, None).unwrap();
    assert_eq!(result.previews_queued, 1, "{project:?}");
    (lib, ctx)
}

fn preview_states(lib: &Library) -> Vec<(String, Option<String>)> {
    let conn = lib.db();
    let mut statement = conn
        .prepare("SELECT state, error FROM previews ORDER BY file_id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn wait_for<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(found) = check() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_renders_pending_previews_on_its_interval() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, _) = library_with_a_pending_model(dir.path());
    assert_eq!(preview_states(&lib)[0].0, "pending");

    let server = start(lib.clone(), &env_for(dir.path(), 50)).await;
    let watching = lib.clone();
    tokio::task::spawn_blocking(move || {
        wait_for("the preview to be rendered", || {
            (preview_states(&watching)[0].0 == "ready").then_some(())
        });
    })
    .await
    .unwrap();

    // The PNG is on disk where the library says, and the API is still answering meanwhile.
    let previews = dir.path().join(".spm").join("previews");
    assert_eq!(std::fs::read_dir(previews).unwrap().count(), 1);
    assert_eq!(
        http(server.addr, "GET", "/api/capabilities", &[])
            .await
            .status,
        200
    );
    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pass_that_panics_is_logged_and_the_loop_carries_on() {
    let dir = tempfile::tempdir().unwrap();
    let capture = LogCapture::default();
    let logger = capture.logger(LogLevelSetting::Trace);
    let lib = open(dir.path(), Some(logger.clone()));
    let passes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&passes);

    let looping = tokio::spawn(run_passes(
        lib,
        Duration::from_millis(20),
        logger,
        move |_lib| {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("a parser bug nobody has met yet");
            }
            Ok(BatchResult::default())
        },
    ));

    tokio::task::spawn_blocking({
        let passes = Arc::clone(&passes);
        move || {
            wait_for("a pass after the panicking one", || {
                (passes.load(Ordering::SeqCst) >= 3).then_some(())
            })
        }
    })
    .await
    .unwrap();
    assert!(!looping.is_finished(), "the loop died with the panic");
    looping.abort();

    let failure = capture
        .find("preview queue run failed")
        .expect("the panic is logged");
    assert_eq!(failure.level, LogLevel::Error);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_pass_is_logged_and_the_loop_carries_on() {
    let dir = tempfile::tempdir().unwrap();
    let capture = LogCapture::default();
    let logger = capture.logger(LogLevelSetting::Trace);
    let lib = open(dir.path(), Some(logger.clone()));
    let passes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&passes);

    let looping = tokio::spawn(run_passes(
        lib,
        Duration::from_millis(20),
        logger,
        move |_lib| {
            counted.fetch_add(1, Ordering::SeqCst);
            Err(AppError::internal("the queue could not claim"))
        },
    ));
    tokio::task::spawn_blocking({
        let passes = Arc::clone(&passes);
        move || {
            wait_for("several passes", || {
                (passes.load(Ordering::SeqCst) >= 3).then_some(())
            })
        }
    })
    .await
    .unwrap();
    looping.abort();
    assert!(capture.find("preview queue run failed").is_some());
}

/// The claim that matters, end to end: one malformed model that trips a bug in its parser fails
/// its own preview and nothing else. The server keeps answering requests, and the next pass
/// carries on with the rest of the library.
#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_preview_handler_fails_its_row_and_does_not_take_the_server_down() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, _) = library_with_a_pending_model(dir.path());
    // The interval is long so the server's own loop does not race the queue run below for the row.
    let server = start(lib.clone(), &env_for(dir.path(), 3_600_000)).await;

    let queue_lib = lib.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_preview_queue(
            &queue_lib,
            &QueueOptions {
                concurrency: 1,
                limit: 10,
                handlers: vec![handler_from_fn(&[FileKind::Model], |_job| {
                    panic!("an index out of range in a parser");
                })],
            },
        )
    })
    .await
    .expect("the panic does not escape the queue")
    .expect("the batch itself succeeds");
    assert_eq!(result.claimed, 1);
    assert_eq!(result.failed, 1);

    let states = preview_states(&lib);
    assert_eq!(states[0].0, "failed");
    assert!(
        states[0]
            .1
            .as_deref()
            .is_some_and(|error| error.contains("panicked")),
        "{states:?}"
    );

    // And the server never noticed.
    assert_eq!(
        http(server.addr, "GET", "/api/capabilities", &[])
            .await
            .status,
        200
    );
    server.stop().await;
}
