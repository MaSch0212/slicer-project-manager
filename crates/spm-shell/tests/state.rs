//! Ported from the Electron shell's `state.test.ts`, and the state-file cases of `library.test.ts`.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use serde_json::json;
use spm_shell::json_store::{FsIo, JsonStoreIo};
use spm_shell::state::{
    REMEMBERED_DIR_KEY, ShellMode, read_remembered_dir, read_remembered_mode,
    read_remembered_mode_with, read_remembered_remote, read_state, read_state_with,
    remember_choice, remember_choice_with, remember_dir, write_state,
};

fn file_in(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("state.json")
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

#[test]
fn nothing_is_remembered_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    assert!(read_state(&file).is_empty());
    assert_eq!(read_remembered_mode(&file), None);
    assert_eq!(read_remembered_dir(&file), None);
    assert_eq!(read_remembered_remote(&file), None);
}

/// Counts what the writer does to the filesystem.
#[derive(Default)]
struct Counting {
    inner: FsIo,
    renames: Mutex<usize>,
}

impl JsonStoreIo for Counting {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        self.inner.create_dir_all(dir)
    }
    fn open(&self, path: &Path) -> io::Result<u64> {
        self.inner.open(path)
    }
    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()> {
        self.inner.write(handle, data)
    }
    fn fsync(&self, handle: u64) -> io::Result<()> {
        self.inner.fsync(handle)
    }
    fn close(&self, handle: u64) -> io::Result<()> {
        self.inner.close(handle)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        *self.renames.lock().unwrap() += 1;
        self.inner.rename(from, to)
    }
    fn remove(&self, path: &Path) -> io::Result<()> {
        self.inner.remove(path)
    }
}

#[test]
fn a_choice_writes_the_mode_and_its_target_in_one_pass() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    let io = Counting::default();
    remember_choice_with(&file, ShellMode::Remote, "https://print.example.com", &io).unwrap();
    // One replacement of the file: there is no moment with the mode on disk and no server beside it.
    assert_eq!(*io.renames.lock().unwrap(), 1);
    assert_eq!(read_remembered_mode(&file), Some(ShellMode::Remote));
    assert_eq!(
        read_remembered_remote(&file).as_deref(),
        Some("https://print.example.com")
    );
}

#[test]
fn switching_mode_leaves_the_other_mode_target_where_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    remember_choice(&file, ShellMode::Local, "D:\\Library").unwrap();
    remember_choice(&file, ShellMode::Remote, "https://print.example.com").unwrap();
    assert_eq!(read_remembered_mode(&file), Some(ShellMode::Remote));
    assert_eq!(read_remembered_dir(&file).as_deref(), Some("D:\\Library"));
    assert_eq!(
        read_remembered_remote(&file).as_deref(),
        Some("https://print.example.com")
    );
    remember_choice(&file, ShellMode::Local, "E:\\Other").unwrap();
    assert_eq!(read_remembered_mode(&file), Some(ShellMode::Local));
    assert_eq!(
        read_remembered_remote(&file).as_deref(),
        Some("https://print.example.com")
    );
}

#[test]
fn a_file_written_before_modes_existed_a_folder_and_no_mode_reads_as_local() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    fs::write(
        &file,
        json!({ REMEMBERED_DIR_KEY: "D:\\Library" }).to_string(),
    )
    .unwrap();
    assert_eq!(read_remembered_mode(&file), Some(ShellMode::Local));
}

#[test]
fn a_mode_that_is_neither_spelling_is_not_a_mode_even_with_a_folder_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    fs::write(
        &file,
        json!({ "mode": "cloud", REMEMBERED_DIR_KEY: "D:\\Library" }).to_string(),
    )
    .unwrap();
    let mut said = Vec::new();
    assert_eq!(
        read_remembered_mode_with(&file, &mut |message| said.push(message.to_owned())),
        None
    );
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].contains("unknown mode"), "{said:?}");
}

