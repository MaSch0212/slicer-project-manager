//! A background thread that runs the preview queue on an interval.
//!
//! For a host with no async runtime to hang a timer on (the desktop app). A server that has one
//! calls [`super::run_preview_batch`] from its own interval instead.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::queue::{PreviewConfig, run_preview_batch};
use crate::db::Library;
use crate::fields;
use crate::log::LogValue;

/// Runs [`run_preview_batch`] on its own thread, once at start and then `interval` after each
/// batch finishes, so two batches of one worker never overlap however slow one is.
///
/// Dropping the worker (or [`PreviewWorker::stop`]) asks it to stop and **waits for it**: a batch
/// that is already running finishes first, because a render cannot be interrupted, and then the
/// thread exits without starting another. It never leaves a thread behind.
#[derive(Debug)]
pub struct PreviewWorker {
    stop: Option<Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl PreviewWorker {
    /// Starts the worker on `lib` (a cheap clone of the host's handle).
    pub fn spawn(lib: Library, config: PreviewConfig, interval: Duration) -> PreviewWorker {
        let (stop, stopped) = mpsc::channel::<()>();
        let handle = thread::Builder::new()
            .name("spm-previews".to_owned())
            .spawn(move || {
                loop {
                    if let Err(error) = run_preview_batch(&lib, &config) {
                        lib.log().error(
                            "preview batch failed",
                            fields!["err" => LogValue::error(&error)],
                        );
                    }
                    // A message and a dropped sender both mean "stop"; only a timeout means "go
                    // round again".
                    if !matches!(
                        stopped.recv_timeout(interval),
                        Err(RecvTimeoutError::Timeout)
                    ) {
                        return;
                    }
                }
            })
            .ok();
        PreviewWorker {
            stop: Some(stop),
            handle,
        }
    }

    /// Stops the worker and waits for it to finish.
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for PreviewWorker {
    fn drop(&mut self) {
        // Dropping the sender wakes the thread's wait at once.
        drop(self.stop.take());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
