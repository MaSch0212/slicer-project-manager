//! The configuration operations, end to end against a real `slicers.json`, with the subprocess and
//! the native dialog injected. A port of the Electron shell's `slicers-host.test.ts`, case for case.
//!
//! Nothing here needs PowerShell or Windows: the whole point of both seams. The document the fake
//! subprocess returns is the fixture the parse suite uses, so a change that breaks the parse breaks
//! this too rather than being papered over by a hand-built install list.

mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spm_core::AppError;
use spm_core::AppErrorCode;
use spm_core::dto::{SlicerConfigDto, SlicerId, SlicerInstallOrigin, SlicerInstallState};
use spm_core::error::DETECTION_FAILED;
use spm_shell::slicers::config::{SLICERS_CONFIG_VERSION, SLICERS_FILE_NAME};
use spm_shell::slicers::detect::RunDetection;
use spm_shell::slicers::host::{SlicersHost, SlicersHostOptions};
use tempfile::TempDir;

const FIXTURE: &str = include_str!("fixtures/slicer-detection.json");

const CURA_12: &str = "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0";
const CURA_13: &str = "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0";
const ORCA: &str = "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g";

struct Case {
    root: TempDir,
    host: SlicersHost,
    file: PathBuf,
    warnings: Arc<Mutex<Vec<String>>>,
}

fn runner(text: &'static str) -> RunDetection {
    Arc::new(move || Ok(text.to_owned()))
}

fn counting_runner(counter: Arc<AtomicUsize>, text: &'static str) -> RunDetection {
    Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        Ok(text.to_owned())
    })
}

impl Case {
    fn new() -> Case {
        Case::with(|_| {})
    }

    fn with(configure: impl FnOnce(&mut SlicersHostOptions)) -> Case {
        let root = tempfile::Builder::new()
            .prefix("spm-slicers-host-")
            .tempdir()
            .unwrap();
        let file = root.path().join("case").join(SLICERS_FILE_NAME);
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let mut options = SlicersHostOptions::new(file.clone());
        options.run = runner(FIXTURE);
        // Every path the fixture names, as though it were on the machine the spike ran on.
        options.io = Arc::new(|path: &str| path.to_lowercase().ends_with(".exe"));
        options.detection_supported = true;
        options.now = Arc::new(|| 1_756_382_400_000);
        let sink = Arc::clone(&warnings);
        options.warn = Arc::new(move |message: &str| sink.lock().unwrap().push(message.to_owned()));
        configure(&mut options);
        Case {
            host: SlicersHost::new(options),
            root,
            file,
            warnings,
        }
    }

