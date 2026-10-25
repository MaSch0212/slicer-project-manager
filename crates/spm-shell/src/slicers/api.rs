//! The slicer commands, as the web app calls them: every argument checked, then handed to the
//! backend with its meaning in the right order.
//!
//! **Arguments are untrusted.** They come from the webview through `invoke`, and the webview is the
//! untrusted side. So each command takes its arguments as raw values and validates them here, with
//! the code the HTTP API would send (`Validation`), instead of letting the framework's own
//! deserialiser answer a bad one with a bare string the page cannot map to a message:
//!
//! - a **product** is one of the five ids; anything else never reaches a lookup;
//! - an **id** is a bounded string (it is looked up, never joined onto a path);
//! - an option object is **strict**: an unknown key is refused rather than silently dropped, which
//!   would accept a page's attempt to add a field this validation has not been written for;
//! - "nothing" is spelled `null` and an argument that is simply absent is a `Validation` failure,
//!   because a client that forgot an argument and one that meant "none" must not be the same
//!   request;
//! - a list is bounded, because the page builds it from what `sessions` gave it and a list longer
//!   than any plausible sessions directory is a bug or an attempt at one.
//!
//! **No command takes a path.** The only path on the whole surface comes out of a native dialog
//! this process owns (`add_manual`), exactly as folder picking does; the page's whole vocabulary is
//! five product names and ids it was given.

use std::sync::Arc;

use serde_json::Value;
use spm_core::AppError;
use spm_core::dto::{
    DiscardedSessionsDto, FileDto, SlicerConfigDto, SlicerId, SlicerLaunchDto, SlicerLaunchMode,
    SlicerLaunchOptions, SlicerSessionDto,
};

use super::sessions::SessionAction;

/// Longest id of a project or file (`idSchema`).
pub const MAX_ID_LENGTH: usize = 64;
/// Longest install id: a registry id carries an uninstall subkey name, as long as a vendor makes it.
pub const MAX_INSTALL_ID_LENGTH: usize = 512;
/// Longest launch id: `<launch directory>/<file name>` for a file found with no record.
pub const MAX_LAUNCH_ID_LENGTH: usize = 512;
/// The most sessions one bulk discard may name.
pub const MAX_DISCARD_IDS: usize = 500;

/// What the commands need from the machine: the one seam between "arguments are valid" and "do it".
pub trait SlicerBackend: Send + Sync {
    fn get(&self) -> Result<SlicerConfigDto, AppError>;
    fn scan(&self) -> Result<SlicerConfigDto, AppError>;
    /// Opens a native file dialog; `None` when the user cancels.
    fn add_manual(&self, slicer_id: SlicerId) -> Result<Option<SlicerConfigDto>, AppError>;
    fn remove(&self, install_id: &str) -> Result<SlicerConfigDto, AppError>;
    fn bind(
        &self,
        slicer_id: SlicerId,
        install_id: Option<&str>,
    ) -> Result<SlicerConfigDto, AppError>;
    fn set_default(&self, slicer_id: Option<SlicerId>) -> Result<SlicerConfigDto, AppError>;
    fn reset_config(&self) -> Result<SlicerConfigDto, AppError>;
    /// Hands a file to a slicer. **Ids, never a path.**
    fn open(
        &self,
        file_id: &str,
        project_id: &str,
        opts: &SlicerLaunchOptions,
    ) -> Result<SlicerLaunchDto, AppError>;
    fn sessions(&self) -> Result<Vec<SlicerSessionDto>, AppError>;
    fn resolve_session(
        &self,
        launch_id: &str,
        action: SessionAction,
        project_id: Option<&str>,
    ) -> Result<Option<FileDto>, AppError>;
    fn discard_sessions(&self, launch_ids: &[String]) -> Result<DiscardedSessionsDto, AppError>;
}

fn missing(name: &str) -> AppError {
    AppError::validation(format!("{name} is required"))
}

fn bad(name: &str, why: &str) -> AppError {
    AppError::validation(format!("{name} {why}"))
}

/// A bounded, non-empty string.
fn bounded<'a>(value: Option<&'a Value>, name: &str, max: usize) -> Result<&'a str, AppError> {
    let value = value.ok_or_else(|| missing(name))?;
    let text = value
        .as_str()
        .ok_or_else(|| bad(name, "must be a string"))?;
    if text.is_empty() {
        return Err(bad(name, "must not be empty"));
    }
    if text.chars().count() > max {
        return Err(bad(name, "is too long"));
    }
    Ok(text)
}

pub fn parse_slicer_id(value: Option<&Value>, name: &str) -> Result<SlicerId, AppError> {
    let value = value.ok_or_else(|| missing(name))?;
    value
        .as_str()
        .and_then(SlicerId::parse)
        .ok_or_else(|| bad(name, "must be one of the five slicers"))
}

fn parse_nullable_slicer_id(
    value: Option<&Value>,
    name: &str,
) -> Result<Option<SlicerId>, AppError> {
    match value {
        None => Err(missing(name)),
        Some(Value::Null) => Ok(None),
        some => parse_slicer_id(some, name).map(Some),
    }
}

fn parse_nullable_install_id<'a>(
    value: Option<&'a Value>,
    name: &str,
) -> Result<Option<&'a str>, AppError> {
    match value {
        None => Err(missing(name)),
        Some(Value::Null) => Ok(None),
        some => bounded(some, name, MAX_INSTALL_ID_LENGTH).map(Some),
    }
}

