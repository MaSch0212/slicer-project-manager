//! User administration. Admin authorisation lives here, in core, not in a transport (spec 2.2, 5.5).

use std::fs;

use rusqlite::{Connection, TransactionBehavior, params};

use super::repo::{
    UserRow, all_user_rows, find_user_by_username, require_user_row, to_user_dto, user_dto_in,
};
use super::usage::disk_usage_by_user_in;
use crate::auth::activation::{issue_activation_token_in, revoke_activation_tokens_in};
use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::dto::{UserDto, UserStatus};
use crate::error::{AppError, AppErrorCode, Result};
use crate::fields;
use crate::files::paths::user_root;
use crate::log::LogValue;
use crate::validate::{CreateUserInput, UpdateUserInput, Validate};

/// A user just created, and the one copy of their activation token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedUser {
    pub user: UserDto,
    pub token: String,
}

pub fn require_admin(ctx: &Ctx) -> Result<()> {
    if ctx.is_admin {
        Ok(())
    } else {
        Err(AppError::forbidden("administrator rights are required"))
    }
}

fn count_other_active_admins(conn: &Connection, exclude_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND status = 'active' AND id <> ?",
        params![exclude_id],
        |row| row.get(0),
    )?)
}

/// Refuses the operation that would leave the installation with no way to manage users.
fn assert_not_last_active_admin(conn: &Connection, row: &UserRow) -> Result<()> {
    let is_active_admin = row.is_admin && row.status == UserStatus::Active;
    if is_active_admin && count_other_active_admins(conn, &row.id)? == 0 {
        return Err(AppError::new(
            AppErrorCode::LastActiveAdmin,
            "the last active administrator must remain",
        ));
    }
    Ok(())
}

pub fn list_users(lib: &Library, ctx: &Ctx) -> Result<Vec<UserDto>> {
    require_admin(ctx)?;
    let conn = lib.db();
    let usage = disk_usage_by_user_in(&conn)?;
    Ok(all_user_rows(&conn)?
        .iter()
        .map(|row| to_user_dto(row, usage.get(&row.id).copied().unwrap_or(0)))
        .collect())
}

fn is_unique_violation(error: &AppError) -> bool {
    error
        .cause
        .as_deref()
        .is_some_and(|cause| cause.contains("UNIQUE constraint failed"))
}

pub fn create_user(lib: &Library, ctx: &Ctx, input: CreateUserInput) -> Result<CreatedUser> {
    require_admin(ctx)?;
    let input = input.validate()?;
    let taken = || AppError::conflict(format!("username \"{}\" is already taken", input.username));

    let id = new_id();
    let now = now_ms();
    let (user, token) = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if find_user_by_username(&tx, &input.username)?.is_some() {
            return Err(taken());
        }
        // library_dir is stored, not derived, so a later username change is an explicit rename.
        tx.execute(
            "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, quota_bytes, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            params![
                id,
                input.username,
                input.display_name,
                input.username,
                input.is_admin,
                input.quota_bytes,
                now
            ],
        )
        .map_err(AppError::from)
        .map_err(|error| if is_unique_violation(&error) { taken() } else { error })?;
        fs::create_dir_all(user_root(lib, &input.username)?)?;
        let token = issue_activation_token_in(&tx, &id, now)?;
        let user = user_dto_in(&tx, &id)?;
        tx.commit()?;
        (user, token)
    };

    // The token itself is never logged: the log is a lower-security artifact than the invite, and
    // anything printed here would hand a reader the account.
    lib.log().info(
        "user created",
        fields![
            "userId" => &id,
            "username" => &input.username,
            "isAdmin" => input.is_admin,
            "by" => &ctx.user_id,
        ],
    );
    Ok(CreatedUser { user, token })
}

/// Issues a fresh activation token for a user who has not activated, killing the previous one.
pub fn reissue_invite(lib: &Library, ctx: &Ctx, id: &str) -> Result<String> {
    require_admin(ctx)?;
    let now = now_ms();
    let (token, username) = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = require_user_row(&tx, id)?;
        if row.status == UserStatus::Active {
            return Err(AppError::conflict("account is already active"));
        }
        // Disabled means revoked: a fresh invite would let activation resurrect it. Re-enable
        // first, then re-invite.
        if row.status == UserStatus::Disabled {
            return Err(AppError::conflict(
                "re-enable the account before issuing a new invite",
            ));
        }
        // The old link dies with the new one's birth: the token is single-use (spec 5.3), and
        // re-issuing is exactly when the previous one should stop working. Two usable links for
        // one account is the thing single-use is meant to prevent.
        revoke_activation_tokens_in(&tx, &row.id, now)?;
        let token = issue_activation_token_in(&tx, &row.id, now)?;
        tx.commit()?;
        (token, row.username)
    };
    lib.log().info(
        "invite reissued",
        fields!["userId" => id, "username" => username, "by" => &ctx.user_id],
    );
    Ok(token)
}

pub fn update_user(lib: &Library, ctx: &Ctx, id: &str, patch: UpdateUserInput) -> Result<UserDto> {
    require_admin(ctx)?;
    let patch = patch.validate()?;
    let user = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = require_user_row(&tx, id)?;

        if patch.is_admin == Some(false) || patch.is_disabled == Some(true) {
            assert_not_last_active_admin(&tx, &row)?;
        }

        if let Some(is_admin) = patch.is_admin {
            tx.execute(
                "UPDATE users SET is_admin = ? WHERE id = ?",
                params![is_admin, id],
            )?;
        }
        if let Some(is_disabled) = patch.is_disabled {
            // Re-enabling must not activate an account that never set a password.
            let status = if is_disabled {
                UserStatus::Disabled
            } else if row.pw_hash.is_some() {
                UserStatus::Active
            } else {
                UserStatus::Pending
            };
            tx.execute(
                "UPDATE users SET status = ? WHERE id = ?",
                params![status.as_str(), id],
            )?;
        }
        if let Some(quota) = patch.quota_bytes {
            // Lowering below current usage is allowed: it blocks uploads, it does not delete.
            tx.execute(
                "UPDATE users SET quota_bytes = ? WHERE id = ?",
                params![quota, id],
            )?;
        }
        let user = user_dto_in(&tx, id)?;
        tx.commit()?;
        user
    };

    let mut logged: Vec<(&str, LogValue)> =
        vec![("userId", id.into()), ("by", (&ctx.user_id).into())];
    if let Some(is_admin) = patch.is_admin {
        logged.push(("isAdmin", is_admin.into()));
    }
    if let Some(is_disabled) = patch.is_disabled {
        logged.push(("isDisabled", is_disabled.into()));
    }
    if let Some(quota) = patch.quota_bytes {
        logged.push(("quotaBytes", quota.into()));
    }
    lib.log().info("user updated", &logged);
    Ok(user)
}

pub fn delete_user(lib: &Library, ctx: &Ctx, id: &str) -> Result<()> {
    require_admin(ctx)?;
    let username = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = require_user_row(&tx, id)?;
        assert_not_last_active_admin(&tx, &row)?;
        // Cascades projects, files, previews, tags and sessions. The folder on disk is left alone.
        tx.execute("DELETE FROM users WHERE id = ?", params![id])?;
        tx.commit()?;
        row.username
    };
    lib.log().info(
        "user deleted",
        fields!["userId" => id, "username" => username, "by" => &ctx.user_id],
    );
    Ok(())
}
