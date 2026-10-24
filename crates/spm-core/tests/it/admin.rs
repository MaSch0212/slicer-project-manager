use std::collections::HashMap;

use rusqlite::params;
use spm_core::auth::activation::check_activation_token;
use spm_core::dto::UserStatus;
use spm_core::testing::TempLibrary;
use spm_core::validate::{CreateUserInput, UpdateUserInput};
use spm_core::{
    AppErrorCode, Ctx, Library, activate_account, create_user, delete_user, list_users,
    reissue_invite, update_user,
};

use crate::common::{PASSWORD, active_admin, code_of, is_url_safe_token};

const NOT_ADMIN: fn() -> Ctx = || Ctx {
    user_id: "someone".to_owned(),
    is_admin: false,
};

fn new_user(
    username: &str,
    display_name: &str,
    is_admin: bool,
    quota: Option<i64>,
) -> CreateUserInput {
    CreateUserInput {
        username: username.to_owned(),
        display_name: display_name.to_owned(),
        is_admin,
        quota_bytes: quota,
    }
}

fn anna(lib: &Library, admin: &Ctx) -> spm_core::CreatedUser {
    create_user(lib, admin, new_user("anna", "Anna", false, None)).unwrap()
}

fn disable(is_disabled: bool) -> UpdateUserInput {
    UpdateUserInput {
        is_disabled: Some(is_disabled),
        ..Default::default()
    }
}

#[test]
fn every_users_operation_is_refused_to_a_non_admin() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let outsider = NOT_ADMIN();
    let forbidden = AppErrorCode::Forbidden;

    assert_eq!(code_of(list_users(&lib, &outsider)), forbidden);
    assert_eq!(
        code_of(create_user(
            &lib,
            &outsider,
            new_user("anna", "Anna", false, None)
        )),
        forbidden
    );
    let demote = UpdateUserInput {
        is_admin: Some(false),
        ..Default::default()
    };
    assert_eq!(
        code_of(update_user(&lib, &outsider, &admin.user_id, demote)),
        forbidden
    );
    assert_eq!(
        code_of(delete_user(&lib, &outsider, &admin.user_id)),
        forbidden
    );
    assert_eq!(
        code_of(reissue_invite(&lib, &outsider, &admin.user_id)),
        forbidden
    );
}

#[test]
fn create_user_makes_a_pending_user_their_folder_and_one_activation_token() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let created = create_user(
        &lib,
        &admin,
        new_user("anna", "Anna", false, Some(5_000_000)),
    )
    .unwrap();

    assert_eq!(created.user.status, UserStatus::Pending);
    assert_eq!(created.user.quota_bytes, Some(5_000_000));
    assert_eq!(created.user.disk_usage_bytes, 0);
    assert!(is_url_safe_token(&created.token), "{}", created.token);
    assert!(lib.dir().join("anna").is_dir());
    assert_eq!(list_users(&lib, &admin).unwrap().len(), 2);
}

#[test]
fn a_duplicate_username_is_a_conflict_case_insensitively() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    anna(&lib, &admin);
    assert_eq!(
        code_of(create_user(
            &lib,
            &admin,
            new_user("ANNA", "Anna II", false, None)
        )),
        AppErrorCode::Conflict
    );
}

// Re-issuing an invite is exactly the moment the old link should stop working: the reason to
// re-issue is that the first link went somewhere it should not have, or is believed lost. Two live
// links for one account is the failure mode, not the feature.
#[test]
fn reissue_invite_hands_out_a_fresh_token_and_kills_the_previous_one() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let created = anna(&lib, &admin);
    assert!(
        check_activation_token(&lib, &created.token, 0)
            .unwrap()
            .valid
    );

    let again = reissue_invite(&lib, &admin, &created.user.id).unwrap();
    assert_ne!(again, created.token);

    assert!(
        !check_activation_token(&lib, &created.token, 0)
            .unwrap()
            .valid
    );
    assert!(check_activation_token(&lib, &again, 0).unwrap().valid);
    // The old row is kept, consumed, rather than deleted: activation_tokens is the audit trail of
    // who was invited and when.
    let rows: i64 = lib
        .db()
        .query_row(
            "SELECT COUNT(*) FROM activation_tokens WHERE user_id = ?",
            params![created.user.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2);
}

#[test]
fn the_killed_token_cannot_be_used_to_activate_even_before_the_new_one_is() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let created = anna(&lib, &admin);
    reissue_invite(&lib, &admin, &created.user.id).unwrap();

    assert_eq!(
        code_of(activate_account(&lib, &created.token, PASSWORD, None)),
        AppErrorCode::InvalidToken
    );
}

#[test]
fn re_issuing_twice_leaves_exactly_one_usable_token() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let created = anna(&lib, &admin);
    let second = reissue_invite(&lib, &admin, &created.user.id).unwrap();
    let third = reissue_invite(&lib, &admin, &created.user.id).unwrap();

    assert!(
        !check_activation_token(&lib, &created.token, 0)
            .unwrap()
            .valid
    );
    assert!(!check_activation_token(&lib, &second, 0).unwrap().valid);
    assert!(check_activation_token(&lib, &third, 0).unwrap().valid);
}

