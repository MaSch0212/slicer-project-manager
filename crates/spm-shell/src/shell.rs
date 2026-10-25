//! The shell's mode: which library the app is looking at (a local folder, a remote server, or none
//! yet), how it got there, and what it lets go of on the way.
//!
//! The webview does not know any of this. It talks to one loopback origin whatever the mode, and
//! [`crate::server`] answers `/api` out of whatever this says is active. What the webview *does*
//! need to hear is "your data changed": [`ShellEvents`], which the desktop app turns into a
//! navigation or a reload of the main webview.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::Router;
use spm_core::AppError;
use spm_core::dto::{LocalLibraryDto, RemoteLibraryDto};

use crate::diag;
use crate::library::{
    DesktopSession, LibraryEvents, LibraryHost, LibraryHostOptions, MakeRouter, ModeChoice,
    OpenFailure, PickerLanguage, PromptReason, PromptTrigger, Prompts, StartPreviews, StartupPlan,
    confirm_remote_options, default_is_directory, default_make_router, default_start_previews,
    mode_picker_options, plan_startup,
};
use crate::remote::{RemoteHost, is_plaintext_to_another_machine, parse_remote_origin};
use crate::state::{STATE_FILE_NAME, ShellMode, remember_choice};
use crate::sync::SingleFlight;

/// Where the main webview should go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellRoute {
    /// The app's home, whatever that is for the mode now active.
    Home,
    /// The page that asks where the library is.
    Connect,
}

impl ShellRoute {
    /// The path on the app's own origin.
    pub fn path(self) -> &'static str {
        match self {
            ShellRoute::Home => "/",
            ShellRoute::Connect => "/desktop/connect",
        }
    }
}

/// What the shell tells the window.
pub trait ShellEvents: Send + Sync {
    /// The target moved (a different server, or out of server mode, or the question is being
    /// asked again): load this route from scratch, so nothing the page holds survives.
    fn navigate(&self, route: ShellRoute);
    /// The library under the page changed (a folder was opened, or a rescan adopted projects):
    /// reload what is on screen.
    fn reload(&self);
}

/// The mode the shell is in right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveMode {
    /// First run, or the user left a server for the connect page: nothing is open.
    Unset,
    Local,
    Remote,
}

/// What a `start` did.
#[derive(Debug)]
pub enum StartOutcome {
    /// A library is open (or a server connected).
    Opened,
    /// Nothing is open: ask. `None` is the mode question; `Some` is a folder prompt with a reason.
    Ask(Option<PromptReason>),
}

pub type MakeRemote = Arc<dyn Fn(&str) -> Arc<RemoteHost> + Send + Sync>;

pub struct ShellOptions {
    pub state_file: PathBuf,
    pub prompts: Arc<dyn Prompts>,
    pub events: Arc<dyn ShellEvents>,
    pub start_previews: StartPreviews,
    pub make_router: MakeRouter,
    pub make_remote: MakeRemote,
    pub language: Arc<dyn Fn() -> PickerLanguage + Send + Sync>,
    /// See [`crate::library::LibraryHostOptions::on_released`].
    pub on_released: Arc<dyn Fn(&std::path::Path) + Send + Sync>,
}

impl ShellOptions {
    /// The real preview worker, router and remote host; English dialogs.
    pub fn new(
        state_file: PathBuf,
        prompts: Arc<dyn Prompts>,
        events: Arc<dyn ShellEvents>,
    ) -> ShellOptions {
        ShellOptions {
            state_file,
            prompts,
            events,
            start_previews: default_start_previews(),
            make_router: default_make_router(),
            make_remote: Arc::new(|origin| Arc::new(RemoteHost::new(origin))),
            language: Arc::new(|| PickerLanguage::En),
            on_released: Arc::new(|_| {}),
        }
    }
}

/// Library-host changes arrive here, and are turned into a reload unless a server is connected.
struct LibraryChanges(Weak<Shell>);

impl LibraryEvents for LibraryChanges {
    fn changed(&self) {
        if let Some(shell) = self.0.upgrade() {
            shell.library_changed();
        }
    }
}

