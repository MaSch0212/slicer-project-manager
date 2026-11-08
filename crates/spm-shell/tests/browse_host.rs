//! Ported from `browse-host.test.ts` and carried forward to tabs: the views' lifecycle, who
//! destroys what, and what the hooks decide. The double records the calls the host makes and
//! models **none** of the webview's behaviour: nothing here navigates, nothing decides whether a
//! bridge is injected, nothing knows what a data directory does. A fake that answered those
//! questions would test what its author believed WebView2 does. Every property that is the
//! webview's own is asserted against a real window in `apps/desktop/tests/hidden_smoke.rs` and
//! **nowhere else**.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use spm_core::AppError;
use spm_core::AppErrorCode;
use spm_core::dto::{BrowseBounds, BrowseStateDto};
use spm_shell::browse::bounds::Rect;
use spm_shell::browse::host::{
    BrowseHost, BrowseHostOptions, BrowseView, HostWindow, MAX_TABS, ViewFactory, WindowOutcome,
};
use spm_shell::browse::registry::SiteRegistry;

#[derive(Default)]
struct FakeView {
    loaded: Mutex<Vec<String>>,
    rects: Mutex<Vec<Rect>>,
    visibility: Mutex<Vec<bool>>,
    closed: AtomicUsize,
    dead: AtomicBool,
    fail_load: Mutex<Option<String>>,
    current: Mutex<Option<String>>,
    calls: Mutex<Vec<&'static str>>,
    during_load: Mutex<Option<Box<dyn Fn() + Send>>>,
    png: Mutex<Option<Vec<u8>>>,
}

impl BrowseView for FakeView {
    fn load(&self, url: &str) -> Result<(), String> {
        self.loaded.lock().unwrap().push(url.to_owned());
        *self.current.lock().unwrap() = Some(url.to_owned());
        if let Some(hook) = self.during_load.lock().unwrap().as_ref() {
            hook();
        }
        self.fail_load.lock().unwrap().clone().map_or(Ok(()), Err)
    }

    fn back(&self) {
        self.calls.lock().unwrap().push("back");
    }

    fn forward(&self) {
        self.calls.lock().unwrap().push("forward");
    }

    fn reload(&self) {
        self.calls.lock().unwrap().push("reload");
    }

    fn set_bounds(&self, rect: Rect) {
        self.rects.lock().unwrap().push(rect);
    }

    fn set_visible(&self, visible: bool) {
        self.visibility.lock().unwrap().push(visible);
    }

    fn url(&self) -> Option<String> {
        self.current.lock().unwrap().clone()
    }

    fn title(&self) -> Option<String> {
        Some("a title".to_owned())
    }

    fn is_loading(&self) -> bool {
        false
    }

    fn can_go_back(&self) -> bool {
        false
    }

    fn can_go_forward(&self) -> bool {
        false
    }

    fn capture_png(&self) -> Option<Vec<u8>> {
        self.png.lock().unwrap().clone()
    }

    fn close(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
        self.dead.store(true, Ordering::SeqCst);
    }

    fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst)
    }
}

impl FakeView {
    fn last_visible(&self) -> Option<bool> {
        self.visibility.lock().unwrap().last().copied()
    }
}

type Made = (Arc<FakeView>, String, String, Option<Rect>);

#[derive(Default)]
struct FakeFactory {
    made: Mutex<Vec<Made>>,
}

impl ViewFactory for FakeFactory {
    fn create(
        &self,
        tab_id: &str,
        start_url: &str,
        rect: Option<Rect>,
    ) -> Result<Arc<dyn BrowseView>, AppError> {
        let view = Arc::new(FakeView::default());
        *view.current.lock().unwrap() = Some(start_url.to_owned());
        self.made.lock().unwrap().push((
            Arc::clone(&view),
            tab_id.to_owned(),
            start_url.to_owned(),
            rect,
        ));
        Ok(view)
    }
}

struct FakeWindow {
    size: Mutex<Option<(f64, f64)>>,
}

impl HostWindow for FakeWindow {
    fn content_size(&self) -> Option<(f64, f64)> {
        *self.size.lock().unwrap()
    }

    fn zoom(&self) -> f64 {
        1.0
    }
}

struct Rig {
    host: Arc<BrowseHost>,
    factory: Arc<FakeFactory>,
    window: Arc<FakeWindow>,
    downloading: Arc<AtomicBool>,
}

