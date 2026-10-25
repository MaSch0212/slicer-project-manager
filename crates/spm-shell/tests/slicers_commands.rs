//! The slicer commands: what the page may ask, how each argument is checked, and that a valid call
//! reaches the backend with its arguments in the right order. The slicer rows of the Electron
//! shell's `dispatch.test.ts`, re-targeted from IPC routes to commands.
//!
//! A recording backend stands in for the machine, so a refused call is proved to have reached
//! nothing; and the assembled subsystem is driven with no library open (the commands work in every
//! mode, because slicer configuration belongs to the computer and not to the library).

mod support;

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spm_core::dto::{
    DiscardedSessionsDto, FileDto, SlicerConfigDto, SlicerId, SlicerLaunchDto, SlicerLaunchMode,
    SlicerLaunchOptions, SlicerSessionDto,
};
use spm_core::{AppError, AppErrorCode};
use spm_shell::slicers::api::{SlicerBackend, SlicerCommands};
use spm_shell::slicers::host::SlicersHostOptions;
use spm_shell::slicers::service::{SlicerServices, SlicerServicesParts};
use spm_shell::slicers::sessions::SessionAction;
use support::slicers::{RecordingSpawner, StubRemote, machine};

#[derive(Default)]
struct Recording {
    calls: Mutex<Vec<String>>,
}