pub struct Shell {
    state_file: PathBuf,
    library: Arc<LibraryHost>,
    prompts: Arc<dyn Prompts>,
    events: Arc<dyn ShellEvents>,
    language: Arc<dyn Fn() -> PickerLanguage + Send + Sync>,
    make_remote: MakeRemote,
    remote: Mutex<Option<Arc<RemoteHost>>>,
    asking: SingleFlight<ModeChoice>,
    connecting: SingleFlight<Result<Option<RemoteLibraryDto>, AppError>>,
    connecting_to: Mutex<Option<String>>,
}

impl Shell {
    pub fn new(options: ShellOptions) -> Arc<Shell> {
        Arc::new_cyclic(|weak: &Weak<Shell>| {
            let mut library =
                LibraryHostOptions::new(options.state_file.clone(), Arc::clone(&options.prompts));
            library.events = Arc::new(LibraryChanges(weak.clone()));
            library.start_previews = options.start_previews;
            library.make_router = options.make_router;
            library.language = Arc::clone(&options.language);
            library.on_released = options.on_released;
            Shell {
                state_file: options.state_file,
                library: LibraryHost::new(library),
                prompts: options.prompts,
                events: options.events,
                language: options.language,
                make_remote: options.make_remote,
                remote: Mutex::new(None),
                asking: SingleFlight::default(),
                connecting: SingleFlight::default(),
                connecting_to: Mutex::new(None),
            }
        })
    }

