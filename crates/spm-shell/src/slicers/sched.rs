//! The two things the session lifecycle needs from time and from the filesystem, as seams.
//!
//! Every number in [`crate::slicers::sessions`] (the 60 s settle window, the 10 s exit settle, the
//! 90 day record retention, the 5 s poll) is a duration, and a suite that waited on any of them
//! would either take minutes or assert nothing about them. So timers are a trait
//! ([`Scheduler`]): the real one is one background thread ([`ThreadScheduler`]); the tests move a
//! clock by hand. The directory watch is a trait too ([`DirectoryWatcher`]): the real one is
//! `notify`'s recommended watcher.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::io;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// A handle to cancel a timer with.
pub type TimerId = u64;

/// `setTimeout` / `setInterval`, narrowed to what the session lifecycle calls.
pub trait Scheduler: Send + Sync {
    /// Runs `task` once, `ms` from now.
    fn after(&self, ms: u64, task: Box<dyn FnOnce() + Send>) -> TimerId;
    /// Runs `task` every `ms`, first `ms` from now.
    fn every(&self, ms: u64, task: Arc<dyn Fn() + Send + Sync>) -> TimerId;
    /// Cancels a timer; cancelling one that already ran (or never was) is not an error.
    fn cancel(&self, id: TimerId);
}

/// A watcher on one directory. Dropping it stops the watch.
pub trait WatchHandle: Send {}

/// What `notify` gives this module, and all of it.
pub trait DirectoryWatcher: Send + Sync {
    /// Calls `on_change` for every event under `directory` (not its subdirectories). An error means
    /// the directory could not be watched: the caller carries on, because the watch is an
    /// optimisation and correctness never rests on it.
    fn watch(
        &self,
        directory: &Path,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> io::Result<Box<dyn WatchHandle>>;
}

// ---------------------------------------------------------------------------------------------
// The real watcher
// ---------------------------------------------------------------------------------------------

struct NotifyHandle {
    _watcher: RecommendedWatcher,
}

impl WatchHandle for NotifyHandle {}

/// The real directory watcher.
pub struct NotifyWatcher;

impl DirectoryWatcher for NotifyWatcher {
    fn watch(
        &self,
        directory: &Path,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> io::Result<Box<dyn WatchHandle>> {
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                // An `Err` is the watch breaking (the directory went away underneath it): nothing to
                // compare, and the poll is still running.
                if event.is_ok() {
                    on_change();
                }
            })
            .map_err(io::Error::other)?;
        watcher
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
        Ok(Box::new(NotifyHandle { _watcher: watcher }))
    }
}

// ---------------------------------------------------------------------------------------------
// The real scheduler
// ---------------------------------------------------------------------------------------------

enum Job {
    Once(Option<Box<dyn FnOnce() + Send>>),
    Every {
        period: Duration,
        task: Arc<dyn Fn() + Send + Sync>,
    },
}

struct State {
    next_id: TimerId,
    jobs: HashMap<TimerId, Job>,
    /// Due time first; the id breaks ties in creation order.
    queue: BinaryHeap<Reverse<(Instant, TimerId)>>,
    shutdown: bool,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

/// One background thread running every timer, so a tracked launch costs a heap entry and not a
/// thread. A task that takes long (hashing a large archive) delays the others, which is fine: they
/// are a poll and a backstop.
pub struct ThreadScheduler {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl ThreadScheduler {
    pub fn new() -> ThreadScheduler {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                next_id: 1,
                jobs: HashMap::new(),
                queue: BinaryHeap::new(),
                shutdown: false,
            }),
            wake: Condvar::new(),
        });
        let worker = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("slicer-sessions-timers".to_owned())
            .spawn(move || run(&worker))
            .ok();
        ThreadScheduler {
            shared,
            thread: Mutex::new(thread),
        }
    }

    fn add(&self, delay: Duration, job: Job) -> TimerId {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let id = state.next_id;
        state.next_id += 1;
        state.jobs.insert(id, job);
        state.queue.push(Reverse((Instant::now() + delay, id)));
        self.shared.wake.notify_all();
        id
    }

    /// Stops the thread and drops every pending timer. Pending work is abandoned, not run.
    pub fn shutdown(&self) {
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.shutdown = true;
            state.jobs.clear();
            state.queue.clear();
            self.shared.wake.notify_all();
        }
        if let Some(thread) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = thread.join();
        }
    }
}

impl Default for ThreadScheduler {
    fn default() -> Self {
        ThreadScheduler::new()
    }
}

impl Drop for ThreadScheduler {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run(shared: &Shared) {
    let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if state.shutdown {
            return;
        }
        let Some(Reverse((due, id))) = state.queue.peek().copied() else {
            state = shared.wake.wait(state).unwrap_or_else(|e| e.into_inner());
            continue;
        };
        let now = Instant::now();
        if due > now {
            state = shared
                .wake
                .wait_timeout(state, due - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
            continue;
        }
        state.queue.pop();
        // A cancelled timer's queue entry is still there; its job is not.
        let Some(job) = state.jobs.get_mut(&id) else {
            continue;
        };
        let task: Box<dyn FnOnce() + Send> = match job {
            Job::Once(task) => match task.take() {
                Some(task) => {
                    state.jobs.remove(&id);
                    task
                }
                None => {
                    state.jobs.remove(&id);
                    continue;
                }
            },
            Job::Every { period, task } => {
                let (period, task) = (*period, Arc::clone(task));
                state.queue.push(Reverse((Instant::now() + period, id)));
                Box::new(move || task())
            }
        };
        // Never held across a task: a task may itself schedule or cancel.
        drop(state);
        task();
        state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    }
}

impl Scheduler for ThreadScheduler {
    fn after(&self, ms: u64, task: Box<dyn FnOnce() + Send>) -> TimerId {
        self.add(Duration::from_millis(ms), Job::Once(Some(task)))
    }

    fn every(&self, ms: u64, task: Arc<dyn Fn() + Send + Sync>) -> TimerId {
        let period = Duration::from_millis(ms.max(1));
        self.add(period, Job::Every { period, task })
    }

    fn cancel(&self, id: TimerId) {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .jobs
            .remove(&id);
    }
}
