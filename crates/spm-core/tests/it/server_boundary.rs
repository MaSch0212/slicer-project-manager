//! The server never ships `strip3mf`, `zip_write` or `entry_hash`: the Rust form of the legacy
//! `server-boundary.test.ts`.
//!
//! The legacy test walked server imports by text because TypeScript has no feature flags. Here the
//! three modules are compiled only when spm-core's `desktop` feature is on, so the property to prove
//! is about the *resolved feature set of the crates that make the server*: if `spm-server` or
//! `spm-http` (or anything they depend on) ever enables `spm-core/desktop`, the modules are
//! compiled into the server and this test fails.
//!
//! The probe is `cargo tree -p <crate>`, which resolves features for that crate alone, the way
//! `cargo build -p <crate>` would, and without dev-dependencies (`-e normal,build`). That matters:
//! spm-core's own dev-dependency on itself turns `desktop` on for core's tests, and `cargo
//! metadata` (which unifies the whole workspace including dev-dependencies) would report it for
//! everything.

use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// The features `cargo tree` resolves for `spm-core` when building `package`, normal and build
/// dependencies only, with `extra` arguments appended.
fn core_features_for(package: &str, extra: &[&str]) -> Vec<String> {
    let output = Command::new(env!("CARGO"))
        .current_dir(workspace_root())
        .args(["tree", "--locked", "--prefix", "none", "-e", "normal,build"])
        .args(["-f", "{p}|{f}", "-p", package])
        .args(extra)
        .output()
        .expect("cargo runs");
    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let mut found: Vec<Vec<String>> = text
        .lines()
        .filter(|line| line.starts_with("spm-core v"))
        .map(|line| {
            let features = line.split_once('|').map_or("", |(_, features)| features);
            features
                .split(',')
                .map(str::trim)
                .filter(|feature| !feature.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .collect();
    found.dedup();
    assert_eq!(
        found.len(),
        1,
        "expected exactly one resolution of spm-core in the tree of {package}:\n{text}"
    );
    found.remove(0)
}

#[test]
fn the_probe_sees_the_desktop_feature_when_it_is_enabled() {
    // The control that keeps the assertions below from passing on a probe that cannot see
    // anything: asking for the feature explicitly must show it.
    let features = core_features_for("spm-core", &["-F", "desktop"]);
    assert!(
        features.iter().any(|feature| feature == "desktop"),
        "cargo tree did not report the desktop feature: {features:?}"
    );
}

#[test]
fn spm_server_never_enables_the_desktop_modules() {
    let features = core_features_for("spm-server", &[]);
    assert!(
        !features.iter().any(|feature| feature == "desktop"),
        "spm-server builds spm-core with {features:?}: strip3mf, zip_write and entry_hash would ship"
    );
}

#[test]
fn spm_http_never_enables_the_desktop_modules() {
    let features = core_features_for("spm-http", &[]);
    assert!(
        !features.iter().any(|feature| feature == "desktop"),
        "spm-http builds spm-core with {features:?}: strip3mf, zip_write and entry_hash would ship"
    );
}
