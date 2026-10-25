//! The model browser, assembled: the registry, the view host, the staging directory, the notices
//! and the landing, wired to each other and to the shell's library.
//!
//! The browser is a property of *this machine*, so none of it depends on the library mode: it
//! works the same in local and in remote mode (E 7.1). What does depend on the mode is where a
//! landing goes, and that is read **per call** through the [`LibrarySource`].

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use spm_core::AppError;
use spm_core::dto::{
    BrowseBounds, BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseStateDto, FileDto,
    ModelSiteDto,
};

use super::api::LibrarySource;
use super::commands::BrowseBackend;
use super::downloads::{Decision, Downloads, DownloadsOptions, MODEL_DOWNLOADS_DIR};
use super::host::{BrowseHost, BrowseHostOptions, HostWindow, ViewFactory};
use super::land::{BrowseLanding, match_projects};
use super::last_page::BROWSE_FILE_NAME;
use super::notices::{BrowseNotices, Notify};
use super::registry::SiteRegistry;

/// A change to the downloads' options before they are built.
pub type TuneDownloads = Box<dyn FnOnce(&mut DownloadsOptions)>;

/// Where the pieces are.
pub struct BrowseServicesParts {
    /// The app's data directory: `model-downloads/` and `browse.json` live here.
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
    landing: BrowseLanding,
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
            last_page_file: parts.data_dir.join(BROWSE_FILE_NAME),
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
            landing: BrowseLanding::new(Arc::clone(&downloads), Arc::clone(&parts.library)),
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

    /// The browser says a download ended. A view parked for it is destroyed now.
    pub fn on_download_finished(&self, url: &str, path: Option<&std::path::Path>, success: bool) {
        self.downloads.on_finished(url, path, success);
        self.host.release_parked();
    }

    /// The shell is going away.
    pub fn close(&self) {
        self.host.on_window_closed();
    }
}

impl BrowseBackend for BrowseServices {
    fn sites(&self) -> Vec<ModelSiteDto> {
        self.host.sites()
    }

    fn attach(&self, bounds: BrowseBounds, url: Option<&str>) -> Result<BrowseStateDto, AppError> {
        self.host.attach(bounds, url)
    }

    fn detach(&self) {
        self.host.detach();
    }

    fn hide(&self) {
        self.host.hide();
    }

    fn show(&self) -> BrowseStateDto {
        self.host.show()
    }

    fn set_bounds(&self, bounds: BrowseBounds) {
        self.host.set_bounds(bounds);
    }

    fn navigate(&self, url: &str) -> Result<BrowseStateDto, AppError> {
        self.host.navigate(url)
    }

    fn back(&self) -> Result<BrowseStateDto, AppError> {
        self.host.back()
    }

    fn forward(&self) -> Result<BrowseStateDto, AppError> {
        self.host.forward()
    }

    fn reload(&self) -> Result<BrowseStateDto, AppError> {
        self.host.reload()
    }

    fn state(&self) -> BrowseStateDto {
        self.host.state()
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

    fn match_page(&self, url: Option<&str>) -> Result<BrowseMatchDto, AppError> {
        match_projects(&self.registry, &self.library, url)
    }

    fn clear_last_page(&self) {
        self.host.clear_last_page();
    }
}
