//! Ported from the two browse rows of `dispatch.test.ts`: every command forwards its arguments in
//! order, and a wrong argument is a `Validation` that never reaches the browser.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::dto::{
    BrowseBounds, BrowseDownloadDto, BrowseMatchDto, BrowseNoticeDto, BrowseStateDto, FileDto,
    ModelSiteDto,
};
use spm_core::{AppError, AppErrorCode};
use spm_shell::browse::commands::{BrowseBackend, BrowseCommands, MAX_ID_LENGTH, MAX_URL_LENGTH};

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
}

fn idle() -> BrowseStateDto {
    BrowseStateDto {
        attached: false,
        url: None,
        title: None,
        is_loading: false,
        can_go_back: false,
        can_go_forward: false,
        site_id: None,
        last_error: None,
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

    fn attach(&self, bounds: BrowseBounds, url: Option<&str>) -> Result<BrowseStateDto, AppError> {
        self.note(format!("attach {bounds:?} {url:?}"));
        Ok(idle())
    }

    fn detach(&self) {
        self.note("detach".into());
    }

    fn hide(&self) {
        self.note("hide".into());
    }

    fn show(&self) -> BrowseStateDto {
        self.note("show".into());
        idle()
    }

    fn set_bounds(&self, bounds: BrowseBounds) {
        self.note(format!("set_bounds {bounds:?}"));
    }

    fn navigate(&self, url: &str) -> Result<BrowseStateDto, AppError> {
        self.note(format!("navigate {url}"));
        Ok(idle())
    }

    fn back(&self) -> Result<BrowseStateDto, AppError> {
        self.note("back".into());
        Ok(idle())
    }

    fn forward(&self) -> Result<BrowseStateDto, AppError> {
        self.note("forward".into());
        Ok(idle())
    }

    fn reload(&self) -> Result<BrowseStateDto, AppError> {
        self.note("reload".into());
        Ok(idle())
    }

    fn state(&self) -> BrowseStateDto {
        self.note("state".into());
        idle()
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

    fn match_page(&self, url: Option<&str>) -> Result<BrowseMatchDto, AppError> {
        self.note(format!("match {url:?}"));
        Ok(BrowseMatchDto {
            url: None,
            key: None,
            projects: Vec::new(),
        })
    }

    fn clear_last_page(&self) {
        self.note("clear".into());
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
    commands
        .attach(Some(&rect()), Some(&json!("https://example.com/")))
        .unwrap();
    commands.attach(Some(&rect()), None).unwrap();
    commands.attach(Some(&rect()), Some(&Value::Null)).unwrap();
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
    commands.state();
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
        .match_page(Some(&json!("https://example.com/m")))
        .unwrap();
    commands.match_page(Some(&Value::Null)).unwrap();
    commands.clear_last_page();
    let bounds = "BrowseBounds { x: 10.0, y: 120.5, width: 800.0, height: 600.0 }";
    assert_eq!(
        calls(&recorder),
        [
            "sites".to_owned(),
            format!("attach {bounds} Some(\"https://example.com/\")"),
            format!("attach {bounds} None"),
            format!("attach {bounds} None"),
            "detach".into(),
            "hide".into(),
            "show".into(),
            format!("set_bounds {bounds}"),
            "navigate https://example.com/a".into(),
            "back".into(),
            "forward".into(),
            "reload".into(),
            "state".into(),
            "downloads".into(),
            "notices".into(),
            "dismiss n-1".into(),
            "land dl p Some(\"x.zip\")".into(),
            "land dl p None".into(),
            "discard dl".into(),
            "match Some(\"https://example.com/m\")".into(),
            "match None".into(),
            "clear".into(),
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
        assert!(refused(commands.attach(bad.as_ref(), None)), "{bad:?}");
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
    assert!(refused(commands.attach(Some(&rect()), Some(&json!(5)))));
    assert!(refused(commands.attach(Some(&rect()), Some(&json!("")))));
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
