//! DTOs of the desktop-only operations (slicers, the model browser). They are Tauri `invoke`
//! payloads, not HTTP routes, but their shapes live with the rest of the contract so the web
//! package has one generated file to import from.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{SlicerBindings, SlicerId, double_option};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SlicerInstallOrigin {
    Registry,
    Msix,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SlicerInstallState {
    Ok,
    Missing,
}

/// One installed slicer the shell is prepared to launch.
///
/// A `SlicerId` names a product; this names an install, and the two are one-to-many (two Curas
/// can sit side by side). `id` is the install's *origin key*, never its path: an MSIX install path
/// embeds the package version, so a stored path breaks silently on update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlicerInstallDto {
    pub id: String,
    pub slicer_id: SlicerId,
    pub label: String,
    /// `null` for a manual entry with no readable version. Never read from the executable.
    pub version: Option<String>,
    /// The last known path. Re-checked before every launch; shown so the user can tell two apart.
    pub path: String,
    pub origin: SlicerInstallOrigin,
    /// `missing`: the stored path failed and re-resolution from the origin key found nothing.
    pub state: SlicerInstallState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlicerConfigDto {
    pub installs: Vec<SlicerInstallDto>,
    /// Which install each product launches. A product with one install is bound to it
    /// automatically; one with two is left unbound and the UI asks.
    pub bindings: SlicerBindings,
    /// Used for every file that does not name a slicer, which is most of a library.
    pub default_slicer_id: Option<SlicerId>,
    /// False off Windows, where manual entry is the only mechanism the UI should offer.
    pub detection_supported: bool,
}

/// Which of the two launch paths a launch takes (spec 6.1 and 6.2).
///
/// `as-is` opens the user's own slicer project unchanged, at its real place in the library.
/// `new-project` starts a new slicer project from a file of any kind; what the slicer is handed
/// may be a stripped copy in a launch directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SlicerLaunchMode {
    AsIs,
    NewProject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlicerLaunchOptions {
    pub mode: SlicerLaunchMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slicer_id: Option<SlicerId>,
}

/// The outcome of one launch, and deliberately *not* a claim that anything opened: a successful
/// spawn is not evidence the file opened (spec 6.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlicerLaunchDto {
    /// Identifies this launch and, for a launch that made one, names its directory under
    /// `<userData>/slicer-sessions/`. The in-place paths make none.
    pub launch_id: String,
    /// The product actually launched, which is not always the one asked for.
    pub slicer_id: SlicerId,
    /// Which install of that product, in the words `/settings/slicers` shows.
    pub install_label: String,
    /// Whether embedded slicer configuration was removed from the copy that was handed over.
    pub stripped: bool,
    pub notices: Vec<String>,
    /// `null` when the platform gave the spawn no pid. Never a claim that the file loaded.
    #[ts(type = "number | null")]
    pub pid: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    Unchanged,
    Changed,
    Settling,
    Unreadable,
}

/// Entries added, removed and changed between the file as launched and the file as it is now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EntryDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}

/// One launch directory under `<userData>/slicer-sessions/`, and what the app can honestly say
/// about the file in it. Everything here is the result of a comparison, not of a notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SlicerSessionDto {
    /// How `resolveSession` and `discardSessions` name this one.
    pub launch_id: String,
    /// Empty for an orphan with nothing beside it to say where it belongs.
    pub project_id: String,
    /// Empty for an orphan, whose record is gone and with it the id of what was launched.
    pub file_id: String,
    pub file_name: String,
    /// `null` only for an orphan that names no slicer at all (an `.stl`, say).
    pub slicer_id: Option<SlicerId>,
    /// For an orphan, when the file appeared, which is the only "started" it has.
    #[ts(type = "number")]
    pub started_at: i64,
    /// Whether the process *this app spawned* is still running; not "the slicer is open".
    pub process_alive: bool,
    /// `settling` is a write in progress and becomes `unreadable` only after a bounded window.
    pub file_state: FileState,
    /// A file found with no `launch.json`: the user must say where it belongs.
    pub is_orphan: bool,
    /// What the file was classified as when it was handed over. Absent for an orphan.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    #[ts(optional = nullable)]
    pub source_slicer: Option<Option<SlicerId>>,
    /// What the returning file classifies as now, when that differs from `sourceSlicer`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    #[ts(optional = nullable)]
    pub returned_as: Option<Option<SlicerId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub source_size_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub returned_size_bytes: Option<i64>,
    /// Absent until the file has settled, and absent for an orphan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub entry_diff: Option<EntryDiff>,
}

/// What discarding several sessions at once reports: how many were found and removed. A session
/// that had already gone is not a failure and is not counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiscardedSessionsDto {
    #[ts(type = "number")]
    pub discarded: u32,
}

/// One row of the model-site registry, as the renderer sees it (spec 4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelSiteDto {
    pub id: String,
    pub display_name: String,
    pub home_url: String,
}

/// Where the `/browse` page wants the native view, in CSS pixels of the host page. An intent, not
/// an instruction: the shell intersects it with a rectangle it computes for itself.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowseBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the browse chrome polls. **Every string here was written by a stranger** (`url`, `title`
/// and `lastError` come from whatever site the view is on) and is rendered as text only: never
/// into HTML, an `href`, a `src` or a CSS `url()`, and truncated for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowseStateDto {
    pub attached: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// The registry row this URL belongs to, or `null`. Drives attribution, not permission (4.4).
    pub site_id: Option<String>,
    /// Set when the last navigation failed, so the UI can say what happened rather than spin.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BrowseDownloadState {
    Progressing,
    Completed,
    Cancelled,
    Interrupted,
}

/// One staged download: what came down, where it came from, and whether it can be believed.
///
/// `file_name`, `source_url` and `page_url` are a stranger's strings, rendered as text only.
/// `is_verifiable: false` means the bytes cannot be believed and `land` refuses it; `discard` is
/// the way out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDownloadDto {
    pub download_id: String,
    pub file_name: String,
    /// The download's own URL, which may be a `blob:`. For display and attribution only.
    pub source_url: String,
    /// The page the view was on when it started. This is what matching uses, never `sourceUrl`.
    /// `null` for a download a popup started.
    pub page_url: Option<String>,
    pub site_id: Option<String>,
    pub mime_type: String,
    pub state: BrowseDownloadState,
    #[ts(type = "number")]
    pub received_bytes: i64,
    /// Can be 0 for a server that sent no length.
    #[ts(type = "number")]
    pub total_bytes: i64,
    /// Recorded and shown, never acted on.
    pub had_user_gesture: bool,
    #[ts(type = "number")]
    pub started_at: i64,
    /// True for a download staged by a previous run of the app. `state` alone does not say
    /// whether a row is running; this is the other half.
    pub is_orphan: bool,
    /// The record vouches for the bytes (5.3). `land` refuses a `false`.
    pub is_verifiable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BrowseNoticeKind {
    Refused,
    Completed,
}

/// One thing the model browser has to say out of band, because the page cannot be told.
/// `file_name` and `detail` are rendered as text only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrowseNoticeDto {
    pub id: String,
    pub kind: BrowseNoticeKind,
    pub file_name: String,
    pub detail: String,
    #[ts(type = "number")]
    pub at: i64,
}
