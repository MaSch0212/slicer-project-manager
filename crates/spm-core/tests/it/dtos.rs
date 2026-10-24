use serde_json::json;
use spm_core::dto::{
    BrowseDownloadDto, BrowseDownloadState, CoreProjectDto, DEFAULT_SETTINGS, FileCounts, FileDto,
    FileKind, PreviewState, ProjectDetailDto, ProjectDto, ProjectState, SlicerId, SlicerSessionDto,
    UserDto, UserStatus,
};
use spm_core::error::{AppErrorCode, QuotaExceededDetails};
use spm_core::{AppError, fields};

/// A literal, not a self-comparison. `get_settings` builds its result from `DEFAULT_SETTINGS` when
/// a user has no `user_settings` rows, so a test that asserts that case against the constant pins
/// only that a *copy of the constant* is returned: it catches a key going missing from the merge
/// but nothing pins what the constant itself says. The legacy suite measured the gap directly:
/// changing `viewMode` from `grid` to `list` left every other test green. This is that pin, one
/// per shipped default, serialised so the wire spelling is pinned too.
#[test]
fn default_settings_matches_the_shipped_defaults_exactly() {
    assert_eq!(
        serde_json::to_value(&DEFAULT_SETTINGS).unwrap(),
        json!({
            "theme": "system",
            "language": "en",
            "viewMode": "grid",
            "sort": "updatedAt",
            "dir": "desc",
            "navCollapsed": false,
            "includeArchived": false,
            "filterTags": [],
        })
    );
}

// Beyond the legacy inventory: the wire shape the port promises is "the same JSON as today".

#[test]
fn error_codes_serialise_to_the_exact_legacy_strings() {
    let legacy = [
        "Unauthorized",
        "Forbidden",
        "NotFound",
        "Conflict",
        "Validation",
        "QuotaExceeded",
        "LengthRequired",
        "InvalidToken",
        "TokenExpired",
        "LastActiveAdmin",
        "TooManyRequests",
        "Internal",
    ];
    assert_eq!(AppErrorCode::ALL.len(), legacy.len());
    for (code, expected) in AppErrorCode::ALL.iter().zip(legacy) {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(expected));
        assert_eq!(code.as_str(), expected);
        assert_eq!(AppErrorCode::parse(expected), Some(*code));
    }
    assert_eq!(AppErrorCode::parse("MethodNotAllowed"), None);
    assert_eq!(AppErrorCode::parse("unauthorized"), None);
}

#[test]
fn the_error_envelope_has_the_legacy_shape() {
    let plain = serde_json::to_value(AppError::not_found("user not found").to_envelope()).unwrap();
    assert_eq!(
        plain,
        json!({"error": {"code": "NotFound", "message": "user not found", "details": {}}})
    );
    let quota = AppError::quota_exceeded(QuotaExceededDetails {
        usage_bytes: 10,
        quota_bytes: 20,
        incoming_bytes: 30,
    });
    assert_eq!(
        serde_json::to_value(quota.to_envelope()).unwrap()["error"]["details"],
        json!({"usageBytes": 10, "quotaBytes": 20, "incomingBytes": 30})
    );
    // An internal failure never leaks its cause to the wire.
    let internal = AppError::internal("disk on fire at /srv/library");
    assert_eq!(internal.message, "internal error");
    assert!(
        !serde_json::to_string(&internal.to_envelope())
            .unwrap()
            .contains("fire")
    );
    assert_eq!(
        internal.cause.as_deref(),
        Some("disk on fire at /srv/library")
    );
}

fn project() -> ProjectDto {
    ProjectDto {
        id: "p1".into(),
        name: "Benchy".into(),
        website: Some("https://example.com/m/1".into()),
        notes: None,
        is_archived: false,
        state: ProjectState::Ok,
        tags: vec!["petg".into()],
        file_counts: FileCounts {
            model: 1,
            slicer_project: 0,
            other: 1,
        },
        created_at: 10,
        updated_at: 20,
        cover_thumb_url: Some("/api/files/f1/thumb".into()),
    }
}

fn files() -> Vec<FileDto> {
    vec![
        FileDto {
            id: "f1".into(),
            name: "cube.stl".into(),
            kind: FileKind::Model,
            slicer: None,
            size_bytes: 42,
            preview_state: PreviewState::Ready,
            raw_url: "/api/files/f1/raw".into(),
            thumb_url: Some("/api/files/f1/thumb".into()),
        },
        FileDto {
            id: "f2".into(),
            name: "notes.txt".into(),
            kind: FileKind::Other,
            slicer: None,
            size_bytes: 7,
            preview_state: PreviewState::Pending,
            raw_url: "/api/files/f2/raw".into(),
            thumb_url: None,
        },
    ]
}

// The key order is the one the legacy server emitted (decorate.ts appended `rawUrl` and
// `thumbUrl`, and `coverThumbUrl`, after the core fields), so the serialised bytes are identical,
// not merely equivalent. The same strings the legacy `decorate.test.ts` pinned.
#[test]
fn a_file_dto_serialises_to_the_exact_bytes_the_server_has_always_emitted() {
    let files = files();
    assert_eq!(
        serde_json::to_string(&files[0]).unwrap(),
        concat!(
            r#"{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready","#,
            r#""rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"}"#
        )
    );
    // Not ready: no `thumbUrl` key at all, absent rather than null.
    assert_eq!(
        serde_json::to_string(&files[1]).unwrap(),
        concat!(
            r#"{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending","#,
            r#""rawUrl":"/api/files/f2/raw"}"#
        )
    );
}

