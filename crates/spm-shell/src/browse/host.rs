//! The browse view's lifecycle: attach, hide, show, position, navigate, detach, and the hooks the
//! view calls back with. The view itself, the window it lives in and the code that makes either
//! are seams, so all of it runs under plain `cargo test`; `apps/desktop` implements them over a
//! Tauri child webview (`Window::add_child`).
//!
//! # The view is a native sibling, not an element
//!
//! It cannot be laid out by CSS, it **paints over the page unconditionally**, and it outlives its
//! route unless something destroys it. So: the page reports its placeholder's rectangle and this
//! host intersects it with an area it computes itself ([`super::bounds`]); anything the page draws
//! over the view (a dialog, a menu) has to *hide* it first ([`BrowseHost::hide`]), which costs the
//! user nothing; and leaving `/browse` calls [`BrowseHost::detach`], which **destroys** the view
//! (a hidden live third-party page is a page still running script and still able to start a
//! download nobody is watching). The persistent profile keeps what matters: the sign-in.
//!
//! **One exception, and it is the Tauri-specific one.** Closing a webview cancels a download that
//! is still coming down (Electron's session kept it). So a detach with a download in flight
//! *parks* the view (hidden, bounds forgotten, still the one view) and
//! [`BrowseHost::release_parked`] destroys it when the last download ends; an attach that finds a
//! parked view reuses it rather than killing the download.
//!
//! # Locking
//!
//! Two small mutexes and one rule: **no call into the view is ever made with either held.** The
//! view's hooks run on the main thread while a command may be waiting on the main thread for a
//! view call, and a lock held across that is a deadlock. Hooks touch `meta` only.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use spm_core::AppError;
use spm_core::dto::{BrowseBounds, BrowseStateDto, ModelSiteDto};

use super::bounds::{CHROME_INSET, MIN_AREA, Rect, view_bounds};
use super::last_page::{clear_last_page, read_last_page, write_last_page};
use super::policy::{
    BrowsePolicy, OpenDecision, browse_navigation_policy, browse_open_decision, describe_refusal,
};
use super::registry::SiteRegistry;

/// A child webview, as the host drives it. Every method is safe to call on a view whose contents
/// have died; [`BrowseView::is_alive`] says whether they have.
pub trait BrowseView: Send + Sync {
    fn load(&self, url: &str) -> Result<(), String>;
    fn back(&self);
    fn forward(&self);
    fn reload(&self);
    fn set_bounds(&self, rect: Rect);
    fn set_visible(&self, visible: bool);
    fn url(&self) -> Option<String>;
    fn title(&self) -> Option<String>;
    fn is_loading(&self) -> bool;
    fn can_go_back(&self) -> bool;
    fn can_go_forward(&self) -> bool;
    /// Asks the view to refresh what it can only learn asynchronously (the history flags).
    fn refresh(&self) {}
    fn close(&self);
    fn is_alive(&self) -> bool;
}

/// Makes a view, already on `start_url`, at `rect` (or hidden when `None`).
pub trait ViewFactory: Send + Sync {
    fn create(&self, start_url: &str, rect: Option<Rect>) -> Result<Arc<dyn BrowseView>, AppError>;
}

/// The window the view lives in.
pub trait HostWindow: Send + Sync {
    /// The content size in device pixels, or `None` when there is no window.
    fn content_size(&self) -> Option<(f64, f64)>;
    /// CSS pixels to device pixels.
    fn zoom(&self) -> f64;
}

pub struct BrowseHostOptions {
    pub factory: Arc<dyn ViewFactory>,
    pub window: Arc<dyn HostWindow>,
    /// `browse.json`.
    pub last_page_file: PathBuf,
    pub registry: Arc<SiteRegistry>,
    /// Whether a download is still coming down, which decides park-or-destroy on detach.
    pub downloads_running: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Default)]
struct Slot {
    view: Option<Arc<dyn BrowseView>>,
    bounds: Option<BrowseBounds>,
    hidden_on_request: bool,
    parked: bool,
}

#[derive(Default)]
struct Meta {
    last_error: Option<String>,
    remembered: Option<String>,
}

pub struct BrowseHost {
    options: BrowseHostOptions,
    slot: Mutex<Slot>,
    meta: Mutex<Meta>,
}

/// What a request for a new window turned into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOutcome {
    /// No window is made. The view may have been sent somewhere (`navigated`).
    Denied { navigated: bool },
}

