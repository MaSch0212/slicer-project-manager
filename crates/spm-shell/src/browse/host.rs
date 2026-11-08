//! The browse views' lifecycle: the tabs, their rectangle, where each may go, and the hooks the
//! views call back with. The views, the window they live in and the code that makes either are
//! seams, so all of it runs under plain `cargo test`; `apps/desktop` implements them over Tauri
//! child webviews (`Window::add_child`).
//!
//! # A view is a native sibling, not an element
//!
//! It cannot be laid out by CSS, it **paints over the page unconditionally**, and it outlives its
//! route unless something destroys it. So: the page reports its placeholder's rectangle and this
//! host intersects it with an area it computes itself ([`super::bounds`]); anything the page draws
//! over the views (a dialog, a menu) has to *hide* them first ([`BrowseHost::hide`]), which costs
//! the user nothing; and only the active tab is ever on screen.
//!
//! # Tabs, and what happens when you leave the page
//!
//! Several sites are open at once, one view each, and **the tabs outlive the route**: leaving
//! `/browse` and coming back finds them where they were, with their scroll position and their
//! sign-in. They die with the process; a restart starts fresh, and nothing about where you were
//! is written to disk.
//!
//! Keeping them alive gives up something the old destroy-on-leave did for us: a hidden live
//! third-party page is a page still running script and still able to start a download nobody is
//! watching. So it is replaced rather than dropped — **while the route is not open, a download
//! request from any tab is refused** ([`BrowseHost::is_attached`], which
//! [`super::service`] consults in the download hook). A download already decided and in flight is
//! not affected; it is the *start* of a new one that is refused.
//!
//! # Closing a tab with a download in flight
//!
//! Closing a webview cancels a download that is still coming down (Electron's session kept it).
//! So closing such a tab removes it from the list but *parks* its view — hidden, no bounds, not a
//! tab any more — and [`BrowseHost::release_parked`] destroys it once the last download ends.
//!
//! # Locking
//!
//! Two small mutexes and one rule: **no call into a view is ever made with either held.** A
//! view's hooks run on the main thread while a command may be waiting on the main thread for a
//! view call, and a lock held across that is a deadlock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use spm_core::AppError;
use spm_core::dto::{BrowseBounds, BrowseStateDto, BrowseTabsDto, ModelSiteDto};

use super::bounds::{CHROME_INSET, MIN_AREA, Rect, view_bounds};
use super::policy::{
    BrowsePolicy, OpenDecision, browse_navigation_policy, browse_open_decision, describe_refusal,
};
use super::registry::SiteRegistry;

/// How many tabs may be open at once.
///
/// Each one is a live webview with its own renderer process and its own memory, so this is a real
/// resource and not a style choice. Eight is roomy for comparing models across the four sites and
/// still bounded.
pub const MAX_TABS: usize = 8;

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
    /// A PNG of what the view is showing, for the still picture a modal is drawn over. `None`
    /// where the platform cannot do it, which is never an error: the dialog opens anyway.
    fn capture_png(&self) -> Option<Vec<u8>> {
        None
    }
    fn close(&self);
    fn is_alive(&self) -> bool;
}

/// Makes a view for one tab, already on `start_url`, at `rect` (or hidden when `None`).
///
/// `tab_id` is the host's own id for the tab. The implementation needs it twice: to give the
/// webview a label of its own, and to tell the hooks which tab is calling back.
pub trait ViewFactory: Send + Sync {
    fn create(
        &self,
        tab_id: &str,
        start_url: &str,
        rect: Option<Rect>,
    ) -> Result<Arc<dyn BrowseView>, AppError>;
}

/// The window the views live in.
pub trait HostWindow: Send + Sync {
    /// The content size in device pixels, or `None` when there is no window.
    fn content_size(&self) -> Option<(f64, f64)>;
    /// CSS pixels to device pixels.
    fn zoom(&self) -> f64;
}