/// `{ mode, slicerId? }`, strictly.
pub fn parse_launch_options(value: Option<&Value>) -> Result<SlicerLaunchOptions, AppError> {
    let value = value.ok_or_else(|| missing("opts"))?;
    let object = value
        .as_object()
        .ok_or_else(|| bad("opts", "must be an object"))?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !matches!(key.as_str(), "mode" | "slicerId"))
    {
        return Err(bad("opts", &format!("has an unknown key: {unknown}")));
    }
    let mode = match object.get("mode").and_then(Value::as_str) {
        Some("as-is") => SlicerLaunchMode::AsIs,
        Some("new-project") => SlicerLaunchMode::NewProject,
        _ => return Err(bad("opts.mode", "must be as-is or new-project")),
    };
    let slicer_id = match object.get("slicerId") {
        None => None,
        some => Some(parse_slicer_id(some, "opts.slicerId")?),
    };
    Ok(SlicerLaunchOptions { mode, slicer_id })
}

fn parse_action(value: Option<&Value>) -> Result<SessionAction, AppError> {
    match value.ok_or_else(|| missing("action"))?.as_str() {
        Some("import") => Ok(SessionAction::Import),
        Some("discard") => Ok(SessionAction::Discard),
        _ => Err(bad("action", "must be import or discard")),
    }
}

fn parse_launch_ids(value: Option<&Value>) -> Result<Vec<String>, AppError> {
    let value = value.ok_or_else(|| missing("launchIds"))?;
    let list = value
        .as_array()
        .ok_or_else(|| bad("launchIds", "must be a list"))?;
    if list.len() > MAX_DISCARD_IDS {
        return Err(bad("launchIds", "names too many sessions"));
    }
    list.iter()
        .map(|id| bounded(Some(id), "launchIds", MAX_LAUNCH_ID_LENGTH).map(str::to_owned))
        .collect()
}

/// The eleven commands, each over raw arguments. The Tauri glue is one line per command.
pub struct SlicerCommands {
    backend: Arc<dyn SlicerBackend>,
}

impl SlicerCommands {
    pub fn new(backend: Arc<dyn SlicerBackend>) -> SlicerCommands {
        SlicerCommands { backend }
    }

    pub fn get(&self) -> Result<SlicerConfigDto, AppError> {
        self.backend.get()
    }

    pub fn scan(&self) -> Result<SlicerConfigDto, AppError> {
        self.backend.scan()
    }

    pub fn add_manual(
        &self,
        slicer_id: Option<&Value>,
    ) -> Result<Option<SlicerConfigDto>, AppError> {
        let slicer_id = parse_slicer_id(slicer_id, "slicerId")?;
        self.backend.add_manual(slicer_id)
    }

    pub fn remove(&self, install_id: Option<&Value>) -> Result<SlicerConfigDto, AppError> {
        let install_id = bounded(install_id, "installId", MAX_INSTALL_ID_LENGTH)?;
        self.backend.remove(install_id)
    }

    /// `install_id` of `null` unbinds.
    pub fn bind(
        &self,
        slicer_id: Option<&Value>,
        install_id: Option<&Value>,
    ) -> Result<SlicerConfigDto, AppError> {
        let slicer_id = parse_slicer_id(slicer_id, "slicerId")?;
        let install_id = parse_nullable_install_id(install_id, "installId")?;
        self.backend.bind(slicer_id, install_id)
    }

    /// `slicer_id` of `null` clears the default.
    pub fn set_default(&self, slicer_id: Option<&Value>) -> Result<SlicerConfigDto, AppError> {
        let slicer_id = parse_nullable_slicer_id(slicer_id, "slicerId")?;
        self.backend.set_default(slicer_id)
    }

    pub fn reset_config(&self) -> Result<SlicerConfigDto, AppError> {
        self.backend.reset_config()
    }

    pub fn open(
        &self,
        file_id: Option<&Value>,
        project_id: Option<&Value>,
        opts: Option<&Value>,
    ) -> Result<SlicerLaunchDto, AppError> {
        let file_id = bounded(file_id, "fileId", MAX_ID_LENGTH)?;
        let project_id = bounded(project_id, "projectId", MAX_ID_LENGTH)?;
        let opts = parse_launch_options(opts)?;
        self.backend.open(file_id, project_id, &opts)
    }

    pub fn sessions(&self) -> Result<Vec<SlicerSessionDto>, AppError> {
        self.backend.sessions()
    }

    pub fn resolve_session(
        &self,
        launch_id: Option<&Value>,
        action: Option<&Value>,
        project_id: Option<&Value>,
    ) -> Result<Option<FileDto>, AppError> {
        let launch_id = bounded(launch_id, "launchId", MAX_LAUNCH_ID_LENGTH)?;
        let action = parse_action(action)?;
        let project_id = match project_id {
            None | Some(Value::Null) => None,
            some => Some(bounded(some, "projectId", MAX_ID_LENGTH)?),
        };
        self.backend.resolve_session(launch_id, action, project_id)
    }

    pub fn discard_sessions(
        &self,
        launch_ids: Option<&Value>,
    ) -> Result<DiscardedSessionsDto, AppError> {
        let launch_ids = parse_launch_ids(launch_ids)?;
        self.backend.discard_sessions(&launch_ids)
    }
}
