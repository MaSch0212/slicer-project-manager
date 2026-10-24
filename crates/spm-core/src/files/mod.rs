//! Files on disk: paths, hashing, classification, zip reading, the chunked-input plumbing the
//! parsers sit on, and the file use cases (upload, rename, delete, resolve).
//!
//! `strip3mf`, `zip_write` and `entry_hash` exist for the desktop shell only (stripping slicer
//! configuration from a 3MF, change detection for a file a slicer has had). They sit behind the
//! `desktop` cargo feature, which the server crates never enable.

pub mod chunks;
pub mod classify;
pub(crate) mod fsio;
pub mod hash;
pub mod paths;
pub mod usecases;
pub mod zip;

#[cfg(feature = "desktop")]
pub mod entry_hash;
#[cfg(feature = "desktop")]
pub mod strip3mf;
#[cfg(feature = "desktop")]
pub mod zip_write;

/// A file's modification time as whole epoch milliseconds, rounded to the nearest, the way the
/// library has always recorded it. A change detector compares this against what a previous scan
/// stored, so rounding must not drift between scans (or between the versions of this program that
/// wrote them).
pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    use std::time::UNIX_EPOCH;
    let Ok(modified) = metadata.modified() else {
        return 0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from((after.as_nanos() + 500_000) / 1_000_000).unwrap_or(i64::MAX),
        // Before 1970: the rounding of a negative half goes up, as `Math.round` does.
        Err(error) => {
            let before = error.duration().as_nanos();
            -i64::try_from(before.saturating_sub(500_000).div_ceil(1_000_000)).unwrap_or(i64::MAX)
        }
    }
}
