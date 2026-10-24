use rusqlite::params;
use serde_json::{Value, json};
use spm_core::auth::password::{PW_ALGO, PW_ITERATIONS, hash_password_with};
use spm_core::auth::tokens::timing_safe_equal;
use spm_core::dto::{DEFAULT_SETTINGS, SettingsPatch, Theme};
use spm_core::files::paths::{safe_join, user_root};
use spm_core::testing::TempLibrary;
use spm_core::users::settings::JsonCodec;
use spm_core::validate::ProfilePatch;
use spm_core::{
    AppErrorCode, Ctx, Library, activate_account, change_password, ensure_bootstrap_admin,
    ensure_local_user, get_settings, login, me, put_settings, update_profile,
};

use crate::common::{PASSWORD, code_of, is_url_safe_token};

/// A bootstrapped, activated admin: what most of these tests start from.
fn activated(lib: &Library) -> Ctx {
    crate::common::active_admin(lib)
}

fn store_setting(lib: &Library, ctx: &Ctx, key: &str, value: &str) {
    lib.db()
        .execute(
            "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)",
            params![ctx.user_id, key, value],
        )
        .unwrap();
}

#[test]
fn safe_join_refuses_to_escape_its_base() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("lib").join("marc");
    assert_eq!(
        safe_join(&base, &["Benchy", "a.stl"]).unwrap(),
        base.join("Benchy").join("a.stl")
    );
    assert_eq!(
        code_of(safe_join(&base, &["..", "anna"])),
        AppErrorCode::Forbidden
    );
}

#[test]
fn safe_join_refuses_absolute_rooted_and_backslash_traversal_segments() {
    // Beyond the legacy case: the same verdict on every platform, whatever the separator.
    let dir = tempfile::tempdir().unwrap();
    for bad in [
        "",
        "/etc",
        "\\share",
        "a/../../b",
        "a\\..\\..\\b",
        "C:\\Windows",
        "..",
    ] {
        assert_eq!(
            code_of(safe_join(dir.path(), &[bad])),
            AppErrorCode::Forbidden,
            "{bad:?}"
        );
    }
    assert!(safe_join(dir.path(), &["a", "b c.stl"]).is_ok());
}

#[test]
fn user_root_flattens_the_library_when_library_dir_is_dot() {
    let lib = TempLibrary::new();
    assert_eq!(user_root(&lib, ".").unwrap(), lib.dir());
    assert_eq!(user_root(&lib, "marc").unwrap(), lib.dir().join("marc"));
}

