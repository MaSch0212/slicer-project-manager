use serde_json::{Value, json};
use spm_core::dto::ProjectQuery;
use spm_core::validate::{
    self, ActivateInput, CreateUserInput, FileRenameInput, ProjectPatch, Validate, parse,
    parse_project_query,
};

fn ok(result: Result<(), String>) -> bool {
    result.is_ok()
}

fn query(value: Value) -> Result<ProjectQuery, validate::Issues> {
    parse_project_query(&value)
}

#[test]
fn username_rejects_a_leading_dash_and_accepts_dots() {
    assert!(!ok(validate::username("-nope")));
    assert!(ok(validate::username("marc.schmidt")));
}

#[test]
fn activate_requires_the_confirmation_to_match() {
    let bad = ActivateInput {
        password: "longenoughpw".into(),
        confirm: "other".into(),
    };
    let issues = bad.validate().unwrap_err();
    assert_eq!(issues.first_path(), "confirm");
    let good = ActivateInput {
        password: "longenoughpw".into(),
        confirm: "longenoughpw".into(),
    };
    assert!(good.validate().is_ok());
}

#[test]
fn activate_enforces_the_10_character_floor() {
    let short = ActivateInput {
        password: "short".into(),
        confirm: "short".into(),
    };
    let issues = short.validate().unwrap_err();
    // Reported on the password, not (also) as a mismatch: a refinement only runs on a valid shape.
    assert_eq!(issues.first_path(), "password");
    assert_eq!(issues.0.len(), 1);
}

#[test]
fn create_user_defaults_is_admin_to_false_and_quota_to_unlimited() {
    let parsed: CreateUserInput =
        parse(&json!({"username": "anna", "displayName": "Anna"})).unwrap();
    assert!(!parsed.is_admin);
    assert_eq!(parsed.quota_bytes, None);
    // An explicit null is the same as omitting it, and a positive whole number is kept.
    let null: CreateUserInput =
        parse(&json!({"username": "anna", "displayName": "Anna", "quotaBytes": null})).unwrap();
    assert_eq!(null.quota_bytes, None);
    let kept: CreateUserInput =
        parse(&json!({"username": "anna", "displayName": "Anna", "quotaBytes": 5})).unwrap();
    assert_eq!(kept.quota_bytes, Some(5));
    assert!(
        parse::<CreateUserInput>(&json!({"username": "anna", "displayName": "A", "quotaBytes": 0}))
            .is_err()
    );
}

#[test]
fn file_name_rejects_separators_traversal_and_dotfiles() {
    for bad in ["../evil.stl", "a/b.stl", "a\\b.stl", "..", ".hidden"] {
        assert!(!ok(validate::file_name(bad)), "{bad}");
    }
    assert!(ok(validate::file_name("benchy.stl")));
}

#[test]
fn file_name_rejects_windows_reserved_device_names_but_accepts_look_alikes() {
    for bad in ["NUL.stl", "con.gcode", "COM1", "LPT9.txt", "nul"] {
        assert!(!ok(validate::file_name(bad)), "{bad}");
    }
    assert!(ok(validate::file_name("console.stl")));
    assert!(ok(validate::file_name("Gridfinity Bin.stl")));
    assert!(ok(validate::file_name("benchy.stl")));
}

#[test]
fn file_name_edge_cases_beyond_the_legacy_ones() {
    // COM0 and LPT0 are not reserved in the legacy pattern ([1-9]); a 10th port is not a device.
    assert!(ok(validate::file_name("COM0")));
    assert!(!ok(validate::file_name("com9.txt")));
    assert!(ok(validate::file_name("com10")));
    // Every Windows-reserved character, a NUL byte and the length bounds.
    for bad in ["a\"b", "a*b", "a:b", "a<b", "a>b", "a?b", "a|b", "a\0b", ""] {
        assert!(!ok(validate::file_name(bad)), "{bad:?}");
    }
    assert!(ok(validate::file_name(&"a".repeat(255))));
    assert!(!ok(validate::file_name(&"a".repeat(256))));
    let renamed = FileRenameInput {
        name: "con.stl".into(),
    };
    assert!(renamed.validate().is_err());
}

