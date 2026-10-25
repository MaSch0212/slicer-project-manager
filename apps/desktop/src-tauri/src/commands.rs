//! The desktop-only operations the web app reaches through `invoke`.
//!
//! None of these is a library API: they are what only the shell can do (ask the operating system
//! for a folder, choose which library the app is looking at). Every one of them is named in
//! [`crate::app_commands::APP_COMMANDS`] and granted to the main webview alone.
//!
//! **No command takes a path.** `desktop_library_pick` opens a native dialog and the user's answer
//! never passes through the page, so a page cannot name a folder to open; the only thing the page
//! supplies is a server address, which is untrusted and validated, and which the user must confirm
//! in a native dialog before anything connects.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};
use spm_core::AppError;
use spm_core::dto::{
    DiscardedSessionsDto, FileDto, LibraryMode, LibraryStateDto, LocalLibraryDto, RemoteLibraryDto,
    SlicerConfigDto, SlicerLaunchDto, SlicerSessionDto,
};
use spm_shell::library::PromptTrigger;
use spm_shell::shell::{ActiveMode, Shell};
use spm_shell::slicers::api::SlicerCommands;
use spm_shell::slicers::service::SlicerServices;
use tauri::State;

/// What the app keeps for its commands.
pub struct AppCtx {
    pub shell: Arc<Shell>,
    /// The slicer subsystem: configuration, launching, sessions.
    pub slicers: Arc<SlicerServices>,
    /// Its commands, over raw arguments (validated there, never here).
    pub slicer_commands: Arc<SlicerCommands>,
}

/// An [`AppError`] as `invoke` rejects with it: the code is what the web app maps to a message, and
/// `details` is what it needs to tell two failures with one code apart (a detection that could not
/// run is an `Internal` with a `reason`; a refused strip is a `Validation` with one too).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> CommandError {
        CommandError {
            code: error.code.as_str().to_owned(),
            message: error.message,
            details: error.details,
        }
    }
}

fn internal(error: impl std::fmt::Display) -> CommandError {
    CommandError::from(AppError::internal(error))
}

/// Which library is open, for the web app's settings and connect pages.
pub fn library_state(shell: &Shell) -> LibraryStateDto {
    match shell.mode() {
        ActiveMode::Unset => LibraryStateDto {
            mode: LibraryMode::Unset,
            dir: None,
            origin: None,
        },
        ActiveMode::Local => LibraryStateDto {
            mode: LibraryMode::Local,
            dir: shell.library().dir().map(|dir| dir.display().to_string()),
            origin: None,
        },
        ActiveMode::Remote => LibraryStateDto {
            mode: LibraryMode::Remote,
            dir: None,
            origin: shell.remote().map(|remote| remote.origin().to_owned()),
        },
    }
}

#[tauri::command]
pub fn desktop_library_state(ctx: State<'_, AppCtx>) -> LibraryStateDto {
    library_state(&ctx.shell)
}

/// Opens the native folder dialog and opens what the user picks. `null` is a cancelled dialog,
/// which leaves the open library alone.
#[tauri::command]
pub async fn desktop_library_pick(
    ctx: State<'_, AppCtx>,
) -> Result<Option<LocalLibraryDto>, CommandError> {
    let shell = Arc::clone(&ctx.shell);
    tokio::task::spawn_blocking(move || shell.pick_local_folder(PromptTrigger::User))
        .await
        .map_err(internal)?
        .map_err(CommandError::from)
}

/// Connects to the server `url` names, after the user confirms it in a native dialog. `null` is
/// a declined confirmation.
#[tauri::command]
pub async fn desktop_library_connect(
    ctx: State<'_, AppCtx>,
    url: String,
) -> Result<Option<RemoteLibraryDto>, CommandError> {
    let shell = Arc::clone(&ctx.shell);
    tokio::task::spawn_blocking(move || shell.connect_remote(&url))
        .await
        .map_err(internal)?
        .map_err(CommandError::from)
}

/// The application menu's "Choose library…": asks which mode, then does what the answer says.
#[tauri::command]
pub async fn desktop_library_choose(ctx: State<'_, AppCtx>) -> Result<(), CommandError> {
    let shell = Arc::clone(&ctx.shell);
    tokio::task::spawn_blocking(move || {
        shell.ask_for_mode(PromptTrigger::User);
    })
    .await
    .map_err(internal)
}

// ---------------------------------------------------------------------------------------------
// Slicers
//
// Each command takes its arguments as raw values and hands them to `SlicerCommands`, which checks
// every one of them (a bad one is a `Validation` with the same shape as any other failure, never a
// framework string the page cannot map). None of them takes a path: the one path on the whole
// surface comes out of a native dialog this process owns.
// ---------------------------------------------------------------------------------------------

