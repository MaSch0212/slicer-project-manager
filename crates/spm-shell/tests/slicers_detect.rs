//! Parsing what the detection subprocess said, with no PowerShell anywhere. A port of the Electron
//! shell's `slicers-detect.test.ts`, case for case.
//!
//! The fixture is the spike's own output, reduced to the rows that matter and byte-verbatim in
//! each of them: the five uninstall keys the machine really has, the MSIX Orca package, and one real
//! non-slicer row that is there for two reasons (it proves a haystack of unrelated programs is
//! filtered out, and its `DisplayName` is genuinely `Fork` followed by fifteen NUL characters,
//! which is what a `REG_SZ` written with its declared length looks like when it reaches JSON).
//!
//! Every other case is its own one-row document built inline. That is deliberate: two cases in one
//! fixture each masked the other, because a row that must produce nothing and a row that must
//! produce something cannot share a document (the assertion about the count is then satisfiable
//! two ways).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{Value, json};
use spm_shell::slicers::detect::{
    DetectIo, DetectedInstall, InstallOrigin, RunDetection, detect_installs, detection_script,
    encoded_detection_command, executable_from_display_icon, is_safe_script_literal,
    parse_detection_with, power_shell_path,
};
use spm_shell::slicers::registry::{SLICER_IDS, slicer};
use spm_shell::slicers::winpath;

const FIXTURE: &str = include_str!("fixtures/slicer-detection.json");

/// The files that "exist" for a test, spelled as they are on the machine the spike ran on.
///
/// **`CuraEngine.exe` and the uninstallers are in here on purpose.** They are real files sitting
/// beside the real executables, so if they were absent the basename check would look like it was
/// working when it was the existence check doing the job.
fn real_files() -> HashSet<String> {
    [
        "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe",
        "C:\\Program Files\\UltiMaker Cura 5.12.0\\CuraEngine.exe",
        "C:\\Program Files\\UltiMaker Cura 5.12.0\\uninstall.exe",
        "C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe",
        "C:\\Program Files\\UltiMaker Cura 5.13.0\\CuraEngine.exe",
        "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe",
        "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe",
        "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-gcodeviewer.exe",
        "C:\\Program Files\\Prusa3D\\PrusaSlicer\\unins000.exe",
        "C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe",
        "C:\\Program Files\\AnycubicSlicerNext\\Uninstall.exe",
        "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
        "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe",
        "C:\\Users\\masch\\AppData\\Local\\Fork\\current\\Fork.exe",
    ]
    .into_iter()
    .map(str::to_lowercase)
    .collect()
}

fn io() -> impl DetectIo {
    let files = real_files();
    move |path: &str| files.contains(&path.to_lowercase())
}

fn always_exists() -> impl DetectIo {
    |_: &str| true
}

/// Parses with a warning sink, answering the installs and what was said.
fn parse(json: &str, io: &dyn DetectIo) -> (Vec<DetectedInstall>, Vec<String>) {
    let mut warnings = Vec::new();
    let installs = parse_detection_with(json, io, &mut |message| warnings.push(message.to_owned()));
    (installs, warnings)
}

fn installs(json: &str, io: &dyn DetectIo) -> Vec<DetectedInstall> {
    parse(json, io).0
}

/// One document, so a case cannot be satisfied by a row that belongs to another case.
fn one_row(row: Value) -> String {
    json!({ "registry": [row], "msix": [] }).to_string()
}

fn cura_row(overrides: Value) -> String {
    let mut row = json!({
        "hive": "HKLM\\WOW6432Node",
        "key": "UltiMaker Cura 5.12.0-5.12.0",
        "displayName": "UltiMaker Cura 5.12.0",
        "displayVersion": "5.12.0",
        "displayIcon": "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe",
    });
    for (key, value) in overrides.as_object().unwrap() {
        row[key] = value.clone();
    }
    one_row(row)
}

fn ids(installs: &[DetectedInstall]) -> Vec<String> {
    installs.iter().map(|install| install.id.clone()).collect()
}

// ---------------------------------------------------------------------------------------------
// The machine the spike ran on
// ---------------------------------------------------------------------------------------------

