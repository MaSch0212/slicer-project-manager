//! The local library: which folder the shell opens, what it says when there is none, and the
//! object that holds one open (database, preview worker, HTTP router) and lets the previous one
//! go.
//!
//! Folder mode is spec 2.6's: one flat local user, no login. Opening a folder is
//! [`Library::open`], [`ensure_local_user`], a preview worker thread, a rescan in the background
//! (so a folder somebody dropped projects into is adopted), and a router in
//! [`AuthMode::Local`](spm_http::AuthMode). **That router authenticates nobody**; whoever puts it
//! on a socket decides who may reach it, and in this app that is [`crate::gate`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use axum::Router;
use spm_core::dto::LocalLibraryDto;
use spm_core::previews::MeshLimits;
use spm_core::{
    AppError, Ctx, Library, OpenOptions, PreviewConfig, PreviewWorker, ensure_local_user, rescan,
};
use spm_http::{AppState, AuthMode, HttpOptions, UiSource};

use crate::diag;
use crate::remote::{REMOTE_URL_ENV, parse_remote_origin};
use crate::state::{
    STATE_FILE_NAME, ShellMode, read_remembered_dir, read_remembered_mode, read_remembered_remote,
    remember_dir,
};
use crate::sync::{Done, SingleFlight};

/// How often the preview worker looks for work. The Electron shell's value.
pub const PREVIEW_INTERVAL: Duration = Duration::from_secs(5);
/// One preview at a time: this is a desktop app next to a slicer, not a server.
pub const PREVIEW_CONCURRENCY: usize = 1;
/// How many rows one pass claims.
pub const PREVIEW_BATCH_LIMIT: usize = 20;

/// The preview configuration this shell runs with: its own concurrency and batch size, core's
/// mesh ceiling.
pub fn preview_config() -> PreviewConfig {
    PreviewConfig {
        concurrency: PREVIEW_CONCURRENCY,
        limit: PREVIEW_BATCH_LIMIT,
        limits: MeshLimits::default(),
    }
}

/// An open library and the user every request in local mode acts as.
#[derive(Clone)]
pub struct DesktopSession {
    pub lib: Library,
    pub ctx: Ctx,
}

/// Opens `dir` as a library and makes its one local user. Creates the folder if it is not there.
pub fn open_desktop_library(dir: &Path) -> Result<DesktopSession, AppError> {
    let lib = Library::open(dir, OpenOptions::default())?;
    let ctx = ensure_local_user(&lib)?;
    Ok(DesktopSession { lib, ctx })
}

// ---------------------------------------------------------------------------------------------
// Startup planning
// ---------------------------------------------------------------------------------------------

/// Names a library folder for one launch, overriding whatever is remembered. Not remembered.
pub const LIBRARY_DIR_ENV: &str = "SPM_LIBRARY_DIR";

/// `SPM_LIBRARY_DIR`, made absolute, or `None` when unset or empty.
pub fn resolve_library_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let value = env(LIBRARY_DIR_ENV).filter(|value| !value.is_empty())?;
    Some(std::path::absolute(&value).unwrap_or_else(|_| PathBuf::from(value)))
}

/// Why the shell is asking for a folder instead of opening one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptReason {
    /// The remembered folder is no longer there.
    Missing { dir: String },
    /// The remembered folder is there and would not open.
    Unopenable { dir: String, detail: String },
}

/// Where a folder or a server came from at startup. **Only `Remembered` is written back.**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanSource {
    Env,
    Remembered,
}

/// What the shell does at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupPlan {
    /// Open this folder.
    Local { source: PlanSource, dir: PathBuf },
    /// Connect to this server.
    Remote { source: PlanSource, origin: String },
    /// Ask for a folder, saying why.
    Picker { reason: PromptReason },
    /// First run (or unusable memory): ask which mode.
    Ask,
}

