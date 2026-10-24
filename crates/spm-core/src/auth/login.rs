use rusqlite::{TransactionBehavior, params};

use super::activation::{
    check_activation_token_in, consume_activation_token_in, explain_unusable_token_in,
};
use super::password::{PasswordHash, hash_password, needs_rehash, verify_password};
use super::sessions::create_session_in;
use crate::clock::now_ms;
use crate::db::Library;
use crate::dto::{UserDto, UserStatus};
use crate::error::{AppError, Result};
use crate::fields;
use crate::users::repo::{find_user_by_username, require_user_row, user_dto_in};
use crate::validate;

/// A signed-in user and the one copy of their session token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginResult {
    pub user: UserDto,
    pub token: String,
    pub expires_at: i64,
}

const UNAUTHORIZED: &str = "username or password is not correct";

fn write_password(conn: &rusqlite::Connection, user_id: &str, pw: &PasswordHash) -> Result<()> {
    conn.execute(
        "UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?",
        params![pw.hash, pw.salt, pw.iterations, pw.algo, user_id],
    )?;
    Ok(())
}

pub fn login(
    lib: &Library,
    username: &str,
    password: &str,
    user_agent: Option<&str>,
) -> Result<LoginResult> {
    login_at(lib, username, password, user_agent, now_ms())
}

pub fn login_at(
    lib: &Library,
    username: &str,
    password: &str,
    user_agent: Option<&str>,
    now: i64,
) -> Result<LoginResult> {
    let row = find_user_by_username(&lib.db(), username)?;
    // One message for every failure mode: unknown user, pending, disabled, wrong password.
    //
    // Known timing channel, deliberately not closed here: this branch returns in about a
    // millisecond, while a wrong password on an active account costs a real PBKDF2 derive
    // (150-400ms), so the two are distinguishable by wall-clock time even though the error is
    // identical in code and message. The fix considered and rejected is a dummy verify on every
    // failure path: on a self-hosted server with admin-created accounts and no self-registration,
    // that makes every bogus request cost 600,000 PBKDF2 iterations, a cheaper DoS than the
    // enumeration it prevents. The mitigation that fixes both at once, rate limiting, belongs in
    // the transport.
    let candidate = row
        .as_ref()
        .filter(|row| row.status == UserStatus::Active)
        .and_then(|row| row.stored_password().map(|stored| (row, stored)));
    let Some((row, stored)) = candidate else {
        // The reason is logged even though the *response* deliberately does not distinguish them:
        // the operator reading their own server log is not the attacker being denied enumeration.
        // Never the password, and never any part of it.
        let reason = row
            .as_ref()
            .map_or("no such user", |row| row.status.as_str());
        lib.log().warn(
            "login rejected",
            fields!["username" => username, "reason" => reason],
        );
        return Err(AppError::unauthorized(UNAUTHORIZED));
    };

    // The derive runs without the database lock: it is the slow part, and it must not stall
    // every other request.
    if !verify_password(password, &stored) {
        lib.log().warn(
            "login rejected",
            fields!["username" => username, "reason" => "bad password"],
        );
        return Err(AppError::unauthorized(UNAUTHORIZED));
    }

    let upgraded = needs_rehash(stored.iterations, &stored.algo).then(|| {
        lib.log().info(
            "rehashing password to current parameters",
            fields!["userId" => &row.id],
        );
        hash_password(password)
    });

    let conn = lib.db();
    if let Some(upgraded) = &upgraded {
        // All four columns land together: a partial write would leave a password that can never
        // verify again, silently and permanently.
        write_password(&conn, &row.id, upgraded)?;
    }
    let session = create_session_in(&conn, &row.id, user_agent, now)?;
    let user = user_dto_in(&conn, &row.id)?;
    drop(conn);
    lib.log().info(
        "login",
        fields!["userId" => &row.id, "username" => &row.username],
    );
    Ok(LoginResult {
        user,
        token: session.token,
        expires_at: session.expires_at,
    })
}

/// Consumes the token, sets the first password, and issues a session in one step (spec 5.3).
pub fn activate_account(
    lib: &Library,
    token: &str,
    new_password: &str,
    user_agent: Option<&str>,
) -> Result<LoginResult> {
    activate_account_at(lib, token, new_password, user_agent, now_ms())
}

pub fn activate_account_at(
    lib: &Library,
    token: &str,
    new_password: &str,
    user_agent: Option<&str>,
    now: i64,
) -> Result<LoginResult> {
    // The password floor is enforced here as well as at the transport: core is the authority.
    validate::password(new_password).map_err(AppError::validation)?;

    // Checked before consuming: a disabled account's link must not be silently burned by a
    // rejected attempt, and disabled is the one status activation must never resurrect from (a
    // session of a non-active user never resolves, so this is the last door). The check is
    // read-only, so an expired-but-unconsumed token still reaches the consume below and reports
    // `TokenExpired`.
    {
        let conn = lib.db();
        let check = check_activation_token_in(&conn, token, now)?;
        match check.user_id.filter(|_| check.valid) {
            Some(user_id) => {
                if require_user_row(&conn, &user_id)?.status == UserStatus::Disabled {
                    return Err(AppError::invalid_token("activation token is not usable"));
                }
            }
            // Not a live token: say precisely why (unknown or used is InvalidToken, expired is
            // TokenExpired) without spending a PBKDF2 derive on a request that cannot win.
            None => return Err(explain_unusable_token_in(&conn, token, now)?),
        }
    }

    let pw = hash_password(new_password);

    // Consume, set the password and open the session in one transaction: a crash between them
    // must not leave a burned invite and an account that still has no password.
    let mut conn = lib.db();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let user_id = consume_activation_token_in(&tx, token, now)?;
    tx.execute(
        "UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?,
                          status = 'active', activated_at = ?
         WHERE id = ?",
        params![pw.hash, pw.salt, pw.iterations, pw.algo, now, user_id],
    )?;
    let session = create_session_in(&tx, &user_id, user_agent, now)?;
    let user = user_dto_in(&tx, &user_id)?;
    tx.commit()?;
    drop(conn);
    lib.log()
        .info("account activated", fields!["userId" => &user_id]);
    Ok(LoginResult {
        user,
        token: session.token,
        expires_at: session.expires_at,
    })
}
