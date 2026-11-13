//! Watching a library folder, so a project folder made in Explorer or a file a slicer saved shows
//! up without anybody pressing "rescan".
//!
//! **What it reports is "something settled", never what changed.** The answer to a change is the
//! ordinary [`crate::projects::rescan::rescan`], whose steady state is a stat of every file and
//! which already knows how to adopt a folder, index a file and forget one that is gone. A watcher
//! that tried to apply each event itself would have to get every editor's save dance right (write a
//! temporary, delete the original, rename the temporary over it: several events, in an order that
//! differs per program); one rescan after the dust has settled gets all of them right by
//! construction.
//!
//! **Settled** means no event for [`QUIET_MS`], or [`MAX_WAIT_MS`] since the first one, whichever
//! comes first: a long copy into the library is indexed in instalments rather than not at all.
//!
//! Events under a dot-entry (the library's own `.spm` folder, whose database and previews change
//! on every rescan and would otherwise feed the watcher its own output) and for transient files
//! ([`is_transient_name`]) are dropped before they count.

use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// How long the folder has to be quiet before it counts as settled.
pub const QUIET_MS: u64 = 1_200;
/// The longest a burst of events can put the answer off.
pub const MAX_WAIT_MS: u64 = 8_000;

/// A file name that is somebody's work in progress rather than a file of the library: a partial
/// download, a temporary an editor writes before renaming it over the real one, an Office lock
/// file. The rescan skips these too, so a slicer's half-written save never becomes a project file
/// with a preview attempt of its own.
pub fn is_transient_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.starts_with("~$")
        || [
            ".tmp",
            ".temp",
            ".part",
            ".partial",
            ".crdownload",
            ".download",
            ".spm-download",
            ".spm-sync",
            "~",
        ]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

/// Whether a path the watcher reported is one that should wake it: not under any dot-entry below
/// the root, and not a transient file.
pub fn is_relevant_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        // Outside the root (a rename out of it reports the old path inside and the new one
        // outside): the part inside is what matters, and that arrives as its own path.
        return false;
    };
    let mut components = relative.components().peekable();
    if components.peek().is_none() {
        // The root itself: a rename or deletion of the whole library is worth a look.
        return true;
    }
    for component in components {
        if let Component::Normal(name) = component
            && is_transient_name(&name.to_string_lossy())
        {
            return false;
        }
    }
    true
}

/// A running watch. Dropping it stops the watch and its thread.
pub struct LibraryWatch {
    // Dropped first, which closes the event channel and ends the thread's loop.
    watcher: Option<RecommendedWatcher>,
    stop: Option<Sender<WatchMessage>>,
    thread: Option<JoinHandle<()>>,
}

enum WatchMessage {
    Event,
    Stop,
}

impl LibraryWatch {
    /// Watches `root` recursively and calls `on_settled` on a thread of its own each time a burst
    /// of relevant events has settled.
    pub fn start(
        root: &Path,
        on_settled: impl Fn() + Send + 'static,
    ) -> notify::Result<LibraryWatch> {
        Self::start_with(root, QUIET_MS, MAX_WAIT_MS, on_settled)
    }

    /// [`LibraryWatch::start`] with the timings given, for tests.
    pub fn start_with(
        root: &Path,
        quiet_ms: u64,
        max_wait_ms: u64,
        on_settled: impl Fn() + Send + 'static,
    ) -> notify::Result<LibraryWatch> {
        let root: PathBuf = root.to_path_buf();
        let (sender, receiver) = mpsc::channel::<WatchMessage>();
        let events = sender.clone();
        let filter_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    // An overflowed or failed watch: a rescan is the safe answer to "something may
                    // have changed".
                    let _ = events.send(WatchMessage::Event);
                    return;
                };
                if event.paths.is_empty()
                    || event
                        .paths
                        .iter()
                        .any(|path| is_relevant_path(&filter_root, path))
                {
                    let _ = events.send(WatchMessage::Event);
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let quiet = Duration::from_millis(quiet_ms);
        let max_wait = Duration::from_millis(max_wait_ms);
        let thread = std::thread::Builder::new()
            .name("spm-library-watch".to_owned())
            .spawn(move || {
                loop {
                    // Wait for the first event of a burst.
                    match receiver.recv() {
                        Ok(WatchMessage::Event) => {}
                        Ok(WatchMessage::Stop) | Err(_) => return,
                    }
                    let first = Instant::now();
                    // Then for the burst to end.
                    loop {
                        let left = max_wait.saturating_sub(first.elapsed());
                        if left.is_zero() {
                            break;
                        }
                        match receiver.recv_timeout(quiet.min(left)) {
                            Ok(WatchMessage::Event) => continue,
                            Ok(WatchMessage::Stop) | Err(RecvTimeoutError::Disconnected) => {
                                return;
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                        }
                    }
                    on_settled();
                }
            })
            .map_err(notify::Error::io)?;
        Ok(LibraryWatch {
            watcher: Some(watcher),
            stop: Some(sender),
            thread: Some(thread),
        })
    }
}

impl Drop for LibraryWatch {
    fn drop(&mut self) {
        drop(self.watcher.take());
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(WatchMessage::Stop);
        }
        if let Some(thread) = self.thread.take()
            // Never join from inside the callback's own thread (a callback that drops the watch).
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn transient_names_are_the_work_in_progress_kinds() {
        for name in [
            ".spm",
            "benchy.3mf.tmp",
            "model.STL.part",
            "x.crdownload",
            "~$notes.docx",
            "draft.3mf~",
            "a.stl.spm-download",
            "a.stl.spm-sync",
        ] {
            assert!(is_transient_name(name), "{name}");
        }
        for name in [
            "benchy.3mf",
            "notes.txt",
            "Temperature Tower.stl",
            "tmp.stl",
        ] {
            assert!(!is_transient_name(name), "{name}");
        }
    }

    #[test]
    fn paths_under_a_dot_folder_or_transient_are_not_relevant() {
        let root = Path::new("/lib");
        assert!(is_relevant_path(root, Path::new("/lib/Benchy/benchy.stl")));
        assert!(is_relevant_path(root, Path::new("/lib/New Project")));
        assert!(is_relevant_path(root, Path::new("/lib")));
        assert!(!is_relevant_path(root, Path::new("/lib/.spm/app.db")));
        assert!(!is_relevant_path(
            root,
            Path::new("/lib/.spm/previews/x.png")
        ));
        assert!(!is_relevant_path(
            root,
            Path::new("/lib/Benchy/benchy.3mf.tmp")
        ));
        assert!(!is_relevant_path(root, Path::new("/elsewhere/file.stl")));
    }

    fn wait_for(count: &AtomicUsize, at_least: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if count.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_burst_of_changes_settles_into_one_call_and_the_spm_folder_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".spm")).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        let watch = LibraryWatch::start_with(dir.path(), 300, 3_000, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        // The library's own database changing is not a change of the library.
        std::fs::write(dir.path().join(".spm").join("app.db"), b"x").unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(count.load(Ordering::SeqCst), 0);

        // A folder and three files in quick succession: one answer.
        let project = dir.path().join("New Project");
        std::fs::create_dir_all(&project).unwrap();
        for name in ["a.stl", "b.stl", "c.stl"] {
            std::fs::write(project.join(name), b"solid").unwrap();
        }
        assert!(wait_for(&count, 1));
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(watch);
    }
}
