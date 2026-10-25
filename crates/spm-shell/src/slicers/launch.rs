//! Handing a file to a slicer, and saying only what the app actually knows about what happens next.
//!
//! **Nothing here starts a process directly.** The spawn is injected ([`SlicerSpawner`]), the
//! library session and the mode are read through closures, and the remote server is a trait, so
//! the whole of this file (both launch paths, the refusals and the launch record) runs under plain
//! `cargo test` with no slicer and no GUI.
//!
//! # The two paths, and why one of them writes nothing at all
//!
//! `as-is` (spec 6.1) launches the **real library path**, resolved through core's
//! `resolve_file_path` and so through `safe_join`. No copy, no strip, no launch directory. It is
//! safe because nothing locks the file, opening modifies neither the file nor its folder, and no
//! litter appears beside it; it is *useful* because four of five slicers save back in place, so
//! the user's work lands in the project folder and the next rescan indexes it. **That in-place save
//! is not the app writing into the library**: the write is the user's entire intent and is made by
//! the slicer. This file writes into the library on no path whatever.
//!
//! `new-project` (spec 6.2) starts a new slicer project from a file of any kind, usually in a
//! slicer other than the one that wrote it. **When that file is a `.3mf`, what the slicer is
//! handed is a temporary copy with the embedded slicer configuration stripped**, so the slicer does
//! not ask to adopt someone else's settings; an existing slicer project opened `as-is` is handed
//! over unchanged. The stripped copy is never stored in the project, and it lives in a launch
//! directory under the app's data directory that nothing deletes while the slicer may still have it
//! open (see [`crate::slicers::sessions`]).
//!
//! - **`.stl` and `.obj` are launched in place, with no copy.** Importing a mesh gives an untitled
//!   project in all five slicers and four of five propose `<basename>.3mf` *beside the model* on
//!   the first save, which puts the new project into the project folder where the rescan finds it.
//! - **Everything else goes through a launch directory**: a stripped copy where there is something
//!   to strip, a verbatim copy where there is not.
//!
//! **The first branch does not include a `.3mf`, and that is constraint 8.** Any config-less
//! `.3mf` classifies as a `model`; launched in place, the slicer proposes `<basename>.3mf`, which
//! *is* the source file's own name, so it offers to write its project over the user's mesh. A
//! `model`-kind `.3mf` is copied into a launch directory like everything else.
//!
//! **`.step`/`.stp` take the copy branch** for a third reason that is neither of the above: what
//! Ctrl+S proposes for a STEP input is unmeasured in every slicer, and the copy branch is the
//! conservative answer.
//!
//! # And remote mode, where there are no in-place paths at all
//!
//! The library's bytes are on another machine, so **every** launch goes through a launch
//! directory, `.stl` and `.obj` included: create the directory, download the one file asked for
//! through the proxy, classify it, strip it where there is something to strip, then launch.
//!
//! # Never half-strip, and never fall back
//!
//! A strip that refuses refuses the whole launch (constraint 9). For Anycubic the tempting fallback
//! (launch the original) *is* the silent-discard case: a healthy process, an empty plate and
//! nothing saying why. The refusal names which of three problems it was, and says that opening the
//! file as-is is still available.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use spm_core::dto::{
    FileKind, SlicerConfigDto, SlicerId, SlicerInstallState, SlicerLaunchDto, SlicerLaunchMode,
    SlicerLaunchOptions,
};
use spm_core::files::classify::{Classification, classify_file};
use spm_core::files::entry_hash::{entry_digests, entry_hash};
use spm_core::files::strip3mf::{StripRefusalReason, strip_refusal_reason, strip3mf};
use spm_core::{AppError, AppErrorCode, get_project, resolve_file_path};

use super::host::{SlicersHost, now_ms};
use super::registry::{SLICER_IDS, slicer};
use super::remote_files::{RemoteLibrary, remote_download, remote_project, require_remote};
use super::spawn::{ExitWatch, SlicerSpawner};
use crate::json_store::write_json_file;
use crate::library::DesktopSession;

/// The directory under the app's data directory that holds one subdirectory per launch.
pub const SLICER_SESSIONS_DIR: &str = "slicer-sessions";

/// The directory under the app's data directory a slicer is given as its **working directory**
/// when the launch built no directory of its own: `<data>/slicer-cwd`.
///
/// **This exists because a slicer resolved an export path against its process working directory
/// and wrote into the repository it was started from** (`AnycubicSlicerNext.exe --export-stl`
/// created `stl/obj_1_….stl` relative to the calling process's cwd). A GUI process inherits its
/// working directory from whatever launched it, so without this the child's cwd is whatever the
/// user's desktop happened to hand this process.
///
/// Not the data directory itself (it holds `state.json` and `slicers.json`), and not the sessions
/// directory (created lazily, so on a fresh profile every in-place launch would fail with `ENOENT`,
/// and a cwd-relative export landing loose there would be surfaced as an orphan session the user
/// never made). **Nothing sweeps this directory**: deleting a file a slicer wrote is D constraint
/// 10 territory. An improvement, not a solution: it bounds one measured mechanism.
pub const SLICER_CWD_DIR: &str = "slicer-cwd";

