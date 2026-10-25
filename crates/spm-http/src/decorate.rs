//! Core returns ids, never URLs. Turning an id into the URL a client fetches is the one piece of
//! DTO shaping that depends on the transport; here every file is served from `/api`.
//!
//! The field order of [`FileDto`] and [`ProjectDto`] is the order the legacy server emitted, so the
//! serialised bytes are the bytes clients have always seen (the tests pin them).

use spm_core::dto::{
    CoreFileDto, CoreProjectDetailDto, CoreProjectDto, FileDto, PreviewState, ProjectDetailDto,
    ProjectDto,
};

/// Everything before `/files/<id>/...`.
pub const FILE_URL_BASE: &str = "/api";

pub fn decorate_file(file: &CoreFileDto) -> FileDto {
    FileDto {
        id: file.id.clone(),
        name: file.name.clone(),
        kind: file.kind,
        slicer: file.slicer,
        size_bytes: file.size_bytes,
        preview_state: file.preview_state,
        raw_url: format!("{FILE_URL_BASE}/files/{}/raw", file.id),
        thumb_url: (file.preview_state == PreviewState::Ready)
            .then(|| format!("{FILE_URL_BASE}/files/{}/thumb", file.id)),
    }
}

pub fn decorate_project(project: &CoreProjectDto) -> ProjectDto {
    ProjectDto {
        id: project.id.clone(),
        name: project.name.clone(),
        website: project.website.clone(),
        notes: project.notes.clone(),
        is_archived: project.is_archived,
        state: project.state,
        tags: project.tags.clone(),
        file_counts: project.file_counts.clone(),
        created_at: project.created_at,
        updated_at: project.updated_at,
        cover_thumb_url: project
            .cover_file_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .map(|id| format!("{FILE_URL_BASE}/files/{id}/thumb")),
    }
}

pub fn decorate_project_detail(detail: &CoreProjectDetailDto) -> ProjectDetailDto {
    ProjectDetailDto {
        project: decorate_project(&detail.project),
        files: detail.files.iter().map(decorate_file).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use spm_core::dto::{FileCounts, FileKind, ProjectState};

    fn ready_file() -> CoreFileDto {
        CoreFileDto {
            id: "f1".into(),
            name: "cube.stl".into(),
            kind: FileKind::Model,
            slicer: None,
            size_bytes: 42,
            preview_state: PreviewState::Ready,
        }
    }

    fn pending_file() -> CoreFileDto {
        CoreFileDto {
            id: "f2".into(),
            name: "notes.txt".into(),
            kind: FileKind::Other,
            slicer: None,
            size_bytes: 7,
            preview_state: PreviewState::Pending,
        }
    }

    fn project() -> CoreProjectDto {
        CoreProjectDto {
            id: "p1".into(),
            name: "Bracket".into(),
            website: None,
            notes: None,
            is_archived: false,
            state: ProjectState::Ok,
            tags: vec!["petg".into()],
            file_counts: FileCounts {
                model: 1,
                slicer_project: 0,
                other: 1,
            },
            cover_file_id: Some("f1".into()),
            created_at: 10,
            updated_at: 20,
        }
    }

    fn json<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn decorate_file_emits_the_exact_bytes_the_server_has_always_emitted() {
        assert_eq!(
            json(&decorate_file(&ready_file())),
            concat!(
                r#"{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready","#,
                r#""rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"}"#
            )
        );
        assert_eq!(
            json(&decorate_file(&pending_file())),
            concat!(
                r#"{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending","#,
                r#""rawUrl":"/api/files/f2/raw"}"#
            )
        );
    }

    #[test]
    fn a_preview_that_is_not_ready_claims_no_thumb_url_at_all() {
        // Absent, not null: the UI's `if (thumbUrl)` and the JSON both depend on it.
        for state in [
            PreviewState::Pending,
            PreviewState::Failed,
            PreviewState::Unsupported,
        ] {
            let file = CoreFileDto {
                preview_state: state,
                ..ready_file()
            };
            let value = serde_json::to_value(decorate_file(&file)).unwrap();
            assert!(value.get("thumbUrl").is_none(), "{state:?}");
        }
    }

    #[test]
    fn decorate_project_replaces_cover_file_id_with_a_url_and_does_not_leak_the_id() {
        assert_eq!(
            json(&decorate_project(&project())),
            concat!(
                r#"{"id":"p1","name":"Bracket","isArchived":false,"state":"ok","tags":["petg"],"#,
                r#""fileCounts":{"model":1,"slicerProject":0,"other":1},"createdAt":10,"updatedAt":20,"#,
                r#""coverThumbUrl":"/api/files/f1/thumb"}"#
            )
        );
        assert!(
            serde_json::to_value(decorate_project(&project()))
                .unwrap()
                .get("coverFileId")
                .is_none()
        );
        let no_cover = CoreProjectDto {
            cover_file_id: None,
            ..project()
        };
        assert!(
            serde_json::to_value(decorate_project(&no_cover))
                .unwrap()
                .get("coverThumbUrl")
                .is_none()
        );
    }

    #[test]
    fn decorate_project_detail_decorates_the_project_and_every_file_under_it() {
        let detail = CoreProjectDetailDto {
            project: project(),
            files: vec![ready_file(), pending_file()],
        };
        assert_eq!(
            json(&decorate_project_detail(&detail)),
            concat!(
                r#"{"id":"p1","name":"Bracket","isArchived":false,"state":"ok","tags":["petg"],"#,
                r#""fileCounts":{"model":1,"slicerProject":0,"other":1},"createdAt":10,"updatedAt":20,"#,
                r#""coverThumbUrl":"/api/files/f1/thumb","files":["#,
                r#"{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready","#,
                r#""rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"},"#,
                r#"{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending","#,
                r#""rawUrl":"/api/files/f2/raw"}]}"#
            )
        );
    }
}
