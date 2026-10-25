//! The release build must unwind.
//!
//! `panic = "abort"` makes a panic anywhere in the process end it, which turns the preview queue's
//! `catch_unwind` into dead code: one malformed model that trips a parser bug would kill the
//! server. A test run unwinds regardless of the profile, so the behaviour tests in `previews.rs`
//! cannot see this; reading the build configuration can.

use std::fs;

use crate::common::repo_root;

fn read(path: &str) -> Option<String> {
    fs::read_to_string(repo_root().join(path)).ok()
}

/// The lines of `[profile.release]`, up to the next table.
fn release_profile(manifest: &str) -> Vec<&str> {
    let mut in_section = false;
    let mut lines = Vec::new();
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == "[profile.release]";
            continue;
        }
        if in_section {
            lines.push(trimmed);
        }
    }
    lines
}

#[test]
fn the_release_profile_does_not_abort_on_panic() {
    let manifest = read("Cargo.toml").expect("the workspace manifest");
    let profile = release_profile(&manifest);
    assert!(
        profile.iter().any(|line| line.starts_with("lto")),
        "the probe did not find [profile.release]: {profile:?}"
    );
    let aborting: Vec<_> = profile
        .iter()
        .filter(|line| !line.starts_with('#') && line.starts_with("panic"))
        .collect();
    assert!(
        aborting.is_empty(),
        "release builds must unwind: {aborting:?}"
    );
}

#[test]
fn nothing_else_turns_panics_into_aborts() {
    // Any other place a build could pick it up from: a cargo config, flags in the Dockerfile.
    for path in [".cargo/config.toml", ".cargo/config", "Dockerfile"] {
        if let Some(text) = read(path) {
            let aborting: Vec<_> = text
                .lines()
                .filter(|line| !line.trim_start().starts_with('#') && line.contains("panic"))
                .filter(|line| line.contains("abort"))
                .collect();
            assert!(aborting.is_empty(), "{path} sets panic=abort: {aborting:?}");
        }
    }
}

#[test]
fn the_probe_reads_the_profile_it_claims_to() {
    // The control that keeps the assertions above from passing on a parser that sees nothing.
    let aborting =
        "[profile.release]\nlto = true\npanic = \"abort\"\n[profile.dev]\nopt-level = 1\n";
    assert_eq!(
        release_profile(aborting),
        ["lto = true", "panic = \"abort\""]
    );
    let other_section = "[profile.dev]\npanic = \"abort\"\n[profile.release]\nlto = true\n";
    assert_eq!(release_profile(other_section), ["lto = true"]);
}
