//! What core logs, and what it must never log.
//!
//! The legacy `logging.test.ts` mixed user/auth cases with rescan, preview-queue and importer
//! cases. All of them are here now: the preview-queue pair at the bottom was held back until the
//! queue existed (part 4).

use std::fs;

use spm_core::dto::FileKind;
use spm_core::log::{LogLevel, LogLevelSetting, LogValue};
use spm_core::previews::{QueueOptions, handler_from_fn, run_preview_queue};
use spm_core::projects::import_curamanager::ImportProgress;
use spm_core::projects::rescan::RescanProgress;
use spm_core::testing::{TempLibrary, seed_user};
use spm_core::validate::{CreateProjectInput, CreateUserInput};

use crate::fixtures::cura_project;
use crate::mesh_fixtures::make_png;
use spm_core::{
    AppError, Ctx, create_project, create_user, delete_project, delete_user,
    ensure_bootstrap_admin, import_curamanager_library, login, rescan,
};

fn text(value: Option<&LogValue>) -> Option<&str> {
    match value {
        Some(LogValue::Str(text)) => Some(text),
        _ => None,
    }
}

/// The legacy test captured the real console around a rescan. Here "silent unless configured" is
/// enforced twice: `spm-core` denies `print!`/`eprintln!` outside the opt-in console sink at
/// compile time (`#![deny(clippy::print_stdout, clippy::print_stderr)]`), and a library opened
/// with no logger gets a silent one, which this test checks while the library does real work,
/// rescan included.
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
    // The rescan half of the legacy scenario: a project, then a rescan that adopts a folder.
    let ctx = seed_user(&lib, "owner");
    create_project(&lib, &ctx, named("Silent")).unwrap();
    fs::create_dir(lib.dir().join("owner").join("Adopted")).unwrap();
    assert_eq!(rescan(&lib, &ctx, None).unwrap().adopted, 1);
}

fn named(name: &str) -> CreateProjectInput {
    CreateProjectInput {
        name: name.to_owned(),
        ..CreateProjectInput::default()
    }
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

/// The project half of the legacy lifecycle test (the user half is above).
#[test]
fn project_lifecycle_changes_are_logged_at_info_with_who_did_them() {
    let (lib, logs) = TempLibrary::logged();
    let ctx = seed_user(&lib, "owner");
    let project = create_project(&lib, &ctx, named("Widget")).unwrap();
    let created = logs.find("project created").expect("creation was logged");
    assert_eq!(created.level, LogLevel::Info);
    assert_eq!(text(created.field("projectId")), Some(project.id.as_str()));
    assert_eq!(text(created.field("userId")), Some(ctx.user_id.as_str()));

    delete_project(&lib, &ctx, &project.id, false).unwrap();
    let deleted = logs.find("project deleted").expect("deletion was logged");
    assert_eq!(deleted.level, LogLevel::Info);
    assert_eq!(text(deleted.field("projectId")), Some(project.id.as_str()));
}

#[test]
fn rescan_logs_a_summary_carrying_its_own_counts() {
    let (lib, logs) = TempLibrary::logged();
    let ctx = seed_user(&lib, "marc");
    let dir = lib.dir().join("marc").join("Adopted Me");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("part.stl"), "solid x").unwrap();

    let result = rescan(&lib, &ctx, None).unwrap();
    // The counts must be non-zero, or the assertions below could not tell a working summary from
    // one that logged zeroes.
    assert_eq!(result.adopted, 1);
    assert_eq!(result.files_added, 1);

    let summary = logs
        .find("rescan complete")
        .expect("no rescan summary was logged");
    assert_eq!(summary.level, LogLevel::Info);
    assert_eq!(summary.field("adopted"), Some(&LogValue::Int(1)));
    assert_eq!(summary.field("filesAdded"), Some(&LogValue::Int(1)));
    assert_eq!(text(summary.field("userId")), Some(ctx.user_id.as_str()));

    let adopted = logs
        .find("adopted project folder")
        .expect("no per-folder record");
    assert_eq!(adopted.level, LogLevel::Debug);
    assert_eq!(text(adopted.field("dirName")), Some("Adopted Me"));
}

#[test]
fn rescan_reports_progress_for_every_project_and_every_file_it_examines() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    for name in ["Alpha", "Beta"] {
        let dir = lib.dir().join("marc").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.stl"), "solid a").unwrap();
        fs::write(dir.join("b.stl"), "solid b").unwrap();
    }

    let mut events: Vec<RescanProgress> = Vec::new();
    let mut record = |event: &RescanProgress| events.push(event.clone());
    let result = rescan(&lib, &ctx, Some(&mut record)).unwrap();
    assert_eq!(result.files_added, 4);

    let mut dirs: Vec<&str> = events.iter().map(|e| e.dir_name.as_str()).collect();
    dirs.dedup();
    assert_eq!(dirs, ["Alpha", "Beta"]);
    // Two projects, and each one reports once on entry plus once per file: 2 * (1 + 2).
    assert_eq!(events.len(), 6);
    assert!(events.iter().all(|e| e.project_count == 2));
    assert_eq!(
        events.iter().map(|e| e.project_index).collect::<Vec<_>>(),
        [1, 1, 1, 2, 2, 2]
    );
    // The cumulative counters must actually climb, not just be present.
    assert_eq!(
        events.iter().map(|e| e.files_seen).collect::<Vec<_>>(),
        [0, 1, 2, 2, 3, 4]
    );
    assert_eq!(events.last().map(|e| e.files_added), Some(3));
}