fn rig() -> Rig {
    let factory = Arc::new(FakeFactory::default());
    let window = Arc::new(FakeWindow {
        size: Mutex::new(Some((1280.0, 860.0))),
    });
    let downloading = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&downloading);
    let host = BrowseHost::new(BrowseHostOptions {
        factory: factory.clone(),
        window: window.clone(),
        registry: Arc::new(SiteRegistry::standard()),
        downloads_running: Arc::new(move || flag.load(Ordering::SeqCst)),
    });
    Rig {
        host,
        factory,
        window,
        downloading,
    }
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> BrowseBounds {
    BrowseBounds {
        x,
        y,
        width,
        height,
    }
}

fn whole() -> BrowseBounds {
    bounds(0.0, 0.0, 1280.0, 860.0)
}

impl Rig {
    fn view(&self, index: usize) -> Arc<FakeView> {
        Arc::clone(&self.factory.made.lock().unwrap()[index].0)
    }

    fn start_url(&self, index: usize) -> String {
        self.factory.made.lock().unwrap()[index].2.clone()
    }

    fn made(&self) -> usize {
        self.factory.made.lock().unwrap().len()
    }

    /// The active tab's state, which is what the old single-view `state()` used to answer.
    fn active(&self) -> BrowseStateDto {
        let tabs = self.host.tabs();
        let active = tabs.active_tab_id.expect("an active tab");
        tabs.tabs
            .into_iter()
            .find(|tab| tab.tab_id == active)
            .expect("the active tab is in the list")
    }

    fn tab_ids(&self) -> Vec<String> {
        self.host
            .tabs()
            .tabs
            .into_iter()
            .map(|tab| tab.tab_id)
            .collect()
    }
}

#[test]
fn attach_opens_one_tab_on_the_start_url_inside_the_allowed_area() {
    let rig = rig();
    let tabs = rig.host.attach(bounds(100.0, 200.0, 800.0, 500.0)).unwrap();
    assert_eq!(rig.made(), 1);
    assert_eq!(rig.start_url(0), "https://www.thingiverse.com/");
    assert!(tabs.attached);
    assert_eq!(tabs.tabs.len(), 1);
    assert_eq!(tabs.active_tab_id, Some(tabs.tabs[0].tab_id.clone()));
    assert_eq!(tabs.tabs[0].title.as_deref(), Some("a title"));
    assert_eq!(
        *rig.view(0).rects.lock().unwrap().last().unwrap(),
        Rect {
            x: 100.0,
            y: 200.0,
            width: 800.0,
            height: 500.0
        }
    );
}

#[test]
fn a_second_attach_finds_the_tabs_where_they_were_rather_than_making_new_ones() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(Some("https://makerworld.com/")).unwrap();
    let before = rig.tab_ids();
    rig.host.detach();
    let tabs = rig.host.attach(whole()).unwrap();
    assert_eq!(rig.made(), 2, "no view was made again");
    assert_eq!(rig.tab_ids(), before, "the same tabs, in the same order");
    assert!(tabs.attached);
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 0);
    assert_eq!(rig.view(1).closed.load(Ordering::SeqCst), 0);
}

#[test]
fn detach_keeps_every_tab_alive_but_takes_them_off_screen_and_off_the_download_path() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    rig.host.detach();
    for index in [0, 1] {
        assert_eq!(rig.view(index).closed.load(Ordering::SeqCst), 0);
        assert_eq!(rig.view(index).last_visible(), Some(false));
    }
    assert_eq!(rig.tab_ids().len(), 2, "the tabs are still there");
    assert!(!rig.host.tabs().attached);
    // The guarantee that replaces destroy-on-leave: nothing may start a download from here.
    assert!(!rig.host.is_attached());
    rig.host.detach();
    assert!(!rig.host.is_attached(), "detaching twice is not an error");
}

#[test]
fn every_view_is_destroyed_when_the_host_window_closes() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    rig.host.on_window_closed();
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 1);
    assert_eq!(rig.view(1).closed.load(Ordering::SeqCst), 1);
    let tabs = rig.host.tabs();
    assert!(!tabs.attached);
    assert!(tabs.tabs.is_empty());
}