/// The record beside the launched copy.
pub const LAUNCH_RECORD_NAME: &str = "launch.json";

/// `<data>/slicer-sessions/<launchId>/launch.json`, written before the spawn.
///
/// **Self-describing on purpose, and it outlives a crash.** The sweep and reconcile rules have to
/// work on a directory found at the next app start with nothing else to explain it: the app that
/// created it may have been killed, the slicer may still have the file open, and the only thing
/// that can say which project a returning `.3mf` belongs to is this file beside it.
///
/// `launched_hash` is [`entry_hash`] of the file **as launched**: a hash over decompressed ZIP
/// entries, never a whole-file hash and never mtime, both of which were measured failing on all
/// four in-place savers.
///
/// There is deliberately no `version` key (see the Electron build's note): a launch record is
/// written once and only ever read, and every change has been additive. The four optional fields
/// exist because a field of the session list cannot be produced without them, and they are optional
/// on *read* because a record written before them is still understood: a session missing one
/// shows less, never something wrong.
///
/// Written only where there *is* a launch directory. The two in-place paths create nothing and
/// therefore record nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerLaunchRecord {
    pub launch_id: String,
    pub mode: SlicerLaunchMode,
    pub project_id: String,
    pub file_id: String,
    pub slicer_id: SlicerId,
    pub install_id: String,
    /// The basename inside the launch directory: the source's basename, kept deliberately.
    pub file_name: String,
    pub launched_hash: String,
    pub started_at: i64,
    /// Which library this launch came out of: `local:<folder>` or `remote:<origin>`. A `projectId`
    /// alone identifies nothing: ids are per-library and the sessions directory is per-machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    /// What the **source** classified as. `returnedAs` is measured against it.
    #[serde(default)]
    pub source_slicer: Option<SlicerId>,
    /// The size of the copy as handed over, which an in-place save overwrites and so destroys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_size_bytes: Option<i64>,
    /// [`entry_digests`] of the copy as handed over: what makes the reconcile's diff a diff
    /// against **what was launched** rather than against the library original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launched_entries: Option<BTreeMap<String, String>>,
    /// When the app removed the file this record describes, and the moment the 90 days start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swept_at: Option<i64>,
}

/// What a launch that made a directory hands to the session lifecycle.
pub struct LaunchedSession {
    pub launch_id: String,
    pub directory: PathBuf,
    /// The exact path handed to the slicer, inside `directory`.
    pub path: PathBuf,
    pub launched_hash: String,
    pub exit: Option<Box<dyn ExitWatch>>,
}

pub type OnLaunched = Arc<dyn Fn(LaunchedSession) + Send + Sync>;

pub struct SlicerLauncherOptions {
    /// `<data>/slicer-sessions`. Created lazily, only by a launch that needs a directory.
    pub sessions_dir: PathBuf,
    /// `<data>/slicer-cwd`, the working directory for a launch that builds no directory of its
    /// own. See [`SLICER_CWD_DIR`] for which directory this must be and which two it must not.
    pub scratch_cwd_dir: PathBuf,
    pub slicers: Arc<SlicersHost>,
    /// The library that is open **right now**, resolved per call rather than captured: the user
    /// can swap the folder without anything here being re-registered.
    pub session: Arc<dyn Fn() -> Option<DesktopSession> + Send + Sync>,
    /// Whether the shell is pointed at a remote server, where there is no local path to launch.
    pub is_remote: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The remote server, resolved per call for the same reason. A remote-mode launch that finds
    /// it `None` refuses rather than falling back to a library that is not there.
    pub remote: Arc<dyn Fn() -> Option<Arc<dyn RemoteLibrary>> + Send + Sync>,
    pub spawner: Arc<dyn SlicerSpawner>,
    /// Told about every launch that made a directory, so the watch can start before the user has
    /// looked at anything. A callback and not a reference: the watch is an *optimisation*, so this
    /// must go on working when nothing is listening.
    pub on_launched: Option<OnLaunched>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_launch_id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl SlicerLauncherOptions {
    pub fn new(
        sessions_dir: PathBuf,
        scratch_cwd_dir: PathBuf,
        slicers: Arc<SlicersHost>,
        session: Arc<dyn Fn() -> Option<DesktopSession> + Send + Sync>,
        is_remote: Arc<dyn Fn() -> bool + Send + Sync>,
        remote: Arc<dyn Fn() -> Option<Arc<dyn RemoteLibrary>> + Send + Sync>,
        spawner: Arc<dyn SlicerSpawner>,
    ) -> SlicerLauncherOptions {
        SlicerLauncherOptions {
            sessions_dir,
            scratch_cwd_dir,
            slicers,
            session,
            is_remote,
            remote,
            spawner,
            on_launched: None,
            now: Arc::new(now_ms),
            new_launch_id: Arc::new(spm_core::new_id),
        }
    }
}

/// What the notices function is told about the file, beyond its classification.
///
/// **`is_3mf` is here because the classification cannot carry it, and one measured row needs it.**
/// PrusaSlicer's four-way "Load project file" modal is a function of the `.3mf` *extension* and not
/// of the file's content: a three-entry archive holding no configuration still drew it. A
/// config-less `.3mf` and an `.stl` both classify `{ model, none }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchedSource {
    /// Of the **source**, which is what chose the strip set. Not of the copy that was handed over.
    pub classification: Classification,
    pub is_3mf: bool,
}

