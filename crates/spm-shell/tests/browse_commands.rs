//! Ported from the two browse rows of `dispatch.test.ts`: every command forwards its arguments in
//! order, and a wrong argument is a `Validation` that never reaches the browser.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::dto::{
    BrowseBounds, BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseTabsDto, FileDto,
    ModelSiteDto,
};
use spm_core::{AppError, AppErrorCode};
use spm_shell::browse::commands::{BrowseBackend, BrowseCommands, MAX_ID_LENGTH, MAX_URL_LENGTH};

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
}

fn idle() -> BrowseTabsDto {
    BrowseTabsDto {
        attached: false,
        tabs: Vec::new(),
        active_tab_id: None,
        can_open_more: true,
    }
}

impl Recorder {
    fn note(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

fn file() -> FileDto {
    serde_json::from_value(json!({
        "id": "f", "name": "n.zip", "kind": "other", "sizeBytes": 1,
        "previewState": "unsupported", "rawUrl": "/api/files/f/raw",
    }))
    .unwrap()
}

impl BrowseBackend for Recorder {
    fn sites(&self) -> Vec<ModelSiteDto> {
        self.note("sites".into());
        Vec::new()
    }

    fn attach(&self, bounds: BrowseBounds) -> Result<BrowseTabsDto, AppError> {
        self.note(format!("attach {bounds:?}"));
        Ok(idle())
    }

    fn detach(&self) {
        self.note("detach".into());
    }

    fn hide(&self) {
        self.note("hide".into());
    }

    fn show(&self) -> BrowseTabsDto {
        self.note("show".into());
        idle()
    }

    fn set_bounds(&self, bounds: BrowseBounds) {
        self.note(format!("set_bounds {bounds:?}"));
    }

    fn navigate(&self, url: &str) -> Result<BrowseTabsDto, AppError> {
        self.note(format!("navigate {url}"));
        Ok(idle())
    }

    fn back(&self) -> Result<BrowseTabsDto, AppError> {
        self.note("back".into());
        Ok(idle())
    }

    fn forward(&self) -> Result<BrowseTabsDto, AppError> {
        self.note("forward".into());
        Ok(idle())
    }

    fn reload(&self) -> Result<BrowseTabsDto, AppError> {
        self.note("reload".into());
        Ok(idle())
    }

    fn tabs(&self) -> BrowseTabsDto {
        self.note("tabs".into());
        idle()
    }

    fn open_tab(&self, url: Option<&str>) -> Result<BrowseTabsDto, AppError> {
        self.note(format!("open_tab {url:?}"));
        Ok(idle())
    }

    fn select_tab(&self, tab_id: &str) -> BrowseTabsDto {
        self.note(format!("select_tab {tab_id}"));
        idle()
    }

    fn close_tab(&self, tab_id: &str) -> Result<BrowseTabsDto, AppError> {
        self.note(format!("close_tab {tab_id}"));
        Ok(idle())
    }

    fn capture_active(&self) -> Option<Vec<u8>> {
        self.note("capture".into());
        Some(vec![0x89, b'P', b'N', b'G'])
    }

    fn downloads(&self) -> Vec<BrowseDownloadDto> {
        self.note("downloads".into());
        Vec::new()
    }

    fn notices(&self) -> Vec<BrowseNoticeDto> {
        self.note("notices".into());
        Vec::new()
    }

    fn dismiss_notice(&self, id: &str) {
        self.note(format!("dismiss {id}"));
    }

    fn land(
        &self,
        download_id: &str,
        project_id: &str,
        name: Option<&str>,
    ) -> Result<FileDto, AppError> {
        self.note(format!("land {download_id} {project_id} {name:?}"));
        Ok(file())
    }

    fn discard(&self, download_id: &str) -> Result<(), AppError> {
        self.note(format!("discard {download_id}"));
        Ok(())
    }

    fn decide(&self, download_id: &str, project_id: &str, file_name: &str) -> Result<(), AppError> {
        self.note(format!("decide {download_id} {project_id} {file_name}"));
        Ok(())
    }

    fn cancel(&self, download_id: &str) -> Result<(), AppError> {
        self.note(format!("cancel {download_id}"));
        Ok(())
    }

    fn match_page(&self, url: Option<&str>) -> Result<BrowseMatchDto, AppError> {
        self.note(format!("match {url:?}"));
        Ok(BrowseMatchDto {
            url: None,
            key: None,
            projects: Vec::new(),
        })
    }
}

fn rig() -> (BrowseCommands, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    (BrowseCommands::new(recorder.clone()), recorder)
}

fn calls(recorder: &Recorder) -> Vec<String> {
    recorder.calls.lock().unwrap().clone()
}

fn refused<T>(result: Result<T, AppError>) -> bool {
    matches!(result, Err(error) if error.code == AppErrorCode::Validation)
}

fn rect() -> Value {
    json!({"x": 10, "y": 120.5, "width": 800, "height": 600})
}

#[test]
fn every_browse_command_forwards_its_arguments_in_order_including_rectangles() {
    let (commands, recorder) = rig();
    commands.sites();
    commands.attach(Some(&rect())).unwrap();
    commands.detach();
    commands.hide();
    commands.show();
    commands.set_bounds(Some(&rect())).unwrap();
    commands
        .navigate(Some(&json!("https://example.com/a")))
        .unwrap();
    commands.back().unwrap();
    commands.forward().unwrap();
    commands.reload().unwrap();
    commands.tabs();
    commands
        .open_tab(Some(&json!("https://example.com/")))
        .unwrap();
    commands.open_tab(None).unwrap();
    commands.open_tab(Some(&Value::Null)).unwrap();
    commands.select_tab(Some(&json!("tab-2"))).unwrap();
    commands.close_tab(Some(&json!("tab-2"))).unwrap();
    assert_eq!(
        commands.capture_active().as_deref(),
        Some("data:image/png;base64,iVBORw==")
    );
    commands.downloads();
    commands.notices();
    commands.dismiss_notice(Some(&json!("n-1"))).unwrap();
    commands
        .land(Some(&json!("dl")), Some(&json!("p")), Some(&json!("x.zip")))
        .unwrap();
    commands
        .land(Some(&json!("dl")), Some(&json!("p")), Some(&Value::Null))
        .unwrap();
    commands.discard(Some(&json!("dl"))).unwrap();
    commands
        .decide(Some(&json!("dl")), Some(&json!("p")), Some(&json!("x.zip")))
        .unwrap();
    commands.cancel(Some(&json!("dl"))).unwrap();
    commands
        .match_page(Some(&json!("https://example.com/m")))
        .unwrap();
    commands.match_page(Some(&Value::Null)).unwrap();
    let bounds = "BrowseBounds { x: 10.0, y: 120.5, width: 800.0, height: 600.0 }";
    assert_eq!(
        calls(&recorder),
        [
            "sites".to_owned(),
            format!("attach {bounds}"),
            "detach".into(),
            "hide".into(),
            "show".into(),
            format!("set_bounds {bounds}"),
            "navigate https://example.com/a".into(),
            "back".into(),
            "forward".into(),
            "reload".into(),
            "tabs".into(),
            "open_tab Some(\"https://example.com/\")".into(),
            "open_tab None".into(),
            "open_tab None".into(),
            "select_tab tab-2".into(),
            "close_tab tab-2".into(),
            "capture".into(),
            "downloads".into(),
            "notices".into(),
            "dismiss n-1".into(),
            "land dl p Some(\"x.zip\")".into(),
            "land dl p None".into(),
            "discard dl".into(),
            "decide dl p x.zip".into(),
            "cancel dl".into(),
            "match Some(\"https://example.com/m\")".into(),
            "match None".into(),
        ]
    );
}

#[test]
fn a_browse_command_rejects_a_wrong_argument_with_validation_and_calls_nothing() {
    let (commands, recorder) = rig();
    let long_id = "x".repeat(MAX_ID_LENGTH * 4);
    let long_url = format!("https://e.com/{}", "a".repeat(MAX_URL_LENGTH));
    // Rectangles: missing, wrong type, non-finite or absurd numbers, negative sizes, unknown keys.
    for bad in [
        None,
        Some(Value::Null),
        Some(json!("rect")),
        Some(json!([1, 2, 3, 4])),
        Some(json!({"x": 1, "y": 2, "width": 3})),
        Some(json!({"x": "1", "y": 2, "width": 3, "height": 4})),
        Some(json!({"x": null, "y": 2, "width": 3, "height": 4})),
        Some(json!({"x": 1e300, "y": 2, "width": 3, "height": 4})),
        Some(json!({"x": 1, "y": 2, "width": -3, "height": 4})),
        Some(json!({"x": 1, "y": 2, "width": 3, "height": 4, "zoom": 2})),
    ] {
        assert!(refused(commands.set_bounds(bad.as_ref())), "{bad:?}");
        assert!(refused(commands.attach(bad.as_ref())), "{bad:?}");
    }
    // URLs.
    for bad in [
        None,
        Some(json!(5)),
        Some(json!("")),
        Some(json!("a\nb")),
        Some(json!(long_url)),
        Some(Value::Null),
    ] {
        assert!(refused(commands.navigate(bad.as_ref())), "{bad:?}");
    }
    assert!(refused(commands.open_tab(Some(&json!(5)))));
    assert!(refused(commands.open_tab(Some(&json!("")))));
    // A tab id is an id this process minted, so the same bounds apply as to any other.
    for bad in [None, Some(json!(5)), Some(json!("")), Some(Value::Null)] {
        assert!(refused(commands.select_tab(bad.as_ref())), "{bad:?}");
        assert!(refused(commands.close_tab(bad.as_ref())), "{bad:?}");
    }
    // A decision names two ids and a file name, each bounded like every other.
    for bad in [None, Some(json!(5)), Some(json!("")), Some(Value::Null)] {
        assert!(refused(commands.cancel(bad.as_ref())), "{bad:?}");
        assert!(
            refused(commands.decide(bad.as_ref(), Some(&json!("p")), Some(&json!("x.zip")))),
            "{bad:?}"
        );
        assert!(
            refused(commands.decide(Some(&json!("dl")), bad.as_ref(), Some(&json!("x.zip")))),
            "{bad:?}"
        );
        assert!(
            refused(commands.decide(Some(&json!("dl")), Some(&json!("p")), bad.as_ref())),
            "{bad:?}"
        );
    }
    assert!(refused(commands.match_page(None)), "absent is not null");
    assert!(refused(commands.match_page(Some(&json!(7)))));
    // Ids, which are looked up and never joined onto a path.
    for bad in [
        None,
        Some(json!(1)),
        Some(json!("")),
        Some(json!(long_id)),
        Some(Value::Null),
    ] {
        assert!(refused(commands.discard(bad.as_ref())), "{bad:?}");
        assert!(refused(commands.dismiss_notice(bad.as_ref())), "{bad:?}");
        assert!(refused(commands.land(
            bad.as_ref(),
            Some(&json!("p")),
            Some(&Value::Null)
        )));
        assert!(refused(commands.land(
            Some(&json!("d")),
            bad.as_ref(),
            Some(&Value::Null)
        )));
    }
    // The land options: a name is a string or null, and an absent one is a mistake.
    assert!(refused(commands.land(
        Some(&json!("d")),
        Some(&json!("p")),
        None
    )));
    assert!(refused(commands.land(
        Some(&json!("d")),
        Some(&json!("p")),
        Some(&json!(9))
    )));
    assert!(refused(commands.land(
        Some(&json!("d")),
        Some(&json!("p")),
        Some(&json!("n".repeat(256)))
    )));
    assert_eq!(
        calls(&recorder),
        Vec::<String>::new(),
        "nothing reached the browser"
    );
}
