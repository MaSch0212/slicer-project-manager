//! Ported from `browse-host.test.ts`: the view's lifecycle, who destroys what, and what the hooks
//! decide. The double records the calls the host makes and models **none** of the webview's
//! behaviour: nothing here navigates, nothing decides whether a bridge is injected, nothing knows
//! what a data directory does. A fake that answered those questions would test what its author
//! believed WebView2 does. Every property that is the webview's own is asserted against a real
//! window in `apps/desktop/tests/hidden_smoke.rs` and **nowhere else**.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use spm_core::AppError;
use spm_core::AppErrorCode;
use spm_core::dto::BrowseBounds;
use spm_shell::browse::bounds::Rect;
use spm_shell::browse::host::{
    BrowseHost, BrowseHostOptions, BrowseView, HostWindow, ViewFactory, WindowOutcome,
};
use spm_shell::browse::last_page::{BROWSE_FILE_NAME, read_last_page, write_last_page};
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

type Made = (Arc<FakeView>, String, Option<Rect>);

#[derive(Default)]
struct FakeFactory {
    made: Mutex<Vec<Made>>,
}

impl ViewFactory for FakeFactory {
    fn create(&self, start_url: &str, rect: Option<Rect>) -> Result<Arc<dyn BrowseView>, AppError> {
        let view = Arc::new(FakeView::default());
        *view.current.lock().unwrap() = Some(start_url.to_owned());
        self.made
            .lock()
            .unwrap()
            .push((Arc::clone(&view), start_url.to_owned(), rect));
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
    file: PathBuf,
    downloading: Arc<AtomicBool>,
    _dir: tempfile::TempDir,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(BROWSE_FILE_NAME);
    let factory = Arc::new(FakeFactory::default());
    let window = Arc::new(FakeWindow {
        size: Mutex::new(Some((1280.0, 860.0))),
    });
    let downloading = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&downloading);
    let host = BrowseHost::new(BrowseHostOptions {
        factory: factory.clone(),
        window: window.clone(),
        last_page_file: file.clone(),
        registry: Arc::new(SiteRegistry::standard()),
        downloads_running: Arc::new(move || flag.load(Ordering::SeqCst)),
    });
    Rig {
        host,
        factory,
        window,
        file,
        downloading,
        _dir: dir,
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

    fn made(&self) -> usize {
        self.factory.made.lock().unwrap().len()
    }
}

#[test]
fn attach_makes_exactly_one_view_on_the_start_url_inside_the_allowed_area() {
    let rig = rig();
    let state = rig
        .host
        .attach(bounds(100.0, 200.0, 800.0, 500.0), None)
        .unwrap();
    assert_eq!(rig.made(), 1);
    let made = rig.factory.made.lock().unwrap();
    assert_eq!(made[0].1, "https://www.thingiverse.com/");
    assert_eq!(
        made[0].2,
        Some(Rect {
            x: 100.0,
            y: 200.0,
            width: 800.0,
            height: 500.0
        })
    );
    assert!(state.attached);
    assert_eq!(state.title.as_deref(), Some("a title"));
}

#[test]
fn a_second_attach_destroys_the_first_view_before_making_the_second() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.host
        .attach(whole(), Some("https://example.com/second"))
        .unwrap();
    assert_eq!(rig.made(), 2);
    assert_eq!(
        rig.view(0).closed.load(Ordering::SeqCst),
        1,
        "the first is gone"
    );
    assert_eq!(rig.view(1).closed.load(Ordering::SeqCst), 0);
    assert_eq!(
        rig.factory.made.lock().unwrap()[1].1,
        "https://example.com/second"
    );
    assert!(rig.host.is_attached());
}

#[test]
fn detach_destroys_and_detaching_twice_is_not_an_error() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.host.detach();
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 1);
    assert!(!rig.host.state().attached);
    rig.host.detach();
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 1);
    assert!(!rig.host.is_attached());
}

#[test]
fn the_view_is_destroyed_when_the_host_window_closes() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.host.on_window_closed();
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 1);
    assert!(!rig.host.state().attached);
}

#[test]
fn attach_with_no_window_is_a_conflict_rather_than_a_view_with_nowhere_to_live() {
    let rig = rig();
    *rig.window.size.lock().unwrap() = None;
    let error = rig.host.attach(whole(), None).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert_eq!(rig.made(), 0);
}

#[test]
fn every_method_that_needs_a_view_says_conflict_when_there_is_none() {
    let rig = rig();
    for result in [
        rig.host.navigate("https://example.com/").map(|_| ()),
        rig.host.back().map(|_| ()),
        rig.host.forward().map(|_| ()),
        rig.host.reload().map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err().code, AppErrorCode::Conflict);
    }
    // These are safe, and report state.
    rig.host.detach();
    rig.host.hide();
    rig.host.set_bounds(whole());
    let state = rig.host.show();
    assert!(!state.attached);
    assert_eq!((state.url, state.title, state.site_id), (None, None, None));
}

