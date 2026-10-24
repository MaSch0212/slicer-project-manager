//! The API's data transfer objects.
//!
//! Rust is the source of truth: TypeScript types are generated from these structs (see
//! [`crate::tsgen`]) and checked in under `packages/web/src/api/generated/`. The JSON they produce is
//! the JSON the legacy contract package described, key for key:
//!
//! * camelCase keys; enum values keep their legacy spelling (`slicer_project`, `updatedAt`, ...);
//! * an optional field is *absent* when empty, never `null`, except where the legacy type said
//!   `T | null` (`quotaBytes`, `strippedRoot`, ...);
//! * fields are declared in the order the legacy server emitted them, so a serialised DTO is
//!   byte-identical, not merely equivalent.
//!
//! Counters, sizes and timestamps are `i64` here and `number` in TypeScript (`#[ts(type =
//! "number")]`): ts-rs would otherwise say `bigint`, which JSON cannot carry.

mod core_dtos;
mod desktop;
mod serde_helpers;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use core_dtos::{CoreFileDto, CoreProjectDetailDto, CoreProjectDto};
pub use desktop::{
    BrowseBounds, BrowseDownloadDto, BrowseDownloadState, BrowseNoticeDto, BrowseNoticeKind,
    BrowseStateDto, EntryDiff, FileState, ModelSiteDto, SlicerConfigDto, SlicerInstallDto,
    SlicerInstallOrigin, SlicerInstallState, SlicerLaunchDto, SlicerLaunchMode,
    SlicerLaunchOptions, SlicerSessionDto,
};
pub(crate) use serde_helpers::double_option;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub requires_auth: bool,
    pub can_manage_users: bool,
    pub can_pick_local_folder: bool,
    pub can_launch_slicer: bool,
    pub can_configure_slicers: bool,
    pub can_browse_model_sites: bool,
}

/// The local library folder a shell has open (spec 2.6). The absolute path is the only field
/// because it is the only thing the UI has to show: the folder *is* the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LocalLibraryDto {
    pub dir: String,
}

/// The remote server a shell is pointed at (spec 2.6's other mode): the origin and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLibraryDto {
    pub origin: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum UserStatus {
    Pending,
    Active,
    Disabled,
}

