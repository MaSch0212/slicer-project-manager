//! One atomic JSON writer for everything the shell keeps on the machine (`state.json` now,
//! `slicers.json` and the model browser's last page later).
//!
//! The sequence is the whole point: write a temp file beside the target, fsync it, close it, then
//! rename it over the target. A reader sees the old document or the new one, never half of either,
//! and a crash between the steps leaves at worst a stray temp file. The IO is a trait so the tests
//! can record the order of calls and fail one of them.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

/// The filesystem operations [`write_json_file_with`] performs, in the order it performs them.
/// A handle is whatever `open` returned; the writer passes the same one to `write`, `fsync` and
/// `close`.
pub trait JsonStoreIo {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()>;
    fn open(&self, path: &Path) -> io::Result<u64>;
    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()>;
    fn fsync(&self, handle: u64) -> io::Result<()>;
    fn close(&self, handle: u64) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Removes `path`; a path that is not there is not an error.
    fn remove(&self, path: &Path) -> io::Result<()>;
}

/// The real filesystem.
#[derive(Default)]
pub struct FsIo {
    files: Mutex<HashMap<u64, File>>,
    next: AtomicU64,
}

impl FsIo {
    fn with_file<T>(
        &self,
        handle: u64,
        f: impl FnOnce(&mut File) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        let file = files
            .get_mut(&handle)
            .ok_or_else(|| io::Error::other("no such handle"))?;
        f(file)
    }
}

impl JsonStoreIo for FsIo {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        fs::create_dir_all(dir)
    }

    fn open(&self, path: &Path) -> io::Result<u64> {
        let file = File::create(path)?;
        let handle = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle, file);
        Ok(handle)
    }

    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()> {
        self.with_file(handle, |file| file.write_all(data))
    }

    fn fsync(&self, handle: u64) -> io::Result<()> {
        self.with_file(handle, |file| file.sync_all())
    }

    fn close(&self, handle: u64) -> io::Result<()> {
        // Dropping the `File` closes it.
        self.files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle);
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// The temp file `file` is written through: it carries this process id, so two instances writing
/// the same target cannot collide on it.
pub fn temp_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Replaces `file` with `value`, atomically.
pub fn write_json_file(file: &Path, value: &Value) -> io::Result<()> {
    write_json_file_with(file, value, &FsIo::default())
}

/// [`write_json_file`] over a chosen IO.
///
/// Pretty-printed with a trailing newline. A failure at any step removes the temp file and is
/// returned; the target is then exactly what it was.
pub fn write_json_file_with(file: &Path, value: &Value, io: &dyn JsonStoreIo) -> io::Result<()> {
    if let Some(dir) = file.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        io.create_dir_all(dir)?;
    }
    let temp = temp_path(file);
    let result = (|| {
        let handle = io.open(&temp)?;
        let written = (|| {
            let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
            text.push('\n');
            io.write(handle, text.as_bytes())?;
            io.fsync(handle)
        })();
        // Closed on both paths: a handle left open would hold the temp file on Windows.
        let closed = io.close(handle);
        written?;
        closed?;
        io.rename(&temp, file)
    })();
    if let Err(error) = result {
        let _ = io.remove(&temp);
        return Err(error);
    }
    Ok(())
}