    /// A real file, so the manual entry's existence check has something to find.
    fn real_exe(&self, name: &str) -> String {
        let dir = self.root.path().join("exe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "MZ").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn stored(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.file).unwrap()).unwrap()
    }
}

fn binding(config: &SlicerConfigDto, slicer_id: SlicerId) -> Option<&str> {
    config.bindings.get(&slicer_id).map(String::as_str)
}

fn picks(path: Option<String>) -> spm_shell::slicers::host::ExecutablePicker {
    Arc::new(move |_| path.clone())
}

// ---------------------------------------------------------------------------------------------
// get and scan
// ---------------------------------------------------------------------------------------------

#[test]
fn a_product_can_be_unbound_and_a_default_can_be_cleared() {
    let case = Case::new();
    let scanned = case.host.scan().unwrap();
    // Anycubic has exactly one install in the fixture, so the scan bound it without being asked,
    // which is the whole reason there has to be a way back. `remove` is not one: the install is
    // still installed, so the next scan finds it and binds it again for being the only one.
    assert!(binding(&scanned, SlicerId::Anycubic).is_some());
    case.host.set_default(Some(SlicerId::Anycubic)).unwrap();

    let unbound = case.host.bind(SlicerId::Anycubic, None).unwrap();
    assert_eq!(binding(&unbound, SlicerId::Anycubic), None);
    // Removed from the map rather than set to `null`: every reader treats *absent* as unbound.
    assert!(
        !case.stored()["bindings"]
            .as_object()
            .unwrap()
            .contains_key("anycubic")
    );
    // Unbinding a product does not touch the others, or the default, which names a product.
    assert_eq!(
        binding(&unbound, SlicerId::Prusaslicer),
        binding(&scanned, SlicerId::Prusaslicer)
    );
    assert_eq!(unbound.default_slicer_id, Some(SlicerId::Anycubic));

    assert_eq!(case.host.set_default(None).unwrap().default_slicer_id, None);
    // And it stuck: both are reads of the file, not of an object this call happened to return.
    assert_eq!(case.host.get().default_slicer_id, None);
    assert_eq!(binding(&case.host.get(), SlicerId::Anycubic), None);
}

#[test]
fn before_any_scan_there_is_nothing_configured_and_no_subprocess_has_run() {
    let runs = Arc::new(AtomicUsize::new(0));
    let case = Case::with(|options| options.run = counting_runner(Arc::clone(&runs), FIXTURE));

    let config = case.host.get();
    assert!(config.installs.is_empty());
    assert!(config.bindings.is_empty());
    assert_eq!(config.default_slicer_id, None);
    assert!(config.detection_supported);
    // Detection is on demand and never at start-up: 880 ms before the user has asked for anything.
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

#[test]
fn a_scan_writes_what_it_found_and_reads_back_the_same() {
    let case = Case::new();
    let scanned = case.host.scan().unwrap();

    assert_eq!(scanned.installs.len(), 6);
    assert_eq!(case.host.get(), scanned);
    assert_eq!(case.stored()["version"], SLICERS_CONFIG_VERSION);
}

#[test]
fn a_scan_binds_the_products_with_one_install_and_leaves_cura_for_the_user() {
    let case = Case::new();
    let config = case.host.scan().unwrap();

    assert_eq!(
        binding(&config, SlicerId::Cura),
        None,
        "two Curas is a question, not an answer"
    );
    let expected: std::collections::BTreeMap<SlicerId, String> = [
        (SlicerId::Anycubic, "registry:HKLM:AnycubicSlicerNext"),
        (SlicerId::Bambu, "registry:HKLM:Bambu Studio"),
        (SlicerId::Prusaslicer, "registry:HKLM:PrusaSlicer_is1"),
        (SlicerId::Orca, ORCA),
    ]
    .into_iter()
    .map(|(slicer, id)| (slicer, id.to_owned()))
    .collect();
    assert_eq!(config.bindings, expected);
}

/// The machine with no slicers on it: the path the spike could not exercise against a real
/// negative, and so the one most likely to be wrong. Every consumer is driven, not just `scan`.
#[test]
fn a_machine_with_nothing_installed_produces_an_empty_configuration_that_everything_survives() {
    let case = Case::with(|options| options.run = runner("{\"registry\":[],\"msix\":[]}"));

    let empty = |default: Option<SlicerId>| SlicerConfigDto {
        installs: vec![],
        bindings: Default::default(),
        default_slicer_id: default,
        detection_supported: true,
    };
    assert_eq!(case.host.scan().unwrap(), empty(None));
    assert_eq!(case.host.get(), empty(None));
    assert_eq!(case.host.reset_config().unwrap(), empty(None));
    assert_eq!(
        case.host.set_default(Some(SlicerId::Cura)).unwrap(),
        empty(Some(SlicerId::Cura))
    );
    assert_eq!(
        case.host.remove("anything").unwrap_err().code,
        AppErrorCode::NotFound
    );
    assert_eq!(
        case.host
            .bind(SlicerId::Cura, Some("anything"))
            .unwrap_err()
            .code,
        AppErrorCode::NotFound
    );
    assert_eq!(
        case.host.resolve_install("anything").unwrap_err().code,
        AppErrorCode::NotFound
    );
    // A cancelled dialog is not an error, and an empty file is not a reason to make one.
    assert_eq!(case.host.add_manual(SlicerId::Cura).unwrap(), None);
    // The file is real and readable after all of that.
    assert_eq!(case.stored()["version"], SLICERS_CONFIG_VERSION);
}

#[test]
fn off_windows_detection_does_not_run_and_the_ui_is_told_so() {
    let runs = Arc::new(AtomicUsize::new(0));
    let case = Case::with(|options| {
        options.detection_supported = false;
        options.run = counting_runner(Arc::clone(&runs), FIXTURE);
    });

    assert!(!case.host.get().detection_supported);
    let scanned = case.host.scan().unwrap();
    assert_eq!(
        runs.load(Ordering::SeqCst),
        0,
        "nothing must be spawned on a platform with no mechanism"
    );
    assert!(scanned.installs.is_empty());
    assert!(!scanned.detection_supported);
}

// ---------------------------------------------------------------------------------------------
// The file this build cannot read
// ---------------------------------------------------------------------------------------------

/// **A downgrade must not eat a newer configuration**, and the assertion is on the bytes. A `scan`
/// that returned an empty config and then wrote it would satisfy every assertion about the return
/// value while destroying the file.
#[test]
fn a_slicers_json_from_a_newer_build_survives_a_scan_byte_for_byte() {
    let runs = Arc::new(AtomicUsize::new(0));
    let case = Case::with(|options| options.run = counting_runner(Arc::clone(&runs), FIXTURE));
    std::fs::create_dir_all(case.file.parent().unwrap()).unwrap();
    let future = format!(
        "{}\n",
        serde_json::to_string_pretty(
            &json!({ "version": 2, "installs": [{ "shape": "unknown" }] })
        )
        .unwrap()
    );
    std::fs::write(&case.file, &future).unwrap();

    let error = case.host.scan().unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("newer version"), "{}", error.message);
    // Before the subprocess, not after it: the refusal is knowable from the file, and spending
    // 880 ms and a PowerShell process to reach it made the user press the button again.
    assert_eq!(
        runs.load(Ordering::SeqCst),
        0,
        "detection ran for an answer that was already decided"
    );
    assert_eq!(
        std::fs::read_to_string(&case.file).unwrap(),
        future,
        "the file was overwritten"
    );

    // And it is not just `scan`: every write refuses.
    let writes: Vec<Result<SlicerConfigDto, AppError>> = vec![
        case.host.set_default(Some(SlicerId::Cura)),
        case.host.bind(SlicerId::Cura, Some(CURA_12)),
        case.host.remove(CURA_12),
    ];
    for write in writes {
        assert!(write.is_err());
        assert_eq!(std::fs::read_to_string(&case.file).unwrap(), future);
    }

    // `get` says there is nothing configured rather than failing: the app runs, the feature does
    // not, and the user is told which.
    assert!(case.host.get().installs.is_empty());

    // `reset_config` is the way out, and the only one.
    assert!(case.host.reset_config().unwrap().installs.is_empty());
    assert_ne!(std::fs::read_to_string(&case.file).unwrap(), future);
    assert_eq!(case.host.scan().unwrap().installs.len(), 6);
}

// ---------------------------------------------------------------------------------------------
// bind, set_default, remove
// ---------------------------------------------------------------------------------------------

#[test]
fn binding_a_product_to_one_of_its_installs_and_a_rescan_leaving_that_alone() {
    let case = Case::new();
    case.host.scan().unwrap();

    let bound = case.host.bind(SlicerId::Cura, Some(CURA_12)).unwrap();
    assert_eq!(binding(&bound, SlicerId::Cura), Some(CURA_12));

    // A second scan sees both Curas again and must not prefer the newer one.
    assert_eq!(
        binding(&case.host.scan().unwrap(), SlicerId::Cura),
        Some(CURA_12)
    );
    assert_eq!(
        binding(
            &case.host.bind(SlicerId::Cura, Some(CURA_13)).unwrap(),
            SlicerId::Cura
        ),
        Some(CURA_13),
        "the user may change their mind"
    );
}

#[test]
fn a_product_cannot_be_bound_to_another_product_install_or_to_one_that_is_not_there() {
    let case = Case::new();
    case.host.scan().unwrap();

    let wrong_product = case.host.bind(SlicerId::Orca, Some(CURA_12)).unwrap_err();
    assert_eq!(wrong_product.code, AppErrorCode::Validation);
    assert!(
        wrong_product.message.contains("is cura, not orca"),
        "{}",
        wrong_product.message
    );

    let missing = case
        .host
        .bind(SlicerId::Cura, Some("manual:nope"))
        .unwrap_err();
    assert_eq!(missing.code, AppErrorCode::NotFound);
    // Neither wrote anything.
    assert_eq!(binding(&case.host.get(), SlicerId::Cura), None);
}

#[test]
fn the_default_is_a_product_and_is_not_gated_on_a_binding_existing() {
    let case = Case::new();
    case.host.scan().unwrap();
    assert_eq!(
        case.host
            .set_default(Some(SlicerId::Cura))
            .unwrap()
            .default_slicer_id,
        Some(SlicerId::Cura)
    );
    // Cura has two installs and so no binding: the default is still allowed, and the honest
    // refusal comes at launch rather than at the moment of a setting that would not stick.
    assert_eq!(binding(&case.host.get(), SlicerId::Cura), None);
    assert_eq!(
        case.host
            .set_default(Some(SlicerId::Orca))
            .unwrap()
            .default_slicer_id,
        Some(SlicerId::Orca)
    );
}

#[test]
fn removing_an_install_takes_its_binding_with_it_and_leaves_the_default_alone() {
    let case = Case::new();
    case.host.scan().unwrap();
    case.host.set_default(Some(SlicerId::Orca)).unwrap();

    let after = case.host.remove(ORCA).unwrap();
    assert!(!after.installs.iter().any(|install| install.id == ORCA));
    assert_eq!(
        binding(&after, SlicerId::Orca),
        None,
        "a binding to an install that is gone is not one"
    );
    // The default names a *product*, and the user may bind that product to something else next.
    assert_eq!(after.default_slicer_id, Some(SlicerId::Orca));
    // Other bindings are untouched.
    assert_eq!(
        binding(&after, SlicerId::Bambu),
        Some("registry:HKLM:Bambu Studio")
    );
}

#[test]
fn removing_something_that_is_not_there_is_not_found_not_a_silent_success() {
    let case = Case::new();
    case.host.scan().unwrap();
    assert_eq!(
        case.host.remove("manual:never").unwrap_err().code,
        AppErrorCode::NotFound
    );
}

// ---------------------------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------------------------

#[test]
fn a_manual_entry_records_the_path_the_user_chose_verbatim_and_binds_it_if_it_is_the_only_one() {
    let probe = Case::new();
    let exe = probe.real_exe("my-own-slicer-build.exe");
    let case = Case::with(|options| options.pick_executable = picks(Some(exe.clone())));

    let config = case
        .host
        .add_manual(SlicerId::Prusaslicer)
        .unwrap()
        .unwrap();
    let install = &config.installs[0];
    assert_eq!(
        Path::new(&install.path),
        Path::new(&exe),
        "the path is used verbatim; the user named it"
    );
    assert_eq!(install.origin, SlicerInstallOrigin::Manual);
    assert_eq!(install.slicer_id, SlicerId::Prusaslicer);
    // Never read from the executable: Cura's and Orca's version resources are empty.
    assert_eq!(install.version, None);
    assert!(install.id.starts_with("manual:"));
    assert_eq!(
        binding(&config, SlicerId::Prusaslicer),
        Some(install.id.as_str())
    );
}

#[test]
fn a_cancelled_dialog_is_none_and_writes_nothing_at_all() {
    let case = Case::with(|options| options.pick_executable = picks(None));

    assert_eq!(case.host.add_manual(SlicerId::Cura).unwrap(), None);
    assert!(!case.file.exists());
}

#[test]
fn a_picked_file_that_is_not_there_is_refused_rather_than_stored() {
    let probe = Case::new();
    let gone = probe
        .root
        .path()
        .join("no-such-dir")
        .join("slicer.exe")
        .to_string_lossy()
        .into_owned();
    let case = Case::with(|options| options.pick_executable = picks(Some(gone.clone())));

    assert_eq!(
        case.host.add_manual(SlicerId::Cura).unwrap_err().code,
        AppErrorCode::NotFound
    );
    assert!(case.host.get().installs.is_empty());
}

#[test]
fn a_manual_entry_does_not_re_point_a_binding_the_user_already_made() {
    let probe = Case::new();
    let exe = probe.real_exe("another-cura.exe");
    let case = Case::with(|options| options.pick_executable = picks(Some(exe.clone())));
    case.host.scan().unwrap();
    case.host.bind(SlicerId::Cura, Some(CURA_13)).unwrap();

    let config = case.host.add_manual(SlicerId::Cura).unwrap().unwrap();
    assert_eq!(binding(&config, SlicerId::Cura), Some(CURA_13));
    assert_eq!(config.installs.len(), 7);
}

/// The page can call this in a loop; nothing between it and the dialog serializes anything.
/// Unbounded native dialogs are how a user is trained to dismiss the one question that matters.
#[test]
fn two_dialogs_cannot_be_stacked_the_same_product_waits_a_different_one_is_refused() {
    let probe = Case::new();
    let exe = probe.real_exe("portable-cura.exe");
    let opened = Arc::new(AtomicUsize::new(0));
    let (release, gate) = mpsc::channel::<()>();
    let gate = Arc::new(Mutex::new(gate));
    let (entered_tx, entered) = mpsc::channel::<()>();
    let entered_tx = Mutex::new(entered_tx);
    let counter = Arc::clone(&opened);
    let case = Arc::new(Case::with(|options| {
        let exe = exe.clone();
        options.pick_executable = Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            let _ = entered_tx.lock().unwrap().send(());
            let _ = gate.lock().unwrap().recv();
            Some(exe.clone())
        });
    }));

    let first = {
        let case = Arc::clone(&case);
        std::thread::spawn(move || case.host.add_manual(SlicerId::Cura))
    };
    // The first dialog is open (the picker has been entered) before anything else is asked.
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    let second = {
        let case = Arc::clone(&case);
        std::thread::spawn(move || case.host.add_manual(SlicerId::Cura))
    };
    // A different product is refused outright, at once, with the dialog still open.
    assert_eq!(
        case.host.add_manual(SlicerId::Orca).unwrap_err().code,
        AppErrorCode::Conflict
    );
    std::thread::sleep(Duration::from_millis(150));
    release.send(()).unwrap();

    let a = first.join().unwrap().unwrap();
    let b = second.join().unwrap().unwrap();
    assert_eq!(
        opened.load(Ordering::SeqCst),
        1,
        "only one dialog was ever opened"
    );
    assert_eq!(a, b);
    assert_eq!(a.unwrap().installs.len(), 1);

    // And the guard is released: a later call opens a dialog again.
    release.send(()).unwrap();
    case.host.add_manual(SlicerId::Orca).unwrap();
    assert_eq!(opened.load(Ordering::SeqCst), 2);
}

