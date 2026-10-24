use rusqlite::Connection;

use crate::error::Result;

/// The schema, in order. These files are the legacy app's, byte for byte, and applying them with
/// the same `PRAGMA user_version` bookkeeping is what lets an existing `.spm/app.db` open
/// unchanged. Never edit one; add the next number.
const MIGRATIONS: [(i64, &str); 3] = [
    (1, include_str!("migrations/001_init.sql")),
    (2, include_str!("migrations/002_preview_claim.sql")),
    (3, include_str!("migrations/003_classifier_version.sql")),
];

/// The schema version a fully migrated database reports in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 3;

/// Applies every migration newer than `PRAGMA user_version`, each in its own transaction, and
/// returns the resulting version.
pub fn run_migrations(conn: &Connection) -> Result<i64> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for (number, sql) in MIGRATIONS {
        if number <= version {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        let applied = conn.execute_batch(sql).and_then(|()| {
            // PRAGMA cannot be parameterised; the value comes from the constant list above.
            conn.execute_batch(&format!("PRAGMA user_version = {number}"))
        });
        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => {
                // The original failure is the one worth reporting; a failed rollback adds nothing.
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.into());
            }
        }
        version = number;
    }

    Ok(version)
}
