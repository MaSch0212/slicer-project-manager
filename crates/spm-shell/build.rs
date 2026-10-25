//! Picks the directory the web bundle is embedded from.
//!
//! The bundle is `packages/web/dist`, built by `pnpm --filter @spm/web build`. A Rust build must
//! work without it (a fresh clone, `cargo test`, clippy), so when that directory does not exist
//! this points the embed at an empty placeholder in `OUT_DIR` instead: the app then serves no UI
//! of its own. `tauri build` runs the web build first (`beforeBuildCommand`), so a packaged app
//! always has one.

use std::path::PathBuf;
use std::{env, fs};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    let dist = manifest.join("../../packages/web/dist");

    let chosen = if dist.is_dir() {
        dist.canonicalize().unwrap_or(dist.clone())
    } else {
        let placeholder =
            PathBuf::from(env::var("OUT_DIR").expect("cargo sets this")).join("web-placeholder");
        fs::create_dir_all(&placeholder).expect("the placeholder directory is created");
        placeholder
    };

    println!("cargo:rustc-env=SPM_WEB_DIST={}", chosen.display());
    println!("cargo:rerun-if-changed=build.rs");
    // A directory is watched recursively; a missing one reruns the script when it appears.
    println!("cargo:rerun-if-changed={}", dist.display());
}
