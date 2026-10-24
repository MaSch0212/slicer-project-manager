//! What a signed-in user does to their own account.

use rusqlite::params;

use super::repo::{require_user_row, user_dto_in};
use crate::auth::password::{hash_password, verify_password};
use crate::ctx::Ctx;
use crate::db::Library;
use crate::dto::UserDto;
use crate::error::{AppError, Result};
use crate::validate::{self, ProfilePatch, Validate};

pub fn me(lib: &Library, ctx: &Ctx) -> Result<UserDto> {
    user_dto_in(&lib.db(), &ctx.user_id)
}

pub fn change_password(lib: &Library, ctx: &Ctx, current: &str, next: &str) -> Result<()> {
    validate::password(next).map_err(AppError::validation)?;
    let row = require_user_row(&lib.db(), &ctx.user_id)?;
    let Some(stored) = row.stored_password() else {
        return Err(AppError::forbidden("account has no password to change"));
    };
    // Both derives run without the database lock.
    if !verify_password(current, &stored) {
        return Err(AppError::unauthorized("current password is not correct"));
    }

    let pw = hash_password(next);
    lib.db().execute(
        "UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?",
        params![pw.hash, pw.salt, pw.iterations, pw.algo, ctx.user_id],
    )?;
    Ok(())
}

pub fn update_profile(lib: &Library, ctx: &Ctx, patch: ProfilePatch) -> Result<UserDto> {
    let patch = patch.validate()?;
    let conn = lib.db();
    if let Some(display_name) = &patch.display_name {
        conn.execute(
            "UPDATE users SET display_name = ? WHERE id = ?",
            params![display_name, ctx.user_id],
        )?;
    }
    user_dto_in(&conn, &ctx.user_id)
}