// ---------------------------------------------------------------------------------------------
// What the app may honestly say
// ---------------------------------------------------------------------------------------------

const PROMPT_BEFORE_LOADING: &str =
    "It will ask what to do with the file before opening it, and nothing loads until you answer.";
const INVALID_CONFIG_GEOMETRY_ONLY: &str =
    "It will say the config is invalid and load geometry only.";
const MAY_DISCARD_SILENTLY: &str = "It may discard the file without telling you.";
const VERSION_WARNING_AND_REWRITE: &str =
    "It will warn about the version and may rewrite print settings.";
const GEOMETRY_DATA_ONLY: &str =
    "It will show one informational notice, \"loading geometry data only\".";
const SLOW_TO_SHOW_A_WINDOW: &str =
    "A slicer can take up to a minute to show a window (measured 2 s to 35 s).";
const WIZARD_OR_UPDATE_PROMPT: &str =
    "It may open a configuration wizard or an update prompt in front of your model.";

/// The second half of Cura's round-trip limit: the half that is only true in remote mode. The
/// first half is the same in both modes and is said *before* the launch, by the page. What remote
/// mode adds is where that leaves the work: in a folder on this computer, which the server this
/// library lives on will never see. Keyed on `saves_in_place` rather than on the id, so it follows
/// the measured property.
const NOTHING_COMES_BACK_FROM_CURA: &str = "This slicer never saves back over the file it was given — its save is always a \"save as\" into a folder of its own on this computer. Nothing will come back here, so anything you want in this library has to be uploaded by hand afterwards.";

/// What the app knows will happen, from the triple *(slicer launched, what the source was, whether
/// the copy was stripped)*.
///
/// **A function of the triple, and not a lookup keyed by slicer** (spec 6.4): Bambu's modal depends
/// on whether the source was Bambu's *own* project and on whether the app stripped it, and
/// Anycubic's silent discard depends on the source being Bambu-lineage and on the copy **not**
/// having been stripped. The predicate everywhere is "a project this slicer did not author", not
/// "another lineage": the measurement behind Orca's rows is Orca opening a **Bambu** project (the
/// same lineage), and it drew both modals. Where prose and measurement disagree, the measurement
/// wins.
///
/// The last two rows apply to every launch. `remote` adds exactly one row.
pub fn notices(
    slicer_id: SlicerId,
    source: &LaunchedSource,
    stripped: bool,
    remote: bool,
) -> Vec<String> {
    let behaviour = slicer(slicer_id).behaviour;
    let authored = source.classification.slicer;
    let mut out: Vec<String> = Vec::new();

    // PrusaSlicer, any `.3mf`, stripped or not. Extension-driven and content-blind. Stripping
    // cannot remove it.
    if behaviour.always_prompts_on_3mf && source.is_3mf {
        out.push(PROMPT_BEFORE_LOADING.to_owned());
    }
    // Bambu, any `.3mf` it did not itself write, including one of its own that this app stripped,
    // because the modal fires on the *absence* of its own `project_settings.config`. That exact
    // pairing was inferred, not run.
    if behaviour.prompts_without_own_config
        && source.is_3mf
        && (stripped || authored != Some(slicer_id))
    {
        out.push(INVALID_CONFIG_GEOMETRY_ONLY.to_owned());
    }
    // Anycubic, an unstripped Bambu-lineage project: the silent-discard case. Anycubic is Bambu
    // lineage too and is deliberately not in the set: its own projects are outside the mechanism.
    if behaviour.discards_foreign_projects
        && !stripped
        && matches!(authored, Some(SlicerId::Bambu | SlicerId::Orca))
    {
        out.push(MAY_DISCARD_SILENTLY.to_owned());
    }
    // Orca, a project it did not author. Unstripped it warns about the version and rewrites print
    // settings; stripped, one informational notice remains.
    if slicer_id == SlicerId::Orca && authored.is_some_and(|authored| authored != slicer_id) {
        out.push(
            if stripped {
                GEOMETRY_DATA_ONLY
            } else {
                VERSION_WARNING_AND_REWRITE
            }
            .to_owned(),
        );
    }
    // Remote mode only. Locally the same Save-As lands somewhere on this machine that the next
    // rescan may well index.
    if remote && !behaviour.saves_in_place {
        out.push(NOTHING_COMES_BACK_FROM_CURA.to_owned());
    }
    out.push(SLOW_TO_SHOW_A_WINDOW.to_owned());
    out.push(WIZARD_OR_UPDATE_PROMPT.to_owned());
    out
}

