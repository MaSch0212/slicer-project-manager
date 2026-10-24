use std::collections::HashMap;

use rusqlite::{Connection, params};

use crate::db::Library;
use crate::error::Result;

const USAGE_SQL: &str = "SELECT p.owner_id AS ownerId, COALESCE(SUM(f.size_bytes), 0) AS bytes
                         FROM files f JOIN projects p ON p.id = f.project_id
                         WHERE p.state = 'ok'
                         GROUP BY p.owner_id";

/// Bytes a user's present projects occupy. Derived, never stored: a file is counted while its
/// project folder exists.
pub(crate) fn disk_usage_bytes_in(conn: &Connection, user_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(f.size_bytes), 0)
         FROM files f JOIN projects p ON p.id = f.project_id
         WHERE p.state = 'ok' AND p.owner_id = ?",
        params![user_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn disk_usage_by_user_in(conn: &Connection) -> Result<HashMap<String, i64>> {
    let mut statement = conn.prepare(USAGE_SQL)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<std::result::Result<HashMap<_, _>, _>>()?)
}

pub fn disk_usage_bytes(lib: &Library, user_id: &str) -> Result<i64> {
    disk_usage_bytes_in(&lib.db(), user_id)
}

pub fn disk_usage_by_user(lib: &Library) -> Result<HashMap<String, i64>> {
    disk_usage_by_user_in(&lib.db())
}
