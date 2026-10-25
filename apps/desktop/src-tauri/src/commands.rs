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
use spm_core::AppError;
use spm_core::dto::{LibraryMode, LibraryStateDto, LocalLibraryDto, RemoteLibraryDto};
use spm_shell::library::PromptTrigger;
use spm_shell::shell::{ActiveMode, Shell};
use tauri::State;

/// What the app keeps for its commands.
pub struct AppCtx {
    pub shell: Arc<Shell>,
}

/// An [`AppError`] as `invoke` rejects with it: the code is what the web app maps to a message.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> CommandError {
        CommandError {
            code: error.code.as_str().to_owned(),
            message: error.message,
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
