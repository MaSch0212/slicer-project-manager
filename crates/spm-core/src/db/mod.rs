//! The library's SQLite database: opening it, migrating it, and the handle everything shares.

pub mod ids;
pub mod migrate;
mod open;

pub use open::{BUSY_TIMEOUT_MS, DB_FILE, Library, OpenOptions, PREVIEWS_DIR, SPM_DIR};
