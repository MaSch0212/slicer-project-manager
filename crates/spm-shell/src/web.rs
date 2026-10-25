//! The web bundle, compiled into the app.
//!
//! `build.rs` points `SPM_WEB_DIST` at `packages/web/dist` when it exists, and at an empty
//! placeholder when it does not, so the crate builds either way (an app built without a bundle
//! serves no UI of its own). `tauri build` runs the web build first, so a packaged app always has
//! one. The same technique as `spm-server`'s embed; the two are separate crates' business.

use std::borrow::Cow;
use std::sync::Arc;

use rust_embed::RustEmbed;
use spm_http::Assets;

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

    pub fn shared() -> Arc<dyn Assets> {
        Arc::new(EmbeddedAssets)
    }
}