    fn remote_slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<RemoteHost>>> {
        self.remote.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn library(&self) -> &Arc<LibraryHost> {
        &self.library
    }

    pub fn mode(&self) -> ActiveMode {
        if self.remote().is_some() {
            ActiveMode::Remote
        } else if self.library.session().is_some() {
            ActiveMode::Local
        } else {
            ActiveMode::Unset
        }
    }

    /// The server the shell is connected to, if it is.
    pub fn remote(&self) -> Option<Arc<RemoteHost>> {
        self.remote_slot().clone()
    }

    /// The open local library, if there is one.
    pub fn session(&self) -> Option<DesktopSession> {
        self.library.session()
    }

    /// The `/api` router of the open local library, if there is one.
    pub fn local_router(&self) -> Option<Router> {
        self.library.router()
    }

    /// Reads the environment and the state file and enters the mode they name, without asking
    /// anything: the caller asks (the mode question, or a folder prompt) when this says to.
    ///
    /// Fails only for what the environment got wrong (both a folder and a server named, a server
    /// that is not a URL, a folder that will not open): the operator's to fix, not a question.
    pub fn start(&self, env: &dyn Fn(&str) -> Option<String>) -> Result<StartOutcome, AppError> {
        match plan_startup(env, &self.state_file, &default_is_directory)? {
            StartupPlan::Ask => Ok(StartOutcome::Ask(None)),
            StartupPlan::Remote { origin, .. } => {
                self.adopt_remote(&origin, false, false);
                Ok(StartOutcome::Opened)
            }
            StartupPlan::Picker { reason } => Ok(StartOutcome::Ask(Some(reason))),
            StartupPlan::Local { source, dir } => match self.library.open_planned(&dir, source) {
                Ok(_) => {
                    self.become_local();
                    Ok(StartOutcome::Opened)
                }
                Err(OpenFailure::Prompt(reason)) => Ok(StartOutcome::Ask(Some(reason))),
                Err(OpenFailure::Fatal(error)) => Err(error),
            },
        }
    }

    /// Asks which mode the library is in, and acts on the answer.
    ///
    /// Two questions at once are one dialog and one answer. *Local* goes on to the folder dialog.
    /// *Remote* lets go of any server and sends the page to the connect page (the page asks for
    /// the address). *Cancel* changes nothing at all.
    pub fn ask_for_mode(&self, trigger: PromptTrigger) -> ModeChoice {
        self.asking.run(|| {
            let choice = self
                .prompts
                .ask_mode(&mode_picker_options((self.language)()));
            match choice {
                ModeChoice::Local => {
                    if let Err(error) = self.pick_local_folder(trigger) {
                        diag::error(&format!("could not open the folder: {}", error.message));
                    }
                }
                ModeChoice::Remote => {
                    // Leaving a live server rebuilds the page on the way; with nothing connected the
                    // same question only navigates. Both are one navigation to the connect page.
                    self.release_remote();
                    self.events.navigate(ShellRoute::Connect);
                }
                ModeChoice::Cancel => {}
            }
            choice
        })
    }

    /// The library changed under the page. Declined while a server is connected: a folder opened
    /// during a switch away from a server is followed by the navigation of the switch itself.
    pub fn library_changed(&self) {
        if self.remote().is_some() {
            return;
        }
        self.events.reload();
    }

    /// Asks for a folder and opens it. `Ok(None)` is a cancelled dialog.
    pub fn pick_local_folder(
        &self,
        trigger: PromptTrigger,
    ) -> Result<Option<LocalLibraryDto>, AppError> {
        let opened = self.library.prompt(None, trigger)?;
        if opened.is_some() {
            self.become_local();
        }
        Ok(opened)
    }

    /// Asks for a folder after a startup that could not open the remembered one, saying why.
    pub fn prompt_for_folder(
        &self,
        reason: Option<&PromptReason>,
        trigger: PromptTrigger,
    ) -> Result<Option<LocalLibraryDto>, AppError> {
        let opened = self.library.prompt(reason, trigger)?;
        if opened.is_some() {
            self.become_local();
        }
        Ok(opened)
    }

    /// Connects to the server `url` names, once the user has said so.
    ///
    /// **`url` is untrusted: it came from the webview.** It is reduced to an origin first (a bad
    /// one is `Validation` and changes nothing), and then the user is asked, by a native dialog the
    /// page cannot click, whether to connect to *that*. Declining connects nothing and writes
    /// nothing (`Ok(None)`). A page asking in a loop gets one dialog: callers for the same server
    /// share one answer, and a call for a different server while one is pending is `Conflict`.
    pub fn connect_remote(&self, url: &str) -> Result<Option<RemoteLibraryDto>, AppError> {
        let origin = parse_remote_origin(url)?;
        if let Some(remote) = self.remote()
            && remote.origin() == origin
        {
            return Ok(Some(RemoteLibraryDto { origin }));
        }
        {
            let mut connecting_to = self.connecting_to.lock().unwrap_or_else(|e| e.into_inner());
            match &*connecting_to {
                Some(other) if *other != origin => {
                    return Err(AppError::conflict(
                        "a server connection is already being confirmed",
                    ));
                }
                Some(_) => {}
                None => *connecting_to = Some(origin.clone()),
            }
        }
        self.connecting.run(|| {
            let confirmed = self
                .prompts
                .confirm_remote(&confirm_remote_options(&origin, (self.language)()));
            let result = if confirmed {
                self.adopt_remote(&origin, true, true);
                Ok(Some(RemoteLibraryDto {
                    origin: origin.clone(),
                }))
            } else {
                Ok(None)
            };
            *self.connecting_to.lock().unwrap_or_else(|e| e.into_inner()) = None;
            result
        })
    }

    fn adopt_remote(&self, origin: &str, remember: bool, replace_page: bool) {
        if is_plaintext_to_another_machine(origin) {
            diag::warn(&format!(
                "{origin} is plain http to another machine; the login, the session and every \
                 file will cross that network in the clear"
            ));
        }
        let previous_origin = self.remote().map(|remote| remote.origin().to_owned());
        let was_remote = previous_origin.is_some();
        self.release_remote();
        self.library.close_current();
        *self.remote_slot() = Some((self.make_remote)(origin));
        if remember {
            self.remember(ShellMode::Remote, origin);
        }
        let moved = !was_remote || previous_origin.as_deref() != Some(origin);
        if replace_page && moved {
            self.events.navigate(ShellRoute::Home);
        }
    }

    fn become_local(&self) {
        if self.remote().is_some() {
            self.release_remote();
            self.events.navigate(ShellRoute::Home);
        }
    }

    fn release_remote(&self) {
        if let Some(remote) = self.remote_slot().take() {
            remote.close();
        }
    }

    fn remember(&self, mode: ShellMode, target: &str) {
        if let Err(error) = remember_choice(&self.state_file, mode, target) {
            diag::error(&format!(
                "could not remember the shell mode in {STATE_FILE_NAME}: {error}"
            ));
        }
    }

    /// Lets go of the server and the library, waiting up to `timeout` for the library's releases.
    pub fn shutdown(&self, timeout: Duration) -> bool {
        self.release_remote();
        self.library.shutdown(timeout)
    }
}
