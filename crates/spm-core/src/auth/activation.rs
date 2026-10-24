use rusqlite::{Connection, OptionalExtension, params};

use super::tokens::{random_token, sha256_bytes};
use crate::db::Library;
use crate::db::ids::new_id;
use crate::error::{AppError, AppErrorCode, Result};

pub const ACTIVATION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// What a read-only look at an activation token found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationCheck {
    pub valid: bool,
    pub username: Option<String>,
    pub user_id: Option<String>,
}

struct TokenRow {
    user_id: String,
    username: String,
    expires_at: i64,
    consumed_at: Option<i64>,
}

/// Returns the raw token exactly once; only its hash is stored (spec 5.3).
pub(crate) fn issue_activation_token_in(
    conn: &Connection,
    user_id: &str,
    now: i64,
) -> Result<String> {
    let token = random_token();
    conn.execute(
        "INSERT INTO activation_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)",
        params![
            new_id(),
            user_id,
            sha256_bytes(&token).as_slice(),
            now + ACTIVATION_TTL_MS,
            now
        ],
    )?;
    Ok(token)
}

pub fn issue_activation_token(lib: &Library, user_id: &str, now: i64) -> Result<String> {
    issue_activation_token_in(&lib.db(), user_id, now)
}

/// Marks every outstanding activation token for a user as consumed, and returns how many.
///
/// `consumed_at` is the single "no longer usable" flag the whole module reads, so revoking writes
/// it rather than adding a parallel column: check and consume already refuse a consumed row, and a
/// revoked link reads as "not valid" to the user without any new branch. The rows stay in the
/// table: they are the record of who was invited and when.
///
/// The token is single-use (spec 5.3), and re-issuing an invite is precisely the moment the
/// previous link should die: the reason to re-issue is that the old link went somewhere it should
/// not have, or is believed lost. Two live links for one account is the failure mode.
pub(crate) fn revoke_activation_tokens_in(
    conn: &Connection,
    user_id: &str,
    now: i64,
) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE activation_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
        params![now, user_id],
    )?)
}

fn find_token(conn: &Connection, token: &str) -> Result<Option<TokenRow>> {
    Ok(conn
        .query_row(
            "SELECT t.user_id, u.username, t.expires_at, t.consumed_at
             FROM activation_tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ?",
            params![sha256_bytes(token).as_slice()],
            |row| {
                Ok(TokenRow {
                    user_id: row.get(0)?,
                    username: row.get(1)?,
                    expires_at: row.get(2)?,
                    consumed_at: row.get(3)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn check_activation_token_in(
    conn: &Connection,
    token: &str,
    now: i64,
) -> Result<ActivationCheck> {
    Ok(match find_token(conn, token)? {
        Some(row) if row.consumed_at.is_none() && row.expires_at > now => ActivationCheck {
            valid: true,
            username: Some(row.username),
            user_id: Some(row.user_id),
        },
        _ => ActivationCheck {
            valid: false,
            username: None,
            user_id: None,
        },
    })
}

/// Read-only check, so an expired link errors before the user types a password (spec 5.3).
pub fn check_activation_token(lib: &Library, token: &str, now: i64) -> Result<ActivationCheck> {
    check_activation_token_in(&lib.db(), token, now)
}

fn not_usable() -> AppError {
    AppError::invalid_token("activation token is not usable")
}

/// The error a token that is not live deserves. Already-consumed takes precedence over expired: a
/// token both used and past its TTL must still read as "not usable", not "expired". The caller
/// should not be told to request a new invite for an account that already activated.
fn unusable_error(row: Option<&TokenRow>, now: i64) -> AppError {
    match row {
        Some(row) if row.consumed_at.is_none() && row.expires_at <= now => {
            AppError::new(AppErrorCode::TokenExpired, "activation token has expired")
        }
        _ => not_usable(),
    }
}

/// The error [`consume_activation_token`] would raise for `token`, without consuming anything.
pub(crate) fn explain_unusable_token_in(
    conn: &Connection,
    token: &str,
    now: i64,
) -> Result<AppError> {
    Ok(unusable_error(find_token(conn, token)?.as_ref(), now))
}

/// Consumes the token and returns the user it belonged to.
pub(crate) fn consume_activation_token_in(
    conn: &Connection,
    token: &str,
    now: i64,
) -> Result<String> {
    let row = find_token(conn, token)?;
    let live = row
        .as_ref()
        .filter(|row| row.consumed_at.is_none() && row.expires_at > now);
    let Some(row) = live else {
        return Err(unusable_error(row.as_ref(), now));
    };

    // `consumed_at IS NULL` in the WHERE clause is the single source of truth for who owns this
    // consumption: should two callers both pass the checks above (two connections, or a future
    // refactor that drops the lock between read and write), only one UPDATE can match an
    // unconsumed row, so the changed-row count, not the earlier read, decides.
    let changed = conn.execute(
        "UPDATE activation_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
        params![now, sha256_bytes(token).as_slice()],
    )?;
    if changed == 0 {
        return Err(not_usable());
    }
    Ok(row.user_id.clone())
}

pub fn consume_activation_token(lib: &Library, token: &str, now: i64) -> Result<String> {
    consume_activation_token_in(&lib.db(), token, now)
}