// ---------------------------------------------------------------------------------------------
// When the subprocess itself fails
// ---------------------------------------------------------------------------------------------

/// A timed-out PowerShell, a `powershell.exe` that is not there and an overflowed buffer all arrive
/// as a plain error. Left alone that would reach the page as an `Internal` it can neither phrase
/// nor switch on.
#[test]
fn a_detection_that_cannot_run_is_internal_with_a_reason_and_writes_nothing() {
    let case = Case::with(|options| {
        options.run = Arc::new(|| Err("spawn powershell.exe ETIMEDOUT".to_owned()));
    });

    let error = case.host.scan().unwrap_err();

    assert_eq!(error.code, AppErrorCode::Internal);
    assert_eq!(
        error.message,
        "could not look for slicers installed on this machine"
    );
    let details = error.details.as_ref().unwrap();
    assert_eq!(details["reason"], DETECTION_FAILED);
    // The underlying failure is kept, but out of the sentence the user is shown.
    assert!(details["cause"].as_str().unwrap().contains("ETIMEDOUT"));
    assert!(!error.message.contains("ETIMEDOUT"));
    assert_eq!(case.warnings.lock().unwrap().len(), 1);

    // Nothing was written: a scan that did not run has nothing to say about the file.
    assert!(!case.file.exists());
}