#[test]
fn the_real_document_yields_six_installs_one_per_install_and_not_one_per_product() {
    let mut found = ids(&installs(FIXTURE, &io()));
    found.sort();
    assert_eq!(
        found,
        [
            "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
            "registry:HKLM:AnycubicSlicerNext",
            "registry:HKLM:Bambu Studio",
            "registry:HKLM:PrusaSlicer_is1",
            "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0",
            "registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0",
        ]
    );
}

/// **The case the whole design exists for.** Two Curas, side by side, both working. A parser that
/// keyed installs on `SlicerId`, or that took the newer of two rows the way the rejected
/// file-association mechanism does, produces one row here and this goes red on all three
/// assertions.
#[test]
fn the_two_cura_installs_stay_two_with_distinct_ids_paths_and_versions() {
    let all = installs(FIXTURE, &io());
    let cura: Vec<&DetectedInstall> = all
        .iter()
        .filter(|install| install.slicer_id == spm_core::dto::SlicerId::Cura)
        .collect();

    assert_eq!(cura.len(), 2);
    let mut versions: Vec<_> = cura
        .iter()
        .map(|install| install.version.clone().unwrap())
        .collect();
    versions.sort();
    assert_eq!(
        versions,
        ["5.12.0", "5.13.0"],
        "the version comes from DisplayVersion; the executables have no version resource at all"
    );
    let mut paths: Vec<_> = cura.iter().map(|install| install.path.clone()).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe",
            "C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe",
        ]
    );
    let distinct: HashSet<&str> = cura.iter().map(|install| install.id.as_str()).collect();
    assert_eq!(distinct.len(), 2);
}

#[test]
fn orca_comes_from_the_msix_half_keyed_on_the_family_and_not_the_versioned_full_name() {
    let all = installs(FIXTURE, &io());
    let orca = all
        .iter()
        .find(|install| install.slicer_id == spm_core::dto::SlicerId::Orca)
        .unwrap();

    // The id must survive an update. The *path* below embeds `2.4.3.0` and the id must not.
    assert_eq!(orca.id, "msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g");
    assert_eq!(orca.version.as_deref(), Some("2.4.3.0"));
    assert_eq!(
        orca.path,
        "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe"
    );
    assert_eq!(
        orca.origin,
        InstallOrigin::Msix {
            package_family: "OrcaSlicer.OrcaSlicer_3qd7h69xpne0g".to_owned()
        }
    );
    assert!(
        !orca.id.contains("2.4.3.0"),
        "the id must not carry the version"
    );
}

#[test]
fn a_program_that_is_not_a_slicer_is_not_an_install_however_real_its_executable_is() {
    // `Fork.exe` exists in the real files, so the only thing rejecting this row is the name.
    assert!(
        !installs(FIXTURE, &io())
            .iter()
            .any(|install| install.path.contains("Fork"))
    );
}

#[test]
fn every_install_carries_the_hive_it_was_found_in_because_the_key_alone_is_not_unique() {
    let all = installs(FIXTURE, &io());
    for install in &all {
        if let InstallOrigin::Registry { hive, key } = &install.origin {
            assert_eq!(install.id, format!("registry:{hive}:{key}"));
        }
    }
    // Cura is under WOW6432Node despite being 64-bit; a detector reading two hives misses both.
    let wow = all
        .iter()
        .filter(|install| {
            matches!(&install.origin, InstallOrigin::Registry { hive, .. } if hive.contains("WOW6432"))
        })
        .count();
    assert_eq!(wow, 2);
}

// ---------------------------------------------------------------------------------------------
// DisplayIcon, which is a field for an icon and not a promise about a binary
// ---------------------------------------------------------------------------------------------

#[test]
fn a_display_icon_naming_cura_engine_exe_produces_no_install_at_all() {
    let engine = "C:\\Program Files\\UltiMaker Cura 5.12.0\\CuraEngine.exe";
    // It is a real file, it is 21 MB, and "the biggest exe in the folder" picks it over Cura.
    assert!(io().is_regular_file(engine));

    assert!(installs(&cura_row(json!({ "displayIcon": engine })), &io()).is_empty());
}