/// Decides what to do at startup, from the environment and the state file.
///
/// Errors only for what the *environment* got wrong, which is the operator's to fix and not a
/// question to put to the user: naming both a folder and a server, or a server that is not a URL.
pub fn plan_startup(
    env: &dyn Fn(&str) -> Option<String>,
    state_file: &Path,
    is_directory: &dyn Fn(&Path) -> bool,
) -> Result<StartupPlan, AppError> {
    let from_env = resolve_library_dir(env);
    let remote_from_env = env(REMOTE_URL_ENV).filter(|value| !value.is_empty());
    if from_env.is_some() && remote_from_env.is_some() {
        return Err(AppError::conflict(format!(
            "{LIBRARY_DIR_ENV} and {REMOTE_URL_ENV} are both set; they name two different libraries"
        )));
    }
    if let Some(dir) = from_env {
        return Ok(StartupPlan::Local {
            source: PlanSource::Env,
            dir,
        });
    }
    if let Some(raw) = remote_from_env {
        return Ok(StartupPlan::Remote {
            source: PlanSource::Env,
            origin: parse_remote_origin(&raw)?,
        });
    }

    let Some(mode) = read_remembered_mode(state_file) else {
        return Ok(StartupPlan::Ask);
    };
    if mode == ShellMode::Remote {
        let Some(origin) = read_remembered_remote(state_file) else {
            return Ok(StartupPlan::Ask);
        };
        return Ok(match parse_remote_origin(&origin) {
            Ok(origin) => StartupPlan::Remote {
                source: PlanSource::Remembered,
                origin,
            },
            Err(_) => {
                diag::warn(&format!(
                    "ignoring an unusable remembered server URL ({origin})"
                ));
                StartupPlan::Ask
            }
        });
    }
    let Some(remembered) = read_remembered_dir(state_file) else {
        return Ok(StartupPlan::Ask);
    };
    if !is_directory(Path::new(&remembered)) {
        return Ok(StartupPlan::Picker {
            reason: PromptReason::Missing { dir: remembered },
        });
    }
    Ok(StartupPlan::Local {
        source: PlanSource::Remembered,
        dir: PathBuf::from(remembered),
    })
}

/// The real `is_directory`.
pub fn default_is_directory(path: &Path) -> bool {
    path.is_dir()
}

// ---------------------------------------------------------------------------------------------
// What the shell says
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerLanguage {
    En,
    De,
}

/// `de`, `de-DE`, `DE` are German; everything else, and no locale at all, is English.
pub fn picker_language(locale: Option<&str>) -> PickerLanguage {
    match locale {
        Some(locale) if locale.to_ascii_lowercase().starts_with("de") => PickerLanguage::De,
        _ => PickerLanguage::En,
    }
}

struct PickerStrings {
    title: &'static str,
    button_label: &'static str,
}

fn picker_strings(language: PickerLanguage) -> PickerStrings {
    match language {
        PickerLanguage::En => PickerStrings {
            title: "Choose a library folder",
            button_label: "Open",
        },
        PickerLanguage::De => PickerStrings {
            title: "Bibliotheksordner auswählen",
            button_label: "Öffnen",
        },
    }
}

/// The title of the English picker, for the places that need the bare string.
pub const FOLDER_PICKER_TITLE: &str = "Choose a library folder";

/// A sentence saying why the shell is asking again.
pub fn explain_reason(reason: &PromptReason, language: PickerLanguage) -> String {
    match (reason, language) {
        (PromptReason::Missing { dir }, PickerLanguage::En) => {
            format!("the last folder is no longer there ({dir})")
        }
        (PromptReason::Missing { dir }, PickerLanguage::De) => {
            format!("Der zuletzt geöffnete Ordner ist nicht mehr vorhanden ({dir})")
        }
        (PromptReason::Unopenable { dir, detail }, PickerLanguage::En) => {
            format!("the last folder could not be opened ({dir}): {detail}")
        }
        (PromptReason::Unopenable { dir, detail }, PickerLanguage::De) => {
            format!("Der zuletzt geöffnete Ordner konnte nicht geöffnet werden ({dir}): {detail}")
        }
    }
}

/// What a native folder dialog is opened with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPickerOptions {
    pub title: String,
    pub message: String,
    pub button_label: String,
    /// A folder, not a file.
    pub directory: bool,
    /// The dialog lets the user make a new folder.
    pub create_directory: bool,
}