#[test]
fn the_importer_reports_both_phases_indexing_before_sidecars() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let dir = lib.dir().join("marc").join("Widget");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("part.stl"), "solid x").unwrap();
    fs::write(
        dir.join("metadata.json"),
        r#"{"Tags": ["toys"], "IsArchived": true}"#,
    )
    .unwrap();

    let mut events: Vec<ImportProgress> = Vec::new();
    let mut record = |event: &ImportProgress| events.push(event.clone());
    let result = import_curamanager_library(&lib, &ctx, false, Some(&mut record)).unwrap();
    assert_eq!(result.tags_applied, 1);

    let is_indexing = |e: &ImportProgress| matches!(e, ImportProgress::Indexing(_));
    let is_sidecars = |e: &ImportProgress| matches!(e, ImportProgress::Sidecars { .. });
    let last_indexing = events
        .iter()
        .rposition(is_indexing)
        .expect("no indexing progress was reported");
    let first_sidecars = events
        .iter()
        .position(is_sidecars)
        .expect("no sidecar progress was reported");
    assert!(
        last_indexing < first_sidecars,
        "phases interleaved: {events:?}"
    );
    let Some(ImportProgress::Sidecars {
        project_index,
        project_count,
        dir_name,
    }) = events.iter().find(|e| is_sidecars(e))
    else {
        unreachable!("a sidecars event was found above")
    };
    assert_eq!(
        (dir_name.as_str(), *project_index, *project_count),
        ("Widget", 1, 1)
    );
}

#[test]
fn a_rescan_with_no_progress_callback_still_works() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    fs::create_dir_all(lib.dir().join("marc").join("Solo")).unwrap();
    assert_eq!(rescan(&lib, &ctx, None).unwrap().adopted, 1);
}

#[test]
fn the_preview_queue_logs_a_batch_summary_and_stays_quiet_when_idle() {
    let (lib, logs) = TempLibrary::logged();
    let ctx = seed_user(&lib, "marc");
    let dir = lib.dir().join("marc").join("Project");
    fs::create_dir_all(&dir).unwrap();
    cura_project(&dir.join("model.3mf"), Some(&make_png(256, 256)));
    rescan(&lib, &ctx, None).unwrap();

    logs.clear();
    let result = run_preview_queue(&lib, &QueueOptions::default()).unwrap();
    assert_eq!(
        result.ready, 1,
        "the fixture must actually produce a preview"
    );
    let batch = logs.find("preview batch").expect("the batch was logged");
    assert_eq!(batch.level, LogLevel::Info);
    assert_eq!(batch.field("claimed"), Some(&LogValue::UInt(1)));
    assert_eq!(batch.field("ready"), Some(&LogValue::UInt(1)));

    // Second run: nothing pending, so an operator on the default level sees nothing at all rather
    // than a zeroed line every few seconds forever.
    logs.clear();
    run_preview_queue(&lib, &QueueOptions::default()).unwrap();
    let info: Vec<_> = logs
        .records()
        .into_iter()
        .filter(|record| record.level == LogLevel::Info)
        .collect();
    assert_eq!(info, []);
}

#[test]
fn a_failing_preview_is_logged_at_warn_with_the_path_that_caused_it() {
    let (lib, logs) = TempLibrary::logged();
    let ctx = seed_user(&lib, "marc");
    let dir = lib.dir().join("marc").join("Project");
    fs::create_dir_all(&dir).unwrap();
    cura_project(&dir.join("model.3mf"), Some(&make_png(256, 256)));
    rescan(&lib, &ctx, None).unwrap();

    logs.clear();
    let result = run_preview_queue(
        &lib,
        &QueueOptions {
            handlers: vec![handler_from_fn(&[FileKind::SlicerProject], |_| {
                Err(AppError::internal("handler exploded"))
            })],
            ..QueueOptions::default()
        },
    )
    .unwrap();
    assert_eq!(result.failed, 1);
    let failure = logs.find("preview failed").expect("the failure was logged");
    assert_eq!(failure.level, LogLevel::Warn);
    let path = text(failure.field("path")).expect("the record carries the path");
    assert!(path.ends_with("model.3mf"), "{path}");
}