/// **A detection that fails is not an install that is gone**, and this is the assertion that keeps
/// those apart. The tempting shape is for the re-resolver to answer `None` on any failure; `None`
/// means "the mechanism ran and did not find this", which marks the install `missing` **and writes
/// that to disk**: one timed-out PowerShell would leave the user with a slicer the app believes is
/// uninstalled, to be un-broken by hand.
#[test]
fn a_failed_re_resolution_leaves_the_install_alone_rather_than_recording_it_as_gone() {
    let probe = Case::new();
    let imagined = probe
        .root
        .path()
        .join("never-created")
        .join("bambu-studio.exe")
        .to_string_lossy()
        .into_owned();
    let document = bambu_document(&imagined);
    let runs = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&runs);
    let case = Case::with(|options| {
        // The first run is the scan and succeeds; the second is the re-resolution and does not.
        options.run = Arc::new(move || {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(document.clone())
            } else {
                Err("spawn powershell.exe ENOENT".to_owned())
            }
        });
        options.io = Arc::new(|_: &str| true);
    });
    case.host.scan().unwrap();
    let before = std::fs::read_to_string(&case.file).unwrap();

    let error = case
        .host
        .resolve_install("registry:HKLM:Bambu Studio")
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Internal);
    assert_eq!(error.details.as_ref().unwrap()["reason"], DETECTION_FAILED);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    // Not `NotFound`, and (the half that matters) not marked missing on disk either.
    assert_eq!(
        std::fs::read_to_string(&case.file).unwrap(),
        before,
        "slicers.json was written on a failed scan"
    );
    assert_eq!(case.host.get().installs[0].state, SlicerInstallState::Ok);
}

