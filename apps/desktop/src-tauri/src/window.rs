//! The main window: how it is built, where it may go, and the application menu.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use spm_shell::gate::LaunchGate;
use spm_shell::library::{PickerLanguage, menu_strings};
use spm_shell::nav::{NavigationPolicy, is_openable_externally, navigation_policy};
use spm_shell::shell::{ShellEvents, ShellRoute};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::security::MAIN_WEBVIEW;

/// What the title bar and the taskbar say.
pub const APP_NAME: &str = "Slicer Project Manager";

/// The menu item that asks where the library is.
pub const CHOOSE_LIBRARY_ITEM: &str = "spm-choose-library";
/// The menu item that opens the developer tools.
pub const DEVTOOLS_ITEM: &str = "spm-devtools";
/// The menu item that reloads the page.
pub const RELOAD_ITEM: &str = "spm-reload";

/// Hands a web page to the system browser. Only `http(s)`: a `file:` or custom-scheme URL given to
/// the shell would execute things.
pub fn open_external(url: &str) {
    if is_openable_externally(url) {
        let _ = open::that_detached(url);
    }
}

/// Told every time a document in a window sets its title: the window's label, and the title. The
/// smoke run's probes report their results through it, because it needs no permission at all.
/// (`create_main_window` also takes the script the smoke run installs in the page.)
pub type TitleSink = Arc<dyn Fn(&str, String) + Send + Sync>;

/// Builds the main window on `url` (a handshake URL on the loopback origin `origin`).
///
/// `hidden` is the smoke run's: the window is created invisible and unfocused and nothing ever
/// shows it, so a test cannot steal the user's focus.
pub fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    origin: &str,
    hidden: bool,
    data_dir: PathBuf,
    smoke: Option<(TitleSink, &'static str)>,
) -> tauri::Result<WebviewWindow<R>> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| tauri::Error::InvalidWebviewUrl("the start URL is not a URL"))?;
    let navigation_origin = origin.to_owned();
    let popup_origin = origin.to_owned();
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WEBVIEW, WebviewUrl::External(parsed))
        .title(APP_NAME)
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .visible(!hidden)
        .focused(!hidden)
        .skip_taskbar(hidden)
        .data_directory(data_dir)
        // The webview stays on its own origin. A link to somewhere else (a project's source URL,
        // an address in a description) opens in the system browser; anything that is not a web
        // page is refused. Tauri injects its bridge into every page a webview loads, so a page
        // that loaded here would be a page that could ask for desktop commands.
        .on_navigation(
            move |url| match navigation_policy(url.as_str(), &navigation_origin) {
                NavigationPolicy::Allow => true,
                NavigationPolicy::External => {
                    open_external(url.as_str());
                    false
                }
                NavigationPolicy::Block => false,
            },
        )
        // `window.open` and `target=_blank` never create a window of this app: a web page goes to
        // the system browser, everything else is dropped.
        .on_new_window(move |url, _features| {
            if navigation_policy(url.as_str(), &popup_origin) == NavigationPolicy::External {
                open_external(url.as_str());
            }
            NewWindowResponse::Deny
        });
    if let Some((sink, init_script)) = smoke {
        builder = builder
            .initialization_script(init_script)
            .on_document_title_changed(move |window, title| {
                sink(window.label(), title);
            });
    }
    builder.build()
}

/// The application menu: where the library is chosen (the way back from a server, where the
/// settings card is hidden), the editing shortcuts, a reload, and the developer tools.
pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    language: PickerLanguage,
) -> tauri::Result<Menu<R>> {
    let (library_label, choose_label) = menu_strings(language);
    let (edit, view, window, reload, devtools) = match language {
        PickerLanguage::En => ("Edit", "View", "Window", "Reload", "Toggle Developer Tools"),
        PickerLanguage::De => (
            "Bearbeiten",
            "Ansicht",
            "Fenster",
            "Neu laden",
            "Entwicklertools umschalten",
        ),
    };
    let library = Submenu::with_items(
        app,
        library_label,
        true,
        &[
            &MenuItem::with_id(app, CHOOSE_LIBRARY_ITEM, choose_label, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        view,
        true,
        &[
            &MenuItem::with_id(app, RELOAD_ITEM, reload, true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(
                app,
                DEVTOOLS_ITEM,
                devtools,
                true,
                Some("CmdOrCtrl+Shift+I"),
            )?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&library, &edit, &view, &window])
}

/// Turns the shell's "the target moved" and "the data changed" into what the main webview does.
pub struct TauriEvents<R: Runtime> {
    pub app: AppHandle<R>,
    /// Set once the listener is up: a navigation needs a fresh handshake URL, which is what makes
    /// it work even if the webview lost its cookie.
    pub gate: Arc<OnceLock<Arc<LaunchGate>>>,
}

impl<R: Runtime> TauriEvents<R> {
    fn window(&self) -> Option<WebviewWindow<R>> {
        self.app.get_webview_window(MAIN_WEBVIEW)
    }
}

impl<R: Runtime> ShellEvents for TauriEvents<R> {
    fn navigate(&self, route: ShellRoute) {
        let (Some(window), Some(gate)) = (self.window(), self.gate.get()) else {
            // A no-op at startup, when the shell has decided before any window exists.
            return;
        };
        if let Ok(url) = gate.handshake_url(route.path()).parse() {
            let _ = window.navigate(url);
        }
    }

    fn reload(&self) {
        let Some(window) = self.window() else { return };
        // **A window on the connect page is sent home instead of reloaded.** It is the one route
        // in the app that is a *question*: reloading it after the question has been answered puts
        // the user back in front of "where is your library?" with the library already open
        // behind it.
        let on_connect = window
            .url()
            .is_ok_and(|url| url.path() == ShellRoute::Connect.path());
        if on_connect {
            self.navigate(ShellRoute::Home);
        } else {
            let _ = window.eval("window.location.reload()");
        }
    }
}