// ---------------------------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------------------------

fn refusal_wording(reason: StripRefusalReason) -> &'static str {
    match reason {
        StripRefusalReason::Encrypted => "it is an encrypted archive",
        StripRefusalReason::Unreadable => "it could not be read as a 3MF archive",
        StripRefusalReason::ConfigurationLeftBehind => {
            "stripping it left slicer configuration behind"
        }
    }
}

/// What is spawned, and what had to be built to spawn it.
struct LaunchPlan {
    /// The exact path handed to the slicer.
    path: PathBuf,
    /// The launch directory, or `None` for the two paths that copy nothing.
    directory: Option<PathBuf>,
    stripped: bool,
    source: LaunchedSource,
}

/// The three facts a launch needs about its source, from whichever side of the wire holds them.
/// `abs_path` is the discriminator: `None` in remote mode because there genuinely is no local path.
struct SourceFile {
    name: String,
    /// What the index says the file is. Never a fresh read: the user chose from what they saw.
    indexed: Classification,
    abs_path: Option<PathBuf>,
}

/// What a partial download is called while it is still partial. Removed before the launch, so it
/// never reaches the "anything else in this directory is reported" rule, but if a crash does leave
/// one behind the suffix makes it legible as an interrupted download.
const DOWNLOAD_SUFFIX: &str = ".spm-download";

pub struct SlicerLauncher {
    options: SlicerLauncherOptions,
}

fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default()
}

fn base_name(name: &str) -> String {
    Path::new(name).file_name().map_or_else(
        || name.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn details(entries: &[(&str, Value)]) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert((*key).to_owned(), value.clone());
    }
    map
}

fn remove_directory(directory: &Path) {
    let _ = std::fs::remove_dir_all(directory);
}

impl SlicerLauncher {
    pub fn new(options: SlicerLauncherOptions) -> SlicerLauncher {
        SlicerLauncher { options }
    }

    /// Hands the file to a slicer, or refuses.
    ///
    /// The order of the steps is load-bearing, and it is the same in both modes. Everything that
    /// can refuse cheaply (the library or the server, the project, the file, the choice of
    /// product, whether that product can read this format at all, the install's path) runs
    /// **before** anything is written or downloaded, so a launch that was never going to work
    /// leaves no directory behind and costs no bytes over the wire. The copy or download is next,
    /// then the strip, then the record, then the spawn; the record is written before the spawn so a
    /// crash in between still leaves a directory that says what it is.
    pub fn open(
        &self,
        file_id: &str,
        project_id: &str,
        opts: &SlicerLaunchOptions,
    ) -> Result<SlicerLaunchDto, AppError> {
        let remote = (self.options.is_remote)();
        let source = if remote {
            self.remote_source(file_id, project_id)?
        } else {
            self.local_source(file_id, project_id)?
        };

        let config = self.options.slicers.get();
        let (slicer_id, why) =
            choose_slicer(opts, source.indexed.slicer, config.default_slicer_id)?;
        // Before the install lookup, and so before anything is written or downloaded: launching a
        // product that cannot read the format is the silent failure this refusal replaces.
        // Lowercased because a user's library really holds `Nozzle Wiper Guard.STEP`.
        //
        // It also runs before `prepare`, which refuses `as-is` for anything that is not a slicer
        // project, so a `.step` opened `as-is` in Cura reports the format rather than the mode.
        // Moving it later would put a refusal after a directory has been created and bytes copied.
        let extension = extension_of(&source.name);
        if (extension == ".step" || extension == ".stp") && !slicer(slicer_id).behaviour.opens_step
        {
            return Err(refuse_step_format(slicer_id, &extension));
        }
        let install_id = config
            .bindings
            .get(&slicer_id)
            .ok_or_else(|| unbound_install(slicer_id, &config))?;
        let (install, executable) = self.options.slicers.resolve_install(install_id)?;

        let launch_id = (self.options.new_launch_id)();
        let library = library_key_of(
            remote,
            (self.options.session)().as_ref(),
            (self.options.remote)()
                .as_deref()
                .map(RemoteLibrary::origin),
        );
        let directory = self.options.sessions_dir.join(&launch_id);
        let plan = match &source.abs_path {
            None => self.prepare_remote(opts.mode, &source, file_id, &directory)?,
            Some(abs_path) => self.prepare(
                opts.mode,
                &source.indexed,
                &source.name,
                abs_path,
                &directory,
            )?,
        };

        let mut launched_hash = String::new();
        if let Some(plan_directory) = &plan.directory {
            launched_hash = entry_hash(&plan.path)?;
            let record = SlicerLaunchRecord {
                launch_id: launch_id.clone(),
                mode: opts.mode,
                project_id: project_id.to_owned(),
                file_id: file_id.to_owned(),
                slicer_id,
                install_id: install.id.clone(),
                file_name: base_name(&plan.path.to_string_lossy()),
                launched_hash: launched_hash.clone(),
                started_at: (self.options.now)(),
                // `None` only where neither a folder nor a server is open, which no launch can
                // reach: both source paths above have already refused by then.
                library,
                source_slicer: plan.source.classification.slicer,
                source_size_bytes: Some(
                    i64::try_from(
                        std::fs::metadata(&plan.path)
                            .map_err(AppError::internal)?
                            .len(),
                    )
                    .unwrap_or(i64::MAX),
                ),
                // The itemised form of `launched_hash`, and the only thing that can still answer
                // "what did the slicer change?" once the slicer has saved back over the file.
                launched_entries: Some(entry_digests(&plan.path)?),
                swept_at: None,
            };
            write_record(&plan_directory.join(LAUNCH_RECORD_NAME), &record)?;
        }

        let child = self.spawn_or_clean(&executable, slicer_id, &plan)?;
        let pid = child.pid.map(i64::from);
        if let Some(plan_directory) = &plan.directory
            && let Some(on_launched) = &self.options.on_launched
        {
            on_launched(LaunchedSession {
                launch_id: launch_id.clone(),
                directory: plan_directory.clone(),
                path: plan.path.clone(),
                launched_hash,
                exit: child.exit,
            });
        }
        let mut all_notices: Vec<String> = Vec::new();
        all_notices.extend(why);
        all_notices.extend(notices(slicer_id, &plan.source, plan.stripped, remote));
        Ok(SlicerLaunchDto {
            launch_id,
            slicer_id,
            install_label: install.label,
            stripped: plan.stripped,
            notices: all_notices,
            pid,
        })
    }

