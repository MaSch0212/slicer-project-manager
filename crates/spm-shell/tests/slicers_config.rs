//! `slicers.json`: what a scan does to it, what an unreadable one does to the app, and how a stored
//! path becomes a path worth spawning. A port of the Electron shell's `slicers-config.test.ts`,
//! case for case.
//!
//! Real temporary files throughout, and real executables where a `stat` is what is being tested:
//! `resolve_install_path` is checked against files this suite creates and deletes, not against an
//! injected predicate, because "the hint went stale" is a filesystem event.

mod support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Value, json};
use spm_core::AppError;
use spm_core::dto::SlicerId;
use spm_shell::slicers::config::{
    ResolveIo, ResolveOutcome, ResolveResult, SLICERS_CONFIG_VERSION, SLICERS_FILE_NAME,
    SlicersConfig, StoredInstall, empty_config, merge_detected, read_config, resolve_install_path,
    to_config_dto, write_config,
};
use spm_shell::slicers::detect::{DetectedInstall, InstallOrigin, is_regular_file};
use tempfile::TempDir;

struct Root {
    dir: TempDir,
    seq: Cell<usize>,
}

impl Root {
    fn new() -> Root {
        Root {
            dir: tempfile::Builder::new()
                .prefix("spm-slicers-config-")
                .tempdir()
                .unwrap(),
            seq: Cell::new(0),
        }
    }

    fn next(&self) -> usize {
        self.seq.set(self.seq.get() + 1);
        self.seq.get()
    }

    fn file(&self) -> PathBuf {
        self.dir
            .path()
            .join(format!("case-{}", self.next()))
            .join(SLICERS_FILE_NAME)
    }

