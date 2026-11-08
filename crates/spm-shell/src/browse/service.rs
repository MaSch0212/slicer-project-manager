//! The model browser, assembled: the registry, the view host, the staging directory, the notices
//! and the landing, wired to each other and to the shell's library.
//!
//! The browser is a property of *this machine*, so none of it depends on the library mode: it
//! works the same in local and in remote mode (E 7.1). What does depend on the mode is where a
//! landing goes, and that is read **per call** through the [`LibrarySource`].

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use spm_core::AppError;
use spm_core::dto::BrowseNoticeKind;
use spm_core::dto::{
    BrowseBounds, BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseTabsDto, FileDto,
    ModelSiteDto,
};

use super::api::LibrarySource;
use super::commands::BrowseBackend;
use super::downloads::{Decision, Downloads, DownloadsOptions, MODEL_DOWNLOADS_DIR, Plan};
use super::host::{BrowseHost, BrowseHostOptions, HostWindow, ViewFactory};
use super::land::{BrowseLanding, match_projects};
use super::notices::{BrowseNotices, Notify};
use super::registry::SiteRegistry;

/// A change to the downloads' options before they are built.
pub type TuneDownloads = Box<dyn FnOnce(&mut DownloadsOptions)>;

/// Where the pieces are.
pub struct BrowseServicesParts {
    /// The app's data directory: `model-downloads/` lives here.
    pub data_dir: PathBuf,
    pub registry: SiteRegistry,
    pub library: LibrarySource,
    /// Which library a download is staged against (`local:<folder>` / `remote:<origin>`).
    pub library_key: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub factory: Arc<dyn ViewFactory>,
    pub window: Arc<dyn HostWindow>,
    pub notify: Notify,
    /// Changes the downloads' options before they are built (tests lower the caps).
    pub tune_downloads: Option<TuneDownloads>,
}

pub struct BrowseServices {
    registry: Arc<SiteRegistry>,
    host: Arc<BrowseHost>,
    downloads: Arc<Downloads>,
    notices: Arc<BrowseNotices>,
    landing: Arc<BrowseLanding>,
    library: LibrarySource,
}

impl BrowseServices {
    pub fn new(parts: BrowseServicesParts) -> Arc<BrowseServices> {
        let registry = Arc::new(parts.registry);
        let notices = Arc::new(BrowseNotices::new(parts.notify));
        let downloads_cell: Arc<OnceLock<Arc<Downloads>>> = Arc::new(OnceLock::new());
        let host_cell: Arc<OnceLock<Arc<BrowseHost>>> = Arc::new(OnceLock::new());

        let running = Arc::clone(&downloads_cell);
        let host = BrowseHost::new(BrowseHostOptions {
            factory: parts.factory,
            window: parts.window,
            registry: Arc::clone(&registry),
            downloads_running: Arc::new(move || {
                running
                    .get()
                    .is_some_and(|downloads| downloads.any_running())
            }),
        });
        let _ = host_cell.set(Arc::clone(&host));

        let attached = Arc::clone(&host_cell);
        let mut options = DownloadsOptions::new(
            parts.data_dir.join(MODEL_DOWNLOADS_DIR),
            Arc::clone(&notices),
            Arc::clone(&registry),
        );
        options.library_key = parts.library_key;
        options.is_view_attached =
            Arc::new(move || attached.get().is_some_and(|host| host.is_attached()));
        if let Some(tune) = parts.tune_downloads {
            tune(&mut options);
        }
        let downloads = Downloads::new(options);
        let _ = downloads_cell.set(Arc::clone(&downloads));

        Arc::new(BrowseServices {
            landing: Arc::new(BrowseLanding::new(
                Arc::clone(&downloads),
                Arc::clone(&parts.library),
            )),
            registry,
            host,
            downloads,
            notices,
            library: parts.library,
        })
    }

    pub fn host(&self) -> &Arc<BrowseHost> {
        &self.host
    }

    pub fn downloads_store(&self) -> &Arc<Downloads> {
        &self.downloads
    }

    pub fn registry(&self) -> &Arc<SiteRegistry> {
        &self.registry
    }

    /// Lists what a previous run left in the staging directory. Deletes nothing.
    pub fn sweep_at_start(&self) {
        self.downloads.sweep();
    }

    /// The browser asked to download: stage it or refuse it.
    pub fn on_download_requested(&self, request: &super::downloads::DownloadRequest) -> Decision {
        self.downloads.on_requested(request)
    }