#[test]
fn the_other_four_things_that_sit_beside_a_real_executable_are_refused_as_well() {
    let beside = [
        (
            "UltiMaker Cura 5.12.0",
            "C:\\Program Files\\UltiMaker Cura 5.12.0\\uninstall.exe",
        ),
        (
            "PrusaSlicer",
            "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-gcodeviewer.exe",
        ),
        // The headless twin, with the *same* version resource as the real one.
        (
            "PrusaSlicer",
            "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe",
        ),
        (
            "AnycubicSlicerNext 1.4.1.2",
            "C:\\Program Files\\AnycubicSlicerNext\\Uninstall.exe",
        ),
    ];
    for (display_name, display_icon) in beside {
        assert!(io().is_regular_file(display_icon), "{display_icon}");
        let found = installs(
            &one_row(json!({
                "hive": "HKLM", "key": "k", "displayName": display_name,
                "displayVersion": "1", "displayIcon": display_icon,
            })),
            &io(),
        );
        assert!(found.is_empty(), "{display_icon}");
    }
}

#[test]
fn a_quoted_display_icon_with_a_trailing_icon_index_resolves_to_the_bare_path() {
    let bare = "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe";
    for written in [
        format!("\"{bare}\",0"),
        format!("{bare},0"),
        format!("\"{bare}\""),
        format!("{bare},-101"),
        format!(" {bare} "),
    ] {
        let found = installs(&cura_row(json!({ "displayIcon": written })), &io());
        assert_eq!(
            found.first().map(|install| install.path.as_str()),
            Some(bare),
            "{written}"
        );
    }
}

#[test]
fn a_comma_that_is_part_of_the_path_is_not_an_icon_index() {
    // Not measured (all five values here were bare paths), so this is the conservative reading of
    // the documented `path[,index]` form rather than a claim about a real vendor.
    assert_eq!(
        executable_from_display_icon("C:\\Tools\\Slicer,v2\\x.exe").as_deref(),
        Some("C:\\Tools\\Slicer,v2\\x.exe")
    );
    assert_eq!(
        executable_from_display_icon("C:\\Tools\\x.exe,0").as_deref(),
        Some("C:\\Tools\\x.exe")
    );
    assert_eq!(executable_from_display_icon(""), None);
    assert_eq!(executable_from_display_icon(",0"), None);
}

/// A spawn resolves a relative path against the process working directory, which on a packaged
/// app is wherever the user happened to launch it from.
///
/// **The `io` here answers yes to everything**, on purpose: with the suite's normal `io` this test
/// would pass for the wrong reason (a relative path is not in the real files either, so the
/// existence check would be doing the work). Every one of these has the right basename and
/// "exists", so nothing but the absolute check can refuse them.
#[test]
fn a_relative_display_icon_is_refused_whatever_it_is_called() {
    let exists = always_exists();
    for relative in [
        "UltiMaker-Cura.exe",
        ".\\UltiMaker-Cura.exe",
        "..\\UltiMaker-Cura.exe",
        "Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe",
        // A drive-relative path: `C:UltiMaker-Cura.exe` means "the current directory on C:".
        "C:UltiMaker-Cura.exe",
    ] {
        assert!(exists.is_regular_file(relative), "{relative}");
        assert!(
            installs(&cura_row(json!({ "displayIcon": relative })), &exists).is_empty(),
            "{relative}"
        );
    }

    // And the check is not simply refusing everything: the absolute spelling of the same file,
    // with the same permissive `io`, is accepted.
    assert_eq!(
        installs(
            &cura_row(json!({
                "displayIcon": "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe"
            })),
            &exists,
        )
        .len(),
        1
    );
}

#[test]
fn a_display_icon_naming_a_file_that_is_not_there_is_refused() {
    let gone = "C:\\Program Files\\UltiMaker Cura 9.9.9\\UltiMaker-Cura.exe";
    assert!(!io().is_regular_file(gone));
    assert!(installs(&cura_row(json!({ "displayIcon": gone })), &io()).is_empty());
}

// ---------------------------------------------------------------------------------------------
// Documents that are not the happy one
// ---------------------------------------------------------------------------------------------

/// The path the spike could not exercise against a real negative, and so the one most likely to
/// be wrong: a machine with no slicers on it.
#[test]
fn a_document_with_nothing_detected_is_an_empty_list_not_a_failure() {
    assert!(installs(&json!({ "registry": [], "msix": [] }).to_string(), &io()).is_empty());
}

