use std::fs;

use rusqlite::{OptionalExtension, TransactionBehavior, params};

use crate::auth::activation::issue_activation_token_in;
use crate::clock::now_ms;
use crate::ctx::Ctx;
use crate::db::Library;
use crate::db::ids::new_id;
use crate::error::Result;
use crate::fields;
use crate::files::paths::user_root;

const BOOTSTRAP_USERNAME: &str = "admin";

/// The administrator created on first run, and the one copy of their activation token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapAdmin {
    pub username: String,
    pub token: String,
}

/// First run against an empty users table: create a pending admin and hand back its raw activation
/// token for the caller to log (spec 5.4). No password exists at any point. Returns `None` when
/// the table already has rows.
pub fn ensure_bootstrap_admin(lib: &Library) -> Result<Option<BootstrapAdmin>> {
    ensure_bootstrap_admin_at(lib, now_ms())
}

pub fn ensure_bootstrap_admin_at(lib: &Library, now: i64) -> Result<Option<BootstrapAdmin>> {
    let id = new_id();
    let token = {
        let mut conn = lib.db();
        // Immediate: two processes opening a fresh library together must not both see it empty.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(None);
        }
        tx.execute(
            "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
             VALUES (?, ?, ?, ?, 1, 'pending', ?)",
            params![id, BOOTSTRAP_USERNAME, "Administrator", BOOTSTRAP_USERNAME, now],
        )?;
        fs::create_dir_all(user_root(lib, BOOTSTRAP_USERNAME)?)?;
        let token = issue_activation_token_in(&tx, &id, now)?;
        tx.commit()?;
        token
    };
    lib.log().info(
        "bootstrap admin created",
        fields!["userId" => &id, "username" => BOOTSTRAP_USERNAME],
    );
    Ok(Some(BootstrapAdmin {
        username: BOOTSTRAP_USERNAME.to_owned(),
        token,
    }))
}

/// Desktop local mode (spec 2.6): exactly one user, flat library, no password, no session. `Ctx`
/// still needs a user id, so the row exists; it is never an administrator.
pub fn ensure_local_user(lib: &Library) -> Result<Ctx> {
    ensure_local_user_at(lib, now_ms())
}

pub fn ensure_local_user_at(lib: &Library, now: i64) -> Result<Ctx> {
    let mut conn = lib.db();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = tx
        .query_row("SELECT id FROM users LIMIT 1", [], |row| row.get(0))
        .optional()?;
    if let Some(user_id) = existing {
        return Ok(Ctx {
            user_id,
            is_admin: false,
        });
    }

    let id = new_id();
    tx.execute(
        "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at, activated_at)
         VALUES (?, 'local', 'Local', '.', 0, 'active', ?, ?)",
        params![id, now, now],
    )?;
    tx.commit()?;
    Ok(Ctx {
        user_id: id,
        is_admin: false,
    })
}