/// The folder dialog's options, with the reason woven into both the title and the message: which
/// of the two a platform shows differs, and the user should read the reason on either.
pub fn folder_picker_options(
    reason: Option<&PromptReason>,
    language: PickerLanguage,
) -> FolderPickerOptions {
    let strings = picker_strings(language);
    let explanation = reason.map(|reason| explain_reason(reason, language));
    FolderPickerOptions {
        title: match &explanation {
            Some(explanation) => format!("{} — {explanation}", strings.title),
            None => strings.title.to_owned(),
        },
        message: explanation.unwrap_or_else(|| strings.title.to_owned()),
        button_label: strings.button_label.to_owned(),
        directory: true,
        create_directory: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeChoice {
    Local,
    Remote,
    Cancel,
}

/// The order of the mode question's buttons, which is also what an index answers.
pub const MODE_CHOICES: [ModeChoice; 3] =
    [ModeChoice::Local, ModeChoice::Remote, ModeChoice::Cancel];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModePickerOptions {
    pub title: String,
    pub message: String,
    /// Local, remote, cancel: in [`MODE_CHOICES`] order.
    pub buttons: [String; 3],
    pub default_index: usize,
    pub cancel_index: usize,
}

pub fn mode_picker_options(language: PickerLanguage) -> ModePickerOptions {
    let (message, local, remote, cancel) = match language {
        PickerLanguage::En => (
            "Where is your library?",
            "Open a local folder…",
            "Connect to a server…",
            "Not now",
        ),
        PickerLanguage::De => (
            "Wo liegt Ihre Bibliothek?",
            "Lokalen Ordner öffnen…",
            "Mit einem Server verbinden…",
            "Später",
        ),
    };
    ModePickerOptions {
        title: "Slicer Project Manager".to_owned(),
        message: message.to_owned(),
        buttons: [local.to_owned(), remote.to_owned(), cancel.to_owned()],
        default_index: 0,
        cancel_index: 2,
    }
}

/// The choice a button index answers; an index nobody offered is a cancel, the answer that
/// changes nothing.
pub fn mode_choice_at(index: usize) -> ModeChoice {
    MODE_CHOICES
        .get(index)
        .copied()
        .unwrap_or(ModeChoice::Cancel)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmOptions {
    pub title: String,
    pub message: String,
    pub detail: String,
    /// Cancel, then connect.
    pub buttons: [String; 2],
    /// The default button refuses.
    pub default_index: usize,
    pub cancel_index: usize,
}

/// The question put to the user before the app talks to a server somebody named. **The default
/// answer refuses**, and so does dismissing it.
pub fn confirm_remote_options(origin: &str, language: PickerLanguage) -> ConfirmOptions {
    let (title, message, detail, buttons) = match language {
        PickerLanguage::En => (
            "Connect to a server",
            format!("Connect this app to {origin}?"),
            "The app will send your sign-in and every request to that address until you change \
             it. Only continue if you recognise it.",
            ["Cancel".to_owned(), "Connect".to_owned()],
        ),
        PickerLanguage::De => (
            "Mit einem Server verbinden",
            format!("Diese App mit {origin} verbinden?"),
            "Die App sendet Ihre Anmeldung und jede Anfrage an diese Adresse, bis Sie sie ändern. \
             Fahren Sie nur fort, wenn Sie die Adresse kennen.",
            ["Abbrechen".to_owned(), "Verbinden".to_owned()],
        ),
    };
    ConfirmOptions {
        title: title.to_owned(),
        message,
        detail: detail.to_owned(),
        buttons,
        default_index: 0,
        cancel_index: 0,
    }
}

/// Whether a button index of the confirmation is "Connect". Only that one is.
pub fn confirmed_at(index: usize) -> bool {
    index == 1
}

/// The application menu's two labels this shell writes itself.
pub fn menu_strings(language: PickerLanguage) -> (&'static str, &'static str) {
    match language {
        PickerLanguage::En => ("Library", "Choose library…"),
        PickerLanguage::De => ("Bibliothek", "Bibliothek auswählen…"),
    }
}

/// Whether the shell or the user raised a prompt: a startup prompt has no window to be modal to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTrigger {
    Startup,
    User,
}

/// Everything the shell asks a human, blocking until they answer. Real implementations show native
/// dialogs; tests answer from a script.
pub trait Prompts: Send + Sync {
    /// A folder, or `None` when the dialog was cancelled.
    fn pick_folder(&self, options: &FolderPickerOptions, trigger: PromptTrigger)
    -> Option<PathBuf>;
    fn ask_mode(&self, options: &ModePickerOptions) -> ModeChoice;
    /// Whether the user confirmed connecting.
    fn confirm_remote(&self, options: &ConfirmOptions) -> bool;
}

/// A prompt that was cancelled before it was asked is just a cancel: for hosts with no UI.
pub struct NoPrompts;

impl Prompts for NoPrompts {
    fn pick_folder(&self, _: &FolderPickerOptions, _: PromptTrigger) -> Option<PathBuf> {
        None
    }
    fn ask_mode(&self, _: &ModePickerOptions) -> ModeChoice {
        ModeChoice::Cancel
    }
    fn confirm_remote(&self, _: &ConfirmOptions) -> bool {
        false
    }
}

pub fn unopenable_reason(dir: &Path, error: &AppError) -> PromptReason {
    PromptReason::Unopenable {
        dir: dir.display().to_string(),
        detail: error.cause.clone().unwrap_or_else(|| error.message.clone()),
    }
}

// ---------------------------------------------------------------------------------------------
// The open folder
// ---------------------------------------------------------------------------------------------

/// What runs previews for an open library. Stopping it blocks until a batch that is already
/// rendering has finished: a render cannot be interrupted.
pub trait PreviewRunner: Send {
    fn stop(self: Box<Self>);
}

impl PreviewRunner for PreviewWorker {
    fn stop(self: Box<Self>) {
        PreviewWorker::stop(*self);
    }
}

/// Starts a [`PreviewRunner`] on a library. The default runs [`PreviewWorker`] at the shell's own
/// settings; a test substitutes one it can block.
pub type StartPreviews = Arc<dyn Fn(&Library) -> Box<dyn PreviewRunner> + Send + Sync>;

pub fn default_start_previews() -> StartPreviews {
    Arc::new(|lib| {
        Box::new(PreviewWorker::spawn(
            lib.clone(),
            preview_config(),
            PREVIEW_INTERVAL,
        ))
    })
}

/// Builds the router that answers `/api` for a session. The default is `spm-http`'s router in
/// local mode with no UI of its own: the shell serves the UI, in every mode.
pub type MakeRouter = Arc<dyn Fn(&DesktopSession) -> Router + Send + Sync>;

pub fn default_make_router() -> MakeRouter {
    Arc::new(|session| {
        spm_http::router(AppState::new(
            session.lib.clone(),
            HttpOptions {
                auth: AuthMode::Local(session.ctx.clone()),
                ui: UiSource::None,
                ..HttpOptions::default()
            },
        ))
    })
}

struct OpenFolder {
    dir: PathBuf,
    session: DesktopSession,
    router: Router,
    runner: Box<dyn PreviewRunner>,
    /// The rescan that adopts what is already in the folder.
    adopt: Option<JoinHandle<()>>,
}

/// What the host tells its owner. Both are "something under the page changed".
pub trait LibraryEvents: Send + Sync {
    /// The library on screen changed, or a rescan found something in it.
    fn changed(&self);
}

impl<F: Fn() + Send + Sync> LibraryEvents for F {
    fn changed(&self) {
        self();
    }
}

pub struct LibraryHostOptions {
    pub state_file: PathBuf,
    pub prompts: Arc<dyn Prompts>,
    pub events: Arc<dyn LibraryEvents>,
    pub start_previews: StartPreviews,
    pub make_router: MakeRouter,
    pub language: Arc<dyn Fn() -> PickerLanguage + Send + Sync>,
    /// Called with a folder's path once its database has been closed. Nothing in the app needs
    /// it; the tests use it to see *when* a folder was let go of.
    pub on_released: Arc<dyn Fn(&Path) + Send + Sync>,
}

impl LibraryHostOptions {
    /// The real preview worker and router, English dialogs, nobody listening for changes.
    pub fn new(state_file: PathBuf, prompts: Arc<dyn Prompts>) -> LibraryHostOptions {
        LibraryHostOptions {
            state_file,
            prompts,
            events: Arc::new(|| {}),
            start_previews: default_start_previews(),
            make_router: default_make_router(),
            language: Arc::new(|| PickerLanguage::En),
            on_released: Arc::new(|_| {}),
        }
    }
}

/// The one open library folder, and the machinery around switching it.
///
/// Opening a folder never waits for the one it replaces. The previous folder is **released** on a
/// thread of its own: its preview worker is told to stop at once, the rescan that was adopting it
/// is waited for, and only then (and only after every earlier release has finished too) is its
/// database closed. So a switch answers immediately however slow a render is, and a folder's
/// handle is never closed from under work that still uses it.
pub struct LibraryHost {
    state_file: PathBuf,
    prompts: Arc<dyn Prompts>,
    events: Arc<dyn LibraryEvents>,
    start_previews: StartPreviews,
    make_router: MakeRouter,
    language: Arc<dyn Fn() -> PickerLanguage + Send + Sync>,
    on_released: Arc<dyn Fn(&Path) + Send + Sync>,
    current: Mutex<Option<OpenFolder>>,
    /// Bumped on every open and close; a rescan that finishes after the library it adopted is gone
    /// has nobody to tell.
    generation: Arc<AtomicU64>,
    asking: SingleFlight<Option<LocalLibraryDto>>,
    last_release: Mutex<Option<Arc<Done>>>,
}

impl LibraryHost {
    pub fn new(options: LibraryHostOptions) -> Arc<LibraryHost> {
        Arc::new(LibraryHost {
            state_file: options.state_file,
            prompts: options.prompts,
            events: options.events,
            start_previews: options.start_previews,
            make_router: options.make_router,
            language: options.language,
            on_released: options.on_released,
            current: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            asking: SingleFlight::default(),
            last_release: Mutex::new(None),
        })
    }

    fn current(&self) -> std::sync::MutexGuard<'_, Option<OpenFolder>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The open library, if any.
    pub fn session(&self) -> Option<DesktopSession> {
        self.current().as_ref().map(|open| open.session.clone())
    }

    /// The router for the open library, if any.
    pub fn router(&self) -> Option<Router> {
        self.current().as_ref().map(|open| open.router.clone())
    }

    /// The open folder, if any.
    pub fn dir(&self) -> Option<PathBuf> {
        self.current().as_ref().map(|open| open.dir.clone())
    }

    /// Opens `dir`, replacing whatever is open, and remembers it (unless `remember` is false: an
    /// environment override is for one launch).
    ///
    /// Re-opening the folder that is already open changes nothing: no second database handle, no
    /// second worker, no reload. A folder that will not open leaves the previous one open and
    /// remembered.
    pub fn open(self: &Arc<Self>, dir: &Path, remember: bool) -> Result<LocalLibraryDto, AppError> {
        let resolved = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
        if self.dir().as_deref() == Some(resolved.as_path()) {
            return Ok(dto(&resolved));
        }
        let session = open_desktop_library(&resolved)?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let runner = (self.start_previews)(&session.lib);
        let router = (self.make_router)(&session);
        let adopt = self.adopt(&session, generation);
        let previous = self.current().replace(OpenFolder {
            dir: resolved.clone(),
            session,
            router,
            runner,
            adopt,
        });
        if let Some(previous) = previous {
            self.release(previous);
        }
        if remember {
            self.remember(&resolved);
        }
        self.events.changed();
        Ok(dto(&resolved))
    }

    fn remember(&self, dir: &Path) {
        if let Err(error) = remember_dir(&self.state_file, &dir.display().to_string()) {
            diag::error(&format!(
                "could not remember the library folder in {STATE_FILE_NAME}: {error}"
            ));
        }
    }

    /// Reconciles the folder with the database in the background, and tells the owner if it found
    /// anything (the page is showing a list that does not have it yet).
    fn adopt(
        self: &Arc<Self>,
        session: &DesktopSession,
        generation: u64,
    ) -> Option<JoinHandle<()>> {
        let (lib, ctx) = (session.lib.clone(), session.ctx.clone());
        let host = Arc::downgrade(self);
        thread::Builder::new()
            .name("spm-rescan".to_owned())
            .spawn(move || match rescan(&lib, &ctx, None) {
                Ok(result) => {
                    let changed = result.adopted
                        + result.marked_missing
                        + result.files_added
                        + result.files_removed
                        > 0;
                    if changed
                        && let Some(host) = host.upgrade()
                        && host.generation.load(Ordering::SeqCst) == generation
                    {
                        host.events.changed();
                    }
                }
                Err(error) => diag::error(&format!(
                    "rescan after opening the library failed: {}",
                    error.cause.as_deref().unwrap_or(&error.message)
                )),
            })
            .ok()
    }

    /// Asks for a folder with the native dialog and opens it.
    ///
    /// `Ok(None)` is a cancelled dialog, which leaves the library that was open alone. Two prompts
    /// at once are one dialog and one answer.
    pub fn prompt(
        self: &Arc<Self>,
        reason: Option<&PromptReason>,
        trigger: PromptTrigger,
    ) -> Result<Option<LocalLibraryDto>, AppError> {
        // The answer is shared as a plain value so every waiter can have a copy; a failure to
        // open is only the leader's to report.
        let outcome: Result<Option<LocalLibraryDto>, AppError> = {
            let mut failure: Option<AppError> = None;
            let shared = self.asking.run(|| {
                if let Some(reason) = reason {
                    diag::warn(&explain_reason(reason, PickerLanguage::En));
                }
                let options = folder_picker_options(reason, (self.language)());
                let picked = self.prompts.pick_folder(&options, trigger)?;
                match self.open(&picked, true) {
                    Ok(opened) => Some(opened),
                    Err(error) => {
                        failure = Some(error);
                        None
                    }
                }
            });
            match failure {
                Some(error) => Err(error),
                None => Ok(shared),
            }
        };
        outcome
    }

    /// Opens what a startup plan names. A remembered folder that will not open degrades to a
    /// prompt reason; an environment folder that will not open is the operator's to fix and fails.
    pub fn open_planned(
        self: &Arc<Self>,
        dir: &Path,
        source: PlanSource,
    ) -> Result<LocalLibraryDto, OpenFailure> {
        match self.open(dir, source != PlanSource::Env) {
            Ok(opened) => Ok(opened),
            Err(error) if source == PlanSource::Env => Err(OpenFailure::Fatal(error)),
            Err(error) => Err(OpenFailure::Prompt(unopenable_reason(dir, &error))),
        }
    }

    /// Lets go of the open library (the shell is leaving local mode).
    pub fn close_current(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let previous = self.current().take();
        if let Some(previous) = previous {
            self.release(previous);
        }
    }

    /// Lets go of everything and waits up to `timeout` for the releases to finish. Returns whether
    /// they did: a render that is mid-way cannot be interrupted, and the process may be about to
    /// exit anyway.
    pub fn shutdown(&self, timeout: Duration) -> bool {
        self.close_current();
        self.settle_within(timeout)
    }

    /// Waits for every release in flight (and the rescan of the open folder) to finish.
    pub fn settle(&self) {
        let adopt = self.current().as_mut().and_then(|open| open.adopt.take());
        if let Some(adopt) = adopt {
            let _ = adopt.join();
        }
        let last = self
            .last_release
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(last) = last {
            last.wait();
        }
    }

    fn settle_within(&self, timeout: Duration) -> bool {
        let last = self
            .last_release
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        last.is_none_or(|last| last.wait_timeout(timeout))
    }

    fn release(&self, previous: OpenFolder) {
        let done = Arc::new(Done::default());
        let earlier = self
            .last_release
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Arc::clone(&done));
        let spawned = thread::Builder::new()
            .name("spm-release".to_owned())
            .spawn({
                let done = Arc::clone(&done);
                let on_released = Arc::clone(&self.on_released);
                move || {
                    let OpenFolder {
                        dir,
                        session,
                        router,
                        runner,
                        adopt,
                    } = previous;
                    // Told to stop at once, so a second switch does not wait behind the first.
                    runner.stop();
                    if let Some(adopt) = adopt {
                        let _ = adopt.join();
                    }
                    // This folder's handle is held until every earlier release has finished.
                    if let Some(earlier) = earlier {
                        earlier.wait();
                    }
                    drop(router);
                    drop(session);
                    on_released(&dir);
                    done.finish();
                }
            });
        if let Err(error) = spawned {
            diag::error(&format!("could not release a library: {error}"));
            done.finish();
        }
    }
}

/// Why [`LibraryHost::open_planned`] did not open.
#[derive(Debug)]
pub enum OpenFailure {
    /// Ask the user for a folder instead, saying why.
    Prompt(PromptReason),
    /// The environment named a folder that will not open: fail the launch.
    Fatal(AppError),
}

fn dto(dir: &Path) -> LocalLibraryDto {
    LocalLibraryDto {
        dir: dir.display().to_string(),
    }
}