#[test]
fn a_document_that_is_not_the_shape_asked_for_degrades_to_nothing() {
    // Unparseable is the one worth a word: the subprocess did not do what it was asked.
    let (found, warnings) = parse("not json at all", &io());
    assert!(found.is_empty());
    assert_eq!(warnings.len(), 1);
    assert!(
        warnings[0].contains("did not return JSON"),
        "{}",
        warnings[0]
    );

    // These are shapes, not failures, and say nothing.
    for document in ["{}", "[]", "null", "{\"registry\":\"nope\",\"msix\":3}"] {
        let (found, warnings) = parse(document, &io());
        assert!(found.is_empty(), "{document}");
        assert!(warnings.is_empty(), "{document}");
    }
}

#[test]
fn a_row_that_is_missing_what_identifies_it_is_dropped_and_the_rest_of_the_document_is_not() {
    let good = json!({
        "hive": "HKLM",
        "key": "Bambu Studio",
        "displayName": "Bambu Studio",
        "displayVersion": "02.08.02.61",
        "displayIcon": "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
    });
    let with = |key: &str, value: &str| {
        let mut row = good.clone();
        row[key] = json!(value);
        row
    };
    for broken in [
        with("hive", ""),
        with("key", ""),
        with("displayIcon", ""),
        json!({ "displayName": "Bambu Studio" }),
        json!("a string where a row should be"),
        Value::Null,
    ] {
        let document = json!({ "registry": [broken, good], "msix": [] }).to_string();
        // One survivor and it is the good row: dropping the *document* over one bad key would take
        // out a scan on a machine with two hundred of them.
        assert_eq!(
            ids(&installs(&document, &io())),
            ["registry:HKLM:Bambu Studio"]
        );
    }
}

#[test]
fn a_version_that_is_only_nul_padding_reads_as_no_version_rather_than_as_padding() {
    let found = installs(
        &cura_row(json!({ "displayVersion": "5.12.0\u{0}\u{0}\u{0}" })),
        &io(),
    );
    assert_eq!(found[0].version.as_deref(), Some("5.12.0"));

    let none = installs(&cura_row(json!({ "displayVersion": "\u{0}\u{0}" })), &io());
    assert_eq!(
        none[0].version, None,
        "no version is null, and the install is still reported"
    );
    assert_eq!(
        none[0].path,
        "C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe"
    );
}

#[test]
fn an_msix_package_this_app_does_not_know_about_is_not_an_install() {
    let document = json!({
        "registry": [],
        "msix": [{
            "packageFamily": "Microsoft.Microsoft3DViewer_8wekyb3d8bbwe",
            "packageFullName": "Microsoft.Microsoft3DViewer_7.2107.7012.0_x64__8wekyb3d8bbwe",
            "version": "7.2107.7012.0",
            "installLocation": "C:\\Program Files\\WindowsApps\\Microsoft.Microsoft3DViewer_x64",
        }],
    })
    .to_string();
    // It claims `.3mf` and `.stl` on this machine. It is still not a slicer.
    assert!(installs(&document, &io()).is_empty());
}

#[test]
fn an_msix_package_whose_executable_is_not_where_the_manifest_says_is_not_an_install() {
    let document = json!({
        "registry": [],
        "msix": [{
            "packageFamily": "OrcaSlicer.OrcaSlicer_3qd7h69xpne0g",
            "packageFullName": "OrcaSlicer.OrcaSlicer_9.9.9.9_x64__3qd7h69xpne0g",
            "version": "9.9.9.9",
            // The shape an update takes: same family, a directory that has moved.
            "installLocation":
                "C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_9.9.9.9_x64__3qd7h69xpne0g",
        }],
    })
    .to_string();
    assert!(installs(&document, &io()).is_empty());
}

#[test]
fn one_install_seen_twice_is_one_install() {
    let row = json!({
        "hive": "HKLM",
        "key": "Bambu Studio",
        "displayName": "Bambu Studio",
        "displayVersion": "02.08.02.61",
        "displayIcon": "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
    });
    let document = json!({ "registry": [row.clone(), row], "msix": [] }).to_string();
    assert_eq!(
        ids(&installs(&document, &io())),
        ["registry:HKLM:Bambu Studio"]
    );
}

// ---------------------------------------------------------------------------------------------
// The script, and the seam it is behind
// ---------------------------------------------------------------------------------------------

