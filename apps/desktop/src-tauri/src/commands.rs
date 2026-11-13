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
    BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseTabsDto, DiscardedSessionsDto,
    FileDto, LibraryMode, LibraryStateDto, LibrarySyncDto, LibrarySyncPhase, LocalLibraryDto,
    RemoteLibraryDto, SlicerConfigDto, SlicerLaunchDto, SlicerSessionDto,
};
use spm_shell::browse::commands::BrowseCommands;
use spm_shell::browse::service::BrowseServices;
use spm_shell::library::PromptTrigger;
use spm_shell::library_sync::{SyncPhase, SyncStatus};
use spm_shell::shell::{ActiveMode, Shell};
use spm_shell::slicers::api::SlicerCommands;
use spm_shell::slicers::service::SlicerServices;
use tauri::{Manager, State};

/// What the app keeps for its commands.
pub struct AppCtx {
    pub shell: Arc<Shell>,
    /// The slicer subsystem: configuration, launching, sessions.
    pub slicers: Arc<SlicerServices>,
    /// Its commands, over raw arguments (validated there, never here).
    pub slicer_commands: Arc<SlicerCommands>,
    /// The model browser: the view host, the staging directory, the landing.
    pub browse: Arc<BrowseServices>,
    /// Its commands, over raw arguments (validated there, never here).
    pub browse_commands: Arc<BrowseCommands>,
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
            sync: None,
        },
        ActiveMode::Local => LibraryStateDto {
            mode: LibraryMode::Local,
            dir: shell.library().dir().map(|dir| dir.display().to_string()),
            origin: None,
            sync: None,
        },
        ActiveMode::Remote => LibraryStateDto {
            mode: LibraryMode::Remote,
            dir: None,
            origin: shell.remote().map(|remote| remote.origin().to_owned()),
            sync: shell.sync_status().map(sync_dto),
        },
    }
}

fn sync_dto(status: SyncStatus) -> LibrarySyncDto {
    LibrarySyncDto {
        dir: status.root,
        phase: match status.phase {
            SyncPhase::Starting => LibrarySyncPhase::Starting,
            SyncPhase::Syncing => LibrarySyncPhase::Syncing,
            SyncPhase::Idle => LibrarySyncPhase::Idle,
            SyncPhase::WaitingForSignIn => LibrarySyncPhase::WaitingForSignIn,
            SyncPhase::Error => LibrarySyncPhase::Error,
        },
        last_synced_at: status.last_synced_at,
        last_error: status.last_error,
    }
}

#[tauri::command]
pub fn desktop_library_state(ctx: State<'_, AppCtx>) -> LibraryStateDto {
    library_state(&ctx.shell)
}

/// Asks for the folder the connected server's library is synced into (a native dialog: the page
/// never names a path). `null` is a cancelled dialog.
#[tauri::command]
pub async fn desktop_library_sync_choose(
    ctx: State<'_, AppCtx>,
) -> Result<Option<LibrarySyncDto>, CommandError> {
    let shell = Arc::clone(&ctx.shell);
    tokio::task::spawn_blocking(move || shell.pick_sync_dir())
        .await
        .map_err(internal)?
        .map(|status| status.map(sync_dto))
        .map_err(CommandError::from)
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

// ---------------------------------------------------------------------------------------------
// The model browser
//
// A property of this machine: the same in local and in remote mode. Each command takes its
// arguments as raw values and hands them to `BrowseCommands`, which checks every one. None takes
// a path: the page names a download id and a project id, and the bytes of a download go from the
// staging directory into the library without passing through the page.
// ---------------------------------------------------------------------------------------------

/// Runs one browse command off the async runtime: the view is driven through the main thread, and
/// a landing or a match waits on the library API.
async fn browsing<T: Send + 'static>(
    ctx: &State<'_, AppCtx>,
    work: impl FnOnce(&BrowseCommands) -> Result<T, AppError> + Send + 'static,
) -> Result<T, CommandError> {
    let commands = Arc::clone(&ctx.browse_commands);
    tokio::task::spawn_blocking(move || work(&commands))
        .await
        .map_err(internal)?
        .map_err(CommandError::from)
}

/// The four sites, for the start links.
#[tauri::command]
pub async fn desktop_browse_sites(
    ctx: State<'_, AppCtx>,
) -> Result<Vec<spm_core::dto::ModelSiteDto>, CommandError> {
    browsing(&ctx, |commands| Ok(commands.sites())).await
}

/// The page is on screen at this placeholder. Puts the tabs back, or opens a first one.
#[tauri::command]
pub async fn desktop_browse_attach(
    ctx: State<'_, AppCtx>,
    bounds: Option<Value>,
) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, move |commands| commands.attach(bounds.as_ref())).await
}

