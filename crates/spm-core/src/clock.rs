//! The one clock core reads. Timestamps are epoch milliseconds in `i64`, as in the database.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, now.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
