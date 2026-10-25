//! The slicer subsystem, assembled: the configuration host, the launcher and the session
//! lifecycle, wired to the shell's mode and to each other.
//!
//! Slicer configuration is a property of *this machine*, so none of it depends on the mode: it
//! works the same in local and in remote mode (D 8.2). What does depend on the mode is the launch
//! (a local path versus a download through the proxy) and the session import (core versus the
//! proxy), and those read the mode **per call** through the closures here, so the user can switch
//! folder or server without anything being re-registered.

use std::path::PathBuf;
use std::sync::Arc;

use spm_core::AppError;
use spm_core::dto::{
    DiscardedSessionsDto, FileDto, SlicerConfigDto, SlicerId, SlicerLaunchDto, SlicerLaunchOptions,
    SlicerSessionDto,
};

use super::api::SlicerBackend;
use super::config::SLICERS_FILE_NAME;
use super::host::{ExecutablePicker, SlicersHost, SlicersHostOptions};
use super::launch::{SLICER_CWD_DIR, SLICER_SESSIONS_DIR, SlicerLauncher, SlicerLauncherOptions};
use super::remote_files::{ProxyRemote, RemoteLibrary};
use super::sessions::{SessionAction, SlicerSessions, SlicerSessionsOptions};
use super::spawn::{ProcessSpawner, SlicerSpawner};
use crate::library::DesktopSession;
use crate::shell::{ActiveMode, Shell};

type SessionSource = Arc<dyn Fn() -> Option<DesktopSession> + Send + Sync>;
/// A change to make to a subsystem's options before it is built (tests drive the clock, the
/// timers and the ids through this; the app leaves it `None`).
type Tune<T> = Option<Box<dyn FnOnce(&mut T)>>;
type ModeSource = Arc<dyn Fn() -> bool + Send + Sync>;
type RemoteSource = Arc<dyn Fn() -> Option<Arc<dyn RemoteLibrary>> + Send + Sync>;

/// Where the pieces are, as closures over whatever supplies them.
pub struct SlicerServicesParts {
    /// The app's data directory: `slicers.json`, `slicer-sessions/` and `slicer-cwd/` live here.
    pub data_dir: PathBuf,
    pub host: SlicersHostOptions,
    pub session: SessionSource,
    pub is_remote: ModeSource,
    pub remote: RemoteSource,
    pub spawner: Arc<dyn SlicerSpawner>,
    /// Changes the sessions' clock, timers and watch (tests); `None` keeps the real ones.
    pub tune_sessions: Tune<SlicerSessionsOptions>,
    /// Changes the launcher's clock and ids (tests); `None` keeps the real ones.
    pub tune_launcher: Tune<SlicerLauncherOptions>,
}

pub struct SlicerServices {
    host: Arc<SlicersHost>,
    launcher: SlicerLauncher,
    sessions: Arc<SlicerSessions>,
}

impl SlicerServices {
    pub fn new(parts: SlicerServicesParts) -> Arc<SlicerServices> {
        let sessions_dir = parts.data_dir.join(SLICER_SESSIONS_DIR);
        let scratch = parts.data_dir.join(SLICER_CWD_DIR);
        let host = Arc::new(SlicersHost::new(parts.host));

        let mut session_options = SlicerSessionsOptions::new(
            sessions_dir.clone(),
            Arc::clone(&parts.session),
            Arc::clone(&parts.is_remote),
            Arc::clone(&parts.remote),
        );
        if let Some(tune) = parts.tune_sessions {
            tune(&mut session_options);
        }
        let sessions = SlicerSessions::new(session_options);

        let mut launcher_options = SlicerLauncherOptions::new(
            sessions_dir,
            scratch,
            Arc::clone(&host),
            parts.session,
            parts.is_remote,
            parts.remote,
            parts.spawner,
        );
        let watching = Arc::clone(&sessions);
        launcher_options.on_launched = Some(Arc::new(move |launch| watching.track(launch)));
        if let Some(tune) = parts.tune_launcher {
            tune(&mut launcher_options);
        }
        Arc::new(SlicerServices {
            host,
            launcher: SlicerLauncher::new(launcher_options),
            sessions,
        })
    }

