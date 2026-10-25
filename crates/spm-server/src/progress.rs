//! A single-line, in-place progress display for the command-line entry points.
//!
//! (The legacy HTTP server never streamed progress: its rescan and import routes answered with
//! the final result only. This is the CLI's display, the one place progress was ever shown.)
//!
//! Two things make this more than a `println!` in a loop:
//!
//! - **It throttles.** Core reports every file it touches, which for a real library is tens of
//!   thousands of callbacks; redrawing on each one would spend more time writing to the terminal
//!   than hashing.
//! - **It yields to log output.** The live line is written without a newline, so anything else
//!   printing would append to it and leave the half-line stranded. [`Progress::clear`] erases it
//!   first, which is what lets a logger and a progress line share one terminal.
//!
//! When stdout is not a terminal (a pipe, a file, CI) there is no cursor to move, so it falls back
//! to plain appended lines at a much slower cadence: a redirected log wants a readable history,
//! not 40 000 copies of the same sentence.

use std::io::{IsTerminal, Write};
use std::sync::{Arc, Mutex, PoisonError};

pub const TTY_INTERVAL_MS: i64 = 100;
pub const NON_TTY_INTERVAL_MS: i64 = 5000;

/// `\r` returns to column 0 and `ESC [ K` erases to the end of the line, so a shorter line never
/// leaves the tail of a longer one behind.
const ERASE_LINE: &str = "\r\x1b[K";

pub struct ProgressDeps {
    pub is_terminal: bool,
    pub write: Box<dyn Fn(&str) + Send + Sync>,
    /// Milliseconds on any monotonic-enough clock.
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
}

#[derive(Default)]
struct State {
    last_drawn_at: Option<i64>,
    dirty: bool,
}

struct Inner {
    deps: ProgressDeps,
    state: Mutex<State>,
}

/// Cheap to clone: the importer's callback and the logger's sink share one.
#[derive(Clone)]
pub struct Progress {
    inner: Arc<Inner>,
}

impl Progress {
    pub fn new(deps: ProgressDeps) -> Progress {
        Progress {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Writes to the process's stdout, detecting whether there is a terminal on the other end.
    pub fn stdout() -> Progress {
        let started = std::time::Instant::now();
        Progress::new(ProgressDeps {
            is_terminal: std::io::stdout().is_terminal(),
            write: Box::new(|text| {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(text.as_bytes());
                let _ = out.flush();
            }),
            now: Box::new(move || i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)),
        })
    }

    /// Redraws the live line, subject to throttling. `force` bypasses it for a phase change.
    pub fn update(&self, text: &str, force: bool) {
        let deps = &self.inner.deps;
        let at = (deps.now)();
        let interval = if deps.is_terminal {
            TTY_INTERVAL_MS
        } else {
            NON_TTY_INTERVAL_MS
        };
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !force && state.last_drawn_at.is_some_and(|last| at - last < interval) {
            return;
        }
        state.last_drawn_at = Some(at);
        if deps.is_terminal {
            self.clear_locked(&mut state);
            (deps.write)(text);
            state.dirty = true;
        } else {
            (deps.write)(&format!("{text}\n"));
        }
    }

    /// Erases the live line so something else can print cleanly. Safe to call repeatedly.
    pub fn clear(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        self.clear_locked(&mut state);
    }

    /// Erases the live line for good; nothing further is drawn until the next `update`, and that
    /// one is not held back by the throttle.
    pub fn done(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        self.clear_locked(&mut state);
        state.last_drawn_at = None;
    }

    fn clear_locked(&self, state: &mut State) {
        if !state.dirty {
            return;
        }
        (self.inner.deps.write)(ERASE_LINE);
        state.dirty = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct Harness {
        progress: Progress,
        out: Arc<Mutex<Vec<String>>>,
        clock: Arc<AtomicI64>,
    }

    impl Harness {
        fn new(is_terminal: bool) -> Harness {
            let out = Arc::new(Mutex::new(Vec::new()));
            let clock = Arc::new(AtomicI64::new(0));
            let (sink, now) = (Arc::clone(&out), Arc::clone(&clock));
            let progress = Progress::new(ProgressDeps {
                is_terminal,
                write: Box::new(move |text| sink.lock().unwrap().push(text.to_owned())),
                now: Box::new(move || now.load(Ordering::SeqCst)),
            });
            Harness {
                progress,
                out,
                clock,
            }
        }

        fn tick(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        fn written(&self) -> Vec<String> {
            self.out.lock().unwrap().clone()
        }

        fn reset(&self) {
            self.out.lock().unwrap().clear();
        }
    }

    #[test]
    fn a_terminal_gets_one_in_place_line_redrawn_no_faster_than_the_interval() {
        let h = Harness::new(true);
        h.progress.update("first", false);
        h.progress.update("too soon", false);
        h.tick(TTY_INTERVAL_MS);
        h.progress.update("second", false);

        // First draw, then erase and redraw for the second. "too soon" never reaches the terminal.
        assert_eq!(h.written(), ["first", "\r\x1b[K", "second"]);
    }

    #[test]
    fn force_bypasses_the_throttle_so_a_phase_change_is_never_swallowed() {
        let h = Harness::new(true);
        h.progress.update("indexing", false);
        h.progress.update("applying sidecars", true);
        assert!(
            h.written().contains(&"applying sidecars".to_owned()),
            "{:?}",
            h.written()
        );
    }

    #[test]
    fn clear_erases_the_live_line_exactly_once_so_a_log_line_starts_clean() {
        let h = Harness::new(true);
        h.progress.update("working", false);
        h.progress.clear();
        h.progress.clear();
        assert_eq!(h.written(), ["working", "\r\x1b[K"]);
    }

    #[test]
    fn clear_before_anything_is_drawn_writes_nothing() {
        let h = Harness::new(true);
        h.progress.clear();
        assert!(h.written().is_empty());
    }

    #[test]
    fn a_redraw_after_a_clear_does_not_erase_a_line_that_is_no_longer_there() {
        let h = Harness::new(true);
        h.progress.update("one", false);
        h.progress.clear();
        h.reset();
        h.tick(TTY_INTERVAL_MS);
        h.progress.update("two", false);
        // No stray escape: the line was already gone, so "two" is written straight out.
        assert_eq!(h.written(), ["two"]);
    }

    #[test]
    fn a_pipe_gets_appended_lines_at_a_slower_cadence_and_no_escape_codes() {
        let h = Harness::new(false);
        h.progress.update("first", false);
        h.tick(TTY_INTERVAL_MS);
        h.progress
            .update("swallowed, a pipe does not want 40k of these", false);
        h.tick(NON_TTY_INTERVAL_MS);
        h.progress.update("second", false);

        assert_eq!(h.written(), ["first\n", "second\n"]);
        assert!(
            !h.written().join("").contains('\x1b'),
            "an escape code reached a non-terminal"
        );
    }

    #[test]
    fn done_leaves_the_terminal_clean_and_lets_the_next_update_draw_immediately() {
        let h = Harness::new(true);
        h.progress.update("working", false);
        h.progress.done();
        assert_eq!(h.written(), ["working", "\r\x1b[K"]);

        h.reset();
        // No clock advance: done() resets the throttle, so a fresh run is not held back by it.
        h.progress.update("next run", false);
        assert_eq!(h.written(), ["next run"]);
    }
}