#[test]
fn a_project_detail_dto_serialises_to_the_exact_legacy_bytes() {
    let detail = ProjectDetailDto {
        project: project(),
        files: files(),
    };
    assert_eq!(
        serde_json::to_string(&detail).unwrap(),
        concat!(
            r#"{"id":"p1","name":"Benchy","website":"https://example.com/m/1","isArchived":false,"#,
            r#""state":"ok","tags":["petg"],"fileCounts":{"model":1,"slicerProject":0,"other":1},"#,
            r#""createdAt":10,"updatedAt":20,"coverThumbUrl":"/api/files/f1/thumb","files":["#,
            r#"{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready","#,
            r#""rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"},"#,
            r#"{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending","#,
            r#""rawUrl":"/api/files/f2/raw"}]}"#
        )
    );
}

#[test]
fn a_core_project_dto_carries_the_cover_file_id_not_a_url() {
    let core = CoreProjectDto {
        id: "p1".into(),
        name: "Benchy".into(),
        website: None,
        notes: None,
        is_archived: true,
        state: ProjectState::Missing,
        tags: vec![],
        file_counts: FileCounts::default(),
        cover_file_id: Some("f1".into()),
        created_at: 1,
        updated_at: 2,
    };
    assert_eq!(
        serde_json::to_string(&core).unwrap(),
        concat!(
            r#"{"id":"p1","name":"Benchy","isArchived":true,"state":"missing","tags":[],"#,
            r#""fileCounts":{"model":0,"slicerProject":0,"other":0},"coverFileId":"f1","#,
            r#""createdAt":1,"updatedAt":2}"#
        )
    );
}

#[test]
fn a_user_dto_keeps_quota_null_but_omits_an_absent_activated_at() {
    let user = UserDto {
        id: "u".into(),
        username: "anna".into(),
        display_name: "Anna".into(),
        is_admin: false,
        status: UserStatus::Pending,
        disk_usage_bytes: 0,
        quota_bytes: None,
        created_at: 5,
        activated_at: None,
    };
    assert_eq!(
        serde_json::to_string(&user).unwrap(),
        concat!(
            r#"{"id":"u","username":"anna","displayName":"Anna","isAdmin":false,"status":"pending","#,
            r#""diskUsageBytes":0,"quotaBytes":null,"createdAt":5}"#
        )
    );
}

#[test]
fn enum_values_keep_their_legacy_spelling() {
    assert_eq!(
        serde_json::to_value(FileKind::SlicerProject).unwrap(),
        json!("slicer_project")
    );
    assert_eq!(
        serde_json::to_value(SlicerId::Prusaslicer).unwrap(),
        json!("prusaslicer")
    );
    assert_eq!(
        serde_json::to_value(BrowseDownloadState::Interrupted).unwrap(),
        json!("interrupted")
    );
    // The database spellings agree with the wire ones, so a row can be mapped by either.
    for kind in [FileKind::Model, FileKind::SlicerProject, FileKind::Other] {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
        assert_eq!(FileKind::parse(kind.as_str()), Some(kind));
    }
    for state in [
        PreviewState::Pending,
        PreviewState::Ready,
        PreviewState::Failed,
        PreviewState::Unsupported,
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), json!(state.as_str()));
    }
}

#[test]
fn a_session_dto_tells_an_absent_slicer_from_a_null_one() {
    // `sourceSlicer?: SlicerId | null`: absent for an orphan, null for a file with no slicer.
    let mut session: SlicerSessionDto = serde_json::from_value(json!({
        "launchId": "l", "projectId": "", "fileId": "", "fileName": "a.stl", "slicerId": null,
        "startedAt": 1, "processAlive": false, "fileState": "unchanged", "isOrphan": true,
    }))
    .unwrap();
    assert_eq!(session.source_slicer, None);
    assert!(
        serde_json::to_value(&session)
            .unwrap()
            .get("sourceSlicer")
            .is_none()
    );

    session.source_slicer = Some(None);
    assert_eq!(
        serde_json::to_value(&session).unwrap()["sourceSlicer"],
        json!(null)
    );
    session.source_slicer = Some(Some(SlicerId::Orca));
    assert_eq!(
        serde_json::to_value(&session).unwrap()["sourceSlicer"],
        json!("orca")
    );
}

#[test]
fn a_download_dto_round_trips() {
    let download = BrowseDownloadDto {
        download_id: "d".into(),
        file_name: "x.stl".into(),
        source_url: "blob:https://a/b".into(),
        page_url: None,
        site_id: None,
        mime_type: "model/stl".into(),
        state: BrowseDownloadState::Completed,
        received_bytes: 1,
        total_bytes: 0,
        had_user_gesture: true,
        started_at: 9,
        is_orphan: false,
        is_verifiable: true,
    };
    let value = serde_json::to_value(&download).unwrap();
    assert_eq!(value["pageUrl"], json!(null));
    assert_eq!(
        serde_json::from_value::<BrowseDownloadDto>(value).unwrap(),
        download
    );
    // A throwaway use of the macro keeps its path exercised from outside the crate.
    let _ = fields!["k" => 1];
}