impl BrowseHost {
    pub fn new(options: BrowseHostOptions) -> Arc<BrowseHost> {
        Arc::new(BrowseHost {
            options,
            slot: Mutex::new(Slot::default()),
            meta: Mutex::new(Meta::default()),
        })
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn meta(&self) -> std::sync::MutexGuard<'_, Meta> {
        self.meta.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn sites(&self) -> Vec<ModelSiteDto> {
        self.options.registry.dtos()
    }

    /// Whether a live view is on screen (not parked). What decides whether a finished download
    /// raises a notice.
    pub fn is_attached(&self) -> bool {
        let slot = self.slot();
        !slot.parked && slot.view.as_ref().is_some_and(|view| view.is_alive())
    }

    fn live_view(&self) -> Option<Arc<dyn BrowseView>> {
        self.slot().view.clone().filter(|view| view.is_alive())
    }

    fn require_view(&self) -> Result<Arc<dyn BrowseView>, AppError> {
        self.live_view()
            .ok_or_else(|| AppError::conflict("the model browser is not open"))
    }

    fn set_last_error(&self, error: Option<String>) {
        self.meta().last_error = error;
    }

    /// The page to open on: what was asked for, else the remembered page, else the registry's
    /// start page. A start URL the policy refuses is an error, not a quiet fall back.
    fn start_url(&self, url: Option<&str>) -> Result<String, AppError> {
        match url {
            Some(url) => {
                if browse_navigation_policy(url) == BrowsePolicy::Block {
                    return Err(AppError::validation(
                        "that URL cannot be opened in the model browser",
                    ));
                }
                Ok(url.to_owned())
            }
            None => Ok(read_last_page(&self.options.last_page_file)
                .unwrap_or_else(|| self.options.registry.start_url().to_owned())),
        }
    }

    /// Creates the view and shows it. A second attach destroys the first view before making the
    /// second (at most one view, ever), except that a view parked for a download is reused.
    pub fn attach(
        &self,
        bounds: BrowseBounds,
        url: Option<&str>,
    ) -> Result<BrowseStateDto, AppError> {
        if self.options.window.content_size().is_none() {
            return Err(AppError::conflict(
                "there is no window to put a model browser in",
            ));
        }
        let target = self.start_url(url)?;

        let parked = {
            let mut slot = self.slot();
            if slot.parked && slot.view.as_ref().is_some_and(|view| view.is_alive()) {
                slot.parked = false;
                slot.hidden_on_request = false;
                slot.bounds = Some(bounds);
                slot.view.clone()
            } else {
                None
            }
        };
        if let Some(view) = parked {
            self.apply_bounds();
            if url.is_some() {
                self.set_last_error(None);
                self.load(&view, &target);
            }
            return Ok(self.state());
        }

        self.destroy_view();
        let rect = self.rect_for(&bounds);
        let view = self.options.factory.create(&target, rect)?;
        {
            let mut slot = self.slot();
            slot.view = Some(Arc::clone(&view));
            slot.bounds = Some(bounds);
            slot.hidden_on_request = false;
            slot.parked = false;
        }
        self.set_last_error(None);
        self.apply_bounds();
        Ok(self.state())
    }

    /// Leaves the route. Destroys the view, unless a download is still coming down, in which case
    /// it is parked until the download ends. Safe when there is no view.
    pub fn detach(&self) {
        let keep = (self.options.downloads_running)() && self.live_view().is_some();
        if !keep {
            self.destroy_view();
            return;
        }
        let view = {
            let mut slot = self.slot();
            slot.parked = true;
            slot.bounds = None;
            slot.view.clone()
        };
        if let Some(view) = view {
            view.set_visible(false);
        }
    }

    /// Destroys a parked view once nothing is downloading any more.
    pub fn release_parked(&self) {
        let parked = self.slot().parked;
        if parked && !(self.options.downloads_running)() {
            self.destroy_view();
        }
    }

    /// Stops the view painting without destroying it: the answer for a modal, which must not cost
    /// the user the page they were on.
    pub fn hide(&self) {
        let view = {
            let mut slot = self.slot();
            slot.hidden_on_request = true;
            slot.view.clone()
        };
        if let Some(view) = view.filter(|view| view.is_alive()) {
            view.set_visible(false);
        }
    }

    pub fn show(&self) -> BrowseStateDto {
        self.slot().hidden_on_request = false;
        self.apply_bounds();
        self.state()
    }

    pub fn set_bounds(&self, bounds: BrowseBounds) {
        {
            let mut slot = self.slot();
            if slot.parked {
                return;
            }
            slot.bounds = Some(bounds);
        }
        self.apply_bounds();
    }

    pub fn navigate(&self, url: &str) -> Result<BrowseStateDto, AppError> {
        let view = self.require_view()?;
        if browse_navigation_policy(url) == BrowsePolicy::Block {
            self.set_last_error(Some(describe_refusal(url)));
            return Err(AppError::validation(
                "that URL cannot be opened in the model browser",
            ));
        }
        self.set_last_error(None);
        self.load(&view, url);
        Ok(self.state())
    }

    pub fn back(&self) -> Result<BrowseStateDto, AppError> {
        let view = self.require_view()?;
        self.set_last_error(None);
        view.back();
        Ok(self.state())
    }

    pub fn forward(&self) -> Result<BrowseStateDto, AppError> {
        let view = self.require_view()?;
        self.set_last_error(None);
        view.forward();
        Ok(self.state())
    }

    pub fn reload(&self) -> Result<BrowseStateDto, AppError> {
        let view = self.require_view()?;
        self.set_last_error(None);
        view.reload();
        Ok(self.state())
    }

    /// What the chrome polls.
    pub fn state(&self) -> BrowseStateDto {
        let last_error = self.meta().last_error.clone();
        let Some(view) = self.live_view() else {
            return BrowseStateDto {
                attached: false,
                url: None,
                title: None,
                is_loading: false,
                can_go_back: false,
                can_go_forward: false,
                site_id: None,
                last_error,
            };
        };
        view.refresh();
        // The empty string is what a view that has not committed a document answers, which is not
        // a URL and must not be reported as one.
        let url = view.url().filter(|url| !url.is_empty());
        let site_id = url
            .as_deref()
            .and_then(|url| self.options.registry.site_for_url(url))
            .map(|site| site.id.to_owned());
        BrowseStateDto {
            attached: true,
            title: view.title().filter(|title| !title.is_empty()),
            is_loading: view.is_loading(),
            can_go_back: view.can_go_back(),
            can_go_forward: view.can_go_forward(),
            site_id,
            url,
            last_error,
        }
    }

    /// Forgets the remembered page. The only thing that does.
    pub fn clear_last_page(&self) {
        self.meta().remembered = None;
        clear_last_page(&self.options.last_page_file);
    }

    // -----------------------------------------------------------------------------------------
    // What the view calls back with
    // -----------------------------------------------------------------------------------------

    /// A top-level navigation (and every redirect of one) is about to happen. `true` lets it.
    ///
    /// A refusal is recorded as the sentence the chrome shows; an allowed navigation is a new
    /// attempt and clears the previous failure.
    pub fn on_navigation(&self, url: &str) -> bool {
        if browse_navigation_policy(url) == BrowsePolicy::Block {
            self.set_last_error(Some(describe_refusal(url)));
            return false;
        }
        self.set_last_error(None);
        true
    }

    /// A page asked for a new window. **No window is ever made**; see
    /// [`super::policy::browse_open_decision`].
    pub fn on_new_window(&self, url: &str) -> WindowOutcome {
        match browse_open_decision(url) {
            OpenDecision::Deny => {
                self.set_last_error(Some(describe_refusal(url)));
                WindowOutcome::Denied { navigated: false }
            }
            OpenDecision::Navigate => {
                if let Some(view) = self.live_view() {
                    self.set_last_error(None);
                    self.load(&view, url);
                    WindowOutcome::Denied { navigated: true }
                } else {
                    WindowOutcome::Denied { navigated: false }
                }
            }
            OpenDecision::Popup => WindowOutcome::Denied { navigated: false },
        }
    }

    /// A navigation committed. The last page is remembered, for `http(s)` only.
    pub fn on_committed(&self, url: &str) {
        {
            let mut meta = self.meta();
            if meta.remembered.as_deref() == Some(url) {
                return;
            }
            meta.remembered = Some(url.to_owned());
        }
        write_last_page(&self.options.last_page_file, url);
    }

    /// The window resized between two reports: the page's report is the intent and this is the
    /// correction, so the view is never stranded at the old rectangle.
    pub fn on_window_resized(&self) {
        self.apply_bounds();
    }

    /// The window closed: one of the backstops, because a native resource whose only owner is a
    /// page's lifecycle hook is a leak waiting for a crash.
    pub fn on_window_closed(&self) {
        self.destroy_view();
    }

    // -----------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------

    fn load(&self, view: &Arc<dyn BrowseView>, url: &str) {
        if let Err(error) = view.load(url) {
            // Only when nothing more specific is already recorded.
            let mut meta = self.meta();
            if meta.last_error.is_none() {
                meta.last_error = Some(error);
            }
        }
    }

    fn rect_for(&self, bounds: &BrowseBounds) -> Option<Rect> {
        let content = self.options.window.content_size()?;
        view_bounds(
            bounds,
            content,
            self.options.window.zoom(),
            CHROME_INSET,
            MIN_AREA,
        )
    }

    fn apply_bounds(&self) {
        let (view, bounds, hidden) = {
            let slot = self.slot();
            (slot.view.clone(), slot.bounds, slot.hidden_on_request)
        };
        let (Some(view), Some(bounds)) = (view, bounds) else {
            return;
        };
        if !view.is_alive() {
            return;
        }
        if hidden {
            view.set_visible(false);
            return;
        }
        match self.rect_for(&bounds) {
            Some(rect) => {
                view.set_bounds(rect);
                view.set_visible(true);
            }
            // A page reporting 1x1 would keep a live third-party page running invisibly: hide it,
            // and do not give it the rectangle.
            None => view.set_visible(false),
        }
    }

    fn destroy_view(&self) {
        let view = {
            let mut slot = self.slot();
            slot.bounds = None;
            slot.hidden_on_request = false;
            slot.parked = false;
            slot.view.take()
        };
        self.set_last_error(None);
        if let Some(view) = view
            && view.is_alive()
        {
            view.close();
        }
    }
}
