//! Slicer Project Manager, desktop shell (Tauri 2).
//!
//! The app is one process: a loopback HTTP listener ([`spm_shell::server`]) that serves the web
//! bundle and `/api`, and one webview that loads it. Everything that is not "show a window" lives
//! in the `spm-shell` crate, which has no GUI in it and is tested without one; this crate is the
//! glue that turns it into windows, menus and `invoke` commands.
//!
//! # Where parts 2 and 3 plug in
//!
//! - **Commands:** write the function in a module beside [`commands`], list its name in
//!   [`app_commands::APP_COMMANDS`] (which is what gives it a permission and what the main
//!   webview's capability grants), and add it to `generate_handler!` in [`run`].
//! - **Capability flags:** flip `can_launch_slicer`, `can_configure_slicers` and
//!   `can_browse_model_sites` in `spm_shell::capabilities`, in both shell columns.
//! - **The model browser's child webview:** `window::create_main_window` returns the main
//!   `WebviewWindow`; its `.as_ref().window()` is the `Window` that `add_child` (Cargo feature
//!   `unstable`, already on) attaches to. Give the child its own label (`browse`), its own
//!   `data_directory`, `on_navigation`, `on_new_window` and `on_download`; never name that label in
//!   [`security::main_capability`]. [`security`] explains why that is the whole containment.

pub mod app_commands;
pub mod commands;
mod hidden;
mod prompts;
pub mod security;
pub mod window;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use spm_http::{DevProxy, resolve_dev_ui_origin};
use spm_shell::library::{PickerLanguage, PromptTrigger, picker_language};
use spm_shell::server::{DesktopServer, Ui};
use spm_shell::shell::{Shell, ShellOptions, StartOutcome};
use spm_shell::slicers::api::SlicerCommands;
use spm_shell::slicers::host::ExecutablePicker;
use spm_shell::slicers::registry::slicer;
use spm_shell::slicers::service::SlicerServices;
use spm_shell::state::STATE_FILE_NAME;
use spm_shell::web::EmbeddedAssets;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::commands::AppCtx;
use crate::prompts::TauriPrompts;
use crate::window::{
    CHOOSE_LIBRARY_ITEM, DEVTOOLS_ITEM, RELOAD_ITEM, TauriEvents, build_menu, create_main_window,
};

/// Names a directory for everything the shell keeps (state file, webview data) in place of the
/// per-user application data directory. For tests and for running a second instance.
pub const USER_DATA_ENV: &str = "SPM_DESKTOP_USER_DATA";
/// Creates every window invisible and unfocused and never shows one. See [`hidden`].
pub const HIDDEN_ENV: &str = "SPM_DESKTOP_HIDDEN";
/// A file to write once the listener is up and the window exists.
pub const READY_FILE_ENV: &str = "SPM_DESKTOP_READY_FILE";
/// Run the smoke checks, write their report here, and exit. See [`hidden`].
pub const SMOKE_REPORT_ENV: &str = "SPM_DESKTOP_SMOKE_REPORT";
/// The Vite dev server to serve the UI from, instead of the embedded bundle.
pub const DEV_UI_ENV: &str = "SPM_DEV_UI_ORIGIN";

/// The running listener, kept so the exit handler can stop it.
struct ServerSlot(Mutex<Option<DesktopServer>>);

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn is_hidden() -> bool {
    env_value(HIDDEN_ENV).is_some_and(|value| value == "1")
}

/// Starts the app and runs until the last window closes.
pub fn run() {
    let context = tauri::generate_context!();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The app asks for no permission (camera, location, notifications, ...): all refused,
        // without a prompt a user could be talked into accepting.
        .on_permission_request(|_webview, _kind| tauri::webview::PermissionResponse::Deny)
        .invoke_handler(tauri::generate_handler![
            commands::desktop_library_state,
            commands::desktop_library_pick,
            commands::desktop_library_connect,
            commands::desktop_library_choose,
            commands::desktop_slicers_get,
            commands::desktop_slicers_scan,
            commands::desktop_slicers_add_manual,
            commands::desktop_slicers_remove,
            commands::desktop_slicers_bind,
            commands::desktop_slicers_set_default,
            commands::desktop_slicers_reset_config,
            commands::desktop_slicers_open,
            commands::desktop_slicers_sessions,
            commands::desktop_slicers_resolve_session,
            commands::desktop_slicers_discard_sessions,
        ])
        .setup(setup)
        .build(context)
        .expect("could not build the application");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            shutdown(handle);
        }
    });
}

/// The native dialog that asks for a slicer's program (the one path on the whole slicer surface).
///
/// In a hidden run (tests, smoke checks) there is no dialog: it answers "cancelled", so nothing can
/// ever put a window on a screen from a command.
fn executable_picker<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    hidden: bool,
    language: PickerLanguage,
) -> ExecutablePicker {
    let handle = handle.clone();
    Arc::new(move |slicer_id| {
        if hidden {
            return None;
        }
        let name = slicer(slicer_id).display_name;
        let title = match language {
            PickerLanguage::De => format!("Programm von {name} auswählen"),
            PickerLanguage::En => format!("Choose the program for {name}"),
        };
        let mut dialog = handle.dialog().file().set_title(&title);
        if cfg!(windows) {
            let programs = match language {
                PickerLanguage::De => "Programme",
                PickerLanguage::En => "Programs",
            };
            dialog = dialog.add_filter(programs, &["exe"]);
        }
        if let Some(parent) = handle.get_webview_window(security::MAIN_WEBVIEW) {
            dialog = dialog.set_parent(&parent);
        }
        let picked = dialog.blocking_pick_file()?.into_path().ok()?;
        Some(picked.to_string_lossy().into_owned())
    })
}