    /// A real executable-shaped file, so a `stat` has something to find.
    fn real_exe(&self, name: &str) -> String {
        let dir = self.dir.path().join(format!("exe-{}", self.next()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "MZ").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn missing(&self, name: &str) -> String {
        self.dir
            .path()
            .join(format!("no-such-dir-{}", self.next()))
            .join(name)
            .to_string_lossy()
            .into_owned()
    }
}

fn detected(
    id: &str,
    slicer_id: SlicerId,
    label: &str,
    origin: InstallOrigin,
    version: &str,
    path: &str,
) -> DetectedInstall {
    DetectedInstall {
        id: id.to_owned(),
        slicer_id,
        label: label.to_owned(),
        origin,
        version: Some(version.to_owned()),
        path: path.to_owned(),
    }
}

fn cura(version: &str) -> DetectedInstall {
    let key = format!("UltiMaker Cura {version}-{version}");
    detected(
        &format!("registry:HKLM\\WOW6432Node:{key}"),
        SlicerId::Cura,
        &format!("UltiMaker Cura {version}"),
        InstallOrigin::Registry {
            hive: "HKLM\\WOW6432Node".to_owned(),
            key,
        },
        version,
        &format!("C:\\Program Files\\UltiMaker Cura {version}\\UltiMaker-Cura.exe"),
    )
}

const ORCA_FAMILY: &str = "OrcaSlicer.OrcaSlicer_3qd7h69xpne0g";
const ORCA_ID: &str = "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g";
const ORCA_PATH: &str = "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe";

fn orca() -> DetectedInstall {
    detected(
        ORCA_ID,
        SlicerId::Orca,
        "OrcaSlicer",
        InstallOrigin::Msix {
            package_family: ORCA_FAMILY.to_owned(),
        },
        "2.4.3.0",
        ORCA_PATH,
    )
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

#[test]
fn a_file_that_is_not_there_is_first_run_nothing_configured_and_writable() {
    let root = Root::new();
    let read = read_config(&root.file());
    assert_eq!(read.config, empty_config());
    assert!(read.writable);
    // First run is silent: a missing file is not a thing to warn about.
    assert!(read.warnings.is_empty());
}

#[test]
fn what_is_written_comes_back_whole() {
    let root = Root::new();
    let file = root.file();
    let config = merge_detected(
        &empty_config(),
        &[cura("5.12.0"), cura("5.13.0"), orca()],
        1_756_382_400_000,
    );
    write_config(&file, &config).unwrap();
    assert_eq!(read_config(&file).config, config);
}

#[test]
fn an_unreadable_file_degrades_to_no_configuration_with_a_warning_and_stays_writable() {
    let root = Root::new();
    for contents in ["{ half", "[]", "null", "\"a string\"", ""] {
        let file = root.file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, contents).unwrap();

        let read = read_config(&file);
        assert_eq!(read.config, empty_config(), "{contents}");
        // Writable: there is nothing here worth protecting, and the next scan is the only way back.
        assert!(read.writable, "{contents}");
        assert_eq!(read.warnings.len(), 1, "{contents}");
        assert!(
            read.warnings[0].contains("unreadable slicers.json"),
            "{contents}: {}",
            read.warnings[0]
        );
    }
}

/// **A downgrade must not eat a newer configuration.** The assertion that matters is on the bytes:
/// a version check that returned an empty config and then let the next write through would pass
/// every assertion about the *return value* and still destroy the file.
#[test]
fn a_version_this_build_does_not_know_reads_as_nothing_and_is_not_writable() {
    let root = Root::new();
    let file = root.file();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let future = serde_json::to_string_pretty(&json!({
        "version": 2,
        "installs": [{ "id": "something:new", "shape": "this build cannot read" }],
        "somethingElse": true,
    }))
    .unwrap();
    std::fs::write(&file, &future).unwrap();

    let read = read_config(&file);

    assert!(read.config.installs.is_empty());
    assert!(read.config.bindings.is_empty());
    assert!(!read.writable);
    assert!(
        read.warnings[0].contains("version 2"),
        "{}",
        read.warnings[0]
    );
    // And the bytes are exactly what they were.
    assert_eq!(std::fs::read_to_string(&file).unwrap(), future);
}

#[test]
fn a_row_that_is_not_a_stored_install_is_dropped_the_rest_of_the_file_is_kept() {
    let root = Root::new();
    let file = root.file();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let good = json!({
        "id": "manual:one",
        "slicerId": "cura",
        "label": "Portable Cura",
        "origin": { "kind": "manual", "id": "one" },
        "version": null,
        "pathHint": "D:\\portable\\UltiMaker-Cura.exe",
        "addedAt": 1,
    });
    let with = |overrides: Value| {
        let mut row = good.clone();
        for (key, value) in overrides.as_object().unwrap() {
            row[key] = value.clone();
        }
        row
    };
    std::fs::write(
        &file,
        json!({
            "version": SLICERS_CONFIG_VERSION,
            "installs": [
                good,
                with(json!({ "id": "manual:two", "slicerId": "superslicer" })),
                with(json!({ "id": "manual:three", "origin": { "kind": "nonsense" } })),
                with(json!({ "id": "manual:four", "pathHint": "" })),
                with(json!({ "id": "manual:five", "addedAt": "yesterday" })),
                "not a row",
            ],
            "bindings": { "cura": "manual:one", "superslicer": "manual:two", "orca": "manual:gone" },
            "defaultSlicerId": "nonsense",
        })
        .to_string(),
    )
    .unwrap();

    let config = read_config(&file).config;
    assert_eq!(
        config
            .installs
            .iter()
            .map(|install| install.id.as_str())
            .collect::<Vec<_>>(),
        ["manual:one"]
    );
    // A binding to an install that is not in the file is not a binding.
    assert_eq!(
        config.bindings,
        BTreeMap::from([(SlicerId::Cura, "manual:one".to_owned())])
    );
    assert_eq!(config.default_slicer_id, None);
}

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

#[test]
fn nothing_detected_on_a_machine_with_nothing_installed_is_an_empty_configuration() {
    let merged = merge_detected(&empty_config(), &[], 1_756_382_400_000);
    assert_eq!(merged, empty_config());
    let dto = to_config_dto(&merged, true);
    assert!(dto.installs.is_empty());
    assert!(dto.bindings.is_empty());
    assert_eq!(dto.default_slicer_id, None);
    assert!(dto.detection_supported);
}

#[test]
fn a_product_with_one_install_is_bound_to_it_a_product_with_two_is_left_for_the_user() {
    let merged = merge_detected(
        &empty_config(),
        &[cura("5.12.0"), cura("5.13.0"), orca()],
        1_756_382_400_000,
    );

    // Orca: nothing to choose.
    assert_eq!(
        merged.bindings.get(&SlicerId::Orca).map(String::as_str),
        Some(ORCA_ID)
    );
    // Cura: two installs, so the app says nothing. Preferring 5.13.0 here is exactly what the
    // rejected file-association mechanism does, and it is what this asserts against.
    assert_eq!(merged.bindings.get(&SlicerId::Cura), None);
    assert_eq!(
        merged.default_slicer_id, None,
        "a scan does not choose a default either"
    );
}

/// **The assertion the plan singles out.** Three things at once, and each can fail alone.
#[test]
fn a_scan_adds_marks_the_vanished_missing_and_leaves_a_user_binding_exactly_as_it_was() {
    let (c12, c13) = (cura("5.12.0"), cura("5.13.0"));
    let first = merge_detected(&empty_config(), &[c12.clone(), c13.clone()], 1000);
    // The one decision the app asks the user to make.
    let mut chosen = first.clone();
    chosen.bindings.insert(SlicerId::Cura, c12.id.clone());

    // 5.12.0 has been uninstalled and Orca has appeared.
    let second = merge_detected(&chosen, &[c13.clone(), orca()], 2000);

    assert_eq!(
        second.bindings.get(&SlicerId::Cura),
        Some(&c12.id),
        "the binding was re-pointed"
    );
    assert_eq!(
        second.bindings,
        BTreeMap::from([
            (SlicerId::Cura, c12.id.clone()),
            (SlicerId::Orca, ORCA_ID.to_owned()),
        ])
    );

    let by_id: BTreeMap<&str, &StoredInstall> = second
        .installs
        .iter()
        .map(|install| (install.id.as_str(), install))
        .collect();
    assert_eq!(
        by_id.len(),
        3,
        "the vanished install was dropped instead of marked"
    );
    assert!(by_id[c12.id.as_str()].missing);
    assert!(!by_id[c13.id.as_str()].missing);
    assert_eq!(
        by_id[ORCA_ID].added_at, 2000,
        "a new install is stamped with the scan"
    );
    assert_eq!(
        by_id[c13.id.as_str()].added_at,
        1000,
        "a re-detected one keeps the time it had"
    );
}

#[test]
fn an_install_that_comes_back_stops_being_missing_and_its_hint_is_refreshed() {
    let gone = merge_detected(&merge_detected(&empty_config(), &[orca()], 1000), &[], 2000);
    assert!(gone.installs[0].missing);

    // The shape an Orca update takes: same family, a directory that now names a new version.
    let moved = DetectedInstall {
        version: Some("2.5.0.0".to_owned()),
        path: ORCA_PATH.replace("2.4.3.0", "2.5.0.0"),
        ..orca()
    };
    let back = merge_detected(&gone, std::slice::from_ref(&moved), 3000);
    assert!(!back.installs[0].missing);
    assert_eq!(back.installs[0].path_hint, moved.path);
    assert_eq!(back.installs[0].version.as_deref(), Some("2.5.0.0"));
    assert_eq!(
        back.installs[0].added_at, 1000,
        "the same install, not a new one"
    );
}

fn manual(id: &str, slicer_id: SlicerId, label: &str, path: &str) -> StoredInstall {
    StoredInstall {
        id: format!("manual:{id}"),
        slicer_id,
        label: label.to_owned(),
        origin: InstallOrigin::Manual { id: id.to_owned() },
        version: None,
        path_hint: path.to_owned(),
        added_at: 500,
        missing: false,
    }
}

#[test]
fn a_manual_entry_is_not_marked_missing_by_a_scan_that_cannot_see_it() {
    let entry = manual(
        "portable",
        SlicerId::Prusaslicer,
        "PrusaSlicer (added by hand)",
        "D:\\portable\\prusa-slicer.exe",
    );
    let before = SlicersConfig {
        installs: vec![entry.clone()],
        ..empty_config()
    };

    let after = merge_detected(&before, &[], 2000);
    // Detection did not find it because detection never could. That is not evidence of anything.
    assert_eq!(after.installs, vec![entry]);
}

#[test]
fn a_manual_entry_counts_as_the_one_install_a_product_is_auto_bound_to() {
    let entry = manual(
        "portable",
        SlicerId::Bambu,
        "Bambu Studio (added by hand)",
        "D:\\portable\\bambu-studio.exe",
    );
    let merged = merge_detected(
        &SlicersConfig {
            installs: vec![entry],
            ..empty_config()
        },
        &[],
        2000,
    );
    assert_eq!(
        merged.bindings.get(&SlicerId::Bambu).map(String::as_str),
        Some("manual:portable")
    );
}

#[test]
fn a_missing_install_is_not_what_a_product_gets_auto_bound_to() {
    let gone = merge_detected(&merge_detected(&empty_config(), &[orca()], 1000), &[], 2000);
    // The binding made on the first scan stays (it is the user's, or as good as) but nothing new
    // is bound to an install that is not there.
    let without_binding = SlicersConfig {
        bindings: BTreeMap::new(),
        ..gone
    };
    assert!(
        merge_detected(&without_binding, &[], 3000)
            .bindings
            .is_empty()
    );
}

// ---------------------------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------------------------

fn stored_for(path: &str, overrides: impl FnOnce(&mut StoredInstall)) -> SlicersConfig {
    let mut install = StoredInstall {
        id: ORCA_ID.to_owned(),
        slicer_id: SlicerId::Orca,
        label: "OrcaSlicer".to_owned(),
        origin: InstallOrigin::Msix {
            package_family: ORCA_FAMILY.to_owned(),
        },
        version: Some("2.4.3.0".to_owned()),
        path_hint: path.to_owned(),
        added_at: 1000,
        missing: false,
    };
    overrides(&mut install);
    SlicersConfig {
        installs: vec![install],
        ..empty_config()
    }
}

/// `is_regular_file` is **the production predicate itself**, not a re-implementation of it: one
/// predicate, so the test cannot disagree with it.
struct CountingIo {
    answer: Option<String>,
    calls: Cell<usize>,
}

impl CountingIo {
    fn new(answer: Option<&str>) -> CountingIo {
        CountingIo {
            answer: answer.map(str::to_owned),
            calls: Cell::new(0),
        }
    }
}

impl ResolveIo for CountingIo {
    fn is_regular_file(&self, path: &str) -> bool {
        is_regular_file(path)
    }

    fn reresolve(&self, _install: &StoredInstall) -> Result<Option<String>, AppError> {
        self.calls.set(self.calls.get() + 1);
        Ok(self.answer.clone())
    }
}

/// The production predicate itself, driven on all three answers. It is the check `add_manual`
/// makes before storing a path and the check that stands between a stale hint and a spawn.
#[test]
fn a_regular_file_is_a_regular_file_a_directory_and_a_missing_path_are_not() {
    let root = Root::new();
    let exe = root.real_exe("orca-slicer.exe");
    let directory = root.dir.path().join(format!("plain-dir-{}", root.next()));
    std::fs::create_dir_all(&directory).unwrap();

    assert!(is_regular_file(&exe));
    assert!(
        !is_regular_file(&directory.to_string_lossy()),
        "a directory is not a regular file"
    );
    assert!(!is_regular_file(&root.missing("x.exe")));
}

#[test]
fn a_good_hint_costs_one_stat_and_no_subprocess_at_all() {
    let root = Root::new();
    let exe = root.real_exe("orca-slicer.exe");
    let io = CountingIo::new(Some("should not be reached"));
    let config = stored_for(&exe, |_| {});

    let result = resolve_install_path(&config, ORCA_ID, &io).unwrap();

    assert_eq!(
        io.calls.get(),
        0,
        "the re-resolver was called for a hint that was fine"
    );
    assert_eq!(
        result,
        ResolveResult {
            outcome: ResolveOutcome::Found { path: exe },
            config,
            changed: false,
        }
    );
}

#[test]
fn a_stale_hint_is_re_resolved_once_and_the_hint_is_rewritten() {
    let root = Root::new();
    let gone = root.missing("orca-slicer.exe");
    let found = root.real_exe("orca-slicer.exe");
    let io = CountingIo::new(Some(&found));

    let result = resolve_install_path(&stored_for(&gone, |_| {}), ORCA_ID, &io).unwrap();

    assert_eq!(io.calls.get(), 1);
    assert_eq!(
        result.outcome,
        ResolveOutcome::Found {
            path: found.clone()
        }
    );
    assert!(result.changed);
    assert_eq!(
        result.config.installs[0].path_hint, found,
        "the hint was not rewritten"
    );
}

/// The check that stops a hint from becoming a spawn of something else. A file *is* there, so the
/// existence check passes and the basename check is the only thing that can refuse it.
#[test]
fn a_hint_that_exists_but_is_not_the_right_executable_is_re_resolved() {
    let root = Root::new();
    let wrong = root.real_exe("CuraEngine.exe");
    let right = root.real_exe("orca-slicer.exe");
    let io = CountingIo::new(Some(&right));

    let result = resolve_install_path(&stored_for(&wrong, |_| {}), ORCA_ID, &io).unwrap();

    assert_eq!(io.calls.get(), 1);
    assert_eq!(result.outcome, ResolveOutcome::Found { path: right });
}

#[test]
fn a_directory_where_the_executable_should_be_is_not_a_hint_worth_spawning() {
    let root = Root::new();
    // A path whose *name* passes the basename check, so the only thing that can refuse it is "is
    // it a regular file".
    let as_directory = root
        .dir
        .path()
        .join(format!("dir-{}", root.next()))
        .join("orca-slicer.exe");
    std::fs::create_dir_all(&as_directory).unwrap();
    let found = root.real_exe("orca-slicer.exe");
    let io = CountingIo::new(Some(&found));

    let result = resolve_install_path(
        &stored_for(&as_directory.to_string_lossy(), |_| {}),
        ORCA_ID,
        &io,
    )
    .unwrap();

    assert_eq!(io.calls.get(), 1);
    assert_eq!(result.outcome, ResolveOutcome::Found { path: found });
}

fn manual_origin(install: &mut StoredInstall) {
    install.id = "manual:portable".to_owned();
    install.origin = InstallOrigin::Manual {
        id: "portable".to_owned(),
    };
}

#[test]
fn a_manual_entry_is_never_re_resolved_because_there_is_nothing_to_re_resolve_it_from() {
    let root = Root::new();
    let gone = root.missing("whatever.exe");
    let io = CountingIo::new(Some("a path that should never be used"));
    let config = stored_for(&gone, manual_origin);

    let result = resolve_install_path(&config, "manual:portable", &io).unwrap();

    assert_eq!(io.calls.get(), 0);
    assert_eq!(result.outcome, ResolveOutcome::Missing);
    assert!(result.changed);
    assert!(result.config.installs[0].missing);
}

#[test]
fn a_manual_entry_whose_file_is_still_there_launches_whatever_it_is_called() {
    // The `exe_name` check does not apply: the user named this path, so the app has no better idea
    // than they do about what it should be called.
    let root = Root::new();
    let odd = root.real_exe("my-slicer-build.exe");
    let io = CountingIo::new(None);
    let config = stored_for(&odd, manual_origin);

    let result = resolve_install_path(&config, "manual:portable", &io).unwrap();

    assert_eq!(io.calls.get(), 0);
    assert_eq!(result.outcome, ResolveOutcome::Found { path: odd });
}

#[test]
fn an_install_that_re_resolution_cannot_find_becomes_missing_and_says_so() {
    let root = Root::new();
    let gone = root.missing("orca-slicer.exe");
    let io = CountingIo::new(None);

    let result = resolve_install_path(&stored_for(&gone, |_| {}), ORCA_ID, &io).unwrap();

    assert_eq!(io.calls.get(), 1);
    assert_eq!(result.outcome, ResolveOutcome::Missing);
    assert!(result.changed);
    assert!(result.config.installs[0].missing);
    // The hint is left as it was: it is the last place this install was seen, and overwriting it
    // with nothing would lose the only clue the next scan has to compare against.
    assert_eq!(result.config.installs[0].path_hint, gone);
}

#[test]
fn an_install_id_that_is_not_in_the_file_is_unknown_and_changes_nothing() {
    let root = Root::new();
    let exe = root.real_exe("orca-slicer.exe");
    let io = CountingIo::new(Some(&exe));
    let config = stored_for(&exe, |_| {});

    let result = resolve_install_path(&config, "registry:HKLM:Nothing", &io).unwrap();

    assert_eq!(io.calls.get(), 0);
    assert_eq!(result.outcome, ResolveOutcome::Unknown);
    assert!(!result.changed);
    assert_eq!(result.config, config);
}

// ---------------------------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------------------------

#[test]
fn the_dto_says_where_an_install_came_from_and_whether_it_is_there() {
    use spm_core::dto::{SlicerInstallOrigin, SlicerInstallState};
    let c12 = cura("5.12.0");
    let gone = merge_detected(
        &merge_detected(&empty_config(), &[c12.clone(), orca()], 1000),
        &[orca()],
        2000,
    );
    let dto = to_config_dto(&gone, true);

    assert_eq!(
        dto.installs
            .iter()
            .map(|install| (install.id.as_str(), install.origin, install.state))
            .collect::<Vec<_>>(),
        [
            (
                c12.id.as_str(),
                SlicerInstallOrigin::Registry,
                SlicerInstallState::Missing
            ),
            (ORCA_ID, SlicerInstallOrigin::Msix, SlicerInstallState::Ok),
        ]
    );
    assert!(dto.detection_supported);
    assert!(!to_config_dto(&gone, false).detection_supported);
}