impl UserStatus {
    /// The spelling stored in `users.status` (a `CHECK` constraint admits exactly these).
    pub fn as_str(self) -> &'static str {
        match self {
            UserStatus::Pending => "pending",
            UserStatus::Active => "active",
            UserStatus::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Option<UserStatus> {
        match value {
            "pending" => Some(UserStatus::Pending),
            "active" => Some(UserStatus::Active),
            "disabled" => Some(UserStatus::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub status: UserStatus,
    #[ts(type = "number")]
    pub disk_usage_bytes: i64,
    /// `null` is unlimited.
    #[ts(type = "number | null")]
    pub quota_bytes: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub activated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Model,
    SlicerProject,
    Other,
}

impl FileKind {
    /// The spelling stored in `files.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Model => "model",
            FileKind::SlicerProject => "slicer_project",
            FileKind::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<FileKind> {
        match value {
            "model" => Some(FileKind::Model),
            "slicer_project" => Some(FileKind::SlicerProject),
            "other" => Some(FileKind::Other),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SlicerId {
    Cura,
    Prusaslicer,
    Anycubic,
    Bambu,
    Orca,
}

impl SlicerId {
    /// The spelling stored in `files.slicer`.
    pub fn as_str(self) -> &'static str {
        match self {
            SlicerId::Cura => "cura",
            SlicerId::Prusaslicer => "prusaslicer",
            SlicerId::Anycubic => "anycubic",
            SlicerId::Bambu => "bambu",
            SlicerId::Orca => "orca",
        }
    }

    pub fn parse(value: &str) -> Option<SlicerId> {
        match value {
            "cura" => Some(SlicerId::Cura),
            "prusaslicer" => Some(SlicerId::Prusaslicer),
            "anycubic" => Some(SlicerId::Anycubic),
            "bambu" => Some(SlicerId::Bambu),
            "orca" => Some(SlicerId::Orca),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PreviewState {
    Pending,
    Ready,
    Failed,
    Unsupported,
}

impl PreviewState {
    /// The spelling stored in `previews.state`.
    pub fn as_str(self) -> &'static str {
        match self {
            PreviewState::Pending => "pending",
            PreviewState::Ready => "ready",
            PreviewState::Failed => "failed",
            PreviewState::Unsupported => "unsupported",
        }
    }

    pub fn parse(value: &str) -> Option<PreviewState> {
        match value {
            "pending" => Some(PreviewState::Pending),
            "ready" => Some(PreviewState::Ready),
            "failed" => Some(PreviewState::Failed),
            "unsupported" => Some(PreviewState::Unsupported),
            _ => None,
        }
    }
}

/// A file as the API shows it: core's `CoreFileDto` plus the URLs only a transport can build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub id: String,
    pub name: String,
    pub kind: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slicer: Option<SlicerId>,
    #[ts(type = "number")]
    pub size_bytes: i64,
    pub preview_state: PreviewState,
    pub raw_url: String,
    /// Present only when the preview is `ready`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thumb_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ProjectState {
    Ok,
    Missing,
}

impl ProjectState {
    /// The spelling stored in `projects.state`.
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectState::Ok => "ok",
            ProjectState::Missing => "missing",
        }
    }

    pub fn parse(value: &str) -> Option<ProjectState> {
        match value {
            "ok" => Some(ProjectState::Ok),
            "missing" => Some(ProjectState::Missing),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileCounts {
    #[ts(type = "number")]
    pub model: i64,
    #[ts(type = "number")]
    pub slicer_project: i64,
    #[ts(type = "number")]
    pub other: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
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
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_thumb_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetailDto {
    #[serde(flatten)]
    #[ts(flatten)]
    pub project: ProjectDto,
    pub files: Vec<FileDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    Name,
    CreatedAt,
    UpdatedAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// The projects list query. The server parses request input with `validate::parse_project_query`,
/// which also enforces the caps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub include_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sort: Option<SortKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir: Option<SortDir>,
    /// How many rows to return. Omitted means "all of them", which is what every caller did
    /// before paging existed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::validate::whole_number_opt"
    )]
    #[ts(optional, type = "number")]
    pub limit: Option<i64>,
    /// How many rows to skip. Only meaningful with `limit`: ignored (not rejected) without it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::validate::whole_number_opt"
    )]
    #[ts(optional, type = "number")]
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RescanResultDto {
    #[ts(type = "number")]
    pub adopted: i64,
    #[ts(type = "number")]
    pub marked_missing: i64,
    #[ts(type = "number")]
    pub files_added: i64,
    #[ts(type = "number")]
    pub files_removed: i64,
    #[ts(type = "number")]
    pub previews_queued: i64,
}

/// What `POST /api/import/curamanager` reports back after an archive import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ZipImportResultDto {
    #[ts(type = "number")]
    pub projects_extracted: i64,
    #[ts(type = "number")]
    pub files_extracted: i64,
    #[ts(type = "number")]
    pub bytes_extracted: i64,
    /// The single wrapping folder the archive was stripped of, if it had one.
    pub stripped_root: Option<String>,
    /// Entries deliberately not written: loose root files, dot-entries, `__MACOSX` noise.
    #[ts(type = "number")]
    pub skipped: i64,
    #[ts(type = "number")]
    pub projects_updated: i64,
    #[ts(type = "number")]
    pub tags_applied: i64,
    pub rescan: RescanResultDto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    De,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Grid,
    List,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub theme: Theme,
    pub language: Language,
    pub view_mode: ViewMode,
    pub sort: SortKey,
    pub dir: SortDir,
    /// Whether the navigation sidebar is collapsed to icons. Desktop layout only; see §4.
    pub nav_collapsed: bool,
    /// Whether the projects page's filter includes archived projects. Spec H §5.
    pub include_archived: bool,
    /// The tag names the projects page's filter is narrowed to. Spec H §5.
    pub filter_tags: Vec<String>,
}

/// The shipped defaults. A user with no `user_settings` rows sees exactly this.
pub const DEFAULT_SETTINGS: SettingsDto = SettingsDto {
    theme: Theme::System,
    language: Language::En,
    view_mode: ViewMode::Grid,
    sort: SortKey::UpdatedAt,
    dir: SortDir::Desc,
    nav_collapsed: false,
    include_archived: false,
    filter_tags: Vec::new(),
};

impl Default for SettingsDto {
    fn default() -> SettingsDto {
        DEFAULT_SETTINGS
    }
}

/// `Partial<SettingsDto>`: the body of a settings update. Every key is optional; an absent key is
/// left as it is. The server parses request input with `validate::parse_settings_patch`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub theme: Option<Theme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub language: Option<Language>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub view_mode: Option<ViewMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sort: Option<SortKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir: Option<SortDir>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nav_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub include_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_tags: Option<Vec<String>>,
}

/// `Partial<Record<SlicerId, string>>` as a map; used by [`SlicerConfigDto`].
pub type SlicerBindings = BTreeMap<SlicerId, String>;