/// Runs one slicer command off the async runtime: the subsystem is blocking (file work, a child
/// process, a PowerShell run, and a proxy call that waits on the network).
async fn slicers<T: Send + 'static>(
    ctx: &State<'_, AppCtx>,
    work: impl FnOnce(&SlicerCommands) -> Result<T, AppError> + Send + 'static,
) -> Result<T, CommandError> {
    let commands = Arc::clone(&ctx.slicer_commands);
    tokio::task::spawn_blocking(move || work(&commands))
        .await
        .map_err(internal)?
        .map_err(CommandError::from)
}

/// What is configured on this computer right now.
#[tauri::command]
pub async fn desktop_slicers_get(ctx: State<'_, AppCtx>) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, |commands| commands.get()).await
}

/// Searches this computer for installed slicers and merges what it finds into the configuration.
#[tauri::command]
pub async fn desktop_slicers_scan(ctx: State<'_, AppCtx>) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, |commands| commands.scan()).await
}

/// Opens a native file dialog for one product's program. `null` is a cancelled dialog.
#[tauri::command]
pub async fn desktop_slicers_add_manual(
    ctx: State<'_, AppCtx>,
    slicer_id: Option<Value>,
) -> Result<Option<SlicerConfigDto>, CommandError> {
    slicers(&ctx, move |commands| {
        commands.add_manual(slicer_id.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn desktop_slicers_remove(
    ctx: State<'_, AppCtx>,
    install_id: Option<Value>,
) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, move |commands| commands.remove(install_id.as_ref())).await
}

/// Points a product at one of its installs; `null` unbinds it.
///
/// `install_id` is a plain `Value` and not an `Option`: a JSON `null` deserialises to `None` for an
/// optional parameter, which would make "unbind" indistinguishable from an argument that was left
/// out, and those two must not be the same request. The cost is that a *missing* key is refused by
/// the framework before this runs, and the page always sends the key.
#[tauri::command]
pub async fn desktop_slicers_bind(
    ctx: State<'_, AppCtx>,
    slicer_id: Option<Value>,
    install_id: Value,
) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, move |commands| {
        commands.bind(slicer_id.as_ref(), Some(&install_id))
    })
    .await
}

/// The product a file that names no slicer is opened with; `null` clears it. A plain `Value` for
/// the reason `desktop_slicers_bind` gives.
#[tauri::command]
pub async fn desktop_slicers_set_default(
    ctx: State<'_, AppCtx>,
    slicer_id: Value,
) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, move |commands| commands.set_default(Some(&slicer_id))).await
}

/// Throws the slicer configuration away: the only way out of one this build cannot read.
#[tauri::command]
pub async fn desktop_slicers_reset_config(
    ctx: State<'_, AppCtx>,
) -> Result<SlicerConfigDto, CommandError> {
    slicers(&ctx, |commands| commands.reset_config()).await
}

/// Hands a file of a project to a slicer. Ids, never a path.
#[tauri::command]
pub async fn desktop_slicers_open(
    ctx: State<'_, AppCtx>,
    file_id: Option<Value>,
    project_id: Option<Value>,
    opts: Option<Value>,
) -> Result<SlicerLaunchDto, CommandError> {
    slicers(&ctx, move |commands| {
        commands.open(file_id.as_ref(), project_id.as_ref(), opts.as_ref())
    })
    .await
}

/// Every file this app has handed to a slicer and not yet finished with.
#[tauri::command]
pub async fn desktop_slicers_sessions(
    ctx: State<'_, AppCtx>,
) -> Result<Vec<SlicerSessionDto>, CommandError> {
    slicers(&ctx, |commands| commands.sessions()).await
}

/// The user's answer to one session: add the returning file to a project, or throw it away.
#[tauri::command]
pub async fn desktop_slicers_resolve_session(
    ctx: State<'_, AppCtx>,
    launch_id: Option<Value>,
    action: Option<Value>,
    project_id: Option<Value>,
) -> Result<Option<FileDto>, CommandError> {
    slicers(&ctx, move |commands| {
        commands.resolve_session(launch_id.as_ref(), action.as_ref(), project_id.as_ref())
    })
    .await
}

/// Throws away several sessions at once; a session that has already gone is not counted.
#[tauri::command]
pub async fn desktop_slicers_discard_sessions(
    ctx: State<'_, AppCtx>,
    launch_ids: Option<Value>,
) -> Result<DiscardedSessionsDto, CommandError> {
    slicers(&ctx, move |commands| {
        commands.discard_sessions(launch_ids.as_ref())
    })
    .await
}