#[test]
fn the_last_active_admin_cannot_be_deleted_disabled_or_demoted() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let last = AppErrorCode::LastActiveAdmin;

    assert_eq!(code_of(delete_user(&lib, &admin, &admin.user_id)), last);
    assert_eq!(
        code_of(update_user(&lib, &admin, &admin.user_id, disable(true))),
        last
    );
    let demote = UpdateUserInput {
        is_admin: Some(false),
        ..Default::default()
    };
    assert_eq!(
        code_of(update_user(&lib, &admin, &admin.user_id, demote)),
        last
    );
}

#[test]
fn once_a_second_admin_is_active_the_first_can_be_removed() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let second = create_user(&lib, &admin, new_user("anna", "Anna", true, None)).unwrap();

    // Still pending, so not yet an *active* admin.
    assert_eq!(
        code_of(delete_user(&lib, &admin, &admin.user_id)),
        AppErrorCode::LastActiveAdmin
    );

    activate_account(&lib, &second.token, "another long password", None).unwrap();
    delete_user(&lib, &admin, &admin.user_id).unwrap();
    let remaining = Ctx {
        user_id: second.user.id.clone(),
        is_admin: true,
    };
    let names: Vec<String> = list_users(&lib, &remaining)
        .unwrap()
        .into_iter()
        .map(|user| user.username)
        .collect();
    assert_eq!(names, ["anna"]);
}

#[test]
fn update_user_toggles_admin_disabled_and_quota_and_re_enabling_respects_pending() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let user = anna(&lib, &admin).user;

    let quota = |quota| UpdateUserInput {
        quota_bytes: Some(quota),
        ..Default::default()
    };
    assert_eq!(
        update_user(&lib, &admin, &user.id, quota(Some(100)))
            .unwrap()
            .quota_bytes,
        Some(100)
    );
    assert_eq!(
        update_user(&lib, &admin, &user.id, quota(None))
            .unwrap()
            .quota_bytes,
        None
    );
    let promote = UpdateUserInput {
        is_admin: Some(true),
        ..Default::default()
    };
    assert!(
        update_user(&lib, &admin, &user.id, promote)
            .unwrap()
            .is_admin
    );
    assert_eq!(
        update_user(&lib, &admin, &user.id, disable(true))
            .unwrap()
            .status,
        UserStatus::Disabled
    );
    // Never activates an account that has no password yet.
    assert_eq!(
        update_user(&lib, &admin, &user.id, disable(false))
            .unwrap()
            .status,
        UserStatus::Pending
    );
}

#[test]
fn deleting_a_user_cascades_their_metadata_but_leaves_their_folder() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let user = anna(&lib, &admin).user;
    lib.db()
        .execute(
            "INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 0)",
            params!["p1", user.id, "Bin", "Bin"],
        )
        .unwrap();

    delete_user(&lib, &admin, &user.id).unwrap();

    let projects: i64 = lib
        .db()
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(projects, 0);
    assert!(lib.dir().join("anna").is_dir());
}

#[test]
fn list_users_reports_each_user_their_own_derived_disk_usage() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let user = anna(&lib, &admin).user;
    {
        let conn = lib.db();
        conn.execute(
            "INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 0)",
            params!["p1", user.id, "Bin", "Bin"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms)
             VALUES ('f1', 'p1', 'a.stl', 'model', 4096, 0)",
            [],
        )
        .unwrap();
    }

    let by_name: HashMap<String, i64> = list_users(&lib, &admin)
        .unwrap()
        .into_iter()
        .map(|user| (user.username, user.disk_usage_bytes))
        .collect();
    assert_eq!(by_name["anna"], 4096);
    assert_eq!(by_name["admin"], 0);
}

#[test]
fn a_user_disabled_while_pending_cannot_activate_with_their_original_token() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let created = anna(&lib, &admin);
    update_user(&lib, &admin, &created.user.id, disable(true)).unwrap();

    assert_eq!(
        code_of(activate_account(&lib, &created.token, PASSWORD, None)),
        AppErrorCode::InvalidToken
    );
}

#[test]
fn reissue_invite_refuses_a_disabled_account() {
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    let user = anna(&lib, &admin).user;
    update_user(&lib, &admin, &user.id, disable(true)).unwrap();

    assert_eq!(
        code_of(reissue_invite(&lib, &admin, &user.id)),
        AppErrorCode::Conflict
    );
}

#[test]
fn core_validates_what_an_admin_creates_even_when_the_transport_did_not() {
    // Beyond the legacy cases: the rules live in core, so a transport that forgot to check still
    // cannot create a user whose name would escape the library.
    let lib = TempLibrary::new();
    let admin = active_admin(&lib);
    for bad in ["../evil", "-nope", "a", "has space"] {
        assert_eq!(
            code_of(create_user(&lib, &admin, new_user(bad, "X", false, None))),
            AppErrorCode::Validation,
            "{bad}"
        );
    }
    assert_eq!(list_users(&lib, &admin).unwrap().len(), 1);
}