/// Leaves the route. The tabs stay alive and hidden; none of them may start a download.
#[tauri::command]
pub async fn desktop_browse_detach(ctx: State<'_, AppCtx>) -> Result<(), CommandError> {
    browsing(&ctx, |commands| {
        commands.detach();
        Ok(())
    })
    .await
}

/// Stops the view painting, for a dialog or a menu the page is about to draw.
#[tauri::command]
pub async fn desktop_browse_hide(ctx: State<'_, AppCtx>) -> Result<(), CommandError> {
    browsing(&ctx, |commands| {
        commands.hide();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn desktop_browse_show(ctx: State<'_, AppCtx>) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, |commands| Ok(commands.show())).await
}

/// Where the page's placeholder is now, in CSS pixels.
#[tauri::command]
pub async fn desktop_browse_set_bounds(
    ctx: State<'_, AppCtx>,
    bounds: Option<Value>,
) -> Result<(), CommandError> {
    browsing(&ctx, move |commands| commands.set_bounds(bounds.as_ref())).await
}

#[tauri::command]
pub async fn desktop_browse_navigate(
    ctx: State<'_, AppCtx>,
    url: Option<Value>,
) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, move |commands| commands.navigate(url.as_ref())).await
}

#[tauri::command]
pub async fn desktop_browse_back(ctx: State<'_, AppCtx>) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, |commands| commands.back()).await
}

#[tauri::command]
pub async fn desktop_browse_forward(ctx: State<'_, AppCtx>) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, |commands| commands.forward()).await
}

#[tauri::command]
pub async fn desktop_browse_reload(ctx: State<'_, AppCtx>) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, |commands| commands.reload()).await
}

/// Every tab and which one is in front: what the chrome polls while `/browse` is mounted.
#[tauri::command]
pub async fn desktop_browse_tabs(ctx: State<'_, AppCtx>) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, |commands| Ok(commands.tabs())).await
}

/// Opens a tab. `url` is `null` for the registry's start page.
#[tauri::command]
pub async fn desktop_browse_open_tab(
    ctx: State<'_, AppCtx>,
    url: Option<Value>,
) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, move |commands| commands.open_tab(url.as_ref())).await
}

/// Brings a tab to the front.
#[tauri::command]
pub async fn desktop_browse_select_tab(
    ctx: State<'_, AppCtx>,
    tab_id: Option<Value>,
) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, move |commands| commands.select_tab(tab_id.as_ref())).await
}

/// Closes a tab. Closing the last one leaves a fresh tab, never an empty browser.
#[tauri::command]
pub async fn desktop_browse_close_tab(
    ctx: State<'_, AppCtx>,
    tab_id: Option<Value>,
) -> Result<BrowseTabsDto, CommandError> {
    browsing(&ctx, move |commands| commands.close_tab(tab_id.as_ref())).await
}

/// A PNG of the front tab as a `data:` URL, for the still picture the download dialog is drawn
/// over. `null` where the platform cannot capture: the dialog opens against the empty slot.
#[tauri::command]
pub async fn desktop_browse_capture(
    ctx: State<'_, AppCtx>,
) -> Result<Option<String>, CommandError> {
    browsing(&ctx, |commands| Ok(commands.capture_active())).await
}

/// Everything staged, including what previous runs left.
#[tauri::command]
pub async fn desktop_browse_downloads(
    ctx: State<'_, AppCtx>,
) -> Result<Vec<BrowseDownloadDto>, CommandError> {
    browsing(&ctx, |commands| Ok(commands.downloads())).await
}

#[tauri::command]
pub async fn desktop_browse_notices(
    ctx: State<'_, AppCtx>,
) -> Result<Vec<BrowseNoticeDto>, CommandError> {
    browsing(&ctx, |commands| Ok(commands.notices())).await
}

#[tauri::command]
pub async fn desktop_browse_dismiss_notice(
    ctx: State<'_, AppCtx>,
    id: Option<Value>,
) -> Result<(), CommandError> {
    browsing(&ctx, move |commands| commands.dismiss_notice(id.as_ref())).await
}

/// Lands a staged download into a project as a new file. Ids, never a path; `name` is `null`
/// to keep the download's own (a plain `Value`, for the reason `desktop_slicers_bind` gives).
#[tauri::command]
pub async fn desktop_browse_land(
    ctx: State<'_, AppCtx>,
    download_id: Option<Value>,
    project_id: Option<Value>,
    name: Value,
) -> Result<FileDto, CommandError> {
    browsing(&ctx, move |commands| {
        commands.land(download_id.as_ref(), project_id.as_ref(), Some(&name))
    })
    .await
}

/// Deletes a staged download and its directory.
#[tauri::command]
pub async fn desktop_browse_discard(
    ctx: State<'_, AppCtx>,
    download_id: Option<Value>,
) -> Result<(), CommandError> {
    browsing(&ctx, move |commands| commands.discard(download_id.as_ref())).await
}

