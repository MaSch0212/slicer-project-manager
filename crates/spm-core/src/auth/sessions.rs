use rusqlite::{Connection, OptionalExtension, params};

use super::tokens::{random_token, sha256_bytes};
use crate::ctx::Ctx;
use crate::db::Library;
use crate::error::Result;

pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Only push the expiry forward once a day, so a busy client is not a write per request.
pub const SESSION_SLIDE_MS: i64 = 24 * 60 * 60 * 1000;

/// A freshly created session. `token` is the only copy there will ever be: the database holds its
/// SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSession {
    pub token: String,
    pub expires_at: i64,
}

pub(crate) fn create_session_in(
    conn: &Connection,
    user_id: &str,
    user_agent: Option<&str>,
    now: i64,
) -> Result<NewSession> {
    let token = random_token();
    let expires_at = now + SESSION_TTL_MS;
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![sha256_bytes(&token).as_slice(), user_id, now, now, expires_at, user_agent],
    )?;
    Ok(NewSession { token, expires_at })
}

pub fn create_session(
    lib: &Library,
    user_id: &str,
    user_agent: Option<&str>,
    now: i64,
) -> Result<NewSession> {
    create_session_in(&lib.db(), user_id, user_agent, now)
}

/// The user a session token belongs to, or `None` for an unknown, expired or disabled-user token.
pub fn resolve_session(lib: &Library, token: &str, now: i64) -> Result<Option<Ctx>> {
    let hash = sha256_bytes(token);
    let conn = lib.db();
    let row = conn
        .query_row(
            "SELECT s.expires_at, s.last_seen_at, u.id, u.is_admin, u.status
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?",
            params![hash.as_slice()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;

    let Some((expires_at, last_seen_at, user_id, is_admin, status)) = row else {
        return Ok(None);
    };
    if expires_at <= now || status != "active" {
        return Ok(None);
    }

    // Write only when the expiry actually slides: SQLite takes a write lock for a write, which
    // serialises concurrent readers, so a write on every authenticated request is exactly the
    // per-request cost SESSION_SLIDE_MS exists to avoid. Consequence: `last_seen_at` means "when
    // this session was last extended", not literally every request.
    if now - last_seen_at > SESSION_SLIDE_MS {
        conn.execute(
            "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
            params![now, now + SESSION_TTL_MS, hash.as_slice()],
        )?;
    }

    Ok(Some(Ctx {
        user_id,
        is_admin: is_admin == 1,
    }))
}

/// Revokes a session immediately. Unknown tokens are not an error.
pub fn delete_session(lib: &Library, token: &str) -> Result<()> {
    lib.db().execute(
        "DELETE FROM sessions WHERE token_hash = ?",
        params![sha256_bytes(token).as_slice()],
    )?;
    Ok(())
}

/// Deletes every expired session and returns how many there were.
pub fn prune_expired_sessions(lib: &Library, now: i64) -> Result<usize> {
    Ok(lib
        .db()
        .execute("DELETE FROM sessions WHERE expires_at <= ?", params![now])?)
}