#[test]
fn bootstrap_creates_a_pending_admin_with_no_password_and_returns_the_token_once() {
    let lib = TempLibrary::new();
    let first = ensure_bootstrap_admin(&lib)
        .unwrap()
        .expect("the first call bootstraps");
    assert_eq!(first.username, "admin");
    assert!(is_url_safe_token(&first.token), "{}", first.token);

    let (status, is_admin, pw_hash): (String, i64, Option<Vec<u8>>) = lib
        .db()
        .query_row("SELECT status, is_admin, pw_hash FROM users", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(status, "pending");
    assert_eq!(is_admin, 1);
    assert_eq!(pw_hash, None);
    assert!(lib.dir().join("admin").is_dir());

    assert_eq!(ensure_bootstrap_admin(&lib).unwrap(), None);
}

#[test]
fn a_pending_account_cannot_log_in() {
    let lib = TempLibrary::new();
    ensure_bootstrap_admin(&lib).unwrap();
    assert_eq!(
        code_of(login(&lib, "admin", "anything at all", None)),
        AppErrorCode::Unauthorized
    );
}

#[test]
fn activation_sets_the_password_activates_and_logs_the_user_straight_in() {
    let lib = TempLibrary::new();
    let boot = ensure_bootstrap_admin(&lib).unwrap().unwrap();
    let result = activate_account(&lib, &boot.token, PASSWORD, Some("agent")).unwrap();
    assert_eq!(result.user.status, spm_core::dto::UserStatus::Active);
    assert!(result.user.activated_at.is_some());
    assert!(!result.token.is_empty());

    let after = login(&lib, "admin", PASSWORD, None).unwrap();
    assert_eq!(after.user.username, "admin");
    assert!(after.user.is_admin);
    assert_eq!(after.user.disk_usage_bytes, 0);
    assert_eq!(after.user.quota_bytes, None);
}

#[test]
fn activation_cannot_be_replayed() {
    let lib = TempLibrary::new();
    let boot = ensure_bootstrap_admin(&lib).unwrap().unwrap();
    activate_account(&lib, &boot.token, PASSWORD, None).unwrap();
    assert_eq!(
        code_of(activate_account(
            &lib,
            &boot.token,
            "another password",
            None
        )),
        AppErrorCode::InvalidToken
    );
}

#[test]
fn login_rejects_a_wrong_password_and_a_disabled_account_identically() {
    let lib = TempLibrary::new();
    activated(&lib);

    let wrong = login(&lib, "admin", "wrong password", None).unwrap_err();
    assert_eq!(wrong.code, AppErrorCode::Unauthorized);
    lib.db()
        .execute("UPDATE users SET status = 'disabled'", [])
        .unwrap();
    let disabled = login(&lib, "admin", PASSWORD, None).unwrap_err();
    assert_eq!(disabled.code, AppErrorCode::Unauthorized);
    // Identical, message included: nothing tells the two apart.
    assert_eq!(wrong.message, disabled.message);
}

#[test]
fn login_upgrades_a_hash_stored_with_weaker_parameters() {
    let lib = TempLibrary::new();
    activated(&lib);

    let weak = hash_password_with(PASSWORD, 1000);
    lib.db()
        .execute(
            "UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?",
            params![weak.hash, weak.salt, weak.iterations, weak.algo],
        )
        .unwrap();

    login(&lib, "admin", PASSWORD, None).unwrap();
    let (hash, salt, iterations, algo): (Vec<u8>, Vec<u8>, i64, String) = lib
        .db()
        .query_row(
            "SELECT pw_hash, pw_salt, pw_iterations, pw_algo FROM users",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();

    // The write-back must land all four columns together: a partial write (a refactor that drops
    // the salt or algo assignment) would leave a password that can never verify again, silently
    // and permanently.
    assert_eq!(iterations, i64::from(PW_ITERATIONS));
    assert_eq!(algo, PW_ALGO);
    assert!(!timing_safe_equal(&hash, &weak.hash));
    assert!(!timing_safe_equal(&salt, &weak.salt));

    // End-to-end proof the upgraded row is actually authenticatable, not just rewritten.
    assert!(login(&lib, "admin", PASSWORD, None).is_ok());
}

#[test]
fn change_password_requires_the_current_one_and_invalidates_nothing_else() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);

    assert_eq!(
        code_of(change_password(&lib, &ctx, "not it", "a new long password")),
        AppErrorCode::Unauthorized
    );
    change_password(&lib, &ctx, PASSWORD, "a new long password").unwrap();
    assert!(login(&lib, "admin", "a new long password", None).is_ok());
}

#[test]
fn update_profile_changes_the_display_name_only() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    let patch = ProfilePatch {
        display_name: Some("Marc S".to_owned()),
    };
    assert_eq!(
        update_profile(&lib, &ctx, patch).unwrap().display_name,
        "Marc S"
    );
    assert_eq!(me(&lib, &ctx).unwrap().username, "admin");
}