    /// The browser says a download ended: a view parked for it is destroyed, and **the choice
    /// the user made when it started is carried out**.
    ///
    /// The decision lives here rather than in the page because the page stops existing the
    /// moment the user leaves `/browse`, and a file has to land even if they walked away while
    /// it was coming down.
    ///
    /// **Landing runs on a thread of its own.** This is called from the browser's own
    /// download hook on the main thread, and a landing is a blocking upload (in remote mode, over
    /// the network); doing it here would freeze the window for the length of it.
    pub fn on_download_finished(
        self: &Arc<Self>,
        url: &str,
        path: Option<&std::path::Path>,
        success: bool,
    ) {
        let finished = self.downloads.on_finished(url, path, success);
        self.host.release_parked();
        let Some(finished) = finished else { return };
        let Some(plan) = finished.plan else { return };
        match plan {
            // Cancelled while it was still coming down: nothing could stop the bytes, so they
            // were allowed to arrive and `downloads` deleted them as they landed. Nothing to do
            // here, and nothing to tell the user: they are the one who cancelled it.
            Plan::Cancel => {}
            Plan::Land {
                project_id,
                file_name,
            } => {
                if !finished.completed {
                    self.notices.add(
                        BrowseNoticeKind::Refused,
                        &file_name,
                        "this download did not finish, so it was not added to your project",
                    );
                    return;
                }
                let services = Arc::clone(self);
                std::thread::spawn(move || {
                    services.land_decided(&finished.download_id, &project_id, &file_name);
                });
            }
        }
    }

    /// Files a download the user already chose a home for. A refusal is kept as a notice with
    /// the server's own words, and the download stays staged so it can be filed by hand.
    fn land_decided(&self, download_id: &str, project_id: &str, file_name: &str) {
        match self.landing.land(download_id, project_id, Some(file_name)) {
            Ok(_) => {
                // Only when nobody is looking. With the page on screen the download leaving the
                // list is the answer, and a notice that had to be dismissed would be in the way.
                if !self.host.is_attached() {
                    self.notices.add(
                        BrowseNoticeKind::Completed,
                        file_name,
                        "this download finished and was added to your project",
                    );
                }
            }
            Err(error) => {
                self.notices
                    .add(BrowseNoticeKind::Refused, file_name, &error.message);
            }
        }
    }

    /// The shell is going away. Every tab goes with it; nothing of where the user was is kept.
    pub fn close(&self) {
        self.host.destroy_all();
    }
}

impl BrowseBackend for BrowseServices {
    fn sites(&self) -> Vec<ModelSiteDto> {
        self.host.sites()
    }

    fn attach(&self, bounds: BrowseBounds) -> Result<BrowseTabsDto, AppError> {
        self.host.attach(bounds)
    }

    fn detach(&self) {
        self.host.detach();
    }

    fn hide(&self) {
        self.host.hide();
    }

    fn show(&self) -> BrowseTabsDto {
        self.host.show()
    }

    fn set_bounds(&self, bounds: BrowseBounds) {
        self.host.set_bounds(bounds);
    }

    fn navigate(&self, url: &str) -> Result<BrowseTabsDto, AppError> {
        self.host.navigate(url)
    }

    fn back(&self) -> Result<BrowseTabsDto, AppError> {
        self.host.back()
    }

    fn forward(&self) -> Result<BrowseTabsDto, AppError> {
        self.host.forward()
    }

    fn reload(&self) -> Result<BrowseTabsDto, AppError> {
        self.host.reload()
    }

    fn tabs(&self) -> BrowseTabsDto {
        self.host.tabs()
    }

    fn open_tab(&self, url: Option<&str>) -> Result<BrowseTabsDto, AppError> {
        self.host.open_tab(url)
    }

    fn select_tab(&self, tab_id: &str) -> BrowseTabsDto {
        self.host.select_tab(tab_id)
    }

    fn close_tab(&self, tab_id: &str) -> Result<BrowseTabsDto, AppError> {
        self.host.close_tab(tab_id)
    }

    fn capture_active(&self) -> Option<Vec<u8>> {
        self.host.capture_active()
    }

    fn downloads(&self) -> Vec<BrowseDownloadDto> {
        self.downloads.list()
    }

    fn notices(&self) -> Vec<BrowseNoticeDto> {
        self.notices.list()
    }

    fn dismiss_notice(&self, id: &str) {
        self.notices.dismiss(id);
    }

    fn land(
        &self,
        download_id: &str,
        project_id: &str,
        name: Option<&str>,
    ) -> Result<FileDto, AppError> {
        self.landing.land(download_id, project_id, name)
    }

    fn discard(&self, download_id: &str) -> Result<(), AppError> {
        self.downloads.discard(download_id)?;
        self.host.release_parked();
        Ok(())
    }

    fn decide(&self, download_id: &str, project_id: &str, file_name: &str) -> Result<(), AppError> {
        self.downloads.decide(download_id, project_id, file_name)
    }

    fn cancel(&self, download_id: &str) -> Result<(), AppError> {
        self.downloads.cancel(download_id)?;
        self.host.release_parked();
        Ok(())
    }

    fn match_page(&self, url: Option<&str>) -> Result<BrowseMatchDto, AppError> {
        match_projects(&self.registry, &self.library, url)
    }
}