#[test]
fn attach_with_no_window_is_a_conflict_rather_than_a_view_with_nowhere_to_live() {
    let rig = rig();
    *rig.window.size.lock().unwrap() = None;
    let error = rig.host.attach(whole()).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert_eq!(rig.host.open_tab(None).unwrap_err().code, error.code);
    assert_eq!(rig.made(), 0);
}

#[test]
fn every_method_that_needs_a_tab_says_conflict_when_there_is_none() {
    let rig = rig();
    for result in [
        rig.host.navigate("https://example.com/").map(|_| ()),
        rig.host.back().map(|_| ()),
        rig.host.forward().map(|_| ()),
        rig.host.reload().map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err().code, AppErrorCode::Conflict);
    }
    assert_eq!(rig.host.capture_active(), None);
    // These are safe, and report state.
    rig.host.detach();
    rig.host.hide();
    rig.host.set_bounds(whole());
    let tabs = rig.host.show();
    assert!(!tabs.attached);
    assert!(tabs.tabs.is_empty());
    assert_eq!(tabs.active_tab_id, None);
}

// ---- the tabs themselves ----------------------------------------------------------------------

#[test]
fn a_new_tab_goes_to_the_front_and_only_the_front_tab_is_on_screen() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let tabs = rig.host.open_tab(Some("https://makerworld.com/")).unwrap();
    assert_eq!(rig.made(), 2);
    assert_eq!(rig.start_url(1), "https://makerworld.com/");
    assert_eq!(tabs.active_tab_id, Some(tabs.tabs[1].tab_id.clone()));
    assert_eq!(rig.view(0).last_visible(), Some(false));
    assert_eq!(rig.view(1).last_visible(), Some(true));
}

#[test]
fn selecting_a_tab_swaps_which_view_paints_and_an_unknown_id_changes_nothing() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    let first = rig.tab_ids()[0].clone();

    let tabs = rig.host.select_tab(&first);
    assert_eq!(tabs.active_tab_id.as_deref(), Some(first.as_str()));
    assert_eq!(rig.view(0).last_visible(), Some(true));
    assert_eq!(rig.view(1).last_visible(), Some(false));

    let tabs = rig.host.select_tab("tab-nope");
    assert_eq!(
        tabs.active_tab_id.as_deref(),
        Some(first.as_str()),
        "an id that is not there is ignored, not an error"
    );
}

#[test]
fn closing_a_tab_destroys_its_view_and_the_one_to_its_right_takes_over() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    rig.host.open_tab(None).unwrap();
    let ids = rig.tab_ids();
    rig.host.select_tab(&ids[1]);

    let tabs = rig.host.close_tab(&ids[1]).unwrap();

    assert_eq!(rig.view(1).closed.load(Ordering::SeqCst), 1);
    assert_eq!(tabs.tabs.len(), 2);
    assert_eq!(
        tabs.active_tab_id.as_deref(),
        Some(ids[2].as_str()),
        "the one to its right"
    );
    assert_eq!(rig.view(2).last_visible(), Some(true));
}

#[test]
fn closing_the_last_tab_opens_a_fresh_one_rather_than_leaving_a_browser_with_no_way_in() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let only = rig.tab_ids()[0].clone();

    let tabs = rig.host.close_tab(&only).unwrap();

    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 1);
    assert_eq!(tabs.tabs.len(), 1);
    assert_ne!(tabs.tabs[0].tab_id, only, "a new tab, not the old one");
    assert_eq!(rig.start_url(1), "https://www.thingiverse.com/");
}

#[test]
fn closing_a_tab_that_is_not_there_is_not_an_error() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let tabs = rig.host.close_tab("tab-nope").unwrap();
    assert_eq!(tabs.tabs.len(), 1);
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 0);
}

#[test]
fn the_cap_is_a_conflict_and_is_reported_before_the_button_is_pressed() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    for _ in 1..MAX_TABS {
        assert!(rig.host.open_tab(None).unwrap().can_open_more || rig.tab_ids().len() == MAX_TABS);
    }
    let tabs = rig.host.tabs();
    assert_eq!(tabs.tabs.len(), MAX_TABS);
    assert!(
        !tabs.can_open_more,
        "the page disables the control at the cap"
    );
    assert_eq!(
        rig.host.open_tab(None).unwrap_err().code,
        AppErrorCode::Conflict
    );
    assert_eq!(rig.made(), MAX_TABS, "no view was made for the refused one");
}