fn bambu_document(display_icon: &str) -> String {
    json!({
        "registry": [{
            "hive": "HKLM",
            "key": "Bambu Studio",
            "displayName": "Bambu Studio",
            "displayVersion": "02.08.02.61",
            "displayIcon": display_icon,
        }],
        "msix": [],
    })
    .to_string()
}

// ---------------------------------------------------------------------------------------------
// resolve_install
// ---------------------------------------------------------------------------------------------

/// A **registry** row, not the MSIX one: `resolve_install` `stat`s the path it ends up with on the
/// *real* filesystem, so this test needs a path that really exists, and the MSIX half builds its
/// path with a Windows join on purpose. A registry row carries its executable path verbatim.
#[test]
fn resolve_install_re_resolves_a_stale_hint_through_one_subprocess_and_rewrites_the_file() {
    let probe = Case::new();
    let exe = probe.real_exe("bambu-studio.exe");
    let id = "registry:HKLM:Bambu Studio";
    let runs = Arc::new(AtomicUsize::new(0));
    // A document that names a path this suite actually created, so the whole chain (subprocess,
    // parse, validation, rewrite) runs rather than being stubbed in the middle.
    let document = bambu_document(&exe);
    let counter = Arc::clone(&runs);
    let wanted = exe.clone();
    let case = Case::with(|options| {
        options.run = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(document.clone())
        });
        options.io = Arc::new(move |path: &str| path == wanted);
    });
    case.host.scan().unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    // Now the install moves: rewrite the stored hint to somewhere that is not there.
    let mut stored = case.stored();
    stored["installs"][0]["pathHint"] = json!(
        case.root
            .path()
            .join("gone")
            .join("bambu-studio.exe")
            .to_string_lossy()
    );
    std::fs::write(&case.file, stored.to_string()).unwrap();

    let (_, path) = case.host.resolve_install(id).unwrap();
    assert_eq!(Path::new(&path), Path::new(&exe));
    assert_eq!(
        runs.load(Ordering::SeqCst),
        2,
        "exactly one more subprocess"
    );
    assert_eq!(
        Path::new(case.stored()["installs"][0]["pathHint"].as_str().unwrap()),
        Path::new(&exe),
        "the rewritten hint was not persisted"
    );

    // And the next launch is free.
    assert_eq!(
        Path::new(&case.host.resolve_install(id).unwrap().1),
        Path::new(&exe)
    );
    assert_eq!(
        runs.load(Ordering::SeqCst),
        2,
        "a good hint must not spawn anything"
    );
}