#[test]
fn a_sub_minimum_request_hides_the_view_and_applies_no_new_rectangle() {
    let rig = rig();
    rig.host
        .attach(bounds(100.0, 200.0, 800.0, 500.0), None)
        .unwrap();
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
fn a_window_resize_reapplies_the_last_reported_rectangle_recomputed_for_the_new_content_size() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
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
    rig.host.attach(whole(), None).unwrap();
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
    rig.host.attach(whole(), None).unwrap();
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
        !rig.host.state().attached,
        "state reports detached and does not throw"
    );
}

#[test]
fn attach_opens_on_the_registry_then_the_remembered_page_then_what_it_was_asked_for() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    assert_eq!(
        rig.factory.made.lock().unwrap()[0].1,
        "https://www.thingiverse.com/"
    );
    write_last_page(&rig.file, "https://www.printables.com/model/1-x");
    rig.host.attach(whole(), None).unwrap();
    assert_eq!(
        rig.factory.made.lock().unwrap()[1].1,
        "https://www.printables.com/model/1-x"
    );
    rig.host
        .attach(whole(), Some("https://makerworld.com/"))
        .unwrap();
    assert_eq!(
        rig.factory.made.lock().unwrap()[2].1,
        "https://makerworld.com/"
    );
}

#[test]
fn a_start_url_the_policy_refuses_is_an_error_not_a_quiet_fall_back_to_the_registry() {
    let rig = rig();
    for url in [
        "spm://app/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "not a url",
    ] {
        let error = rig.host.attach(whole(), Some(url)).unwrap_err();
        assert_eq!(error.code, AppErrorCode::Validation, "{url}");
    }
    assert_eq!(rig.made(), 0);
}

#[test]
fn navigate_refuses_a_blocked_url_in_the_main_process_and_loads_nothing() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    let view = rig.view(0);
    for url in ["bambustudio://open?model=1", "file:///C:/x", "nope", ""] {
        assert_eq!(
            rig.host.navigate(url).unwrap_err().code,
            AppErrorCode::Validation
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
    rig.host.attach(whole(), None).unwrap();
    let _ = rig.host.navigate("bambustudio://open?model=1");
    let sentence = rig.host.state().last_error.unwrap();
    assert_eq!(
        sentence,
        "the model browser does not open bambustudio: URLs"
    );
    assert!(!sentence.contains("model=1"), "never the URL");
    rig.host.navigate("https://example.com/ok").unwrap();
    assert_eq!(rig.host.state().last_error, None);
}

#[test]
fn the_last_page_is_remembered_on_a_commit_and_only_for_http_and_clear_forgets_it() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.host.on_committed("https://www.thingiverse.com/thing:1");
    assert_eq!(
        read_last_page(&rig.file).as_deref(),
        Some("https://www.thingiverse.com/thing:1")
    );
    rig.host
        .on_committed("blob:https://www.thingiverse.com/ae5e");
    assert_eq!(
        read_last_page(&rig.file).as_deref(),
        Some("https://www.thingiverse.com/thing:1")
    );
    rig.host.clear_last_page();
    assert_eq!(read_last_page(&rig.file), None);
    assert!(!rig.file.exists());
    // The same page again after clearing is written again (the memory was cleared with the file).
    rig.host.on_committed("https://www.thingiverse.com/thing:1");
    assert!(read_last_page(&rig.file).is_some());
}

#[test]
fn the_navigation_hook_refuses_blocked_schemes_and_allows_web_pages() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
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
        assert_eq!(rig.host.on_navigation(url), allowed, "{url}");
    }
}

#[test]
fn the_scheme_in_a_refusal_is_bounded_because_a_site_chooses_how_long_it_is() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    let url = format!("{}://x/", "s".repeat(500));
    assert!(!rig.host.on_navigation(&url));
    assert!(rig.host.state().last_error.unwrap().len() < 100);
}

#[test]
fn the_new_window_hook_navigates_in_place_denies_the_rest_and_never_makes_a_window() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    let view = rig.view(0);
    assert_eq!(
        rig.host.on_new_window("https://example.com/second"),
        WindowOutcome::Denied { navigated: true }
    );
    assert_eq!(
        view.loaded.lock().unwrap().as_slice(),
        ["https://example.com/second"]
    );
    // A blob: window is the third download idiom and goes to the view, which downloads it.
    assert_eq!(
        rig.host.on_new_window("blob:https://example.com/zip"),
        WindowOutcome::Denied { navigated: true }
    );
    // The deferred about:blank popup has nothing to load: denied, and not an error to show.
    let loaded = view.loaded.lock().unwrap().len();
    assert_eq!(
        rig.host.on_new_window("about:blank"),
        WindowOutcome::Denied { navigated: false }
    );
    assert_eq!(rig.host.state().last_error, None);
    // A blocked scheme is refused with the sentence.
    assert_eq!(
        rig.host.on_new_window("bambustudio://open"),
        WindowOutcome::Denied { navigated: false }
    );
    assert!(
        rig.host
            .state()
            .last_error
            .unwrap()
            .contains("bambustudio:")
    );
    assert_eq!(view.loaded.lock().unwrap().len(), loaded);
}