#[test]
fn closing_a_tab_with_a_download_in_flight_parks_its_view_until_the_download_ends() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    let ids = rig.tab_ids();
    rig.downloading.store(true, Ordering::SeqCst);

    rig.host.close_tab(&ids[0]).unwrap();

    let parked = rig.view(0);
    assert_eq!(
        parked.closed.load(Ordering::SeqCst),
        0,
        "closing it would cancel the download"
    );
    assert_eq!(parked.last_visible(), Some(false));
    assert_eq!(rig.tab_ids().len(), 1, "it is not a tab any more");
    rig.host.release_parked();
    assert_eq!(parked.closed.load(Ordering::SeqCst), 0, "still downloading");
    rig.downloading.store(false, Ordering::SeqCst);
    rig.host.release_parked();
    assert_eq!(parked.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn nothing_about_where_the_user_was_survives_the_process() {
    // There is no last-page file any more, so there is nothing to assert about its contents:
    // what is pinned here is that a commit writes nothing and keeps nothing to hand back.
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let id = rig.tab_ids()[0].clone();
    rig.host
        .on_committed(&id, "https://www.thingiverse.com/thing:1");

    let fresh = rig.rebuilt();
    fresh.host.attach(whole()).unwrap();
    assert_eq!(
        fresh.start_url(0),
        "https://www.thingiverse.com/",
        "a new process starts on the registry's page, not where the last one was"
    );
}

impl Rig {
    /// A second host over its own factory: what the next run of the app would see.
    fn rebuilt(&self) -> Rig {
        rig()
    }
}

// ---- bounds, hiding, and views that die ---------------------------------------------------------

#[test]
fn a_sub_minimum_request_hides_the_view_and_applies_no_new_rectangle() {
    let rig = rig();
    rig.host.attach(bounds(100.0, 200.0, 800.0, 500.0)).unwrap();
    let before = rig.view(0).rects.lock().unwrap().len();
    rig.host.set_bounds(bounds(300.0, 300.0, 1.0, 1.0));
    let view = rig.view(0);
    assert_eq!(view.last_visible(), Some(false));
    assert_eq!(
        view.rects.lock().unwrap().len(),
        before,
        "no rectangle was given"
    );
    // A real request puts it back.
    rig.host.set_bounds(bounds(100.0, 200.0, 800.0, 500.0));
    assert_eq!(view.last_visible(), Some(true));
}

#[test]
fn a_bounds_report_while_the_page_is_gone_is_ignored() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.detach();
    let view = rig.view(0);
    let rects = view.rects.lock().unwrap().len();
    rig.host.set_bounds(bounds(10.0, 10.0, 900.0, 700.0));
    assert_eq!(view.rects.lock().unwrap().len(), rects);
    assert_eq!(view.last_visible(), Some(false));
}

#[test]
fn a_window_resize_reapplies_the_last_reported_rectangle_recomputed_for_the_new_content_size() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let view = rig.view(0);
    let first = *view.rects.lock().unwrap().last().unwrap();
    *rig.window.size.lock().unwrap() = Some((1000.0, 700.0));
    rig.host.on_window_resized();
    let second = *view.rects.lock().unwrap().last().unwrap();
    assert_eq!(first.width, 1280.0 - 64.0);
    assert_eq!(second.width, 1000.0 - 64.0);
    assert_eq!(second.height, 700.0 - 100.0);
}

#[test]
fn hide_survives_the_bounds_reports_that_follow_it_and_show_puts_the_view_back() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let view = rig.view(0);
    rig.host.hide();
    assert_eq!(view.last_visible(), Some(false));
    rig.host.set_bounds(bounds(80.0, 200.0, 600.0, 400.0));
    rig.host.on_window_resized();
    assert_eq!(
        view.last_visible(),
        Some(false),
        "a report paints nothing while hidden"
    );
    let rects = view.rects.lock().unwrap().len();
    rig.host.show();
    assert_eq!(view.last_visible(), Some(true));
    assert_eq!(
        view.rects.lock().unwrap().len(),
        rects + 1,
        "the bounds were reapplied"
    );
}

