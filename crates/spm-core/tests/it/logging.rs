//! What core logs, and what it must never log.
//!
//! The legacy `logging.test.ts` mixed user/auth cases with rescan, preview-queue and importer
//! cases. The former are ported here; the latter belong to the parts of core that do not exist
//! yet and are listed in the porting report as deferred (project lifecycle and rescan: part 3;
//! preview queue: part 4).

use spm_core::log::{LogLevel, LogLevelSetting, LogValue};
use spm_core::testing::{TempLibrary, seed_user};
use spm_core::validate::CreateUserInput;
use spm_core::{Ctx, create_user, delete_user, ensure_bootstrap_admin, login};

fn text(value: Option<&LogValue>) -> Option<&str> {
    match value {
        Some(LogValue::Str(text)) => Some(text),
        _ => None,
    }
}

/// The legacy test captured the real console around a rescan. Here "silent unless configured" is
/// enforced twice: `spm-core` denies `print!`/`eprintln!` outside the opt-in console sink at
/// compile time (`#![deny(clippy::print_stdout, clippy::print_stderr)]`), and a library opened
/// with no logger gets a silent one, which this test checks while the library does real work.
/// The rescan half of the legacy scenario is deferred to part 3.
#[test]
fn a_library_with_no_logger_configured_stays_completely_silent() {
    let lib = TempLibrary::new();
    assert_eq!(lib.log().level(), LogLevelSetting::Silent);
    for level in [
        LogLevel::Error,
        LogLevel::Warn,
        LogLevel::Info,
        LogLevel::Debug,
        LogLevel::Trace,
    ] {
        assert!(
            !lib.log().enabled(level),
            "{level:?} is enabled on a default library"
        );
    }
    // Real work that logs when a logger is configured: bootstrap, a rejected login, a user.
    seed_user(&lib, "marc");
    let _ = login(&lib, "nobody", "whatever", None);
    ensure_bootstrap_admin(&lib).unwrap();
}

#[test]
fn a_rejected_login_is_logged_at_warn_with_a_reason_and_never_the_password() {
    let (lib, logs) = TempLibrary::logged();
    seed_user(&lib, "marc");
    assert!(login(&lib, "nobody", "hunter2 is a secret", None).is_err());

    let rejected = logs
        .find("login rejected")
        .expect("the rejection was logged");
    assert_eq!(rejected.level, LogLevel::Warn);
    assert_eq!(text(rejected.field("username")), Some("nobody"));
    assert_eq!(text(rejected.field("reason")), Some("no such user"));
    let everything = format!("{:?}", logs.records());
    assert!(
        !everything.contains("hunter2"),
        "the attempted password reached the log"
    );
}

#[test]
fn a_wrong_password_is_logged_with_its_own_reason_and_still_never_the_password() {
    // Beyond the legacy case: the other rejection path, which has a real hash to derive.
    let (lib, logs) = TempLibrary::logged();
    let admin = crate::common::active_admin(&lib);
    logs.clear();
    assert!(login(&lib, "admin", "not the password", None).is_err());

    let rejected = logs.find("login rejected").unwrap();
    assert_eq!(text(rejected.field("reason")), Some("bad password"));
    assert!(!format!("{:?}", logs.records()).contains("not the password"));
    let _ = admin;
}

/// The project half of the legacy test (`project created` / `project deleted`) is deferred to
/// part 3, when projects are ported.
#[test]
fn user_lifecycle_changes_are_logged_at_info_with_who_did_them() {
    let (lib, logs) = TempLibrary::logged();
    let admin = Ctx {
        user_id: "admin-id".to_owned(),
        is_admin: true,
    };
    let created = create_user(
        &lib,
        &admin,
        CreateUserInput {
            username: "newbie".to_owned(),
            display_name: "Newbie".to_owned(),
            is_admin: false,
            quota_bytes: None,
        },
    )
    .unwrap();

    let record = logs.find("user created").expect("creation was logged");
    assert_eq!(record.level, LogLevel::Info);
    assert_eq!(text(record.field("username")), Some("newbie"));
    assert_eq!(text(record.field("by")), Some("admin-id"));
    // The invite token is the credential; it must never be recoverable from the log.
    assert!(
        !format!("{:?}", logs.records()).contains(&created.token),
        "the invite token was logged"
    );

    // A second admin, so the first could be removed; here the target is the newbie anyway.
    delete_user(&lib, &admin, &created.user.id).unwrap();
    let deleted = logs.find("user deleted").expect("deletion was logged");
    assert_eq!(text(deleted.field("username")), Some("newbie"));
    assert_eq!(text(deleted.field("by")), Some("admin-id"));
}
