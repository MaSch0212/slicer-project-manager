//! **Persisted third-party browsing history, one entry long, which the user did not ask for.**
//!
//! That is what this file is, said plainly, because every other way of describing it ("the last
//! page", "where you were") makes it sound like a preference. `browse.json` in the app's data
//! directory holds one key: the URL the model browser was last sitting on, so reopening `/browse`
//! returns to a half-finished search instead of to the registry's start page. Spec 9.14 is open on
//! whether it should exist at all, and this module is written so dropping it is a deletion rather
//! than an untangling: nothing else reads the file, and `attach` falls back to the registry's
//! start page when it answers `None`.
//!
//! **It is cleared by [`clear_last_page`] and by nothing else.** The browse profile is a directory
//! of its own (`browse-profile/`); this file is beside it, not inside it, so deleting the profile
//! leaves it. The page can ask for it to be forgotten.
//!
//! A file of its own, not a key in `state.json`: one corrupt write should cost the user their last
//! browsed page or their library choice, never both. It shares [`crate::json_store`]'s writer with
//! every other file the shell keeps, and a test pins that sequence for *this* file.

use std::path::Path;

use serde_json::{Value, json};

use super::policy::is_http_url;
use crate::json_store::{FsIo, JsonStoreIo, write_json_file_with};

/// Beside `state.json` and `slicers.json` in the data directory, never inside either.
pub const BROWSE_FILE_NAME: &str = "browse.json";

/// The one key in it.
pub const LAST_URL_KEY: &str = "lastUrl";

/// The longest URL this file will store or return. Not a limit any site approaches (the longest
/// the spike recorded is 66 characters): a bound on what a *file* can make the shell do, because
/// the answer is fed to the view at every attach and a hand-edited megabyte must not be.
pub const MAX_REMEMBERED_URL: usize = 2048;

/// Whether a URL is one this file will keep: `http(s)`, of a sane length.
pub fn is_rememberable_url(value: &str) -> bool {
    is_http_url(value, MAX_REMEMBERED_URL)
}

/// The remembered page, or `None` for a file that is not there, is not JSON, is not an object, or
/// names something [`is_rememberable_url`] refuses. Every one of those is a first run.
pub fn read_last_page(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let value = parsed.as_object()?.get(LAST_URL_KEY)?.as_str()?;
    is_rememberable_url(value).then(|| value.to_owned())
}

/// Replaces the file with `url`. Silent when the URL is not one this file keeps (a `blob:` document
/// the user opened is not a failure of anything), and **it does not fail on a write error either**:
/// a data directory this process cannot write is already reported by `state.json`, and losing a
/// scroll position is not a reason to fail a navigation that has already happened.
pub fn write_last_page(file: &Path, url: &str) {
    write_last_page_with(file, url, &FsIo::default());
}

pub fn write_last_page_with(file: &Path, url: &str, io: &dyn JsonStoreIo) {
    if !is_rememberable_url(url) {
        return;
    }
    if let Err(error) = write_json_file_with(file, &json!({ LAST_URL_KEY: url }), io) {
        crate::diag::warn(&format!(
            "could not remember the last browsed page in {BROWSE_FILE_NAME}: {error}"
        ));
    }
}

/// Removes the file. A delete and not a write of `{}`: the point is that the entry stops
/// existing. A file that is not there is a success.
pub fn clear_last_page(file: &Path) {
    clear_last_page_with(file, &FsIo::default());
}

pub fn clear_last_page_with(file: &Path, io: &dyn JsonStoreIo) {
    if let Err(error) = io.remove(file) {
        crate::diag::warn(&format!("could not forget the last browsed page: {error}"));
    }
}