#[test]
fn a_view_whose_contents_died_is_not_painted_hidden_or_moved() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let view = rig.view(0);
    view.dead.store(true, Ordering::SeqCst);
    let (rects, visibility) = (
        view.rects.lock().unwrap().len(),
        view.visibility.lock().unwrap().len(),
    );
    rig.host.set_bounds(bounds(80.0, 200.0, 600.0, 400.0));
    rig.host.hide();
    rig.host.show();
    assert_eq!(view.rects.lock().unwrap().len(), rects);
    assert_eq!(view.visibility.lock().unwrap().len(), visibility);
    assert!(
        !rig.host.is_attached(),
        "a dead view is not a browser that is open"
    );
}

// ---- policy ------------------------------------------------------------------------------------

#[test]
fn a_start_url_the_policy_refuses_is_an_error_not_a_quiet_fall_back_to_the_registry() {
    let rig = rig();
    for url in [
        "spm://app/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "not a url",
    ] {
        let error = rig.host.open_tab(Some(url)).unwrap_err();
        assert_eq!(error.code, AppErrorCode::Validation, "{url}");
    }
    assert_eq!(rig.made(), 0);
}

#[test]
fn navigate_refuses_a_blocked_url_in_the_main_process_and_loads_nothing() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let view = rig.view(0);
    for url in ["bambustudio://open?model=1", "file:///C:/x", "nope", ""] {
        assert_eq!(
            rig.host.navigate(url).unwrap_err().code,
            AppErrorCode::Validation,
            "{url}"
        );
    }
    assert!(view.loaded.lock().unwrap().is_empty());
    rig.host.navigate("https://example.com/ok").unwrap();
    assert_eq!(
        view.loaded.lock().unwrap().as_slice(),
        ["https://example.com/ok"]
    );
}

#[test]
fn a_navigation_the_policy_refuses_leaves_the_sentence_the_chrome_renders() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let _ = rig.host.navigate("bambustudio://open?model=1");
    let sentence = rig.active().last_error.unwrap();
    assert_eq!(
        sentence,
        "the model browser does not open bambustudio: URLs"
    );
    assert!(!sentence.contains("model=1"), "never the URL");
    rig.host.navigate("https://example.com/ok").unwrap();
    assert_eq!(rig.active().last_error, None);
}

#[test]
fn a_refusal_is_recorded_against_the_tab_it_happened_in_and_no_other() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    let ids = rig.tab_ids();

    assert!(!rig.host.on_navigation(&ids[0], "bambustudio://open"));

    let tabs = rig.host.tabs();
    let errors: Vec<Option<String>> = tabs.tabs.into_iter().map(|tab| tab.last_error).collect();
    assert!(errors[0].is_some(), "the tab it happened in");
    assert_eq!(errors[1], None, "and not the one in front");
}

#[test]
fn the_navigation_hook_refuses_blocked_schemes_and_allows_web_pages() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let id = rig.tab_ids()[0].clone();
    for (url, allowed) in [
        ("https://example.com/", true),
        ("http://example.com/", true),
        ("blob:https://example.com/x", true),
        ("data:text/html,x", true),
        ("about:blank", true),
        ("bambustudio://open?model=1", false),
        ("spm://app/", false),
        ("file:///C:/x", false),
        ("javascript:alert(1)", false),
        ("garbage", false),
    ] {
        assert_eq!(rig.host.on_navigation(&id, url), allowed, "{url}");
    }
}

#[test]
fn the_scheme_in_a_refusal_is_bounded_because_a_site_chooses_how_long_it_is() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let id = rig.tab_ids()[0].clone();
    let url = format!("{}://x/", "s".repeat(500));
    assert!(!rig.host.on_navigation(&id, &url));
    assert!(rig.active().last_error.unwrap().len() < 100);
}

#[test]
fn the_new_window_hook_navigates_in_place_denies_the_rest_and_never_opens_a_tab() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let id = rig.tab_ids()[0].clone();
    let view = rig.view(0);
    assert_eq!(
        rig.host.on_new_window(&id, "https://example.com/second"),
        WindowOutcome::Denied { navigated: true }
    );
    assert_eq!(
        view.loaded.lock().unwrap().as_slice(),
        ["https://example.com/second"]
    );
    // In the tab that asked, never a new one: a site must not be able to fill the strip.
    assert_eq!(rig.tab_ids().len(), 1);
    // A blob: window is the third download idiom and goes to the view, which downloads it.
    assert_eq!(
        rig.host.on_new_window(&id, "blob:https://example.com/zip"),
        WindowOutcome::Denied { navigated: true }
    );
    // The deferred about:blank popup has nothing to load: denied, and not an error to show.
    let loaded = view.loaded.lock().unwrap().len();
    assert_eq!(
        rig.host.on_new_window(&id, "about:blank"),
        WindowOutcome::Denied { navigated: false }
    );
    assert_eq!(rig.active().last_error, None);
    // A blocked scheme is refused with the sentence.
    assert_eq!(
        rig.host.on_new_window(&id, "bambustudio://open"),
        WindowOutcome::Denied { navigated: false }
    );
    assert!(rig.active().last_error.unwrap().contains("bambustudio:"));
    assert_eq!(view.loaded.lock().unwrap().len(), loaded);
}