    /// The real thing for the desktop app: the shell's mode, the real process spawner, the real
    /// timers and watch. `pick_executable` is the native file dialog.
    pub fn for_shell(
        shell: &Arc<Shell>,
        data_dir: PathBuf,
        handle: tokio::runtime::Handle,
        pick_executable: ExecutablePicker,
    ) -> Arc<SlicerServices> {
        let mut host = SlicersHostOptions::new(data_dir.join(SLICERS_FILE_NAME));
        host.pick_executable = pick_executable;
        let for_session = Arc::clone(shell);
        let for_mode = Arc::clone(shell);
        let for_remote = Arc::clone(shell);
        SlicerServices::new(SlicerServicesParts {
            data_dir,
            host,
            session: Arc::new(move || for_session.session()),
            is_remote: Arc::new(move || for_mode.mode() == ActiveMode::Remote),
            remote: Arc::new(move || {
                for_remote.remote().map(|host| {
                    Arc::new(ProxyRemote::new(host, handle.clone())) as Arc<dyn RemoteLibrary>
                })
            }),
            spawner: Arc::new(ProcessSpawner::new()),
            tune_sessions: None,
            tune_launcher: None,
        })
    }

    pub fn host(&self) -> &Arc<SlicersHost> {
        &self.host
    }

    pub fn sessions_lifecycle(&self) -> &Arc<SlicerSessions> {
        &self.sessions
    }

    /// The sweep at next start: surfaces sessions and deletes nothing that holds a file.
    pub fn sweep_at_start(&self) -> usize {
        self.sessions.sweep_at_start()
    }

    /// Stops every watcher and timer. Called when the shell is going away.
    pub fn close(&self) {
        self.sessions.close();
    }
}

impl SlicerBackend for SlicerServices {
    fn get(&self) -> Result<SlicerConfigDto, AppError> {
        Ok(self.host.get())
    }

    fn scan(&self) -> Result<SlicerConfigDto, AppError> {
        self.host.scan()
    }

    fn add_manual(&self, slicer_id: SlicerId) -> Result<Option<SlicerConfigDto>, AppError> {
        self.host.add_manual(slicer_id)
    }

    fn remove(&self, install_id: &str) -> Result<SlicerConfigDto, AppError> {
        self.host.remove(install_id)
    }

    fn bind(
        &self,
        slicer_id: SlicerId,
        install_id: Option<&str>,
    ) -> Result<SlicerConfigDto, AppError> {
        self.host.bind(slicer_id, install_id)
    }

    fn set_default(&self, slicer_id: Option<SlicerId>) -> Result<SlicerConfigDto, AppError> {
        self.host.set_default(slicer_id)
    }

    fn reset_config(&self) -> Result<SlicerConfigDto, AppError> {
        self.host.reset_config()
    }

    fn open(
        &self,
        file_id: &str,
        project_id: &str,
        opts: &SlicerLaunchOptions,
    ) -> Result<SlicerLaunchDto, AppError> {
        self.launcher.open(file_id, project_id, opts)
    }

    fn sessions(&self) -> Result<Vec<SlicerSessionDto>, AppError> {
        Ok(self.sessions.list())
    }

    fn resolve_session(
        &self,
        launch_id: &str,
        action: SessionAction,
        project_id: Option<&str>,
    ) -> Result<Option<FileDto>, AppError> {
        self.sessions.resolve(launch_id, action, project_id)
    }

    fn discard_sessions(&self, launch_ids: &[String]) -> Result<DiscardedSessionsDto, AppError> {
        let discarded = self.sessions.discard_many(launch_ids);
        Ok(DiscardedSessionsDto {
            discarded: u32::try_from(discarded).unwrap_or(u32::MAX),
        })
    }
}