/// The guard around everything interpolated into the script, driven directly. `detection_script`
/// refuses to build a script around a literal that fails this, but both of its operands are module
/// constants, so nothing a test can pass reaches that refusal: exporting the predicate is what
/// makes the guard falsifiable. These are the strings a careless edit to the family would
/// introduce.
#[test]
fn the_script_literal_guard_refuses_everything_that_could_close_a_powershell_literal() {
    for hostile in [
        "Orca'; Start-Process calc; '",
        "Orca\"; Start-Process calc",
        "Orca$(Start-Process calc)",
        "Orca`nStart-Process calc",
        "Orca; Start-Process calc",
        "Orca | Start-Process calc",
        "Orca & calc",
        "Orca_with a space",
        "Orca\nSlicer",
        "",
    ] {
        assert!(!is_safe_script_literal(hostile), "{hostile:?}");
    }

    // And it is not simply refusing everything: every literal the table really carries passes.
    for id in SLICER_IDS {
        if let Some(family) = slicer(id).windows.msix_package_family {
            assert!(is_safe_script_literal(family), "{family}");
        }
    }
    assert!(is_safe_script_literal(
        "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
    ));
}

/// The script crosses the process boundary base64-encoded, so its punctuation cannot matter.
#[test]
fn the_script_is_handed_over_as_base64_utf16le_and_survives_the_round_trip() {
    fn decode(encoded: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }
    let encoded = encoded_detection_command(&detection_script());
    assert!(
        encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    );
    assert_eq!(decode(&encoded), detection_script());
    // A script that really does need a quote now costs nothing, and non-ASCII survives.
    assert_eq!(
        decode(&encoded_detection_command("echo \"hi\" \u{e9}")),
        "echo \"hi\" \u{e9}"
    );
}

/// The one subprocess this app starts before a launch, named outright rather than found: a
/// process `PATH` lookup would let the environment decide which binary runs.
#[test]
fn powershell_is_named_by_absolute_path_out_of_system_root_rather_than_off_path() {
    let env = |system_root: Option<&'static str>| {
        move |name: &str| {
            (name == "SystemRoot")
                .then(|| system_root.map(str::to_owned))
                .flatten()
        }
    };
    assert_eq!(
        power_shell_path(&env(Some("C:\\Windows"))),
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    // A Windows installed somewhere else is followed; an environment that says nothing is not.
    assert_eq!(
        power_shell_path(&env(Some("D:\\Win"))),
        "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    assert!(winpath::is_absolute(&power_shell_path(&env(None))));
    assert_eq!(
        power_shell_path(&env(None)),
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "an environment that names no Windows still gets an absolute path, not a bare name"
    );
    // Never a bare name, which is the whole point.
    assert_ne!(power_shell_path(&env(None)), "powershell.exe");
}

#[test]
fn the_script_reads_all_three_hives_and_every_msix_family_in_the_registry_table() {
    let script = detection_script();
    for hive in [
        "HKLM:\\SOFTWARE\\Microsoft",
        "WOW6432Node",
        "HKCU:\\SOFTWARE\\Microsoft",
    ] {
        assert!(script.contains(hive), "{hive}");
    }
    for id in SLICER_IDS {
        if let Some(family) = slicer(id).windows.msix_package_family {
            assert!(script.contains(family), "{family}");
        }
    }
    // The registry half reads `DisplayIcon` and **not** `InstallLocation`: the latter is empty for
    // four of the five uninstall keys, so a detector built on it finds PrusaSlicer and nothing
    // else. The MSIX half does read an install location, legitimately (it is the only path an MSIX
    // package has), so the assertion is on the registry item and not on the word.
    assert!(!script.contains("$item.InstallLocation"));
    assert!(script.contains("$item.DisplayIcon"));
    assert!(script.contains("$pkg.InstallLocation"));
}

#[test]
fn detect_installs_runs_the_injected_subprocess_exactly_once_and_parses_what_it_said() {
    let runs = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&runs);
    let run: RunDetection = Arc::new(move || {
        *counter.lock().unwrap() += 1;
        Ok(FIXTURE.to_owned())
    });

    let found = detect_installs(&run, &io(), &mut |_| {}).unwrap();

    assert_eq!(*runs.lock().unwrap(), 1);
    assert_eq!(found.len(), 6);
}
