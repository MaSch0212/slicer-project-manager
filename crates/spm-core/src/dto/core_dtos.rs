//! What core returns: ids, never URLs (parent spec 4.2). Only a transport knows its own URL
//! scheme, so it decorates these into `FileDto` and `ProjectDto`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{FileCounts, FileKind, PreviewState, ProjectState, SlicerId};

/// `FileDto` without `thumbUrl` and `rawUrl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoreFileDto {
    pub id: String,
    pub name: String,
    pub kind: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slicer: Option<SlicerId>,
    #[ts(type = "number")]
    pub size_bytes: i64,
    pub preview_state: PreviewState,
}

/// `ProjectDto` with `coverFileId` in place of `coverThumbUrl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoreProjectDto {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    pub is_archived: bool,
    pub state: ProjectState,
    pub tags: Vec<String>,
    pub file_counts: FileCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_file_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CoreProjectDetailDto {
    #[serde(flatten)]
    #[ts(flatten)]
    pub project: CoreProjectDto,
    pub files: Vec<CoreFileDto>,
}