impl Recording {
    fn note(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn empty_config() -> SlicerConfigDto {
    SlicerConfigDto {
        installs: vec![],
        bindings: Default::default(),
        default_slicer_id: None,
        detection_supported: true,
    }
}

impl SlicerBackend for Recording {
    fn get(&self) -> Result<SlicerConfigDto, AppError> {
        self.note("get".to_owned());
        Ok(empty_config())
    }

    fn scan(&self) -> Result<SlicerConfigDto, AppError> {
        self.note("scan".to_owned());
        Ok(empty_config())
    }

    fn add_manual(&self, slicer_id: SlicerId) -> Result<Option<SlicerConfigDto>, AppError> {
        self.note(format!("add_manual {}", slicer_id.as_str()));
        Ok(None)
    }

    fn remove(&self, install_id: &str) -> Result<SlicerConfigDto, AppError> {
        self.note(format!("remove {install_id}"));
        Ok(empty_config())
    }

    fn bind(
        &self,
        slicer_id: SlicerId,
        install_id: Option<&str>,
    ) -> Result<SlicerConfigDto, AppError> {
        self.note(format!("bind {} {install_id:?}", slicer_id.as_str()));
        Ok(empty_config())
    }

    fn set_default(&self, slicer_id: Option<SlicerId>) -> Result<SlicerConfigDto, AppError> {
        self.note(format!("set_default {:?}", slicer_id.map(SlicerId::as_str)));
        Ok(empty_config())
    }

    fn reset_config(&self) -> Result<SlicerConfigDto, AppError> {
        self.note("reset_config".to_owned());
        Ok(empty_config())
    }

    fn open(
        &self,
        file_id: &str,
        project_id: &str,
        opts: &SlicerLaunchOptions,
    ) -> Result<SlicerLaunchDto, AppError> {
        self.note(format!(
            "open {file_id} {project_id} {:?} {:?}",
            opts.mode,
            opts.slicer_id.map(SlicerId::as_str)
        ));
        Ok(SlicerLaunchDto {
            launch_id: "launch".to_owned(),
            slicer_id: opts.slicer_id.unwrap_or(SlicerId::Orca),
            install_label: "OrcaSlicer".to_owned(),
            stripped: false,
            notices: vec![],
            pid: None,
        })
    }

    fn sessions(&self) -> Result<Vec<SlicerSessionDto>, AppError> {
        self.note("sessions".to_owned());
        Ok(vec![])
    }

    fn resolve_session(
        &self,
        launch_id: &str,
        action: SessionAction,
        project_id: Option<&str>,
    ) -> Result<Option<FileDto>, AppError> {
        self.note(format!(
            "resolve_session {launch_id} {action:?} {project_id:?}"
        ));
        Ok(None)
    }

    fn discard_sessions(&self, launch_ids: &[String]) -> Result<DiscardedSessionsDto, AppError> {
        self.note(format!("discard_sessions {launch_ids:?}"));
        Ok(DiscardedSessionsDto { discarded: 0 })
    }
}

fn commands() -> (SlicerCommands, Arc<Recording>) {
    let backend = Arc::new(Recording::default());
    (SlicerCommands::new(backend.clone()), backend)
}

fn v(value: Value) -> Option<Value> {
    Some(value)
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

#[test]
fn the_slicer_commands_reach_the_backend_with_their_arguments_in_the_right_order() {
    let (commands, backend) = commands();

    commands.get().unwrap();
    commands.scan().unwrap();
    commands
        .add_manual(v(json!("prusaslicer")).as_ref())
        .unwrap();
    commands
        .remove(v(json!("registry:HKLM:Bambu Studio")).as_ref())
        .unwrap();
    commands
        .bind(
            v(json!("cura")).as_ref(),
            v(json!("registry:HKLM:Cura")).as_ref(),
        )
        .unwrap();
    // `null` is "nothing": unbind, and no default.
    commands
        .bind(v(json!("cura")).as_ref(), v(Value::Null).as_ref())
        .unwrap();
    commands.set_default(v(json!("orca")).as_ref()).unwrap();
    commands.set_default(v(Value::Null).as_ref()).unwrap();
    commands.reset_config().unwrap();
    commands
        .open(
            v(json!("file-1")).as_ref(),
            v(json!("project-1")).as_ref(),
            v(json!({ "mode": "new-project", "slicerId": "bambu" })).as_ref(),
        )
        .unwrap();
    commands
        .open(
            v(json!("file-2")).as_ref(),
            v(json!("project-2")).as_ref(),
            v(json!({ "mode": "as-is" })).as_ref(),
        )
        .unwrap();
    commands.sessions().unwrap();
    commands
        .resolve_session(
            v(json!("launch-1")).as_ref(),
            v(json!("import")).as_ref(),
            v(json!("project-3")).as_ref(),
        )
        .unwrap();
    commands
        .resolve_session(
            v(json!("launch-2")).as_ref(),
            v(json!("discard")).as_ref(),
            None,
        )
        .unwrap();
    commands
        .discard_sessions(v(json!(["a", "b/c.3mf"])).as_ref())
        .unwrap();

    assert_eq!(
        backend.calls(),
        [
            "get",
            "scan",
            "add_manual prusaslicer",
            "remove registry:HKLM:Bambu Studio",
            "bind cura Some(\"registry:HKLM:Cura\")",
            "bind cura None",
            "set_default Some(\"orca\")",
            "set_default None",
            "reset_config",
            "open file-1 project-1 NewProject Some(\"bambu\")",
            "open file-2 project-2 AsIs None",
            "sessions",
            "resolve_session launch-1 Import Some(\"project-3\")",
            "resolve_session launch-2 Discard None",
            "discard_sessions [\"a\", \"b/c.3mf\"]",
        ]
    );
}

#[test]
fn a_command_rejects_a_wrong_argument_with_validation_and_calls_nothing() {
    let (commands, backend) = commands();
    let long = |n: usize| Value::String("x".repeat(n));
    let many: Vec<Value> = (0..501).map(|n| json!(format!("id-{n}"))).collect();

    let refused: Vec<(&str, Result<(), AppError>)> = vec![
        // A product that is not one of the five.
        (
            "unknown product",
            commands
                .add_manual(v(json!("superslicer")).as_ref())
                .map(drop),
        ),
        (
            "product not a string",
            commands.add_manual(v(json!(5)).as_ref()).map(drop),
        ),
        ("product absent", commands.add_manual(None).map(drop)),
        (
            "a prototype key",
            commands
                .add_manual(v(json!("__proto__")).as_ref())
                .map(drop),
        ),
        // Ids are bounded strings.
        (
            "install id empty",
            commands.remove(v(json!("")).as_ref()).map(drop),
        ),
        (
            "install id an object",
            commands.remove(v(json!({ "id": 1 })).as_ref()).map(drop),
        ),
        (
            "install id too long",
            commands.remove(v(long(513)).as_ref()).map(drop),
        ),
        // Binding: `null` is "none", an absent argument is a mistake.
        (
            "bind with no install argument",
            commands.bind(v(json!("cura")).as_ref(), None).map(drop),
        ),
        (
            "bind a number",
            commands
                .bind(v(json!("cura")).as_ref(), v(json!(3)).as_ref())
                .map(drop),
        ),
        (
            "bind a bad product",
            commands
                .bind(v(json!("nope")).as_ref(), v(Value::Null).as_ref())
                .map(drop),
        ),
        ("default absent", commands.set_default(None).map(drop)),
        (
            "default unknown",
            commands.set_default(v(json!("nope")).as_ref()).map(drop),
        ),
        // The one command that names a file names it by id twice, with a strict option object.
        (
            "open: file id too long",
            commands
                .open(
                    v(long(65)).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({ "mode": "as-is" })).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: project id missing",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    None,
                    v(json!({ "mode": "as-is" })).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: options missing",
            commands
                .open(v(json!("f")).as_ref(), v(json!("p")).as_ref(), None)
                .map(drop),
        ),
        (
            "open: options not an object",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!("as-is")).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: unknown mode",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({ "mode": "replace" })).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: no mode",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({})).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: an unknown key in a strict object",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({ "mode": "as-is", "localPath": "C:\\Windows\\win.ini" })).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: unknown slicer",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({ "mode": "as-is", "slicerId": "nope" })).as_ref(),
                )
                .map(drop),
        ),
        (
            "open: a null slicer is not 'not stated'",
            commands
                .open(
                    v(json!("f")).as_ref(),
                    v(json!("p")).as_ref(),
                    v(json!({ "mode": "as-is", "slicerId": null })).as_ref(),
                )
                .map(drop),
        ),
        // Sessions.
        (
            "resolve: unknown action",
            commands
                .resolve_session(v(json!("l")).as_ref(), v(json!("delete")).as_ref(), None)
                .map(drop),
        ),
        (
            "resolve: launch id empty",
            commands
                .resolve_session(v(json!("")).as_ref(), v(json!("discard")).as_ref(), None)
                .map(drop),
        ),
        (
            "resolve: launch id too long",
            commands
                .resolve_session(v(long(513)).as_ref(), v(json!("discard")).as_ref(), None)
                .map(drop),
        ),
        (
            "resolve: project id too long",
            commands
                .resolve_session(
                    v(json!("l")).as_ref(),
                    v(json!("import")).as_ref(),
                    v(long(65)).as_ref(),
                )
                .map(drop),
        ),
        (
            "discard: not a list",
            commands.discard_sessions(v(json!("a")).as_ref()).map(drop),
        ),
        ("discard: absent", commands.discard_sessions(None).map(drop)),
        (
            "discard: an oversized list",
            commands
                .discard_sessions(v(Value::Array(many)).as_ref())
                .map(drop),
        ),
        (
            "discard: a non-string id",
            commands
                .discard_sessions(v(json!(["a", 7])).as_ref())
                .map(drop),
        ),
    ];

    for (what, result) in refused {
        let error = result.expect_err(what);
        assert_eq!(error.code, AppErrorCode::Validation, "{what}: {error}");
    }
    assert!(
        backend.calls().is_empty(),
        "a refused call reached the backend: {:?}",
        backend.calls()
    );

    // And the boundary is where it was said to be: 500 ids and 512-character ids are accepted.
    let exactly: Vec<Value> = (0..500).map(|n| json!(format!("id-{n}"))).collect();
    commands
        .discard_sessions(v(Value::Array(exactly)).as_ref())
        .unwrap();
    commands.remove(v(long(512)).as_ref()).unwrap();
    assert_eq!(backend.calls().len(), 2);
}

