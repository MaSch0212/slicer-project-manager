//! Starting a slicer: detached, with no console window, in a working directory the app chose, and
//! without anything of this process's secrets.
//!
//! The seam is [`SlicerSpawner`]: every test passes a recorder or a stub executable, and the real
//! one is [`ProcessSpawner`] over `std::process`.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// What an exit watch calls when the spawned process has ended.
pub type ExitCallback = Box<dyn FnOnce() + Send>;

/// Observation of the spawned process's exit, and the only observation the exit sweep may rest on.
///
/// What it deliberately does **not** promise: that the slicer closed. With `single_instance` on,
/// the spawned process hands the file to an already-running instance and exits while the slicer
/// stays open (measured), so an exit is the start of a settle period and never a conclusion.
pub trait ExitWatch: Send {
    /// Calls `callback` once, when the process has exited (immediately, if it already has).
    fn on_exit(self: Box<Self>, callback: ExitCallback);
}

/// The part of a spawned child this subsystem uses, and all of it. `exit` is `None` for a child
/// that cannot be watched: it still launched, and its session is one nothing will ever sweep.
pub struct SpawnedSlicer {
    pub pid: Option<u32>,
    pub exit: Option<Box<dyn ExitWatch>>,
}

/// Injected. The real one is [`ProcessSpawner`]; every test passes a recorder.
///
/// **`cwd` is required and the child never inherits one.** A slicer was measured resolving an
/// export path against its process working directory and writing into the repository it was
/// started from: an inherited cwd is whatever the user's desktop happened to hand this process.
pub trait SlicerSpawner: Send + Sync {
    fn spawn(&self, command: &str, args: &[String], cwd: &Path) -> Result<SpawnedSlicer, String>;
}

/// Environment variables the child never inherits: this app's own configuration (a remote server's
/// address, the data directory, test switches), the webview's, and Tauri's. Nothing of this
/// process's secrets is in its environment today (the per-launch secret lives in memory and a
/// cookie), so this is the guarantee that none ever creeps in by way of a variable.
pub const SCRUBBED_ENV_PREFIXES: [&str; 3] = ["SPM_", "WEBVIEW2_", "TAURI_"];

/// Whether a variable name is one the child must not inherit (case-insensitively: Windows).
pub fn is_scrubbed_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    SCRUBBED_ENV_PREFIXES
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`: no console is attached to (or created for) the
/// child, and it is outside this process's group, so closing or killing the app does not take the
/// slicer with it. A slicer is a GUI application: hiding *its* window would be the opposite of the
/// point, which is why this is not `CREATE_NO_WINDOW`.
#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn detach(_command: &mut Command) {}

/// The real spawner.
///
/// The child's environment is **exactly** the one this spawner was given minus
/// [`SCRUBBED_ENV_PREFIXES`] (never "whatever this process happens to have"), so what a slicer
/// inherits is a decision made here and testable with a chosen environment.
pub struct ProcessSpawner {
    environment: Box<dyn Fn() -> Vec<(OsString, OsString)> + Send + Sync>,
}

impl ProcessSpawner {
    /// This process's own environment, scrubbed.
    pub fn new() -> ProcessSpawner {
        ProcessSpawner {
            environment: Box::new(|| std::env::vars_os().collect()),
        }
    }

    /// A chosen environment, scrubbed: for tests, which cannot set this process's own.
    pub fn with_environment(environment: Vec<(OsString, OsString)>) -> ProcessSpawner {
        ProcessSpawner {
            environment: Box::new(move || environment.clone()),
        }
    }
}

impl Default for ProcessSpawner {
    fn default() -> Self {
        ProcessSpawner::new()
    }
}

impl SlicerSpawner for ProcessSpawner {
    fn spawn(&self, command: &str, args: &[String], cwd: &Path) -> Result<SpawnedSlicer, String> {
        let mut process = Command::new(command);
        process
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear();
        for (name, value) in (self.environment)() {
            if !is_scrubbed_env_name(&name.to_string_lossy()) {
                process.env(name, value);
            }
        }
        detach(&mut process);
        let mut child = process.spawn().map_err(|error| error.to_string())?;
        let pid = child.id();
        let state = Arc::new(Mutex::new(WaitState::default()));
        let waiter_state = Arc::clone(&state);
        // Reaps the child whether or not anybody is watching it, and wakes whoever is.
        std::thread::Builder::new()
            .name("slicer-exit-watch".to_owned())
            .spawn(move || {
                let _ = child.wait();
                let callback = {
                    let mut state = waiter_state.lock().unwrap_or_else(|e| e.into_inner());
                    state.exited = true;
                    state.callback.take()
                };
                if let Some(callback) = callback {
                    callback();
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(SpawnedSlicer {
            pid: Some(pid),
            exit: Some(Box::new(ProcessExit { state })),
        })
    }
}

#[derive(Default)]
struct WaitState {
    exited: bool,
    callback: Option<ExitCallback>,
}

struct ProcessExit {
    state: Arc<Mutex<WaitState>>,
}

impl ExitWatch for ProcessExit {
    fn on_exit(self: Box<Self>, callback: ExitCallback) {
        let run_now = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.exited {
                Some(callback)
            } else {
                state.callback = Some(callback);
                None
            }
        };
        if let Some(callback) = run_now {
            callback();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_apps_own_variables_are_scrubbed_and_the_slicers_are_not() {
        for name in [
            "SPM_REMOTE_URL",
            "spm_library_dir",
            "SPM_DESKTOP_USER_DATA",
            "WEBVIEW2_USER_DATA_FOLDER",
            "TAURI_ENV_DEBUG",
        ] {
            assert!(is_scrubbed_env_name(name), "{name}");
        }
        for name in [
            "PATH",
            "APPDATA",
            "USERPROFILE",
            "TEMP",
            "LOCALAPPDATA",
            "SPMX",
        ] {
            assert!(!is_scrubbed_env_name(name), "{name}");
        }
    }
}
