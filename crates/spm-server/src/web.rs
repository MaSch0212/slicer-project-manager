//! The web bundle, compiled into the binary.
//!
//! `build.rs` points `SPM_WEB_DIST` at `packages/web/dist` when it exists, and at an empty
//! placeholder when it does not, so the crate builds either way (a binary built without a bundle
//! serves no UI of its own). `SPM_WEB_ROOT` overrides the embedded bundle with a directory, and
//! `SPM_DEV_UI_ORIGIN` overrides both with the Vite dev server.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use rust_embed::RustEmbed;
use spm_http::{Assets, UiSource};

#[derive(RustEmbed)]
#[folder = "$SPM_WEB_DIST"]
struct Bundle;

/// The files embedded at build time.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmbeddedAssets;

impl Assets for EmbeddedAssets {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        // Names inside the bundle never start with a slash or climb out of it; refuse a lookup
        // that does rather than relying on the embed's own handling of it.
        if path.starts_with('/') || path.split(['/', '\\']).any(|part| part == "..") {
            return None;
        }
        Bundle::get(path).map(|file| file.data)
    }
}

impl EmbeddedAssets {
    /// Whether the build embedded a bundle at all (it has an `index.html`).
    pub fn has_index() -> bool {
        Bundle::get("index.html").is_some()
    }

    /// The directory the bundle was embedded from.
    pub fn source_dir() -> &'static str {
        env!("SPM_WEB_DIST")
    }
}

/// Where non-API requests are answered from: the directory `SPM_WEB_ROOT` names, else the
/// embedded bundle.
pub fn ui_source(web_root: Option<PathBuf>) -> UiSource {
    match web_root {
        Some(root) => UiSource::Dir(root),
        None => UiSource::Assets(Arc::new(EmbeddedAssets)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn the_embedded_files_are_the_files_in_the_directory_they_came_from() {
        let dir = PathBuf::from(EmbeddedAssets::source_dir());
        assert!(dir.is_dir(), "{}", dir.display());
        // Whatever the build embedded, every top-level file must read back byte for byte, and a
        // bundle with an index.html must say so.
        let mut checked = 0;
        for entry in fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let embedded = EmbeddedAssets
                    .get(&name)
                    .unwrap_or_else(|| panic!("{name}"));
                assert_eq!(
                    embedded.as_ref(),
                    fs::read(entry.path()).unwrap().as_slice(),
                    "{name}"
                );
                checked += 1;
            }
        }
        assert_eq!(
            EmbeddedAssets::has_index(),
            dir.join("index.html").is_file()
        );
        assert!(checked > 0 || !EmbeddedAssets::has_index());
    }

    #[test]
    fn nested_files_and_misses() {
        let dir = PathBuf::from(EmbeddedAssets::source_dir());
        assert!(EmbeddedAssets.get("definitely/not/there.js").is_none());
        assert!(EmbeddedAssets.get("").is_none());
        if let Ok(assets) = fs::read_dir(dir.join("assets")) {
            for entry in assets
                .flatten()
                .filter(|entry| entry.path().is_file())
                .take(3)
            {
                let name = format!("assets/{}", entry.file_name().to_string_lossy());
                assert_eq!(
                    EmbeddedAssets.get(&name).unwrap().as_ref(),
                    fs::read(entry.path()).unwrap().as_slice()
                );
            }
        }
    }

    #[test]
    fn a_lookup_that_climbs_out_of_the_bundle_finds_nothing() {
        for path in [
            "../Cargo.toml",
            "assets/../../Cargo.toml",
            "/index.html",
            "..\\x",
        ] {
            assert!(EmbeddedAssets.get(path).is_none(), "{path}");
        }
    }

    #[test]
    fn spm_web_root_overrides_the_embedded_bundle() {
        let root = PathBuf::from("/some/dir");
        assert!(matches!(ui_source(Some(root.clone())), UiSource::Dir(found) if found == root));
        assert!(matches!(ui_source(None), UiSource::Assets(_)));
    }
}
