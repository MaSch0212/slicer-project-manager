//! Building and reading the stand-in slicer (`stub_slicer.rs`).
//!
//! It is compiled with the same `rustc` that is building the tests, into a directory the test owns.
//! Compiling is about half a second and keeps the stub out of every build graph: no workspace
//! member, no binary target, nothing that could ever be mistaken for something shipped.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

const SOURCE: &str = include_str!("stub_slicer.rs");

fn rustc() -> PathBuf {
    // `CARGO` is set by cargo for the tests it runs, and the real `rustc` is its sibling; the PATH
    // lookup is the fallback for a runner that does not set it.
    let sibling = std::env::var_os("CARGO")
        .map(PathBuf::from)
        .and_then(|cargo| {
            cargo
                .parent()
                .map(|bin| bin.join(format!("rustc{}", std::env::consts::EXE_SUFFIX)))
        })
        .filter(|path| path.is_file());
    sibling.unwrap_or_else(|| PathBuf::from("rustc"))
}

/// Compiles the stub as `<dir>/<name>` and answers its path.
pub fn build_stub(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let source = dir.join("stub_slicer_source.rs");
    std::fs::write(&source, SOURCE).unwrap();
    let exe = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let output = std::process::Command::new(rustc())
        .args([
            "--edition",
            "2024",
            "-C",
            "opt-level=0",
            "-C",
            "debuginfo=0",
            "--crate-name",
            "stub_slicer",
            "-o",
        ])
        .arg(&exe)
        .arg(&source)
        .output()
        .expect("rustc runs");
    assert!(
        output.status.success(),
        "the stub did not compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    exe
}

/// Tells the stub to stay alive for `ms` after writing its record.
pub fn keep_alive(exe: &Path, ms: u64) {
    std::fs::write(sidecar(exe, ".mode"), format!("sleep={ms}\n")).unwrap();
}

/// Tells the stub to keep a copy of the file it is handed (see `stub_slicer.rs`).
pub fn keep_a_copy_of_the_argument(exe: &Path) {
    std::fs::write(sidecar(exe, ".mode"), "copy\n").unwrap();
}

pub fn sidecar(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// What the stub wrote down, once it has: polled to a generous ceiling, because the process is
/// started detached and the test cannot wait on it.
pub fn record_of(exe: &Path) -> Value {
    let file = sidecar(exe, ".record.json");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "the stub never wrote {}",
            file.display()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
