//! Helpers shared by the test modules.

use spm_core::{AppErrorCode, Ctx, Library, activate_account, ensure_bootstrap_admin};

pub const PASSWORD: &str = "a good long password";

/// The code a failed result carries; panics when it succeeded.
pub fn code_of<T: std::fmt::Debug>(result: spm_core::Result<T>) -> AppErrorCode {
    result.expect_err("the call was expected to fail").code
}

/// Bootstraps the first admin, activates them, and returns their context.
pub fn active_admin(lib: &Library) -> Ctx {
    let boot = ensure_bootstrap_admin(lib)
        .unwrap()
        .expect("a fresh library bootstraps");
    let result = activate_account(lib, &boot.token, PASSWORD, None).unwrap();
    Ctx {
        user_id: result.user.id,
        is_admin: true,
    }
}

pub fn is_url_safe_token(token: &str) -> bool {
    token.len() == 43
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
