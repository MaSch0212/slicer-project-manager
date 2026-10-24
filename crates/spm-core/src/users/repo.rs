use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::auth::password::PasswordHash;
use crate::dto::{UserDto, UserStatus};
use crate::error::{AppError, Result};

/// A `users` row.
#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub library_dir: String,
    pub pw_hash: Option<Vec<u8>>,
    pub pw_salt: Option<Vec<u8>>,
    pub pw_iterations: Option<i64>,
    pub pw_algo: Option<String>,
    pub is_admin: bool,
    pub status: UserStatus,
    pub quota_bytes: Option<i64>,
    pub created_at: i64,
    pub activated_at: Option<i64>,
}

impl UserRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<UserRow> {
        let status: String = row.get("status")?;
        Ok(UserRow {
            id: row.get("id")?,
            username: row.get("username")?,
            display_name: row.get("display_name")?,
            library_dir: row.get("library_dir")?,
            pw_hash: row.get("pw_hash")?,
            pw_salt: row.get("pw_salt")?,
            pw_iterations: row.get("pw_iterations")?,
            pw_algo: row.get("pw_algo")?,
            is_admin: row.get::<_, i64>("is_admin")? == 1,
            // A CHECK constraint admits only the three spellings, so this cannot be reached
            // through the application; a hand-edited database is reported, not guessed at.
            status: UserStatus::parse(&status).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!("unknown user status {status:?}").into(),
                )
            })?,
            quota_bytes: row.get("quota_bytes")?,
            created_at: row.get("created_at")?,
            activated_at: row.get("activated_at")?,
        })
    }

    /// The stored password hash, when the account has one (an invited user has not set it yet).
    pub fn stored_password(&self) -> Option<PasswordHash> {
        match (&self.pw_hash, &self.pw_salt, self.pw_iterations) {
            (Some(hash), Some(salt), Some(iterations)) if iterations != 0 => Some(PasswordHash {
                hash: hash.clone(),
                salt: salt.clone(),
                iterations,
                algo: self.pw_algo.clone().unwrap_or_default(),
            }),
            _ => None,
        }
    }
}

pub(crate) fn find_user_by_id(conn: &Connection, id: &str) -> Result<Option<UserRow>> {
    Ok(conn
        .query_row(
            "SELECT * FROM users WHERE id = ?",
            params![id],
            UserRow::from_row,
        )
        .optional()?)
}

/// Usernames are unique case-insensitively (the column is `COLLATE NOCASE`).
pub(crate) fn find_user_by_username(conn: &Connection, username: &str) -> Result<Option<UserRow>> {
    Ok(conn
        .query_row(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
            params![username],
            UserRow::from_row,
        )
        .optional()?)
}

pub(crate) fn require_user_row(conn: &Connection, id: &str) -> Result<UserRow> {
    find_user_by_id(conn, id)?.ok_or_else(|| AppError::not_found("user not found"))
}

pub(crate) fn all_user_rows(conn: &Connection) -> Result<Vec<UserRow>> {
    let mut statement = conn.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE")?;
    let rows = statement.query_map([], UserRow::from_row)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub(crate) fn to_user_dto(row: &UserRow, disk_usage_bytes: i64) -> UserDto {
    UserDto {
        id: row.id.clone(),
        username: row.username.clone(),
        display_name: row.display_name.clone(),
        is_admin: row.is_admin,
        status: row.status,
        disk_usage_bytes,
        quota_bytes: row.quota_bytes,
        created_at: row.created_at,
        activated_at: row.activated_at,
    }
}

/// The DTO of one user, usage included, read under one lock.
pub(crate) fn user_dto_in(conn: &Connection, id: &str) -> Result<UserDto> {
    let row = require_user_row(conn, id)?;
    Ok(to_user_dto(
        &row,
        super::usage::disk_usage_bytes_in(conn, id)?,
    ))
}