#[test]
fn project_patch_allows_clearing_website_with_null_but_not_with_a_bad_url() {
    let cleared: ProjectPatch = parse(&json!({"website": null})).unwrap();
    assert_eq!(cleared.website, Some(None));
    let untouched: ProjectPatch = parse(&json!({})).unwrap();
    assert_eq!(untouched.website, None);
    assert!(parse::<ProjectPatch>(&json!({"website": "not a url"})).is_err());
    let set: ProjectPatch = parse(&json!({"website": "https://example.com/m/1"})).unwrap();
    assert_eq!(
        set.website,
        Some(Some("https://example.com/m/1".to_owned()))
    );
}

#[test]
fn project_query_accepts_a_valid_limit_offset_pair() {
    let parsed = query(json!({"limit": 48, "offset": 96})).unwrap();
    assert_eq!(
        parsed,
        ProjectQuery {
            limit: Some(48),
            offset: Some(96),
            ..Default::default()
        }
    );
}

#[test]
fn project_query_rejects_a_limit_over_the_200_cap_zero_negative_or_non_integer() {
    for bad in [json!(201), json!(0), json!(-1), json!(1.5)] {
        assert!(query(json!({"limit": bad.clone()})).is_err(), "{bad}");
    }
    // The cap itself is still admitted: only past it is refused.
    assert!(query(json!({"limit": 200})).is_ok());
}

#[test]
fn project_query_rejects_a_negative_or_non_integer_offset_but_allows_zero() {
    for bad in [json!(-1), json!(1.5)] {
        assert!(query(json!({"offset": bad.clone()})).is_err(), "{bad}");
    }
    assert!(query(json!({"offset": 0})).is_ok());
}

#[test]
fn project_query_caps_the_search_term_and_validates_its_tags() {
    // Beyond the legacy cases, but the same schema: the search cap the UI mirrors, and the
    // per-tag rules the filter shares with tag creation.
    assert!(query(json!({"search": "a".repeat(200)})).is_ok());
    assert!(query(json!({"search": "a".repeat(201)})).is_err());
    assert!(query(json!({"tags": ["  petg  "]})).unwrap().tags == Some(vec!["petg".to_owned()]));
    assert!(query(json!({"tags": [""]})).is_err());
    assert!(query(json!({"sort": "colour"})).is_err());
}

#[test]
fn server_url_accepts_http_and_https_and_no_other_scheme() {
    for bad in [
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///c:/",
        "not a url",
    ] {
        assert!(!ok(validate::server_url(bad)), "{bad}");
    }
    assert!(ok(validate::server_url("https://example.invalid:8443/")));
    assert!(ok(validate::server_url("http://192.168.1.10:8080")));
}

#[test]
fn server_url_rejects_an_address_carrying_credentials() {
    for bad in [
        "https://user:pass@example.invalid/",
        "https://user@example.invalid/",
        "https://:pass@example.invalid/",
        "http://admin:hunter2@192.168.1.10:8080/",
    ] {
        assert!(!ok(validate::server_url(bad)), "{bad}");
    }
    // The same host without them is still fine, so this rejects the credentials and not the URL.
    assert!(ok(validate::server_url("https://example.invalid/")));
}

#[test]
fn server_url_rejects_a_path_a_query_and_a_fragment_as_the_shell_does() {
    for bad in [
        "https://print.example.invalid/spm",
        "https://print.example.invalid/?next=/projects",
        "https://print.example.invalid/#projects",
        "http://192.168.1.10:8080/api/",
    ] {
        assert!(!ok(validate::server_url(bad)), "{bad}");
    }
    assert!(ok(validate::server_url("https://print.example.invalid")));
    assert!(ok(validate::server_url("https://print.example.invalid/")));
    assert!(ok(validate::server_url("http://192.168.1.10:8080/")));
}

#[test]
fn issues_become_the_legacy_validation_error_shape() {
    let error: spm_core::AppError =
        parse::<ActivateInput>(&json!({"password": "longenoughpw", "confirm": "x"}))
            .unwrap_err()
            .into();
    assert_eq!(error.code, spm_core::AppErrorCode::Validation);
    assert_eq!(error.message, "request body failed validation");
    let envelope = serde_json::to_value(error.to_envelope()).unwrap();
    assert_eq!(
        envelope,
        json!({"error": {
            "code": "Validation",
            "message": "request body failed validation",
            "details": {"issues": [{"message": "passwords do not match", "path": ["confirm"]}]},
        }})
    );
}