    /// The file as the open library knows it.
    ///
    /// Ownership scoping is core's, not this file's: `get_project` joins against the owner and
    /// fails `NotFound` for a project the caller does not own, which is what makes a `projectId`
    /// from the untrusted side safe to accept. The file has to be *in* that project as well: the
    /// record and the reconcile both name the pair, and a mismatched pair would send a returning
    /// file to the wrong project.
    fn local_source(&self, file_id: &str, project_id: &str) -> Result<SourceFile, AppError> {
        let session = (self.options.session)()
            .ok_or_else(|| AppError::conflict("no library folder is open"))?;
        let detail = get_project(&session.lib, &session.ctx, project_id)?;
        let file = detail
            .files
            .iter()
            .find(|candidate| candidate.id == file_id)
            .ok_or_else(|| {
                AppError::not_found("that file is not in that project")
                    .with_details(details(&[("fileId", Value::from(file_id))]))
            })?;
        let resolved = resolve_file_path(&session.lib, &session.ctx, file_id)?;
        Ok(SourceFile {
            name: resolved.name,
            indexed: Classification {
                kind: file.kind,
                slicer: file.slicer,
                unreadable: false,
            },
            abs_path: Some(resolved.abs_path),
        })
    }

    /// The same three facts, out of the server, and the same ownership check.
    ///
    /// **This is why remote mode fetches the project and not only the file**: the API exposes no
    /// `GET /api/files/:id`, so there is nowhere else to learn a file's name, kind and slicer, and
    /// the pair check falls out of it for free. The name is validated rather than trusted: it
    /// arrives from another machine and is about to become a path this process writes to, and
    /// `validate::file_name` is the same rule the server accepts uploads under.
    fn remote_source(&self, file_id: &str, project_id: &str) -> Result<SourceFile, AppError> {
        let remote = require_remote((self.options.remote)())?;
        let files = remote_project(&*remote, project_id)?;
        let file = files
            .iter()
            .find(|candidate| candidate.id == file_id)
            .ok_or_else(|| {
                AppError::not_found("that file is not in that project")
                    .with_details(details(&[("fileId", Value::from(file_id))]))
            })?;
        if spm_core::validate::file_name(&file.name).is_err() {
            return Err(AppError::validation(
                "the server named that file in a way this app cannot use",
            )
            .with_details(details(&[("fileId", Value::from(file_id))])));
        }
        Ok(SourceFile {
            name: file.name.clone(),
            indexed: Classification {
                kind: file.kind,
                slicer: file.slicer,
                unreadable: false,
            },
            abs_path: None,
        })
    }