/// The case detection cannot catch: a slicer uninstalled since the last scan. The paths here are
/// under this suite's own temporary root and are never created, deliberately: a fixture path that
/// happens to exist on the machine running the tests would make the test say the opposite of what
/// it means.
#[test]
fn an_install_that_is_gone_is_reported_as_gone_rather_than_spawned_into_a_hole() {
    let probe = Case::new();
    let imagined = probe
        .root
        .path()
        .join("never-created")
        .join("bambu-studio.exe")
        .to_string_lossy()
        .into_owned();
    let document = bambu_document(&imagined);
    let case = Case::with(|options| {
        options.run = Arc::new(move || Ok(document.clone()));
        // True at scan time: this stands in for a machine where it really was installed.
        options.io = Arc::new(|_: &str| true);
    });
    case.host.scan().unwrap();
    assert_eq!(case.host.get().installs[0].path, imagined);

    let error = case
        .host
        .resolve_install("registry:HKLM:Bambu Studio")
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::NotFound);
    assert!(
        error.message.contains("no longer installed"),
        "{}",
        error.message
    );
    assert_eq!(
        Value::Object(error.details.clone().unwrap()),
        json!({ "installId": "registry:HKLM:Bambu Studio" })
    );

    let stored = case.stored();
    let install = stored["installs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|install| install["id"] == "registry:HKLM:Bambu Studio")
        .unwrap();
    assert_eq!(install["missing"], true);
    assert_eq!(
        case.host.get().installs[0].state,
        SlicerInstallState::Missing
    );
}