#[test]
fn an_empty_string_is_not_a_remembered_value() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    fs::write(
        &file,
        json!({ "mode": "", REMEMBERED_DIR_KEY: "", "remoteUrl": "" }).to_string(),
    )
    .unwrap();
    assert_eq!(read_remembered_dir(&file), None);
    assert_eq!(read_remembered_remote(&file), None);
    assert_eq!(read_remembered_mode(&file), None);
}

#[test]
fn a_value_of_the_wrong_type_is_ignored_rather_than_returned() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    fs::write(
        &file,
        json!({ REMEMBERED_DIR_KEY: 42, "remoteUrl": ["https://x"] }).to_string(),
    )
    .unwrap();
    assert_eq!(read_remembered_dir(&file), None);
    assert_eq!(read_remembered_remote(&file), None);
}

#[test]
fn a_file_that_is_not_an_object_at_all_is_treated_as_nothing_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    for text in ["[]", "\"text\"", "null", "{\"mode\":", ""] {
        fs::write(&file, text).unwrap();
        let mut said = Vec::new();
        let state = read_state_with(&file, &mut |message| said.push(message.to_owned()));
        assert!(state.is_empty(), "{text:?}");
        // Said once, not silently: a forgotten choice with no explanation anywhere is the
        // failure to avoid.
        assert_eq!(said.len(), 1, "{text:?} {said:?}");
    }
}

#[test]
fn the_write_leaves_nothing_behind_but_the_file_itself() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    remember_choice(&file, ShellMode::Local, "D:\\A").unwrap();
    remember_choice(&file, ShellMode::Remote, "https://print.example.com").unwrap();
    assert_eq!(names(dir.path()), ["state.json"]);
}

// ---- from library.test.ts: the state-file half ------------------------------------------------

#[test]
fn the_remembered_folder_round_trips_through_the_state_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    assert_eq!(read_remembered_dir(&file), None);
    remember_dir(&file, "D:\\One").unwrap();
    assert_eq!(read_remembered_dir(&file).as_deref(), Some("D:\\One"));
    remember_dir(&file, "D:\\Two").unwrap();
    assert_eq!(read_remembered_dir(&file).as_deref(), Some("D:\\Two"));
}

#[test]
fn remembering_a_folder_keeps_the_rest_of_the_state_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir);
    fs::write(
        &file,
        json!({ "mode": "local", "windowBounds": { "w": 1280 } }).to_string(),
    )
    .unwrap();
    remember_dir(&file, "D:\\One").unwrap();
    let state = read_state(&file);
    assert_eq!(state["windowBounds"], json!({ "w": 1280 }));
    assert_eq!(state["mode"], "local");
    assert_eq!(state[REMEMBERED_DIR_KEY], "D:\\One");
}

#[test]
fn a_state_file_that_cannot_be_read_at_all_is_reported_but_a_missing_one_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the file should be: reading it fails with something other than "not found".
    let blocked = dir.path().join("state.json");
    fs::create_dir(&blocked).unwrap();
    let mut said = Vec::new();
    assert!(read_state_with(&blocked, &mut |m| said.push(m.to_owned())).is_empty());
    assert_eq!(said.len(), 1, "{said:?}");

    let mut said = Vec::new();
    let missing = dir.path().join("nope.json");
    assert!(read_state_with(&missing, &mut |m| said.push(m.to_owned())).is_empty());
    assert!(said.is_empty());
}

#[test]
fn a_write_that_cannot_complete_leaves_no_temp_file_behind() {
    let dir = tempfile::tempdir().unwrap();
    // The target is a directory, so the final rename cannot replace it.
    let file = file_in(&dir);
    fs::create_dir(&file).unwrap();
    fs::write(file.join("keep"), "x").unwrap();
    assert!(write_state(&file, &serde_json::Map::new()).is_err());
    assert_eq!(names(dir.path()), ["state.json"]);
}