pub struct BrowseHostOptions {
    pub factory: Arc<dyn ViewFactory>,
    pub window: Arc<dyn HostWindow>,
    pub registry: Arc<SiteRegistry>,
    /// Whether a download is still coming down, which decides destroy-or-park on a tab close.
    pub downloads_running: Arc<dyn Fn() -> bool + Send + Sync>,
}

struct Tab {
    id: String,
    view: Arc<dyn BrowseView>,
    last_error: Option<String>,
}

#[derive(Default)]
struct Tabs {
    tabs: Vec<Tab>,
    active: Option<String>,
    /// Views of closed tabs that are still finishing a download. Not tabs any more.
    parked: Vec<Arc<dyn BrowseView>>,
    bounds: Option<BrowseBounds>,
    hidden_on_request: bool,
    /// Whether the page is on screen. False everywhere else in the app.
    attached: bool,
}

impl Tabs {
    fn find(&self, id: &str) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    fn active_tab(&self) -> Option<&Tab> {
        self.active.as_deref().and_then(|id| self.find(id))
    }
}

pub struct BrowseHost {
    options: BrowseHostOptions,
    state: Mutex<Tabs>,
    next_id: AtomicU64,
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
            state: Mutex::new(Tabs::default()),
            next_id: AtomicU64::new(1),
        })
    }

    /// The lock. Named for what it is, so that nothing confuses it with the `tabs()` the page
    /// asks for — and so that a `return` from inside a block that holds it reads as the mistake
    /// it is (`tabs()` locks too).
    fn locked(&self) -> std::sync::MutexGuard<'_, Tabs> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn sites(&self) -> Vec<ModelSiteDto> {
        self.options.registry.dtos()
    }

    /// Whether the page is on screen with at least one live tab.
    ///
    /// **This is what decides whether a download may start at all.** A tab that is alive but off
    /// the route is a page nobody is watching, and the whole reason the old code destroyed the
    /// view on leaving was to stop it downloading behind the user's back.
    pub fn is_attached(&self) -> bool {
        let state = self.locked();
        state.attached && state.tabs.iter().any(|tab| tab.view.is_alive())
    }

    fn require_active(&self) -> Result<Arc<dyn BrowseView>, AppError> {
        self.locked()
            .active_tab()
            .map(|tab| Arc::clone(&tab.view))
            .filter(|view| view.is_alive())
            .ok_or_else(|| AppError::conflict("the model browser is not open"))
    }

    fn set_error(&self, tab_id: &str, error: Option<String>) {
        if let Some(tab) = self.locked().find_mut(tab_id) {
            tab.last_error = error;
        }
    }

    fn set_active_error(&self, error: Option<String>) {
        let mut state = self.locked();
        if let Some(id) = state.active.clone()
            && let Some(tab) = state.find_mut(&id)
        {
            tab.last_error = error;
        }
    }

    /// Where a new tab opens: what was asked for, else the registry's start page. A URL the
    /// policy refuses is an error, not a quiet fall back.
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
            None => Ok(self.options.registry.start_url().to_owned()),
        }
    }

    // -----------------------------------------------------------------------------------------
    // The route
    // -----------------------------------------------------------------------------------------

    /// The page is on screen. Opens a first tab if there is none, and puts the tabs back where
    /// they were otherwise.
    pub fn attach(&self, bounds: BrowseBounds) -> Result<BrowseTabsDto, AppError> {
        if self.options.window.content_size().is_none() {
            return Err(AppError::conflict(
                "there is no window to put a model browser in",
            ));
        }
        let empty = {
            let mut state = self.locked();
            state.attached = true;
            state.hidden_on_request = false;
            state.bounds = Some(bounds);
            state.tabs.retain(|tab| tab.view.is_alive());
            state.tabs.is_empty()
        };
        if empty {
            self.open_tab(None)?;
        }
        self.apply_bounds();
        Ok(self.tabs())
    }

    /// The page is gone. The tabs stay, hidden; none of them may start a download from here.
    pub fn detach(&self) {
        let views = {
            let mut state = self.locked();
            state.attached = false;
            state.bounds = None;
            state.hidden_on_request = false;
            self.live_views(&state)
        };
        for view in views {
            view.set_visible(false);
        }
    }

    /// Stops the views painting without destroying them: the answer for a modal, which must not
    /// cost the user the page they were on.
    pub fn hide(&self) {
        let views = {
            let mut state = self.locked();
            state.hidden_on_request = true;
            self.live_views(&state)
        };
        for view in views {
            view.set_visible(false);
        }
    }

    /// Every tab's view that still has contents. A view whose contents died is never painted,
    /// hidden or moved: there is nothing there to do it to.
    fn live_views(&self, state: &Tabs) -> Vec<Arc<dyn BrowseView>> {
        state
            .tabs
            .iter()
            .map(|tab| Arc::clone(&tab.view))
            .filter(|view| view.is_alive())
            .collect()
    }

    pub fn show(&self) -> BrowseTabsDto {
        self.locked().hidden_on_request = false;
        self.apply_bounds();
        self.tabs()
    }

    pub fn set_bounds(&self, bounds: BrowseBounds) {
        {
            let mut state = self.locked();
            if !state.attached {
                return;
            }
            state.bounds = Some(bounds);
        }
        self.apply_bounds();
    }

    // -----------------------------------------------------------------------------------------
    // The tabs
    // -----------------------------------------------------------------------------------------

    /// Opens a tab on `url` (or the registry's start page) and makes it the active one.
    pub fn open_tab(&self, url: Option<&str>) -> Result<BrowseTabsDto, AppError> {
        if self.options.window.content_size().is_none() {
            return Err(AppError::conflict(
                "there is no window to put a model browser in",
            ));
        }
        let target = self.start_url(url)?;
        {
            let state = self.locked();
            if state.tabs.len() >= MAX_TABS {
                return Err(AppError::conflict("that is as many tabs as this can hold"));
            }
        }
        let id = format!("tab-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let rect = {
            let state = self.locked();
            state
                .bounds
                .filter(|_| state.attached && !state.hidden_on_request)
        }
        .and_then(|bounds| self.rect_for(&bounds));
        let view = self.options.factory.create(&id, &target, rect)?;
        {
            let mut state = self.locked();
            state.tabs.push(Tab {
                id: id.clone(),
                view,
                last_error: None,
            });
            state.active = Some(id);
        }
        self.apply_bounds();
        Ok(self.tabs())
    }

    /// Brings a tab to the front. Unknown ids are ignored rather than an error: a page racing a
    /// close against a click is not a fault.
    pub fn select_tab(&self, tab_id: &str) -> BrowseTabsDto {
        {
            let mut state = self.locked();
            if state.find(tab_id).is_some() {
                state.active = Some(tab_id.to_owned());
            }
        }
        self.apply_bounds();
        self.tabs()
    }

    /// Closes a tab. Its view is destroyed, unless a download is still coming down, in which case
    /// it is parked until the download ends. Closing the last tab opens a fresh one, so the page
    /// is never left with a browser and no way back into it.
    pub fn close_tab(&self, tab_id: &str) -> Result<BrowseTabsDto, AppError> {
        // Asked and answered before the guard is taken: `tabs()` locks, and a `return` out of a
        // block that still holds the guard is a deadlock, not a missing tab.
        if self.locked().find(tab_id).is_none() {
            return Ok(self.tabs());
        }
        let (removed, keep) = {
            let mut state = self.locked();
            let Some(index) = state.tabs.iter().position(|tab| tab.id == tab_id) else {
                // Raced with another close. Explicitly released: `tabs()` locks, and returning
                // from here with the guard still held is a deadlock.
                drop(state);
                return Ok(self.tabs());
            };
            let tab = state.tabs.remove(index);
            if state.active.as_deref() == Some(tab_id) {
                // The one to its right, else the one to its left, else nothing.
                state.active = state
                    .tabs
                    .get(index)
                    .or_else(|| state.tabs.last())
                    .map(|tab| tab.id.clone());
            }
            let keep = (self.options.downloads_running)() && tab.view.is_alive();
            if keep {
                state.parked.push(Arc::clone(&tab.view));
            }
            (tab.view, keep)
        };
        removed.set_visible(false);
        if !keep && removed.is_alive() {
            removed.close();
        }
        let empty = self.locked().tabs.is_empty();
        if empty {
            self.open_tab(None)?;
        }
        self.apply_bounds();
        Ok(self.tabs())
    }

    /// Destroys parked views once nothing is downloading any more.
    pub fn release_parked(&self) {
        if (self.options.downloads_running)() {
            return;
        }
        let parked = std::mem::take(&mut self.locked().parked);
        for view in parked {
            if view.is_alive() {
                view.close();
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Driving the active tab
    // -----------------------------------------------------------------------------------------

    pub fn navigate(&self, url: &str) -> Result<BrowseTabsDto, AppError> {
        let view = self.require_active()?;
        if browse_navigation_policy(url) == BrowsePolicy::Block {
            self.set_active_error(Some(describe_refusal(url)));
            return Err(AppError::validation(
                "that URL cannot be opened in the model browser",
            ));
        }
        self.set_active_error(None);
        self.load(&view, url);
        Ok(self.tabs())
    }

    pub fn back(&self) -> Result<BrowseTabsDto, AppError> {
        let view = self.require_active()?;
        self.set_active_error(None);
        view.back();
        Ok(self.tabs())
    }

    pub fn forward(&self) -> Result<BrowseTabsDto, AppError> {
        let view = self.require_active()?;
        self.set_active_error(None);
        view.forward();
        Ok(self.tabs())
    }

    pub fn reload(&self) -> Result<BrowseTabsDto, AppError> {
        let view = self.require_active()?;
        self.set_active_error(None);
        view.reload();
        Ok(self.tabs())
    }

    /// A PNG of the active tab, for the still picture a modal is drawn over. `None` is not an
    /// error: the dialog opens against the empty slot instead.
    pub fn capture_active(&self) -> Option<Vec<u8>> {
        self.require_active().ok()?.capture_png()
    }

    /// Every tab, for the chrome.
    pub fn tabs(&self) -> BrowseTabsDto {
        let (snapshot, active, attached, count) = {
            let state = self.locked();
            let snapshot: Vec<(String, Arc<dyn BrowseView>, Option<String>)> = state
                .tabs
                .iter()
                .map(|tab| {
                    (
                        tab.id.clone(),
                        Arc::clone(&tab.view),
                        tab.last_error.clone(),
                    )
                })
                .collect();
            (
                snapshot,
                state.active.clone(),
                state.attached,
                state.tabs.len(),
            )
        };
        let tabs = snapshot
            .into_iter()
            .map(|(id, view, last_error)| self.tab_state(id, &view, last_error))
            .collect();
        BrowseTabsDto {
            attached,
            tabs,
            active_tab_id: active,
            can_open_more: count < MAX_TABS,
        }
    }

    fn tab_state(
        &self,
        tab_id: String,
        view: &Arc<dyn BrowseView>,
        last_error: Option<String>,
    ) -> BrowseStateDto {
        if !view.is_alive() {
            return BrowseStateDto {
                tab_id,
                url: None,
                title: None,
                is_loading: false,
                can_go_back: false,
                can_go_forward: false,
                site_id: None,
                last_error,
            };
        }
        view.refresh();
        // The empty string is what a view that has not committed a document answers, which is not
        // a URL and must not be reported as one.
        let url = view.url().filter(|url| !url.is_empty());
        let site_id = url
            .as_deref()
            .and_then(|url| self.options.registry.site_for_url(url))
            .map(|site| site.id.to_owned());
        BrowseStateDto {
            tab_id,
            title: view.title().filter(|title| !title.is_empty()),
            is_loading: view.is_loading(),
            can_go_back: view.can_go_back(),
            can_go_forward: view.can_go_forward(),
            site_id,
            url,
            last_error,
        }
    }

    // -----------------------------------------------------------------------------------------
    // What the views call back with
    // -----------------------------------------------------------------------------------------

    /// A top-level navigation (and every redirect of one) is about to happen. `true` lets it.
    ///
    /// A refusal is recorded against that tab as the sentence the chrome shows; an allowed
    /// navigation is a new attempt and clears the previous failure.
    pub fn on_navigation(&self, tab_id: &str, url: &str) -> bool {
        if browse_navigation_policy(url) == BrowsePolicy::Block {
            self.set_error(tab_id, Some(describe_refusal(url)));
            return false;
        }
        self.set_error(tab_id, None);
        true
    }

    /// A page asked for a new window. **No window is ever made**; see
    /// [`super::policy::browse_open_decision`]. A target that is allowed is loaded in the tab
    /// that asked, not in a new one: a site must not be able to fill the strip with tabs.
    pub fn on_new_window(&self, tab_id: &str, url: &str) -> WindowOutcome {
        match browse_open_decision(url) {
            OpenDecision::Deny => {
                self.set_error(tab_id, Some(describe_refusal(url)));
                WindowOutcome::Denied { navigated: false }
            }
            OpenDecision::Navigate => {
                let view = self
                    .locked()
                    .find(tab_id)
                    .map(|tab| Arc::clone(&tab.view))
                    .filter(|view| view.is_alive());
                if let Some(view) = view {
                    self.set_error(tab_id, None);
                    self.load(&view, url);
                    WindowOutcome::Denied { navigated: true }
                } else {
                    WindowOutcome::Denied { navigated: false }
                }
            }
            OpenDecision::Popup => WindowOutcome::Denied { navigated: false },
        }
    }

    /// A navigation committed. Nothing is remembered: the tabs live as long as the process and
    /// no more, so there is no file here to leak a browsing history into.
    pub fn on_committed(&self, _tab_id: &str, _url: &str) {}

    /// The window resized between two reports: the page's report is the intent and this is the
    /// correction, so a view is never stranded at the old rectangle.
    pub fn on_window_resized(&self) {
        self.apply_bounds();
    }

    /// The window closed: one of the backstops, because a native resource whose only owner is a
    /// page's lifecycle hook is a leak waiting for a crash.
    pub fn on_window_closed(&self) {
        self.destroy_all();
    }

    /// Everything goes. Called at exit.
    pub fn destroy_all(&self) {
        let (tabs, parked) = {
            let mut state = self.locked();
            state.active = None;
            state.bounds = None;
            state.attached = false;
            let tabs: Vec<Arc<dyn BrowseView>> = state.tabs.drain(..).map(|tab| tab.view).collect();
            let parked = std::mem::take(&mut state.parked);
            (tabs, parked)
        };
        for view in tabs.into_iter().chain(parked) {
            if view.is_alive() {
                view.close();
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------

    fn load(&self, view: &Arc<dyn BrowseView>, url: &str) {
        if let Err(error) = view.load(url) {
            let mut state = self.locked();
            if let Some(id) = state.active.clone()
                && let Some(tab) = state.find_mut(&id)
                // Only when nothing more specific is already recorded.
                && tab.last_error.is_none()
            {
                tab.last_error = Some(error);
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

    /// Exactly one view is on screen: the active tab's, and only while the page is there and
    /// nothing is drawn over it. Every other view is hidden, whatever it was doing before.
    fn apply_bounds(&self) {
        let (views, active, bounds, hidden, attached) = {
            let state = self.locked();
            let views: Vec<(String, Arc<dyn BrowseView>)> = state
                .tabs
                .iter()
                .map(|tab| (tab.id.clone(), Arc::clone(&tab.view)))
                .collect();
            (
                views,
                state.active.clone(),
                state.bounds,
                state.hidden_on_request,
                state.attached,
            )
        };
        let rect = bounds.and_then(|bounds| self.rect_for(&bounds));
        for (id, view) in views {
            if !view.is_alive() {
                continue;
            }
            let is_active = active.as_deref() == Some(id.as_str());
            // A page reporting 1x1 would keep a live third-party page running invisibly: hide it,
            // and do not give it the rectangle.
            match rect {
                Some(rect) if is_active && attached && !hidden => {
                    view.set_bounds(rect);
                    view.set_visible(true);
                }
                _ => view.set_visible(false),
            }
        }
    }
}
