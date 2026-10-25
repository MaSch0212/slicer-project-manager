//! What the shell remembers between launches, and the one file it writes it to.
//!
//! Three keys that have to move together or not at all: the **mode** (local folder or remote
//! server), the folder, and the server's origin. The writer is atomic and fsync'd
//! ([`crate::json_store`]) so a torn write costs nothing: the old file or the new one, never half.

use std::io;
use std::path::Path;

use serde_json::{Map, Value};

use crate::diag;
use crate::json_store::{FsIo, JsonStoreIo, write_json_file_with};

/// The file under the app's data directory that carries all of it.
pub const STATE_FILE_NAME: &str = "state.json";

/// Which of spec 2.6's two modes the shell is in.
///
/// "Unset" is not one of them and is deliberately not in this type: it is the absence of an answer,
/// which the state file spells by having no `mode` key at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellMode {
    Local,
    Remote,
}

impl ShellMode {
    fn as_str(self) -> &'static str {
        match self {
            ShellMode::Local => "local",
            ShellMode::Remote => "remote",
        }
    }
}

/// The folder key, unchanged from the Electron shell so a `state.json` it wrote still reopens its
/// folder.
pub const REMEMBERED_DIR_KEY: &str = "libraryDir";
pub const MODE_KEY: &str = "mode";
pub const REMOTE_URL_KEY: &str = "remoteUrl";

pub type ShellState = Map<String, Value>;

/// Reads the state file; anything unreadable is "nothing remembered".
pub fn read_state(state_file: &Path) -> ShellState {
    read_state_with(state_file, &mut diag::warn)
}

/// [`read_state`] with the warning sink chosen by the caller.
///
/// A missing file is first run, or a data directory that has just been wiped, and is the one case
/// worth no words. Everything else (permission denied, a directory where the file should be, an
/// I/O error, malformed JSON, JSON that is not an object) returns the user to the picker with
/// their choice apparently forgotten, and a silent catch would leave that with no explanation in
/// any log.
pub fn read_state_with(state_file: &Path, warn: &mut dyn FnMut(&str)) -> ShellState {
    let text = match std::fs::read_to_string(state_file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return ShellState::new(),
        Err(error) => {
            warn(&format!("could not read {STATE_FILE_NAME}: {error}"));
            return ShellState::new();
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            warn(&format!(
                "ignoring an unreadable {STATE_FILE_NAME}: not an object"
            ));
            ShellState::new()
        }
        Err(error) => {
            warn(&format!(
                "ignoring an unreadable {STATE_FILE_NAME}: {error}"
            ));
            ShellState::new()
        }
    }
}

fn read_string(state_file: &Path, key: &str) -> Option<String> {
    match read_state(state_file).get(key) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

pub fn read_remembered_dir(state_file: &Path) -> Option<String> {
    read_string(state_file, REMEMBERED_DIR_KEY)
}

pub fn read_remembered_remote(state_file: &Path) -> Option<String> {
    read_string(state_file, REMOTE_URL_KEY)
}

/// The remembered mode, or `None` when there is none.
///
/// **Absent and unrecognised are different answers**, and conflating them was a real bug in the
/// Electron shell: an unknown `mode` used to fall through to the same fallback as a missing one,
/// so a `state.json` that said `"mode": "cloud"` beside a folder silently opened that folder.
///
/// - **Absent** is a file written before modes existed: a folder and no `mode`. It reads as
///   `Local`, so upgrading does not throw anyone back to a question they already answered.
/// - **Unrecognised** (hand-edited, or written by a newer version) is `None`, which asks. The file
///   was written by something whose intent this code does not know, and the keys beside the one it
///   cannot read are no more trustworthy than the one it cannot.
pub fn read_remembered_mode(state_file: &Path) -> Option<ShellMode> {
    read_remembered_mode_with(state_file, &mut diag::warn)
}

pub fn read_remembered_mode_with(
    state_file: &Path,
    warn: &mut dyn FnMut(&str),
) -> Option<ShellMode> {
    match read_state(state_file).get(MODE_KEY) {
        Some(Value::String(value)) if value == "local" => return Some(ShellMode::Local),
        Some(Value::String(value)) if value == "remote" => return Some(ShellMode::Remote),
        Some(_) => {
            warn(&format!(
                "ignoring an unknown {MODE_KEY} in {STATE_FILE_NAME}"
            ));
            return None;
        }
        None => {}
    }
    read_remembered_dir(state_file).map(|_| ShellMode::Local)
}

/// Writes the shell's choice down: the mode, and the folder or origin it names.
///
/// One function for both modes, and the *whole* choice in one write, because that is what makes
/// the keys impossible to disagree: two writes (the mode, then its target) would have a window in
/// which `mode: remote` was on disk beside the previous mode's folder and no server.
///
/// The key of the mode that is *not* chosen is left alone rather than deleted: switching to a
/// server and back should not make the shell forget which folder it was. Only `mode` decides which
/// of the two is read at startup.
pub fn remember_choice(state_file: &Path, mode: ShellMode, target: &str) -> io::Result<()> {
    remember_choice_with(state_file, mode, target, &FsIo::default())
}

/// [`remember_choice`] over a chosen IO, so a test can count the writes.
pub fn remember_choice_with(
    state_file: &Path,
    mode: ShellMode,
    target: &str,
    io: &dyn JsonStoreIo,
) -> io::Result<()> {
    let mut state = read_state(state_file);
    state.insert(MODE_KEY.to_owned(), Value::String(mode.as_str().to_owned()));
    let key = match mode {
        ShellMode::Local => REMEMBERED_DIR_KEY,
        ShellMode::Remote => REMOTE_URL_KEY,
    };
    state.insert(key.to_owned(), Value::String(target.to_owned()));
    write_state_with(state_file, &state, io)
}

/// Remembers a local folder.
pub fn remember_dir(state_file: &Path, dir: &str) -> io::Result<()> {
    remember_choice(state_file, ShellMode::Local, dir)
}

/// Replaces the state file, atomically.
pub fn write_state(state_file: &Path, state: &ShellState) -> io::Result<()> {
    write_state_with(state_file, state, &FsIo::default())
}

pub fn write_state_with(
    state_file: &Path,
    state: &ShellState,
    io: &dyn JsonStoreIo,
) -> io::Result<()> {
    write_json_file_with(state_file, &Value::Object(state.clone()), io)
}