#[test]
fn settings_return_defaults_then_merge_a_patch() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);

    // DEFAULT_SETTINGS, not a literal copy: a literal here would silently stop covering whichever
    // key the struct gains next. (The literal itself is pinned in `dtos`.)
    assert_eq!(get_settings(&lib, &ctx).unwrap(), DEFAULT_SETTINGS);
    let german = SettingsPatch {
        language: Some(spm_core::dto::Language::De),
        ..Default::default()
    };
    assert_eq!(
        put_settings(&lib, &ctx, german).unwrap().language,
        spm_core::dto::Language::De
    );
    let dark = SettingsPatch {
        theme: Some(Theme::Dark),
        ..Default::default()
    };
    assert_eq!(
        put_settings(&lib, &ctx, dark).unwrap().language,
        spm_core::dto::Language::De
    );
    assert_eq!(get_settings(&lib, &ctx).unwrap().theme, Theme::Dark);
}

// The codec table's enum tightening is a deliberate behaviour change (spec 3.2): a row written by
// a build that once offered a "purple" theme, or edited by hand, must not ship to the renderer.
#[test]
fn a_stored_theme_value_the_enum_no_longer_accepts_falls_back_to_the_default_not_through() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    store_setting(&lib, &ctx, "theme", "purple");

    let settings = get_settings(&lib, &ctx).unwrap();
    assert_eq!(settings.theme, DEFAULT_SETTINGS.theme);
}

#[test]
fn nav_collapsed_round_trips_true_and_false_through_put_and_get_settings() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    let patch = |value| SettingsPatch {
        nav_collapsed: Some(value),
        ..Default::default()
    };

    assert!(!get_settings(&lib, &ctx).unwrap().nav_collapsed);
    assert!(put_settings(&lib, &ctx, patch(true)).unwrap().nav_collapsed);
    assert!(get_settings(&lib, &ctx).unwrap().nav_collapsed);
    assert!(
        !put_settings(&lib, &ctx, patch(false))
            .unwrap()
            .nav_collapsed
    );
    assert!(!get_settings(&lib, &ctx).unwrap().nav_collapsed);
}

#[test]
fn a_nav_collapsed_row_holding_garbage_falls_back_to_the_default() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    store_setting(&lib, &ctx, "navCollapsed", "yes");

    assert!(!get_settings(&lib, &ctx).unwrap().nav_collapsed);
}

#[test]
fn include_archived_round_trips_true_and_false_through_put_and_get_settings() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    let patch = |value| SettingsPatch {
        include_archived: Some(value),
        ..Default::default()
    };

    assert!(!get_settings(&lib, &ctx).unwrap().include_archived);
    assert!(
        put_settings(&lib, &ctx, patch(true))
            .unwrap()
            .include_archived
    );
    assert!(get_settings(&lib, &ctx).unwrap().include_archived);
    assert!(
        !put_settings(&lib, &ctx, patch(false))
            .unwrap()
            .include_archived
    );
    assert!(!get_settings(&lib, &ctx).unwrap().include_archived);
}

#[test]
fn filter_tags_round_trips_a_list_through_put_and_get_settings() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);

    assert!(get_settings(&lib, &ctx).unwrap().filter_tags.is_empty());
    let tags = vec!["petg".to_owned(), "functional".to_owned()];
    let patch = SettingsPatch {
        filter_tags: Some(tags.clone()),
        ..Default::default()
    };
    assert_eq!(put_settings(&lib, &ctx, patch).unwrap().filter_tags, tags);
    assert_eq!(get_settings(&lib, &ctx).unwrap().filter_tags, tags);
}

// A stored filterTags value that fails the schema decodes to nothing and the default (an empty
// list) stands, exactly as a stored theme the enum no longer accepts falls back above. `["a", 1]`
// is valid JSON, an array, but its second element is a number, which a tag name is not.
#[test]
fn a_stored_filter_tags_value_that_fails_the_schema_falls_back_to_the_default() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    store_setting(&lib, &ctx, "filterTags", r#"["a", 1]"#);

    assert!(get_settings(&lib, &ctx).unwrap().filter_tags.is_empty());
}