#[test]
fn a_tab_names_the_site_its_url_belongs_to_and_reports_no_url_as_none_rather_than_empty() {
    let rig = rig();
    let idle = rig.host.tabs();
    assert!(!idle.attached);
    assert!(idle.tabs.is_empty());
    assert!(idle.can_open_more);

    rig.host.attach(whole()).unwrap();
    rig.host
        .navigate("https://www.printables.com/model/1-x")
        .unwrap();
    let state = rig.active();
    assert_eq!(state.site_id.as_deref(), Some("printables"));
    assert_eq!(
        state.url.as_deref(),
        Some("https://www.printables.com/model/1-x")
    );
    let view = rig.view(0);
    *view.current.lock().unwrap() = Some("https://example.com/".to_owned());
    assert_eq!(rig.active().site_id, None);
    *view.current.lock().unwrap() = Some(String::new());
    assert_eq!(rig.active().url, None, "an uncommitted view has no URL");
}

#[test]
fn a_load_that_fails_records_the_words_and_a_refusal_that_happened_first_outranks_them() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let id = rig.tab_ids()[0].clone();
    let view = rig.view(0);
    *view.fail_load.lock().unwrap() = Some("net::ERR_NAME_NOT_RESOLVED".to_owned());
    rig.host.navigate("https://nowhere.invalid/").unwrap();
    assert_eq!(
        rig.active().last_error.as_deref(),
        Some("net::ERR_NAME_NOT_RESOLVED")
    );
    // A refusal recorded while the load was under way is not overwritten by the failure that
    // follows it: "does not open bambustudio: URLs" beats the engine's error code.
    let host = Arc::clone(&rig.host);
    let during = id.clone();
    *view.during_load.lock().unwrap() = Some(Box::new(move || {
        host.on_navigation(&during, "bambustudio://open");
    }));
    *view.fail_load.lock().unwrap() = Some("net::ERR_FAILED".to_owned());
    rig.host.reload().unwrap();
    rig.host.navigate("https://example.com/redirects").unwrap();
    assert_eq!(
        rig.active().last_error.as_deref(),
        Some("the model browser does not open bambustudio: URLs")
    );
}

#[test]
fn back_forward_and_reload_reach_the_view_and_clear_the_last_error() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    let _ = rig.host.navigate("bambustudio://x");
    assert!(rig.active().last_error.is_some());
    rig.host.back().unwrap();
    assert_eq!(rig.active().last_error, None);
    rig.host.forward().unwrap();
    rig.host.reload().unwrap();
    assert_eq!(
        rig.view(0).calls.lock().unwrap().as_slice(),
        ["back", "forward", "reload"]
    );
}

// ---- the still picture ---------------------------------------------------------------------------

#[test]
fn the_capture_is_the_front_tabs_and_a_platform_that_cannot_do_it_is_not_an_error() {
    let rig = rig();
    rig.host.attach(whole()).unwrap();
    rig.host.open_tab(None).unwrap();
    *rig.view(0).png.lock().unwrap() = Some(vec![1, 2, 3]);
    *rig.view(1).png.lock().unwrap() = Some(vec![4, 5, 6]);

    assert_eq!(rig.host.capture_active(), Some(vec![4, 5, 6]));

    let ids = rig.tab_ids();
    rig.host.select_tab(&ids[0]);
    assert_eq!(rig.host.capture_active(), Some(vec![1, 2, 3]));

    *rig.view(0).png.lock().unwrap() = None;
    assert_eq!(
        rig.host.capture_active(),
        None,
        "no picture, and no failure: the dialog opens anyway"
    );
}