// ---------------------------------------------------------------------------------------------
// The assembled subsystem with no library open
// ---------------------------------------------------------------------------------------------

/// Every slicer command answers with no library open, because none of them needs one: slicer
/// configuration is a property of the computer. (Launching needs a library or a server, and says
/// which it is missing.)
#[test]
fn every_slicer_command_answers_with_no_library_open_because_none_of_them_needs_one() {
    let env = support::slicers::Env::new();
    let data_dir = env.dir("data");
    let mut host = SlicersHostOptions::new(data_dir.join("slicers.json"));
    host.detection_supported = true;
    host.run = Arc::new(|| Ok("{\"registry\":[],\"msix\":[]}".to_owned()));
    host.warn = Arc::new(|_| {});
    let services = SlicerServices::new(SlicerServicesParts {
        data_dir,
        host,
        session: Arc::new(|| None),
        is_remote: Arc::new(|| false),
        remote: Arc::new(|| None),
        spawner: RecordingSpawner::new(),
        tune_sessions: None,
        tune_launcher: None,
    });
    let commands = SlicerCommands::new(services.clone());

    assert!(commands.get().unwrap().installs.is_empty());
    assert!(commands.scan().unwrap().installs.is_empty());
    assert_eq!(
        commands.add_manual(v(json!("cura")).as_ref()).unwrap(),
        None
    );
    assert_eq!(
        commands
            .bind(v(json!("cura")).as_ref(), v(Value::Null).as_ref())
            .unwrap()
            .bindings
            .len(),
        0
    );
    assert_eq!(
        commands
            .set_default(v(json!("orca")).as_ref())
            .unwrap()
            .default_slicer_id,
        Some(SlicerId::Orca)
    );
    assert!(commands.sessions().unwrap().is_empty());
    assert_eq!(
        commands
            .discard_sessions(v(json!([])).as_ref())
            .unwrap()
            .discarded,
        0
    );
    assert!(commands.reset_config().unwrap().installs.is_empty());
    // The launch is the one that needs somewhere to read the file from, and says which.
    let error = commands
        .open(
            v(json!("f")).as_ref(),
            v(json!("p")).as_ref(),
            v(json!({ "mode": "as-is" })).as_ref(),
        )
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("no library folder is open"));
    services.close();
}