    /// Downloads the file into a launch directory and builds what the slicer is handed.
    ///
    /// **There is no in-place branch here, and that is the whole of remote mode.** The download
    /// lands beside its final name rather than on it, and is renamed or stripped into place: a
    /// strip reads its input and writes its output, so it cannot be its own destination; and a
    /// download interrupted halfway would otherwise leave a truncated file under the name the
    /// record is about to claim is complete.
    fn prepare_remote(
        &self,
        mode: SlicerLaunchMode,
        source: &SourceFile,
        file_id: &str,
        directory: &Path,
    ) -> Result<LaunchPlan, AppError> {
        if mode == SlicerLaunchMode::AsIs && source.indexed.kind != FileKind::SlicerProject {
            return Err(refuse_not_a_project(source.indexed.kind));
        }
        let file_name = base_name(&source.name);
        refuse_record_name(&file_name)?;

        let remote = require_remote((self.options.remote)())?;
        let target = directory.join(&file_name);
        let download = directory.join(format!("{file_name}{DOWNLOAD_SUFFIX}"));
        std::fs::create_dir_all(directory).map_err(AppError::internal)?;
        if let Err(error) = remote_download(&*remote, file_id, &download) {
            // Nothing has been handed to anything and no record exists, so this directory can
            // explain nothing and no slicer can put anything back into it, which is what keeps
            // removing it compatible with constraint 10.
            remove_directory(directory);
            return Err(error);
        }

        let extension = extension_of(&file_name);
        // `as-is` means the user's own project, unchanged: the mode exists to hand over exactly
        // what is in the library. `new-project` strips a `.3mf`, and `strip3mf` writes a verbatim
        // copy where there was nothing to strip, so the one call covers both halves.
        if mode == SlicerLaunchMode::AsIs || extension != ".3mf" {
            if let Err(error) = std::fs::rename(&download, &target) {
                remove_directory(directory);
                return Err(AppError::internal(error));
            }
            return Ok(LaunchPlan {
                path: target.clone(),
                directory: Some(directory.to_path_buf()),
                stripped: false,
                source: LaunchedSource {
                    classification: classify_file(&target),
                    is_3mf: extension == ".3mf",
                },
            });
        }
        match strip3mf(&download, &target) {
            Ok(result) => {
                let _ = std::fs::remove_file(&download);
                Ok(LaunchPlan {
                    path: target,
                    directory: Some(directory.to_path_buf()),
                    stripped: result.stripped,
                    source: LaunchedSource {
                        classification: result.classification,
                        is_3mf: true,
                    },
                })
            }
            Err(error) => {
                remove_directory(directory);
                Err(refuse_strip(error, &source.name))
            }
        }
    }

    /// Builds, or deliberately does not build, the file the slicer is handed.
    ///
    /// The `.3mf` branch is decided on the **extension**, not on the classification, and that is
    /// the whole of constraint 8 in one line: a config-less `.3mf` classifies exactly as an `.stl`
    /// does, so a classification-driven branch would launch it in place and offer the slicer's
    /// project over the user's mesh.
    fn prepare(
        &self,
        mode: SlicerLaunchMode,
        indexed: &Classification,
        name: &str,
        abs_path: &Path,
        directory: &Path,
    ) -> Result<LaunchPlan, AppError> {
        let extension = extension_of(name);
        if mode == SlicerLaunchMode::AsIs {
            // Opening a file "as it is" only means anything for a file that *is* a slicer project.
            // For a mesh it would launch the mesh in place; for anything else there is nothing for
            // a slicer to open. The other path takes both.
            if indexed.kind != FileKind::SlicerProject {
                return Err(refuse_not_a_project(indexed.kind));
            }
            // The classification the app already holds, rather than a second read of a file
            // nothing on this path is about to touch.
            return Ok(LaunchPlan {
                path: abs_path.to_path_buf(),
                directory: None,
                stripped: false,
                source: LaunchedSource {
                    classification: *indexed,
                    is_3mf: extension == ".3mf",
                },
            });
        }

        if extension == ".stl" || extension == ".obj" {
            return Ok(LaunchPlan {
                path: abs_path.to_path_buf(),
                directory: None,
                stripped: false,
                source: LaunchedSource {
                    classification: classify_file(abs_path),
                    is_3mf: false,
                },
            });
        }

        // `base_name`, not `name`: the copy must land inside the launch directory whatever the row
        // in the database says. Kept otherwise verbatim, because the basename is what four of five
        // slicers propose on the first save and what Cura carries into its Save-As dialog.
        let file_name = base_name(name);
        refuse_record_name(&file_name)?;
        std::fs::create_dir_all(directory).map_err(AppError::internal)?;
        let copy = directory.join(&file_name);
        if extension != ".3mf" {
            if let Err(error) = std::fs::copy(abs_path, &copy) {
                remove_directory(directory);
                return Err(AppError::internal(error));
            }
            return Ok(LaunchPlan {
                path: copy,
                directory: Some(directory.to_path_buf()),
                stripped: false,
                source: LaunchedSource {
                    classification: classify_file(abs_path),
                    is_3mf: false,
                },
            });
        }
        // Always writes the output (a verbatim copy where there was nothing to strip), so this one
        // call covers both halves of "the stripped copy where there is something to strip, a
        // verbatim copy where there is not".
        match strip3mf(abs_path, &copy) {
            Ok(result) => Ok(LaunchPlan {
                path: copy,
                directory: Some(directory.to_path_buf()),
                stripped: result.stripped,
                source: LaunchedSource {
                    classification: result.classification,
                    is_3mf: true,
                },
            }),
            Err(error) => {
                // Nothing was handed to anything, so there is nothing this directory could ever
                // explain and nothing a slicer could put back into it. That is what makes removing
                // it here compatible with constraint 10, which is about directories a slicer has
                // *seen*.
                remove_directory(directory);
                Err(refuse_strip(error, name))
            }
        }
    }

