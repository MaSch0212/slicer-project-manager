//! Ported from the Electron shell's `json-store.test.ts`: the one atomic JSON writer.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use serde_json::json;
use spm_shell::json_store::{FsIo, JsonStoreIo, temp_path, write_json_file, write_json_file_with};

/// The real filesystem, recording every call, and failing the one it is told to.
#[derive(Default)]
struct Recording {
    inner: FsIo,
    calls: Mutex<Vec<String>>,
    fail_rename: bool,
}

impl Recording {
    fn log(&self, entry: impl Into<String>) {
        self.calls.lock().unwrap().push(entry.into());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl JsonStoreIo for Recording {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        self.log("mkdir");
        self.inner.create_dir_all(dir)
    }
    fn open(&self, path: &Path) -> io::Result<u64> {
        let handle = self.inner.open(path)?;
        self.log(format!("open#{handle}"));
        Ok(handle)
    }
    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()> {
        self.log(format!("write#{handle}"));
        self.inner.write(handle, data)
    }
    fn fsync(&self, handle: u64) -> io::Result<()> {
        self.log(format!("fsync#{handle}"));
        self.inner.fsync(handle)
    }
    fn close(&self, handle: u64) -> io::Result<()> {
        self.log(format!("close#{handle}"));
        self.inner.close(handle)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.log("rename");
        if self.fail_rename {
            return Err(io::Error::other("the rename was refused"));
        }
        self.inner.rename(from, to)
    }
    fn remove(&self, path: &Path) -> io::Result<()> {
        self.log("remove");
        self.inner.remove(path)
    }
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
fn the_file_is_written_whole_with_a_trailing_newline_and_nothing_is_left_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    write_json_file(&file, &json!({ "mode": "local", "n": 1 })).unwrap();

    let text = fs::read_to_string(&file).unwrap();
    assert!(text.ends_with("}\n"), "{text:?}");
    // Pretty-printed with two spaces, as `JSON.stringify(value, null, 2)` was.
    assert!(text.contains("\n  \"mode\": \"local\""), "{text:?}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap(),
        json!({ "mode": "local", "n": 1 })
    );
    assert_eq!(names(dir.path()), ["state.json"]);
}

#[test]
fn a_directory_that_does_not_exist_yet_is_created() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a").join("b").join("state.json");
    write_json_file(&file, &json!({ "ok": true })).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&file).unwrap()).unwrap(),
        json!({ "ok": true })
    );
}

#[test]
fn an_existing_file_is_replaced_not_appended_to_or_truncated_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    write_json_file(&file, &json!({ "long": "x".repeat(500) })).unwrap();
    write_json_file(&file, &json!({ "a": 1 })).unwrap();
    // A shorter second document leaves no tail of the first behind.
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&file).unwrap()).unwrap(),
        json!({ "a": 1 })
    );
}

#[test]
fn the_bytes_are_flushed_on_the_handle_they_were_written_to_before_the_rename() {
    let dir = tempfile::tempdir().unwrap();
    let io = Recording::default();
    write_json_file_with(&dir.path().join("state.json"), &json!({}), &io).unwrap();
    assert_eq!(
        io.calls(),
        ["mkdir", "open#1", "write#1", "fsync#1", "close#1", "rename"]
    );
}

#[test]
fn a_rename_that_cannot_complete_removes_the_temp_file_and_returns_the_error() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let io = Recording {
        fail_rename: true,
        ..Recording::default()
    };
    let error = write_json_file_with(&file, &json!({ "a": 1 }), &io).unwrap_err();
    assert!(error.to_string().contains("refused"), "{error}");
    assert_eq!(io.calls().last().map(String::as_str), Some("remove"));
    assert!(names(dir.path()).is_empty(), "{:?}", names(dir.path()));
}

#[test]
fn the_temp_file_carries_this_process_id_so_two_instances_cannot_collide() {
    let temp = temp_path(Path::new("state.json"));
    let name = temp.to_string_lossy();
    assert!(
        name.contains(&format!(".{}.", std::process::id())),
        "{name}"
    );
    assert!(name.ends_with(".tmp"));
}

#[test]
fn a_write_over_a_file_another_writer_is_part_way_through_does_not_read_as_torn() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    // Another instance's temp file, half written.
    let other = dir.path().join("state.json.99999.tmp");
    fs::write(&other, "{\"half\":").unwrap();

    write_json_file(&file, &json!({ "complete": true })).unwrap();

    assert_eq!(fs::read_to_string(&other).unwrap(), "{\"half\":");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&file).unwrap()).unwrap(),
        json!({ "complete": true })
    );
}