#[test]
fn state_names_the_site_a_url_belongs_to_and_reports_no_url_as_none_rather_than_empty() {
    let rig = rig();
    let idle = rig.host.state();
    assert!(!idle.attached);
    assert_eq!(
        (
            idle.url,
            idle.title,
            idle.site_id,
            idle.last_error,
            idle.is_loading
        ),
        (None, None, None, None, false)
    );
    rig.host
        .attach(whole(), Some("https://www.printables.com/model/1-x"))
        .unwrap();
    let state = rig.host.state();
    assert_eq!(state.site_id.as_deref(), Some("printables"));
    assert_eq!(
        state.url.as_deref(),
        Some("https://www.printables.com/model/1-x")
    );
    let view = rig.view(0);
    *view.current.lock().unwrap() = Some("https://example.com/".to_owned());
    assert_eq!(rig.host.state().site_id, None);
    *view.current.lock().unwrap() = Some(String::new());
    assert_eq!(rig.host.state().url, None, "an uncommitted view has no URL");
}

#[test]
fn a_load_that_fails_records_the_words_and_a_refusal_that_happened_first_outranks_them() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    let view = rig.view(0);
    *view.fail_load.lock().unwrap() = Some("net::ERR_NAME_NOT_RESOLVED".to_owned());
    rig.host.navigate("https://nowhere.invalid/").unwrap();
    assert_eq!(
        rig.host.state().last_error.as_deref(),
        Some("net::ERR_NAME_NOT_RESOLVED")
    );
    // A refusal recorded while the load was under way is not overwritten by the failure that
    // follows it: "does not open bambustudio: URLs" beats the engine's error code.
    let host = Arc::clone(&rig.host);
    *view.during_load.lock().unwrap() = Some(Box::new(move || {
        host.on_navigation("bambustudio://open");
    }));
    *view.fail_load.lock().unwrap() = Some("net::ERR_FAILED".to_owned());
    rig.host.reload().unwrap();
    rig.host.navigate("https://example.com/redirects").unwrap();
    assert_eq!(
        rig.host.state().last_error.as_deref(),
        Some("the model browser does not open bambustudio: URLs")
    );
}

#[test]
fn back_forward_and_reload_reach_the_view_and_clear_the_last_error() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    let _ = rig.host.navigate("bambustudio://x");
    assert!(rig.host.state().last_error.is_some());
    rig.host.back().unwrap();
    assert_eq!(rig.host.state().last_error, None);
    rig.host.forward().unwrap();
    rig.host.reload().unwrap();
    assert_eq!(
        rig.view(0).calls.lock().unwrap().as_slice(),
        ["back", "forward", "reload"]
    );
}

#[test]
fn a_detach_with_a_download_in_flight_parks_the_view_and_the_end_of_the_download_destroys_it() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.downloading.store(true, Ordering::SeqCst);
    rig.host.detach();
    let view = rig.view(0);
    assert_eq!(
        view.closed.load(Ordering::SeqCst),
        0,
        "closing it would cancel the download"
    );
    assert_eq!(view.last_visible(), Some(false));
    assert!(!rig.host.is_attached(), "a parked view is not on screen");
    rig.host.release_parked();
    assert_eq!(view.closed.load(Ordering::SeqCst), 0, "still downloading");
    rig.downloading.store(false, Ordering::SeqCst);
    rig.host.release_parked();
    assert_eq!(view.closed.load(Ordering::SeqCst), 1);
    assert!(!rig.host.state().attached);
}

#[test]
fn an_attach_that_finds_a_parked_view_reuses_it_rather_than_killing_the_download() {
    let rig = rig();
    rig.host.attach(whole(), None).unwrap();
    rig.downloading.store(true, Ordering::SeqCst);
    rig.host.detach();
    let state = rig.host.attach(whole(), None).unwrap();
    assert!(state.attached);
    assert_eq!(rig.made(), 1, "no second view");
    assert_eq!(rig.view(0).closed.load(Ordering::SeqCst), 0);
    assert!(rig.host.is_attached());
    assert_eq!(rig.view(0).last_visible(), Some(true));
}