    /// The one call that starts a process. A failed spawn takes its launch directory with it.
    ///
    /// **The child's working directory is set here and never inherited** (see
    /// [`SLICER_CWD_DIR`]): the launch directory when the plan built one, so a cwd-relative write
    /// lands beside the copy where the session scan can see it, and the scratch directory when it
    /// did not. The scratch directory is made *here*, immediately before the spawn that needs it:
    /// not once at construction, so a profile where the user deleted it between launches still
    /// works.
    fn spawn_or_clean(
        &self,
        executable: &str,
        slicer_id: SlicerId,
        plan: &LaunchPlan,
    ) -> Result<super::spawn::SpawnedSlicer, AppError> {
        let result = (|| {
            let cwd = plan
                .directory
                .clone()
                .unwrap_or_else(|| self.options.scratch_cwd_dir.clone());
            if plan.directory.is_none() {
                std::fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
            }
            let args = slicer(slicer_id).argv(&plan.path.to_string_lossy());
            self.options.spawner.spawn(executable, &args, &cwd)
        })();
        result.map_err(|cause| {
            if let Some(directory) = &plan.directory {
                remove_directory(directory);
            }
            let mut error = AppError::new(
                AppErrorCode::Internal,
                format!("could not start {}", slicer(slicer_id).display_name),
            )
            .with_details(details(&[("cause", Value::from(cause.clone()))]));
            error.cause = Some(cause);
            error
        })
    }
}

fn write_record(path: &Path, record: &SlicerLaunchRecord) -> Result<(), AppError> {
    let value = serde_json::to_value(record).map_err(AppError::internal)?;
    write_json_file(path, &value).map_err(AppError::internal)
}

/// Which library a launch belongs to, as one comparable string: `local:<resolved folder>` or
/// `remote:<origin>`. The prefix is not decoration: without it a server called `C:\models` and a
/// folder of that name would compare equal.
///
/// **Compared with [`same_library`], never with `==`.** Windows paths are case-insensitive, and
/// case is not the only way one folder gets two spellings (a junction, an 8.3 short name, a UNC
/// alias): the folder is canonicalised first, and only when that fails is it merely made absolute.
/// A library folder that has been *moved* since the launch resolves to nothing and its sessions are
/// listed nowhere; nothing is deleted and moving the folder back recovers them.
///
/// `None` when nothing is open. Callers treat that as "cannot tell" rather than "foreign".
pub fn library_key_of(
    is_remote: bool,
    session: Option<&DesktopSession>,
    remote_origin: Option<&str>,
) -> Option<String> {
    if is_remote {
        return remote_origin.map(|origin| format!("remote:{origin}"));
    }
    session.map(|session| format!("local:{}", canonical_dir(session.lib.dir())))
}

/// The folder as the filesystem names it, or the plain resolution when it cannot be reached.
pub fn canonical_dir(dir: &Path) -> String {
    match std::fs::canonicalize(dir) {
        Ok(canonical) => strip_verbatim_prefix(&canonical.to_string_lossy()),
        Err(_) => std::path::absolute(dir)
            .unwrap_or_else(|_| dir.to_path_buf())
            .to_string_lossy()
            .into_owned(),
    }
}

/// Windows canonicalisation answers `\\?\C:\x` and `\\?\UNC\server\share`; the key is the form a
/// user and a record would write.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_owned();
    }
    path.to_owned()
}

/// Whether two library keys name the same library, or whether either is simply unknown. Unknown
/// compares *equal* on purpose: a record written before the field existed has no library, and
/// hiding every one of those from the session list would delete the user's memory of unfinished
/// work to fix a labelling problem.
pub fn same_library(a: Option<&str>, b: Option<&str>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return true;
    };
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// `as-is` needs a slicer project. Shared, because both modes refuse it with the same sentence.
fn refuse_not_a_project(kind: FileKind) -> AppError {
    AppError::validation(
        "only a slicer project can be opened as it is; start a new slicer project from this file instead",
    )
    .with_details(details(&[("kind", Value::from(kind.as_str()))]))
}

/// A STEP file handed to a product that cannot read one.
///
/// **An error, not a `notices()` sentence.** Notices say what will happen during a launch that is
/// going ahead; this one does not. Warning and launching anyway is the silent-discard case with
/// extra words: Cura handed a STEP shows one window titled `Untitled`, no dialog, and a warning in
/// a log file the user will never open. The alternatives are **read from the registry, not spelled
/// here**. It offers no conversion advice: this app has no converter.
fn refuse_step_format(slicer_id: SlicerId, extension: &str) -> AppError {
    let capable: Vec<&str> = SLICER_IDS
        .into_iter()
        .filter(|id| slicer(*id).behaviour.opens_step)
        .map(|id| slicer(id).display_name)
        .collect();
    AppError::validation(format!(
        "{} cannot open STEP files. Choose one of {} instead.",
        slicer(slicer_id).display_name,
        capable.join(", ")
    ))
    .with_details(details(&[
        ("slicerId", Value::from(slicer_id.as_str())),
        ("extension", Value::from(extension)),
    ]))
}

