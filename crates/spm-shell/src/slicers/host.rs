//! The one thing that owns `slicers.json`, and the only place its lifecycle lives.
//!
//! Everything the web app can ask about slicer *configuration* arrives here. Slicer configuration
//! is a property of *this machine*, not of whichever library is open, so none of it depends on
//! the mode: it works the same in local and in remote mode.
//!
//! **What the web app may name.** Nothing here takes a filesystem path from the page.
//! [`SlicersHost::add_manual`] takes a `SlicerId` and nothing else; the path comes from a native
//! dialog this process owns, exactly as folder picking does. The worst a hostile page can do on
//! these commands is ask for the dialog (one at a time, below), name an install id that does not
//! exist (`NotFound`), or reset a file in the app's own data directory. It cannot name a path, and
//! so cannot choose what a later launch spawns.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use spm_core::dto::{SlicerConfigDto, SlicerId};
use spm_core::error::DETECTION_FAILED;
use spm_core::{AppError, AppErrorCode};

use super::config::{
    ConfigRead, ResolveIo, ResolveOutcome, SLICERS_FILE_NAME, SlicersConfig, StoredInstall,
    auto_bind, empty_config, merge_detected, read_config, resolve_install_path, to_config_dto,
    write_config,
};
use super::detect::{
    DetectIo, DetectedInstall, FsDetectIo, InstallOrigin, RunDetection, detect_installs,
    is_regular_file, powershell_runner,
};
use super::registry::slicer;
use crate::diag;
use crate::sync::SingleFlight;

/// Asks the user for an executable. `None` when they cancel, which is not an error.
pub type ExecutablePicker = Arc<dyn Fn(SlicerId) -> Option<String> + Send + Sync>;

type Warn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct SlicersHostOptions {
    /// `slicers.json` under the app's data directory.
    pub config_file: PathBuf,
    /// The detection subprocess. Injected; see [`RunDetection`].
    pub run: RunDetection,
    /// The filesystem question the **parse** asks, so a fixture needs no real executables.
    ///
    /// Deliberately *not* the same seam as `is_regular_file` below: this one exists so a document
    /// describing another machine can be parsed on this one, and is a stub in almost every test.
    /// The other is this host's view of the real filesystem, and stubbing it by accident would make
    /// a manual entry or a pre-launch check pass for a file that is not there.
    pub io: Arc<dyn DetectIo>,
    /// Whether a path is a regular file that exists: the check `add_manual` and `resolve_install`
    /// make, on the machine the app is running on.
    pub is_regular_file: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// The native file dialog. Defaulted to a cancel rather than to a stub, so a caller that forgets
    /// to wire it cannot silently be more permissive than the real shell.
    pub pick_executable: ExecutablePicker,
    /// Whether detection can run at all (Windows). Injectable so the off-Windows branch is driven.
    pub detection_supported: bool,
    /// Epoch milliseconds, injected so `added_at` is assertable.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Where warnings go (stderr by default).
    pub warn: Warn,
}