fn shutdown<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    if let Some(slot) = handle.try_state::<ServerSlot>()
        && let Some(server) = slot.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    {
        tauri::async_runtime::block_on(server.stop());
    }
    if let Some(ctx) = handle.try_state::<AppCtx>() {
        // Every slicer watcher and timer goes. Nothing of a launch is deleted by this: a session
        // outlives the run of the app (that is what the sweep at next start surfaces).
        ctx.slicers.close();
        // A render that is mid-way cannot be interrupted and the process is exiting anyway.
        ctx.shell.shutdown(std::time::Duration::from_secs(3));
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let hidden = is_hidden();
    let user_data: PathBuf = match env_value(USER_DATA_ENV) {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    };
    std::fs::create_dir_all(&user_data)?;
    let language = picker_language(sys_locale::get_locale().as_deref());

    let gate_cell = Arc::new(OnceLock::new());
    let mut options = ShellOptions::new(
        user_data.join(STATE_FILE_NAME),
        Arc::new(TauriPrompts {
            app: handle.clone(),
        }),
        Arc::new(TauriEvents {
            app: handle.clone(),
            gate: Arc::clone(&gate_cell),
        }),
    );
    options.language = Arc::new(move || language);
    let shell = Shell::new(options);

    let outcome = match shell.start(&env_value) {
        Ok(outcome) => outcome,
        Err(error) => {
            // The environment named something unusable: the operator's to fix, not a question.
            let message = error.cause.clone().unwrap_or_else(|| error.message.clone());
            if !hidden {
                handle
                    .dialog()
                    .message(&message)
                    .title(window::APP_NAME)
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            return Err(message.into());
        }
    };

    // Development: the Vite dev server answers the UI, so it can be changed without a rebuild.
    // Named explicitly (`pnpm dev` sets it): a debug build is not a development session, and a
    // test that builds one must still get the embedded bundle.
    let ui = match env_value(DEV_UI_ENV) {
        Some(origin) => {
            let origin =
                resolve_dev_ui_origin(Some(&origin))?.ok_or("the dev UI origin is empty")?;
            Ui::Dev(DevProxy::new(origin, spm_core::Logger::noop()))
        }
        None => Ui::Assets(EmbeddedAssets::shared()),
    };
    let server = tauri::async_runtime::block_on(DesktopServer::start(Arc::clone(&shell), ui))?;
    let origin = server.origin();
    let _ = gate_cell.set(Arc::clone(server.gate()));

    // The one grant: this exact origin, this one webview, the app's own commands. See `security`.
    app.add_capability(security::main_capability(&origin).to_string())?;
    let slicers = SlicerServices::for_shell(
        &shell,
        user_data.clone(),
        tauri::async_runtime::handle().inner().clone(),
        executable_picker(&handle, hidden, language),
    );
    // What a previous run left under `slicer-sessions/` is surfaced, and nothing that holds a file
    // is deleted: the slicer may well still have it open.
    slicers.sweep_at_start();
    app.manage(AppCtx {
        shell: Arc::clone(&shell),
        slicer_commands: Arc::new(SlicerCommands::new(slicers.clone())),
        slicers,
    });

    let probes = hidden::Probes::from_env();
    let main = create_main_window(
        &handle,
        &server.initial_url(),
        &origin,
        hidden,
        user_data.join("webview"),
        probes
            .as_ref()
            .map(|probes| (probes.sink(), hidden::MAIN_INIT_JS)),
    )?;
    if !hidden {
        app.set_menu(build_menu(&handle, language)?)?;
        app.on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            if id == CHOOSE_LIBRARY_ITEM {
                if let Some(ctx) = app.try_state::<AppCtx>() {
                    let shell = Arc::clone(&ctx.shell);
                    std::thread::spawn(move || {
                        shell.ask_for_mode(PromptTrigger::User);
                    });
                }
            } else if id == RELOAD_ITEM {
                if let Some(window) = app.get_webview_window(security::MAIN_WEBVIEW) {
                    let _ = window.eval("window.location.reload()");
                }
            } else if id == DEVTOOLS_ITEM
                && let Some(window) = app.get_webview_window(security::MAIN_WEBVIEW)
            {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        });
    }

    // A remembered folder that is gone or will not open: say which, with a dialog, once the
    // window is there to sit behind it. Cancelling leaves the connect page, which is usable.
    if let StartOutcome::Ask(Some(reason)) = outcome
        && !hidden
    {
        let shell = Arc::clone(&shell);
        std::thread::spawn(move || {
            if let Err(error) = shell.prompt_for_folder(Some(&reason), PromptTrigger::Startup) {
                spm_shell::diag::error(&format!("could not open the folder: {}", error.message));
            }
        });
    }

    let ui_embedded = EmbeddedAssets::has_index();
    hidden::announce_and_smoke(&handle, &main, &server, &shell, ui_embedded, probes);
    app.manage(ServerSlot(Mutex::new(Some(server))));
    Ok(())
}