#[test]
fn slicer_configuration_works_in_remote_mode_where_there_is_no_library() {
    // In remote mode the session is `None` by design and a launch reads the server instead; the
    // configuration, being about this computer, is the same call either way.
    let env = support::slicers::Env::new();
    let data_dir = env.dir("data");
    let mut host = SlicersHostOptions::new(data_dir.join("slicers.json"));
    host.warn = Arc::new(|_| {});
    let remote = StubRemote::new("https://library.invalid");
    let config = machine();
    spm_shell::slicers::config::write_config(&data_dir.join("slicers.json"), &config).unwrap();
    let services = SlicerServices::new(SlicerServicesParts {
        data_dir,
        host,
        session: Arc::new(|| None),
        is_remote: Arc::new(|| true),
        remote: Arc::new(move || {
            Some(remote.clone() as Arc<dyn spm_shell::slicers::remote_files::RemoteLibrary>)
        }),
        spawner: RecordingSpawner::new(),
        tune_sessions: None,
        tune_launcher: None,
    });

    let got = services.get().unwrap();
    assert_eq!(got.installs.len(), 5);
    assert_eq!(got.default_slicer_id, Some(SlicerId::Orca));
    let unbound = services.bind(SlicerId::Cura, None).unwrap();
    assert!(!unbound.bindings.contains_key(&SlicerId::Cura));
    services.close();
}

#[test]
fn launch_options_parse_exactly_to_the_two_modes() {
    // The pair the page sends, and nothing else, is what the launcher is ever asked.
    let parsed =
        spm_shell::slicers::api::parse_launch_options(Some(&json!({ "mode": "new-project" })))
            .unwrap();
    assert_eq!(parsed.mode, SlicerLaunchMode::NewProject);
    assert_eq!(parsed.slicer_id, None);
    let parsed = spm_shell::slicers::api::parse_launch_options(Some(
        &json!({ "mode": "as-is", "slicerId": "cura" }),
    ))
    .unwrap();
    assert_eq!(parsed.mode, SlicerLaunchMode::AsIs);
    assert_eq!(parsed.slicer_id, Some(SlicerId::Cura));
}