/// The one basename a launch directory's file may not have: `launch.json` is written into that
/// directory a moment later, so a source of that name would be overwritten by its own record.
/// Refused rather than renamed: the basename is load-bearing on this path.
fn refuse_record_name(file_name: &str) -> Result<(), AppError> {
    if file_name.to_lowercase() != LAUNCH_RECORD_NAME {
        return Ok(());
    }
    Err(AppError::validation(format!(
        "a file called {LAUNCH_RECORD_NAME} cannot be prepared for a new project, because the app writes a record of that name beside the copy it hands over"
    ))
    .with_details(details(&[("fileName", Value::from(file_name))])))
}

/// Which product to launch, and whether the user should be told how it was decided.
///
/// An explicit choice always wins. Failing that, `as-is` uses the slicer the file itself names
/// (the whole point of the path) and both modes fall back to the configured default.
/// `new-project` deliberately does *not* consult the file's own slicer: the target of that path is
/// usually not the product that wrote the file.
fn choose_slicer(
    opts: &SlicerLaunchOptions,
    file_slicer: Option<SlicerId>,
    default_slicer_id: Option<SlicerId>,
) -> Result<(SlicerId, Option<String>), AppError> {
    if let Some(slicer_id) = opts.slicer_id {
        return Ok((slicer_id, None));
    }
    if opts.mode == SlicerLaunchMode::AsIs
        && let Some(slicer_id) = file_slicer
    {
        return Ok((slicer_id, None));
    }
    let Some(default_slicer_id) = default_slicer_id else {
        return Err(AppError::conflict(if opts.mode == SlicerLaunchMode::AsIs {
            "this file does not say which slicer wrote it, and no default slicer is set"
        } else {
            "no slicer was chosen, and no default slicer is set"
        }));
    };
    let chosen = slicer(default_slicer_id).display_name;
    Ok((
        default_slicer_id,
        Some(if opts.mode == SlicerLaunchMode::AsIs {
            format!(
                "This file does not say which slicer wrote it, so your default ({chosen}) was used."
            )
        } else {
            format!("No slicer was chosen, so your default ({chosen}) was used.")
        }),
    ))
}

/// A product with no install bound to it.
///
/// **It names the choice and does not make it.** A product with exactly one install is bound
/// automatically when it is detected, so reaching here with candidates means either that there are
/// none, or that the user has more than one and has not said which: preferring the newer of two
/// Curas is precisely the guess `/settings/slicers` exists to stop the app making.
fn unbound_install(slicer_id: SlicerId, config: &SlicerConfigDto) -> AppError {
    let product = slicer(slicer_id).display_name;
    let candidates: Vec<&str> = config
        .installs
        .iter()
        .filter(|install| {
            install.slicer_id == slicer_id && install.state != SlicerInstallState::Missing
        })
        .map(|install| install.label.as_str())
        .collect();
    let extra = details(&[("slicerId", Value::from(slicer_id.as_str()))]);
    match candidates.as_slice() {
        [] => AppError::not_found(format!(
            "{product} is not set up on this machine; add it under Settings, Slicers"
        ))
        .with_details(extra),
        // Not a choice, so not phrased as one, and not bound automatically either: reaching here
        // with one usable install means the user unbound it, or a second install went missing
        // after they were asked to choose; writing a binding out of a launch would undo the first
        // of those silently, on a code path whose job is to start a process.
        [label] => AppError::conflict(format!(
            "{product} is installed ({label}) but not chosen for launching; pick it under Settings, Slicers"
        ))
        .with_details(extra),
        labels => AppError::conflict(format!(
            "this machine has {} installs of {product} ({}); choose which one to launch under Settings, Slicers",
            labels.len(),
            labels.join(", ")
        ))
        .with_details(extra),
    }
}

/// Turns a `strip3mf` refusal into the sentence the user gets (constraint 9).
///
/// It names which of the three problems it was, because they have three different next moves, and
/// it says that the other path is still open: the tempting silent fallback from here is to launch
/// the original, and for Anycubic that fallback is the empty plate.
fn refuse_strip(error: AppError, name: &str) -> AppError {
    // Not a strip refusal at all (a filesystem failure, say): it travels unchanged rather than
    // being dressed up as one of three reasons it is not.
    let Some(reason) = strip_refusal_reason(&error) else {
        return error;
    };
    AppError::validation(format!(
        "{name} could not be prepared for a new project because {}. Opening it as it is, without stripping, is still available.",
        refusal_wording(reason)
    ))
    .with_details(details(&[("reason", Value::from(reason.as_str()))]))
}