/// Where this download's bytes go when they arrive: an existing project, under this name.
///
/// The choice is recorded in the shell, not in the page, because the page stops existing when
/// the user leaves the browser and the file still has to land.
#[tauri::command]
pub async fn desktop_browse_decide(
    ctx: State<'_, AppCtx>,
    download_id: Option<Value>,
    project_id: Option<Value>,
    file_name: Option<Value>,
) -> Result<(), CommandError> {
    browsing(&ctx, move |commands| {
        commands.decide(
            download_id.as_ref(),
            project_id.as_ref(),
            file_name.as_ref(),
        )
    })
    .await
}

/// The user does not want this file. One already on disk is deleted now; one still coming down
/// is deleted when it arrives, since nothing can stop a WebView2 download once it has started.
#[tauri::command]
pub async fn desktop_browse_cancel(
    ctx: State<'_, AppCtx>,
    download_id: Option<Value>,
) -> Result<(), CommandError> {
    browsing(&ctx, move |commands| commands.cancel(download_id.as_ref())).await
}

/// Which of the user's projects a page may be the source of, by `website` and the match key.
/// `url` is `null` for a download no page is known for. An empty answer is the honest one.
#[tauri::command]
pub async fn desktop_browse_match(
    ctx: State<'_, AppCtx>,
    url: Value,
) -> Result<BrowseMatchDto, CommandError> {
    browsing(&ctx, move |commands| commands.match_page(Some(&url))).await
}

// ---------------------------------------------------------------------------------------------
// The window. The page draws the title bar, so the three buttons, the drag and the developer
// tools are commands; `crate::window` explains why they are app commands rather than a `core:*`
// grant. Every one of them acts on the main window by label: the page never names a window.
// ---------------------------------------------------------------------------------------------

/// What the title bar has to draw differently: the maximise button becomes restore, and a
/// maximised window on Windows needs no rounded corners under its top row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateDto {
    pub is_maximized: bool,
}

/// The main window.
///
/// **`get_window`, never `get_webview_window`.** Tauri only calls a window a "webview window"
/// while it hosts exactly one webview whose label matches its own
/// (`webviews().all(|w| w.label() == self.label())`), so the moment the model browser adds a
/// `browse-<tab>` child to it, `get_webview_window("main")` answers `None` — for good, because
/// the tabs outlive the route. Everything that asks for the window this way simply stops
/// working, silently.
fn main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::Window<R>, CommandError> {
    app.get_window(crate::security::MAIN_WEBVIEW)
        .ok_or_else(|| internal("there is no main window"))
}

/// The app's own webview, for the things that are the *page's* and not the window's.
fn main_webview<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::Webview<R>, CommandError> {
    app.get_webview(crate::security::MAIN_WEBVIEW)
        .ok_or_else(|| internal("there is no main webview"))
}

/// Whether the window is maximised. The page asks after every resize; there is no event channel
/// to the page, and a resize is the only thing that can change the answer.
#[tauri::command]
pub fn desktop_window_state<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<WindowStateDto, CommandError> {
    let window = main_window(&app)?;
    Ok(WindowStateDto {
        is_maximized: window.is_maximized().map_err(internal)?,
    })
}

/// Hands the window to the system's own drag loop, from a press in the title bar.
///
/// **Not a manual move-the-window-to-the-pointer loop**, on purpose: this is what keeps
/// drag-to-snap, the shake gesture and the monitor-edge behaviour working, because from here on
/// it is Windows moving the window and not us.
#[tauri::command]
pub fn desktop_window_start_drag<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), CommandError> {
    main_window(&app)?.start_dragging().map_err(internal)
}

#[tauri::command]
pub fn desktop_window_minimize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), CommandError> {
    main_window(&app)?.minimize().map_err(internal)
}

/// Maximise or restore, whichever the window is not. One command rather than two because the
/// button is one button, and because asking first would race the answer.
#[tauri::command]
pub fn desktop_window_toggle_maximize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<WindowStateDto, CommandError> {
    let window = main_window(&app)?;
    if window.is_maximized().map_err(internal)? {
        window.unmaximize().map_err(internal)?;
    } else {
        window.maximize().map_err(internal)?;
    }
    Ok(WindowStateDto {
        is_maximized: window.is_maximized().map_err(internal)?,
    })
}

/// Closes the window, which ends the app. It goes through the window's own close so the exit
/// handler still runs (the listener is stopped, the slicer watchers are closed).
#[tauri::command]
pub fn desktop_window_close<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), CommandError> {
    main_window(&app)?.close().map_err(internal)
}

/// `Ctrl+Shift+I`, which used to be a menu item. `devtools` is a feature of the release build
/// here, as it was in the Electron app.
#[tauri::command]
pub fn desktop_window_toggle_devtools<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), CommandError> {
    // The developer tools belong to a webview, not to a window.
    let webview = main_webview(&app)?;
    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
    Ok(())
}