/// Defence in depth at the last seam before a spawn. Re-resolution answers with a path a
/// *subprocess* named, and in production that path has already been through the parse's four
/// checks. This is the belt for that brace: the path handed back is `stat`ed here too, so a
/// re-resolver that answered with something that is not there cannot turn a stale hint into a
/// spawn of nothing.
#[test]
fn a_re_resolved_path_that_is_not_there_is_missing_not_a_path_to_spawn() {
    // The MSIX arm, and its path is spelled the way the document really spells one: a Windows
    // path. Nothing at this location exists on any platform, which is the whole point.
    let document = json!({
        "registry": [],
        "msix": [{
            "packageFamily": "OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
            "packageFullName": "OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g",
            "version": "2.4.3.0",
            "installLocation": "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_never_installed",
        }],
    })
    .to_string();
    let case = Case::with(|options| {
        options.run = Arc::new(move || Ok(document.clone()));
        // True at scan time: this stands in for a machine where the package really is installed.
        options.io = Arc::new(|_: &str| true);
    });
    case.host.scan().unwrap();
    assert_eq!(
        case.host.get().installs[0].path,
        "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_never_installed\\orca-slicer.exe",
        "the MSIX path is the install location joined with the exe name, Windows-style"
    );

    let error = case.host.resolve_install(ORCA).unwrap_err();
    assert_eq!(error.code, AppErrorCode::NotFound);
}
