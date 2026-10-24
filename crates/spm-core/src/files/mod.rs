//! Files on disk: paths, hashing, classification, zip reading, and the chunked-input plumbing the
//! parsers sit on. Upload, rename, delete and previews arrive with the later parts of the port.
//!
//! `strip3mf`, `zip_write` and `entry_hash` exist for the desktop shell only (stripping slicer
//! configuration from a 3MF, change detection for a file a slicer has had). They sit behind the
//! `desktop` cargo feature, which the server crates never enable.

pub mod chunks;
pub mod classify;
pub(crate) mod fsio;
pub mod hash;
pub mod paths;
pub mod zip;

#[cfg(feature = "desktop")]
pub mod entry_hash;
#[cfg(feature = "desktop")]
pub mod strip3mf;
#[cfg(feature = "desktop")]
pub mod zip_write;