// The array-length half of the schema is a separate clause from the per-element check: every one
// of 51 generated names is individually valid, so this only fails because the list itself is one
// element over the bound.
#[test]
fn a_stored_filter_tags_value_of_51_tags_exceeds_the_bound_and_falls_back_to_the_default() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    let too_many: Vec<String> = (0..51).map(|i| format!("tag{i}")).collect();
    store_setting(
        &lib,
        &ctx,
        "filterTags",
        &serde_json::to_string(&too_many).unwrap(),
    );

    assert!(get_settings(&lib, &ctx).unwrap().filter_tags.is_empty());
}

// The bound's other side: exactly 50 is still within it, so this pins the limit at 50 rather than
// merely "somewhere below 51".
#[test]
fn a_stored_filter_tags_value_of_exactly_50_tags_is_within_the_bound_and_round_trips() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    let at_limit: Vec<String> = (0..50).map(|i| format!("tag{i}")).collect();
    store_setting(
        &lib,
        &ctx,
        "filterTags",
        &serde_json::to_string(&at_limit).unwrap(),
    );

    assert_eq!(get_settings(&lib, &ctx).unwrap().filter_tags, at_limit);
}

// Not JSON at all takes the same fallback through the codec's parse guard instead of its
// validator guard: two separate branches, and a regression could break either without the other.
#[test]
fn a_stored_filter_tags_value_that_is_not_json_at_all_falls_back_to_the_default() {
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    store_setting(&lib, &ctx, "filterTags", "not json at all");

    assert!(get_settings(&lib, &ctx).unwrap().filter_tags.is_empty());
}

// These exercise the JSON codec directly, against an ad hoc validator, rather than through
// get/put: they pin the codec's own contract independently of which key uses it. Three separate
// tests, not one sequential fixture, so a failure in one cannot shadow the others.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Payload {
    tags: Vec<String>,
}

fn payload_codec() -> JsonCodec<Payload, impl Fn(Value) -> Option<Payload>> {
    JsonCodec::new(|value| serde_json::from_value::<Payload>(value).ok())
}

#[test]
fn json_codec_round_trips_a_payload_the_schema_accepts() {
    let codec = payload_codec();
    let payload = Payload {
        tags: vec!["petg".to_owned(), "functional".to_owned()],
    };
    let encoded = codec.encode(&payload);
    assert_eq!(codec.decode(&encoded), Some(payload));
}

#[test]
fn json_codec_decode_returns_none_for_malformed_json() {
    assert_eq!(payload_codec().decode("{not valid json"), None);
}

#[test]
fn json_codec_decode_returns_none_for_json_that_parses_but_fails_the_schema() {
    assert_eq!(
        payload_codec().decode(&json!({"tags": [1, 2]}).to_string()),
        None
    );
}

#[test]
fn ensure_local_user_makes_one_flat_library_user_and_is_idempotent() {
    let lib = TempLibrary::new();
    let ctx = ensure_local_user(&lib).unwrap();
    assert!(!ctx.is_admin);
    assert_eq!(ensure_local_user(&lib).unwrap(), ctx);
    let (library_dir, count): (String, i64) = lib
        .db()
        .query_row(
            "SELECT library_dir, (SELECT COUNT(*) FROM users) FROM users",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(library_dir, ".");
    assert_eq!(count, 1);
}

#[test]
fn a_new_password_below_the_floor_is_refused_by_core_itself() {
    // Beyond the legacy cases: the floor is enforced where the password is set, not only at the
    // transport, because core is the authority.
    let lib = TempLibrary::new();
    let ctx = activated(&lib);
    assert_eq!(
        code_of(change_password(&lib, &ctx, PASSWORD, "short")),
        AppErrorCode::Validation
    );
    let boot_lib = TempLibrary::new();
    let boot = ensure_bootstrap_admin(&boot_lib).unwrap().unwrap();
    assert_eq!(
        code_of(activate_account(&boot_lib, &boot.token, "short", None)),
        AppErrorCode::Validation
    );
    // A refused attempt burns nothing: the invite still works.
    assert!(activate_account(&boot_lib, &boot.token, PASSWORD, None).is_ok());
}