impl SlicersHostOptions {
    /// The real subprocess, filesystem and clock. Detection runs on Windows only.
    pub fn new(config_file: PathBuf) -> SlicersHostOptions {
        SlicersHostOptions {
            config_file,
            run: powershell_runner(),
            io: Arc::new(FsDetectIo),
            is_regular_file: Arc::new(|path: &str| is_regular_file(path)),
            pick_executable: Arc::new(|_| None),
            detection_supported: cfg!(windows),
            now: Arc::new(now_ms),
            warn: Arc::new(diag::warn),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

pub struct SlicersHost {
    options: SlicersHostOptions,
    /// The executable dialog that is already open, so a loop cannot stack native dialogs: the page
    /// can call this as fast as it likes and dialog fatigue is precisely the failure a native
    /// dialog exists to resist.
    picking: SingleFlight<Result<Option<SlicerConfigDto>, AppError>>,
    /// Which slicer `picking` is asking about, so a second caller is answered about its own.
    picking_for: Mutex<Option<SlicerId>>,
}

fn not_found(message: &str) -> AppError {
    AppError::not_found(message)
}

impl SlicersHost {
    pub fn new(options: SlicersHostOptions) -> SlicersHost {
        SlicersHost {
            options,
            picking: SingleFlight::default(),
            picking_for: Mutex::new(None),
        }
    }

    /// Whether detection can run at all. False off Windows; manual entry is then the only way in.
    pub fn detection_supported(&self) -> bool {
        self.options.detection_supported
    }

    /// What is configured right now. Reads the file every time: it is small and hand-editable.
    pub fn get(&self) -> SlicerConfigDto {
        to_config_dto(&self.load().config, self.detection_supported())
    }

    /// Runs detection and merges what it found into what is already there.
    ///
    /// Off Windows this is a read: there is no mechanism to run, and inventing one would be
    /// designing macOS and Linux detection by accident.
    pub fn scan(&self) -> Result<SlicerConfigDto, AppError> {
        if !self.detection_supported() {
            return Ok(self.get());
        }
        let ConfigRead {
            config, writable, ..
        } = self.load();
        // Before the subprocess, not after it: a scan against a file written by a newer build
        // would otherwise spend 880 ms to arrive at a refusal that was already knowable.
        if !writable {
            return self.save(&config, writable);
        }
        let detected = self.detect()?;
        self.save(
            &merge_detected(&config, &detected, (self.options.now)()),
            writable,
        )
    }

    /// One detection run, with its failures given an identity the page can act on.
    ///
    /// A timed-out PowerShell, a `powershell.exe` that is not where it should be and an output
    /// overflow all arrive as a plain error. Left alone they would reach the page as `Internal`
    /// with nothing it can phrase; `Internal` is still the code (none of the others is honest about
    /// a subprocess that did not run) and `details.reason` is what makes it usable. The underlying
    /// message goes in `details.cause` for the log and a bug report.
    fn detect(&self) -> Result<Vec<DetectedInstall>, AppError> {
        let mut warn = |message: &str| (self.options.warn)(message);
        detect_installs(&self.options.run, &*self.options.io, &mut warn).map_err(|cause| {
            (self.options.warn)(&format!("slicer detection could not run: {cause}"));
            let mut details = Map::new();
            details.insert("reason".into(), Value::from(DETECTION_FAILED));
            details.insert("cause".into(), Value::from(cause.clone()));
            let mut error = AppError::new(
                AppErrorCode::Internal,
                "could not look for slicers installed on this machine",
            )
            .with_details(details);
            error.cause = Some(cause);
            error
        })
    }

    /// Adds an install the user names in a native dialog.
    ///
    /// Its path is used **verbatim**: the user chose it, so the `exe_name` check that guards a
    /// `DisplayIcon` does not apply (a vendor's icon field is not a promise about which binary to
    /// run, and a person pointing at a portable build is). The file-exists check still applies.
    ///
    /// `Ok(None)` when the user cancels: not an error, exactly like folder picking.
    pub fn add_manual(&self, slicer_id: SlicerId) -> Result<Option<SlicerConfigDto>, AppError> {
        // One dialog at a time. A second caller asking about the *same* slicer gets the in-flight
        // answer; one asking about a different slicer is refused rather than handed the answer to a
        // question it did not ask.
        {
            let mut picking_for = self.picking_for.lock().unwrap_or_else(|e| e.into_inner());
            match *picking_for {
                Some(other) if other != slicer_id => {
                    return Err(AppError::conflict(
                        "a slicer executable is already being chosen",
                    ));
                }
                Some(_) => {}
                None => *picking_for = Some(slicer_id),
            }
        }
        self.picking.run(|| {
            let result = self.add_manual_inner(slicer_id);
            *self.picking_for.lock().unwrap_or_else(|e| e.into_inner()) = None;
            result
        })
    }

    fn add_manual_inner(&self, slicer_id: SlicerId) -> Result<Option<SlicerConfigDto>, AppError> {
        let Some(path) = (self.options.pick_executable)(slicer_id).filter(|path| !path.is_empty())
        else {
            return Ok(None);
        };
        if !(self.options.is_regular_file)(&path) {
            return Err(not_found("that file is not there any more"));
        }
        let ConfigRead {
            config, writable, ..
        } = self.load();
        // One id, spelled twice: the origin id is the identity and the install id is the identity
        // with its origin spelled in front.
        let generated = spm_core::new_id();
        let install = StoredInstall {
            id: format!("manual:{generated}"),
            slicer_id,
            label: format!("{} (added by hand)", slicer(slicer_id).display_name),
            origin: InstallOrigin::Manual { id: generated },
            // Never from the executable: Cura's and Orca's version resources are empty.
            version: None,
            path_hint: path,
            added_at: (self.options.now)(),
            missing: false,
        };
        let mut installs = config.installs.clone();
        installs.push(install);
        // The same rule a scan follows: bind what there is no choice about, re-point nothing.
        // Only for this product: adding Cura by hand must not quietly re-bind a product the user
        // deliberately unbound.
        let mut bindings = config.bindings.clone();
        if let std::collections::btree_map::Entry::Vacant(vacant) = bindings.entry(slicer_id)
            && let Some(only) = auto_bind(&BTreeMap::new(), &installs).remove(&slicer_id)
        {
            vacant.insert(only);
        }
        self.save(
            &SlicersConfig {
                installs,
                bindings,
                ..config
            },
            writable,
        )
        .map(Some)
    }

    /// Forgets an install.
    ///
    /// A binding to it goes with it. `default_slicer_id` is *not* cleared: it names a product, and
    /// the user may bind that product to something else in the next click. A detected install
    /// removed this way comes back on the next scan, deliberately: **it is not a way to unbind
    /// anything**; that is what `bind(slicer, None)` is for.
    pub fn remove(&self, install_id: &str) -> Result<SlicerConfigDto, AppError> {
        let ConfigRead {
            config, writable, ..
        } = self.load();
        if !config
            .installs
            .iter()
            .any(|install| install.id == install_id)
        {
            return Err(not_found("no such slicer install"));
        }
        let mut bindings = config.bindings.clone();
        bindings.retain(|_, bound| bound != install_id);
        let installs = config
            .installs
            .iter()
            .filter(|install| install.id != install_id)
            .cloned()
            .collect();
        self.save(
            &SlicersConfig {
                installs,
                bindings,
                ..config
            },
            writable,
        )
    }

    /// Points a product at one of its installs: the one decision D asks the user to make.
    /// `None` unbinds, by *removal* from the map and not by a `null` in it, because every reader
    /// treats "absent" as unbound.
    pub fn bind(
        &self,
        slicer_id: SlicerId,
        install_id: Option<&str>,
    ) -> Result<SlicerConfigDto, AppError> {
        let ConfigRead {
            mut config,
            writable,
            ..
        } = self.load();
        match install_id {
            None => {
                config.bindings.remove(&slicer_id);
            }
            Some(install_id) => {
                let install = config
                    .installs
                    .iter()
                    .find(|candidate| candidate.id == install_id)
                    .ok_or_else(|| not_found("no such slicer install"))?;
                if install.slicer_id != slicer_id {
                    return Err(AppError::validation(format!(
                        "that install is {}, not {}",
                        install.slicer_id.as_str(),
                        slicer_id.as_str()
                    )));
                }
                config.bindings.insert(slicer_id, install_id.to_owned());
            }
        }
        self.save(&config, writable)
    }

    /// The product a file that names no slicer is opened with, or `None` for none. Not gated on
    /// there being a binding for it: the default is a statement of preference and the bindings are
    /// a statement of fact about this machine.
    pub fn set_default(&self, slicer_id: Option<SlicerId>) -> Result<SlicerConfigDto, AppError> {
        let ConfigRead {
            mut config,
            writable,
            ..
        } = self.load();
        config.default_slicer_id = slicer_id;
        self.save(&config, writable)
    }

    /// Throws the file away and starts again: the only operation that writes over a file this
    /// build cannot read, and the only way out of that state. A user action by construction.
    pub fn reset_config(&self) -> Result<SlicerConfigDto, AppError> {
        let fresh = empty_config();
        write_config(&self.options.config_file, &fresh).map_err(AppError::internal)?;
        Ok(to_config_dto(&fresh, self.detection_supported()))
    }

    /// The path to spawn for an install, checked and re-resolved if need be.
    ///
    /// An error rather than a null path: every caller is about to spawn, and there is nothing
    /// useful to do with "no path" other than tell the user. `NotFound` carries the install id.
    pub fn resolve_install(&self, install_id: &str) -> Result<(StoredInstall, String), AppError> {
        let ConfigRead {
            config, writable, ..
        } = self.load();
        let io = HostResolveIo { host: self };
        let result = resolve_install_path(&config, install_id, &io)?;
        if result.changed && writable {
            write_config(&self.options.config_file, &result.config).map_err(AppError::internal)?;
        }
        match result.outcome {
            ResolveOutcome::Found { path } => {
                let install = result
                    .config
                    .installs
                    .iter()
                    .find(|candidate| candidate.id == install_id)
                    .cloned()
                    .ok_or_else(|| not_found("no such slicer install"))?;
                Ok((install, path))
            }
            outcome => {
                let mut details = Map::new();
                details.insert("installId".into(), Value::from(install_id));
                Err(not_found(if outcome == ResolveOutcome::Unknown {
                    "no such slicer install"
                } else {
                    "that slicer is no longer installed where it was"
                })
                .with_details(details))
            }
        }
    }

    fn load(&self) -> ConfigRead {
        let read = read_config(&self.options.config_file);
        for warning in &read.warnings {
            (self.options.warn)(warning);
        }
        read
    }

    /// Writes, unless the file on disk was written by a build this one cannot read. The refusal is
    /// an error the page can switch on rather than a silent no-op: a settings page that showed a
    /// binding it had not stored would be worse than one that says the file has to be reset first.
    fn save(&self, config: &SlicersConfig, writable: bool) -> Result<SlicerConfigDto, AppError> {
        if !writable {
            return Err(AppError::conflict(format!(
                "{SLICERS_FILE_NAME} was written by a newer version of this app; reset it to continue"
            )));
        }
        write_config(&self.options.config_file, config).map_err(AppError::internal)?;
        Ok(to_config_dto(config, self.detection_supported()))
    }
}

struct HostResolveIo<'a> {
    host: &'a SlicersHost,
}

impl ResolveIo for HostResolveIo<'_> {
    fn is_regular_file(&self, path: &str) -> bool {
        (self.host.options.is_regular_file)(path)
    }

    /// One detection run, looked up by origin key. Off Windows there is nothing to run.
    ///
    /// **A detection that fails is not an install that is gone**: `Ok(None)` means "the mechanism
    /// ran and this install was not in what it found", which marks the install `missing` and writes
    /// that to disk. A PowerShell that timed out has found nothing about anything, so the error is
    /// let out and `slicers.json` stays exactly as it was.
    fn reresolve(&self, install: &StoredInstall) -> Result<Option<String>, AppError> {
        if !self.host.detection_supported() {
            return Ok(None);
        }
        let detected = self.host.detect()?;
        Ok(detected
            .into_iter()
            .find(|candidate| candidate.id == install.id)
            .map(|candidate| candidate.path))
    }
}
