//! Both local launch paths, end to end against a real library and a real `slicers.json`, with the
//! spawn injected. A port of the Electron shell's `slicers-launch.test.ts`, case for case.
//!
//! **Every assertion here is about the path that was spawned, not about a spawn having happened**
//! (constraint 7). That is the whole difference between a test that would have caught the data-loss
//! defect in the first draft of the spec and one that would have gone green through it: a
//! `model`-kind `.3mf` launched at its library path spawns exactly as successfully as one launched
//! from a copy.
//!
//! **And about the working directory it was spawned in**, for the same reason: a slicer was
//! measured resolving an export path against its process cwd and writing into the repository, and
//! a launch with no `cwd` at all spawns exactly as successfully as one with the right one.
//!
//! Nothing here needs a slicer, a window or Windows.

mod support;

use std::path::{Path, PathBuf};

use serde_json::Value;
use spm_core::AppErrorCode;
use spm_core::dto::{FileKind, SlicerId, SlicerLaunchMode, SlicerLaunchOptions};
use spm_core::files::classify::{Classification, classify_file};
use spm_core::files::entry_hash::{entry_digests, entry_hash};
use spm_shell::slicers::launch::{
    LAUNCH_RECORD_NAME, LaunchedSource, SLICER_CWD_DIR, SLICER_SESSIONS_DIR, SlicerLaunchRecord,
    notices,
};
use spm_shell::slicers::registry::{SLICER_IDS, slicer};
use support::slicers::{
    ANYCUBIC_EXE, BAMBU_EXE, CURA_12, CURA_12_EXE, CURA_13_EXE, Env, Harness, HarnessOptions, ORCA,
    ORCA_EXE, PRUSA_EXE, install, machine, step_bytes, stl_bytes,
};
use support::threemf::{
    bambu_lineage_project, cura_project, deflated, patch_zip_headers, plain_mesh_3mf,
    prusa_project, set_u16, slice_info, stored, write_zip,
};

fn new_project(slicer_id: Option<SlicerId>) -> SlicerLaunchOptions {
    SlicerLaunchOptions {
        mode: SlicerLaunchMode::NewProject,
        slicer_id,
    }
}

fn as_is(slicer_id: Option<SlicerId>) -> SlicerLaunchOptions {
    SlicerLaunchOptions {
        mode: SlicerLaunchMode::AsIs,
        slicer_id,
    }
}

fn read_record(directory: &Path) -> SlicerLaunchRecord {
    serde_json::from_str(&std::fs::read_to_string(directory.join(LAUNCH_RECORD_NAME)).unwrap())
        .unwrap()
}

fn cura_bytes(path: &Path) {
    cura_project(path, None);
}

fn classified(path: &Path) -> (FileKind, Option<SlicerId>) {
    let classification = classify_file(path);
    (classification.kind, classification.slicer)
}

// ---------------------------------------------------------------------------------------------
// The data-loss rule (constraint 8)
// ---------------------------------------------------------------------------------------------

#[test]
fn a_model_kind_3mf_is_copied_into_a_launch_directory_and_its_own_path_is_never_spawned() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Mesh");
    let (file_id, abs_path) = env.add_file(&project_id, "mesh.3mf", plain_mesh_3mf);

    // The trap this exists for: `classify_file` calls this a `model`, exactly as it calls an
    // `.stl` one, and the reference library holds 28 of them.
    assert_eq!(classified(&abs_path), (FileKind::Model, None));
    let before = (
        std::fs::read(&abs_path).unwrap(),
        std::fs::metadata(&abs_path).unwrap().modified().unwrap(),
    );

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    assert_eq!(h.spawner.count(), 1);
    let spawned = PathBuf::from(&h.spawner.paths()[0]);
    assert_eq!(
        spawned,
        h.sessions_dir.join(&result.launch_id).join("mesh.3mf")
    );
    assert_ne!(spawned, abs_path);
    assert!(
        spawned.exists(),
        "the copy the slicer was handed is not there"
    );

    // The source is untouched, bytes and mtime both. The slicer's first save proposes
    // `<basename>.3mf`, which for this source *is* the source, so "we did not launch it in place"
    // and "the source is unchanged" are two different claims and both are worth making.
    assert_eq!(std::fs::read(&abs_path).unwrap(), before.0);
    assert_eq!(
        std::fs::metadata(&abs_path).unwrap().modified().unwrap(),
        before.1
    );
}

#[test]
fn an_stl_is_launched_in_place_and_no_launch_directory_is_created_at_all() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Stl");
    let (file_id, abs_path) = env.add_file(&project_id, "cube.stl", stl_bytes);

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    assert_eq!(h.spawner.paths(), [abs_path.to_string_lossy().into_owned()]);
    assert!(
        h.sessions().is_empty(),
        "a mesh launched in place must leave no launch directory"
    );
    assert!(!result.stripped);
}

#[test]
fn an_obj_is_launched_in_place_too() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Obj");
    let (file_id, abs_path) = env.add_file(&project_id, "cube.obj", |path| {
        std::fs::write(path, "v 0 0 0\n").unwrap()
    });

    h.launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    assert_eq!(h.spawner.paths(), [abs_path.to_string_lossy().into_owned()]);
    assert!(h.sessions().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Path A: open as-is
// ---------------------------------------------------------------------------------------------

#[test]
fn a_slicer_project_opened_as_is_is_spawned_at_the_library_path_with_no_copy_and_no_strip() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("AsIs");
    let (file_id, abs_path) = env.add_file(&project_id, "bracket.3mf", cura_bytes);
    let before = (
        std::fs::read(&abs_path).unwrap(),
        std::fs::metadata(&abs_path).unwrap().modified().unwrap(),
    );

    let result = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap();

    let spawned = h.spawner.spawned();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].command, CURA_13_EXE);
    assert_eq!(spawned[0].args, [abs_path.to_string_lossy().into_owned()]);
    // No launch directory on this path, so the scratch directory is the whole of the answer.
    assert_eq!(spawned[0].cwd, h.scratch_cwd_dir);
    assert!(spawned[0].cwd_existed);
    assert!(h.sessions().is_empty());
    assert!(!result.stripped);
    // The file's own slicer, not the configured default (`orca`).
    assert_eq!(result.slicer_id, SlicerId::Cura);
    assert_eq!(result.install_label, "UltiMaker Cura 5.13.0");
    assert_eq!(result.pid, Some(4242));
    assert_eq!(std::fs::read(&abs_path).unwrap(), before.0);
    assert_eq!(
        std::fs::metadata(&abs_path).unwrap().modified().unwrap(),
        before.1
    );
}

#[test]
fn as_is_on_a_file_that_names_no_slicer_falls_back_to_the_default_and_says_so() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Unattributed");
    // Rule 4: saved but never sliced, so it is a project with no slicer the app can name.
    let (file_id, abs_path) = env.add_file(&project_id, "saved.3mf", |path| {
        write_zip(
            path,
            &[
                deflated("3D/3dmodel.model", "<model/>"),
                stored("Metadata/project_settings.config", "{}"),
            ],
            None,
        );
    });
    assert_eq!(classified(&abs_path), (FileKind::SlicerProject, None));

    let result = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap();

    assert_eq!(result.slicer_id, SlicerId::Orca);
    assert!(
        result.notices.iter().any(|line| line
            .contains("does not say which slicer wrote it, so your default (OrcaSlicer) was used")),
        "notices did not explain the choice: {:?}",
        result.notices
    );
}

#[test]
fn as_is_refuses_a_file_that_is_not_a_slicer_project_and_points_at_the_other_path() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("AsIsMesh");
    let (file_id, _) = env.add_file(&project_id, "mesh.3mf", plain_mesh_3mf);

    let error = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert!(
        error
            .message
            .contains("start a new slicer project from this file instead")
    );
    assert_eq!(h.spawner.count(), 0);
}

// ---------------------------------------------------------------------------------------------
// Path B: the launch directory
// ---------------------------------------------------------------------------------------------

#[test]
fn a_slicer_project_handed_to_another_slicer_is_stripped_into_a_launch_directory() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("strip-me".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Strip");
    let (file_id, abs_path) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let result = h
        .launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Anycubic)),
        )
        .unwrap();

    let copy = h.sessions_dir.join("strip-me").join("bracket.3mf");
    let spawned = h.spawner.spawned();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].command, ANYCUBIC_EXE);
    assert_eq!(spawned[0].args, [copy.to_string_lossy().into_owned()]);
    assert_eq!(spawned[0].cwd, h.sessions_dir.join("strip-me"));
    assert!(spawned[0].cwd_existed);
    assert!(result.stripped);
    // The copy keeps the source's basename, because that is what four of five slicers propose on
    // the first save and what Cura carries into its Save-As dialog.
    assert_eq!(copy.file_name(), abs_path.file_name());
    // Stripped means stripped: nothing in the copy still says Cura.
    assert_eq!(classified(&copy), (FileKind::Model, None));
    assert_ne!(entry_hash(&copy).unwrap(), entry_hash(&abs_path).unwrap());
}

#[test]
fn a_source_with_nothing_to_strip_is_copied_verbatim_and_says_it_was_not_stripped() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("verbatim".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Verbatim");
    let (file_id, abs_path) = env.add_file(&project_id, "mesh.3mf", plain_mesh_3mf);

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    let copy = h.sessions_dir.join("verbatim").join("mesh.3mf");
    assert_eq!(h.spawner.paths()[0], copy.to_string_lossy());
    assert!(!result.stripped);
    assert_eq!(
        std::fs::read(&copy).unwrap(),
        std::fs::read(&abs_path).unwrap()
    );
}

#[test]
fn a_source_called_launch_json_is_refused_rather_than_overwritten_by_its_own_record() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Collision");
    // `.json` takes the plain-copy branch, and the copy keeps the source's basename, which for this
    // one name is the name of the record written beside it a moment later. Left alone, the record
    // replaces the copy, and the slicer is handed a record whose `launched_hash` describes the file
    // it has just overwritten.
    let (file_id, abs_path) = env.add_file(&project_id, "launch.json", |path| {
        std::fs::write(path, "{\"mine\": true}").unwrap();
    });

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert!(
        error
            .message
            .contains("a file called launch.json cannot be prepared for a new project"),
        "{}",
        error.message
    );
    assert_eq!(h.spawner.count(), 0);
    assert!(
        h.sessions().is_empty(),
        "the refusal must not leave a launch directory behind"
    );
    // And the user's own file is exactly as it was.
    assert_eq!(
        std::fs::read_to_string(&abs_path).unwrap(),
        "{\"mine\": true}"
    );

    // Spelled differently, and on the platform this ships to it is the same file. The comparison is
    // case-insensitive for that reason, and refusing it on a case-sensitive filesystem too costs
    // nothing: it is one basename, and no slicer can do anything with a `.json` anyway.
    let other = env.project("CollisionCase");
    let (shouty, _) = env.add_file(&other, "Launch.JSON", |path| {
        std::fs::write(path, "{}").unwrap()
    });
    let second = h
        .launcher
        .open(&shouty, &other, &new_project(None))
        .unwrap_err();
    assert_eq!(second.code, AppErrorCode::Validation);
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn a_launch_directory_holds_the_copy_and_the_record_and_nothing_named_like_the_other() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("two-entries".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("TwoEntries");
    let (file_id, _) = env.add_file(&project_id, "plate.3mf", cura_bytes);

    h.launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    let directory = h.sessions_dir.join("two-entries");
    let mut names: Vec<String> = std::fs::read_dir(&directory)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["launch.json", "plate.3mf"]);
    // The invariant the refusal above exists to keep: the record still describes the copy.
    let record = read_record(&directory);
    assert_eq!(
        record.launched_hash,
        entry_hash(&directory.join(&record.file_name)).unwrap()
    );
}

#[test]
fn a_file_that_is_neither_a_mesh_nor_a_3mf_is_copied_into_a_launch_directory_unchanged() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("other".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Other");
    let (file_id, abs_path) = env.add_file(&project_id, "notes.gcode", |path| {
        std::fs::write(path, ";G-code\n").unwrap()
    });

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    let copy = h.sessions_dir.join("other").join("notes.gcode");
    assert_eq!(h.spawner.paths()[0], copy.to_string_lossy());
    assert!(!result.stripped);
    assert_eq!(
        std::fs::read(&copy).unwrap(),
        std::fs::read(&abs_path).unwrap()
    );
}

// ---------------------------------------------------------------------------------------------
// The launch record
// ---------------------------------------------------------------------------------------------

/// The canonical form of a folder, computed here independently of the code under test: on Windows
/// a temporary directory can carry an 8.3 short name, and a plain absolute path would then
/// disagree with what the launcher records for the very same folder.
fn independent_key(dir: &Path) -> String {
    let canonical = std::fs::canonicalize(dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    format!(
        "local:{}",
        canonical.strip_prefix("\\\\?\\").unwrap_or(&canonical)
    )
}

#[test]
fn launch_json_records_the_launch_with_launched_hash_equal_to_entry_hash_of_what_was_launched() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("recorded".to_owned()),
            now: Some(1_756_400_000_123),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Recorded");
    let (file_id, abs_path) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(Some(SlicerId::Orca)))
        .unwrap();

    let directory = h.sessions_dir.join("recorded");
    let copy = directory.join("bracket.3mf");
    let record = read_record(&directory);
    let expected = SlicerLaunchRecord {
        launch_id: "recorded".to_owned(),
        mode: SlicerLaunchMode::NewProject,
        project_id: project_id.clone(),
        file_id: file_id.clone(),
        slicer_id: SlicerId::Orca,
        install_id: ORCA.to_owned(),
        file_name: "bracket.3mf".to_owned(),
        launched_hash: entry_hash(&copy).unwrap(),
        started_at: 1_756_400_000_123,
        // Which library this came out of. `slicer-sessions/` is per-machine and every id above is
        // per-library, so without this a session survives a folder switch as an unanswerable row.
        library: Some(independent_key(env.library.path())),
        // Three facts the reconcile cannot recover afterwards: four of five slicers save back
        // *over* this file, so once the first Ctrl+S lands nothing on disk can still say what it
        // was, how big it was, or what was in it.
        source_slicer: Some(SlicerId::Cura),
        source_size_bytes: Some(i64::try_from(std::fs::metadata(&copy).unwrap().len()).unwrap()),
        launched_entries: Some(entry_digests(&copy).unwrap()),
        swept_at: None,
    };
    assert_eq!(record, expected);
    // Not the source's digests: the copy was stripped, so a diff against the original would blame
    // the slicer for entries this app removed.
    assert_ne!(
        record.launched_entries.as_ref().unwrap(),
        &entry_digests(&abs_path).unwrap(),
        "the record kept the source digests rather than those of the launched copy"
    );
    assert_eq!(record.launch_id, result.launch_id);
    // The hash is of the *stripped copy*, which is the file the slicer has: not of the source.
    assert_ne!(record.launched_hash, entry_hash(&abs_path).unwrap());
    // The directory holds the file and the record, and nothing else.
    let mut names: Vec<String> = std::fs::read_dir(&directory)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["bracket.3mf", "launch.json"]);
    // And the watch is told about it.
    let launched = h.launched.lock().unwrap();
    assert_eq!(launched.len(), 1);
    assert_eq!(launched[0].launch_id, "recorded");
    assert_eq!(launched[0].path, copy);
    assert_eq!(launched[0].launched_hash, record.launched_hash);
}

#[test]
fn an_in_place_launch_writes_no_record_because_there_is_no_directory_to_put_one_in() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("NoRecord");
    let (file_id, _) = env.add_file(&project_id, "cube.stl", stl_bytes);

    h.launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap();

    assert!(h.sessions().is_empty());
    assert!(
        h.launched.lock().unwrap().is_empty(),
        "nothing to watch on an in-place launch"
    );
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

fn reason(error: &spm_core::AppError) -> Option<&str> {
    error.details.as_ref()?.get("reason")?.as_str()
}

#[test]
fn a_strip_that_would_leave_configuration_behind_refuses_names_the_reason_and_never_spawns() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("TwoFlavours");
    // Both a Cura tree and a PrusaSlicer config. `classify_3mf` calls it `cura` (first match wins),
    // so it gets the Cura strip set, and what comes out still classifies `prusaslicer`.
    let (file_id, _) = env.add_file(&project_id, "mixed.3mf", |path| {
        write_zip(
            path,
            &[
                deflated("3D/3dmodel.model", "<model/>"),
                stored("Cura/preferences.cfg", "[general]"),
                stored("Metadata/Slic3r_PE.config", "; generated by PrusaSlicer"),
            ],
            None,
        );
    });

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(reason(&error), Some("configuration-left-behind"));
    assert!(
        error
            .message
            .contains("stripping it left slicer configuration behind")
    );
    // Constraint 9: it says the other path is still open, rather than quietly taking it.
    assert!(
        error
            .message
            .contains("Opening it as it is, without stripping, is still available")
    );
    // The count, not only the refusal: a fallback to the original would have refused nothing.
    assert_eq!(h.spawner.count(), 0);
    assert!(
        h.sessions().is_empty(),
        "a refused strip left its launch directory behind"
    );
}

#[test]
fn a_3mf_that_is_not_a_readable_archive_refuses_as_unreadable_rather_than_being_handed_over() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Corrupt");
    let (file_id, _) = env.add_file(&project_id, "torn.3mf", |path| {
        std::fs::write(path, "not a zip").unwrap()
    });

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(reason(&error), Some("unreadable"));
    assert!(error.message.contains("could not be read as a 3MF archive"));
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn an_encrypted_entry_refuses_as_encrypted_which_is_a_different_next_move_from_unreadable() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Encrypted");
    let (file_id, _) = env.add_file(&project_id, "locked.3mf", |path| {
        cura_bytes(path);
        // General-purpose bit 0, in both headers: the entry is encrypted, so the rewriter cannot
        // reproduce bytes it cannot read. The archive is otherwise perfectly well-formed, which is
        // what separates this from the `unreadable` case.
        patch_zip_headers(path, |patch| {
            if patch.name != "3D/3dmodel.model" {
                return;
            }
            set_u16(patch.file, patch.central_at + 8, 1);
            set_u16(patch.file, patch.local_at + 6, 1);
        });
    });

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(reason(&error), Some("encrypted"));
    assert!(error.message.contains("it is an encrypted archive"));
    assert!(
        error
            .message
            .contains("Opening it as it is, without stripping, is still available")
    );
    assert_eq!(h.spawner.count(), 0);
    assert!(h.sessions().is_empty());
}

#[test]
fn a_launch_whose_bound_install_has_vanished_reports_it_as_gone_and_does_not_spawn() {
    // Every executable is there except Cura's, and the re-resolution finds nothing.
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            present: Some(vec![ORCA_EXE, BAMBU_EXE, ANYCUBIC_EXE, PRUSA_EXE]),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Gone");
    let (file_id, _) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::NotFound);
    assert!(error.message.contains("no longer installed where it was"));
    assert_eq!(h.spawner.count(), 0);
    assert!(
        h.sessions().is_empty(),
        "a vanished install must not leave a launch directory"
    );
}

#[test]
fn a_product_with_two_installs_and_no_binding_refuses_naming_the_choice_rather_than_making_it() {
    let env = Env::new();
    let mut config = machine();
    config.installs.push(install(
        CURA_12,
        SlicerId::Cura,
        "UltiMaker Cura 5.12.0",
        CURA_12_EXE,
    ));
    config.bindings.remove(&SlicerId::Cura);
    let h = Harness::new(
        &env,
        HarnessOptions {
            config: Some(config),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("TwoCuras");
    let (file_id, _) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(
        error.message.contains("2 installs of UltiMaker Cura"),
        "{}",
        error.message
    );
    assert!(error.message.contains("UltiMaker Cura 5.13.0"));
    assert!(error.message.contains("UltiMaker Cura 5.12.0"));
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn a_product_with_one_unbound_install_is_not_described_as_a_choice_between_installs() {
    let env = Env::new();
    let mut config = machine();
    // A second Cura that is gone. The count the message may quote is the *usable* one, which is
    // one: "1 installs ... choose which one" is both broken English and a false question.
    let mut gone = install(
        CURA_12,
        SlicerId::Cura,
        "UltiMaker Cura 5.12.0",
        CURA_12_EXE,
    );
    gone.missing = true;
    config.installs.push(gone);
    config.bindings.remove(&SlicerId::Cura);
    let h = Harness::new(
        &env,
        HarnessOptions {
            config: Some(config),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("OneUnbound");
    let (file_id, _) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(
        error
            .message
            .contains("UltiMaker Cura is installed (UltiMaker Cura 5.13.0) but not chosen"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("installs of"));
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn a_product_with_no_install_at_all_is_reported_as_not_set_up_not_as_an_ambiguous_choice() {
    let env = Env::new();
    let mut config = machine();
    config
        .installs
        .retain(|row| row.slicer_id != SlicerId::Cura);
    config.bindings.remove(&SlicerId::Cura);
    let h = Harness::new(
        &env,
        HarnessOptions {
            config: Some(config),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("NoCura");
    let (file_id, _) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::NotFound);
    assert!(
        error
            .message
            .contains("UltiMaker Cura is not set up on this machine"),
        "{}",
        error.message
    );
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn a_file_that_belongs_to_another_project_is_not_launchable_through_this_one() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let mine = env.project("Mine");
    let theirs = env.project("Theirs");
    let (file_id, _) = env.add_file(&theirs, "bracket.3mf", cura_bytes);
    // A file of its own in the project being named, which is what makes this a *pair* check rather
    // than an "is this project empty" check. Without it, a launcher that took whichever file the
    // project happened to list first would refuse here for the wrong reason and pass.
    let (decoy_id, decoy_path) = env.add_file(&mine, "decoy.3mf", cura_bytes);

    let error = h.launcher.open(&file_id, &mine, &as_is(None)).unwrap_err();

    assert_eq!(error.code, AppErrorCode::NotFound);
    assert_eq!(h.spawner.count(), 0);

    // And the same project does launch its own file, so the refusal above is not this fixture
    // refusing everything.
    h.launcher.open(&decoy_id, &mine, &as_is(None)).unwrap();
    assert_eq!(
        h.spawner.spawned()[0].args,
        [decoy_path.to_string_lossy().into_owned()]
    );
}

#[test]
fn no_library_open_is_a_refusal_and_so_is_remote_mode_with_no_server_attached() {
    let env = Env::new();
    let closed = Harness::new(
        &env,
        HarnessOptions {
            no_library: true,
            ..HarnessOptions::default()
        },
    );
    let error = closed.launcher.open("f", "p", &as_is(None)).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("no library folder is open"));

    // Remote mode reaches a different refusal: there is no *server*, which is not the same failure
    // as there being no folder, and the message has to say which it was.
    let remote = Harness::new(
        &env,
        HarnessOptions {
            is_remote: true,
            ..HarnessOptions::default()
        },
    );
    let error = remote.launcher.open("f", "p", &as_is(None)).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("not connected to a server"));
}

#[test]
fn no_default_slicer_and_nothing_chosen_is_a_refusal_not_a_guess() {
    let env = Env::new();
    let mut config = machine();
    config.default_slicer_id = None;
    let h = Harness::new(
        &env,
        HarnessOptions {
            config: Some(config),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("NoDefault");
    let (file_id, _) = env.add_file(&project_id, "cube.stl", stl_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("no default slicer is set"));
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn a_spawn_that_fails_takes_its_launch_directory_with_it() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("doomed".to_owned()),
            spawn_fails: true,
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("Doomed");
    let (file_id, _) = env.add_file(&project_id, "bracket.3mf", cura_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Internal);
    assert!(h.sessions().is_empty());
}

// ---------------------------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------------------------

#[test]
fn argv_is_exactly_the_registry_row_which_is_one_bare_positional_argument() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Argv");
    let (file_id, abs_path) = env.add_file(&project_id, "cube.stl", stl_bytes);

    h.launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Prusaslicer)),
        )
        .unwrap();

    let spawned = h.spawner.spawned();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].command, PRUSA_EXE);
    assert_eq!(spawned[0].args, [abs_path.to_string_lossy().into_owned()]);
    assert_eq!(spawned[0].cwd, h.scratch_cwd_dir);
    assert!(spawned[0].cwd_existed);
}

// ---------------------------------------------------------------------------------------------
// The working directory the child inherits (F-7)
// ---------------------------------------------------------------------------------------------

#[test]
fn a_launch_that_builds_a_directory_hands_the_slicer_that_directory_as_its_cwd() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("cwd-directory".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("CwdDirectory");
    let (file_id, _) = env.add_file(&project_id, "plate.3mf", cura_bytes);

    h.launcher
        .open(&file_id, &project_id, &new_project(Some(SlicerId::Orca)))
        .unwrap();

    let directory = h.sessions_dir.join("cwd-directory");
    let spawned = &h.spawner.spawned()[0];
    assert_eq!(spawned.cwd, directory);
    assert!(spawned.cwd_existed);
    // The whole point of preferring the launch directory: a cwd-relative write lands beside the
    // copy, where the session scan can see it, rather than anywhere else on the machine.
    assert_eq!(Path::new(&spawned.args[0]).parent().unwrap(), directory);
}

#[test]
fn a_launch_that_builds_no_directory_hands_the_slicer_the_scratch_directory_created_first() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("CwdScratch");
    let (file_id, _) = env.add_file(&project_id, "cube.stl", stl_bytes);

    // Nothing has created it yet. This is the fresh-profile shape, and it is the one an earlier
    // draft of the design would have failed on.
    assert!(!h.scratch_cwd_dir.exists());

    h.launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Anycubic)),
        )
        .unwrap();

    let spawned = &h.spawner.spawned()[0];
    assert_eq!(spawned.cwd, h.scratch_cwd_dir);
    // Existed *at the moment of the spawn*, not merely by the time this line runs.
    assert!(spawned.cwd_existed);
    // Not the two answers the spec rejected. The sessions directory is created lazily, so a spawn
    // pointed at it on a fresh profile fails and every in-place launch fails; and a stray landing
    // loose in it is surfaced to the user as an orphan session they never made.
    assert_ne!(spawned.cwd, h.sessions_dir);
    assert!(
        h.sessions().is_empty(),
        "the scratch directory must not be under slicer-sessions"
    );
}

#[test]
fn the_scratch_directory_is_remade_for_the_next_launch_after_the_user_deletes_it() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("CwdRemade");
    let (file_id, _) = env.add_file(&project_id, "cube.stl", stl_bytes);

    h.launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Anycubic)),
        )
        .unwrap();
    // A profile the user has cleaned out between two launches. Creating the directory once, at
    // construction, survives the test above and dies here.
    std::fs::remove_dir_all(&h.scratch_cwd_dir).unwrap();
    assert!(!h.scratch_cwd_dir.exists());

    h.launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Anycubic)),
        )
        .unwrap();

    let spawned = h.spawner.spawned();
    assert_eq!(spawned.len(), 2);
    assert_eq!(spawned[1].cwd, h.scratch_cwd_dir);
    assert!(spawned[1].cwd_existed);
}

/// Re-targeted from the Electron suite's source walk of `app.ts` (which asserted that the one real
/// `spawn` call passed a `cwd`): in Rust the spawner trait takes the working directory as a
/// required argument, so a spawn without one does not compile. What is left to pin is that the two
/// directories the app hands the launcher are two different single-segment names, side by side
/// under one parent, neither inside the other; and `slicers_commands.rs` proves the assembled
/// subsystem puts them there.
#[test]
fn the_two_directories_are_different_single_segment_names_side_by_side() {
    assert_ne!(SLICER_CWD_DIR, SLICER_SESSIONS_DIR);
    for name in [SLICER_CWD_DIR, SLICER_SESSIONS_DIR] {
        // Single segments, so "same parent" really does make them siblings: a constant that grew
        // a separator could put the scratch directory under `slicer-sessions`.
        assert!(
            !name.contains(['\\', '/']),
            "{name} is a path, not a directory name"
        );
    }
    let data = Path::new("data");
    assert_ne!(data.join(SLICER_CWD_DIR), data.join(SLICER_SESSIONS_DIR));
}

// ---------------------------------------------------------------------------------------------
// STEP, and the one product that cannot read it (F-4, F-5)
// ---------------------------------------------------------------------------------------------

fn details_of(error: &spm_core::AppError) -> Value {
    Value::Object(error.details.clone().unwrap_or_default())
}

#[test]
fn a_step_handed_to_cura_is_refused_and_nothing_is_spawned() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("StepCura");
    let (file_id, _) = env.add_file(&project_id, "part.step", step_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(Some(SlicerId::Cura)))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(
        details_of(&error),
        serde_json::json!({ "slicerId": "cura", "extension": ".step" })
    );
    // The sentence the user actually sees, spelled out rather than rebuilt from the registry the
    // code reads: a message derived here would agree with a table that had every row wrong.
    assert_eq!(
        error.message,
        "UltiMaker Cura cannot open STEP files. Choose one of PrusaSlicer, Anycubic Slicer Next, Bambu Studio, OrcaSlicer instead."
    );
    // The assertion, not the refusal: launching Cura at a STEP file is the measured failure, a
    // healthy process, an empty plate and a warning in a log nobody opens.
    assert_eq!(h.spawner.count(), 0);
    assert!(
        h.sessions().is_empty(),
        "the refusal must come before anything is written"
    );
}

#[test]
fn a_stp_is_the_same_refusal_and_says_which_extension_it_was() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("StpCura");
    let (file_id, _) = env.add_file(&project_id, "part.stp", step_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(Some(SlicerId::Cura)))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(
        details_of(&error),
        serde_json::json!({ "slicerId": "cura", "extension": ".stp" })
    );
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn an_uppercase_step_is_refused_too_which_is_the_spelling_in_the_user_library() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("UpperStepCura");
    // `Nozzle Wiper Guard.STEP`, the real file Cura's own log shows silently dropped nine minutes
    // before the spike opened anything.
    let (file_id, _) = env.add_file(&project_id, "Wiper Guard.STEP", step_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(Some(SlicerId::Cura)))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(
        details_of(&error),
        serde_json::json!({ "slicerId": "cura", "extension": ".step" })
    );
    assert_eq!(h.spawner.count(), 0);
}

#[test]
fn the_common_shape_cura_is_the_default_and_nothing_was_chosen() {
    // No slicer on the call, because the UI has no per-launch picker. This is how a user actually
    // reaches the refusal.
    let env = Env::new();
    let mut config = machine();
    config.default_slicer_id = Some(SlicerId::Cura);
    let h = Harness::new(
        &env,
        HarnessOptions {
            config: Some(config),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("StepDefault");
    let (file_id, _) = env.add_file(&project_id, "part.step", step_bytes);

    let error = h
        .launcher
        .open(&file_id, &project_id, &new_project(None))
        .unwrap_err();

    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(
        details_of(&error),
        serde_json::json!({ "slicerId": "cura", "extension": ".step" })
    );
    assert_eq!(h.spawner.count(), 0);
}

// Four, one per product, and named individually: a refusal keyed on the wrong side of the boolean
// passes a suite that only ever asks about Cura, and an assertion satisfied by refusing everything
// is not an assertion.
fn a_step_opens_in(slicer_id: SlicerId) {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some(format!("step-{}", slicer_id.as_str())),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project(&format!("Step-{}", slicer_id.as_str()));
    let (file_id, _) = env.add_file(&project_id, "part.step", step_bytes);

    let result = h
        .launcher
        .open(&file_id, &project_id, &new_project(Some(slicer_id)))
        .unwrap();

    assert_eq!(h.spawner.count(), 1);
    assert_eq!(result.slicer_id, slicer_id);
}

#[test]
fn a_step_opens_in_prusaslicer_which_was_measured_reading_both_extensions() {
    a_step_opens_in(SlicerId::Prusaslicer);
}

#[test]
fn a_step_opens_in_anycubic_which_was_measured_reading_both_extensions() {
    a_step_opens_in(SlicerId::Anycubic);
}

#[test]
fn a_step_opens_in_bambu_which_was_measured_reading_both_extensions() {
    a_step_opens_in(SlicerId::Bambu);
}

#[test]
fn a_step_opens_in_orca_which_was_measured_reading_both_extensions() {
    a_step_opens_in(SlicerId::Orca);
}

#[test]
fn a_step_goes_through_a_launch_directory_keeping_its_own_basename() {
    let env = Env::new();
    let h = Harness::new(
        &env,
        HarnessOptions {
            launch_id: Some("step-copied".to_owned()),
            ..HarnessOptions::default()
        },
    );
    let project_id = env.project("StepCopied");
    let (file_id, abs_path) = env.add_file(&project_id, "bracket.step", step_bytes);

    h.launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Prusaslicer)),
        )
        .unwrap();

    // Asserted as a path rather than trusted as a paragraph: a STEP moved onto the in-place branch
    // would spawn exactly as successfully from the library path, and nothing has measured what the
    // four capable slicers propose on the first save from a STEP input.
    let copy = h.sessions_dir.join("step-copied").join("bracket.step");
    let spawned = &h.spawner.spawned()[0];
    assert_eq!(spawned.args[0], copy.to_string_lossy());
    assert_ne!(spawned.args[0], abs_path.to_string_lossy());
    assert_eq!(copy.file_name(), abs_path.file_name());
    assert_eq!(spawned.cwd, h.sessions_dir.join("step-copied"));
    assert_eq!(
        std::fs::read(&copy).unwrap(),
        std::fs::read(&abs_path).unwrap()
    );
}

#[test]
fn the_registry_says_which_products_open_step_one_row_at_a_time() {
    // Individually, not as a filter over the table, so a row that flips is named in the failure.
    assert!(
        !slicer(SlicerId::Cura).behaviour.opens_step,
        "cura ships no STEP reader (spike 1d)"
    );
    assert!(
        slicer(SlicerId::Prusaslicer).behaviour.opens_step,
        "prusaslicer opens .step and .stp"
    );
    assert!(
        slicer(SlicerId::Anycubic).behaviour.opens_step,
        "anycubic opens .step and .stp"
    );
    assert!(
        slicer(SlicerId::Bambu).behaviour.opens_step,
        "bambu opens .step and .stp"
    );
    assert!(
        slicer(SlicerId::Orca).behaviour.opens_step,
        "orca opens .step and .stp"
    );
    // And the refusal's list of alternatives is every capable row, in registry order.
    assert_eq!(
        SLICER_IDS
            .into_iter()
            .filter(|id| slicer(*id).behaviour.opens_step)
            .map(|id| slicer(id).display_name)
            .collect::<Vec<_>>(),
        [
            "PrusaSlicer",
            "Anycubic Slicer Next",
            "Bambu Studio",
            "OrcaSlicer"
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// The notices table, driven as a triple
// ---------------------------------------------------------------------------------------------

const ALWAYS: [&str; 2] = [
    "A slicer can take up to a minute to show a window (measured 2 s to 35 s).",
    "It may open a configuration wizard or an update prompt in front of your model.",
];

/// A `.3mf` project written by `slicer`, as `classify_3mf` would label it.
fn project_from(slicer_id: SlicerId) -> LaunchedSource {
    LaunchedSource {
        classification: Classification {
            kind: FileKind::SlicerProject,
            slicer: Some(slicer_id),
            unreadable: false,
        },
        is_3mf: true,
    }
}

fn mesh(is_3mf: bool) -> LaunchedSource {
    LaunchedSource {
        classification: Classification {
            kind: FileKind::Model,
            slicer: None,
            unreadable: false,
        },
        is_3mf,
    }
}

fn with_always(specific: &[&str]) -> Vec<String> {
    specific
        .iter()
        .chain(ALWAYS.iter())
        .map(|line| (*line).to_owned())
        .collect()
}

fn said(slicer_id: SlicerId, source: LaunchedSource, stripped: bool) -> Vec<String> {
    notices(slicer_id, &source, stripped, false)
}

#[test]
fn prusaslicer_warns_about_its_dialog_for_any_3mf_stripped_or_not_and_never_for_an_stl() {
    for stripped in [false, true] {
        for source in [project_from(SlicerId::Cura), mesh(true)] {
            assert_eq!(
                said(SlicerId::Prusaslicer, source, stripped),
                with_always(&[
                    "It will ask what to do with the file before opening it, and nothing loads until you answer."
                ])
            );
        }
    }
    // A config-less `.3mf` and an `.stl` classify identically; only the extension separates them,
    // which is why `is_3mf` is part of the input at all.
    assert_eq!(
        said(SlicerId::Prusaslicer, mesh(false), false),
        with_always(&[])
    );
}

#[test]
fn bambu_warns_for_a_project_it_did_not_author_and_for_its_own_once_stripped() {
    let modal = "It will say the config is invalid and load geometry only.";

    assert_eq!(
        said(SlicerId::Bambu, project_from(SlicerId::Cura), false),
        with_always(&[modal])
    );
    assert_eq!(
        said(SlicerId::Bambu, project_from(SlicerId::Cura), true),
        with_always(&[modal])
    );
    // The row a slicer-keyed table cannot produce: stripping is what *creates* the modal here.
    assert_eq!(
        said(SlicerId::Bambu, project_from(SlicerId::Bambu), true),
        with_always(&[modal])
    );
    // And the negative that makes the positive mean something.
    assert_eq!(
        said(SlicerId::Bambu, project_from(SlicerId::Bambu), false),
        with_always(&[])
    );
    assert_eq!(said(SlicerId::Bambu, mesh(false), false), with_always(&[]));
}

#[test]
fn anycubic_warns_about_a_silent_discard_only_for_an_unstripped_bambu_lineage_project() {
    let discard = "It may discard the file without telling you.";

    assert_eq!(
        said(SlicerId::Anycubic, project_from(SlicerId::Bambu), false),
        with_always(&[discard])
    );
    assert_eq!(
        said(SlicerId::Anycubic, project_from(SlicerId::Orca), false),
        with_always(&[discard])
    );
    // Stripping is what fixes it (that is the headline measurement), so the notice goes.
    assert_eq!(
        said(SlicerId::Anycubic, project_from(SlicerId::Bambu), true),
        with_always(&[])
    );
    // Its own project, and a lineage whose header its version check does not read.
    assert_eq!(
        said(SlicerId::Anycubic, project_from(SlicerId::Anycubic), false),
        with_always(&[])
    );
    assert_eq!(
        said(SlicerId::Anycubic, project_from(SlicerId::Cura), false),
        with_always(&[])
    );
}

#[test]
fn orca_says_two_different_things_about_a_foreign_project_and_nothing_about_its_own() {
    assert_eq!(
        said(SlicerId::Orca, project_from(SlicerId::Bambu), false),
        with_always(&["It will warn about the version and may rewrite print settings."])
    );
    assert_eq!(
        said(SlicerId::Orca, project_from(SlicerId::Bambu), true),
        with_always(&["It will show one informational notice, \"loading geometry data only\"."])
    );
    assert_eq!(
        said(SlicerId::Orca, project_from(SlicerId::Orca), false),
        with_always(&[])
    );
    assert_eq!(said(SlicerId::Orca, mesh(true), false), with_always(&[]));
}

#[test]
fn cura_is_told_nothing_beyond_the_two_that_apply_to_every_launch() {
    assert_eq!(
        said(SlicerId::Cura, project_from(SlicerId::Prusaslicer), false),
        with_always(&[])
    );
    assert_eq!(said(SlicerId::Cura, mesh(false), true), with_always(&[]));
}

#[test]
fn remote_mode_adds_exactly_one_row_for_the_product_that_never_saves_in_place() {
    // Keyed on `saves_in_place`, so it follows the measured property: Cura alone.
    for id in SLICER_IDS {
        let remote = notices(id, &mesh(false), false, true);
        let local = notices(id, &mesh(false), false, false);
        if id == SlicerId::Cura {
            assert_eq!(remote.len(), local.len() + 1);
            assert!(
                remote[0].contains("Nothing will come back here"),
                "{}",
                remote[0]
            );
        } else {
            assert_eq!(remote, local, "{id:?}");
        }
    }
}

#[test]
fn the_notices_a_real_launch_carries_are_the_ones_its_own_triple_produces() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("Notices");
    let (file_id, abs_path) = env.add_file(&project_id, "plate.3mf", |path| {
        bambu_lineage_project(path, &["X-BBL-Client-Type"], None);
    });
    assert_eq!(
        classified(&abs_path),
        (FileKind::SlicerProject, Some(SlicerId::Bambu))
    );

    // Unstripped, straight to Anycubic: the silent-discard case, and the one the strip exists for.
    let as_is_launch = h
        .launcher
        .open(&file_id, &project_id, &as_is(Some(SlicerId::Anycubic)))
        .unwrap();
    assert_eq!(
        as_is_launch.notices,
        said(SlicerId::Anycubic, project_from(SlicerId::Bambu), false)
    );
    assert!(
        as_is_launch
            .notices
            .contains(&"It may discard the file without telling you.".to_owned())
    );

    // The same file through the new-project path is stripped, and the warning is gone.
    let stripped = h
        .launcher
        .open(
            &file_id,
            &project_id,
            &new_project(Some(SlicerId::Anycubic)),
        )
        .unwrap();
    assert!(stripped.stripped);
    assert_eq!(
        stripped.notices,
        said(SlicerId::Anycubic, project_from(SlicerId::Bambu), true)
    );
    assert!(
        !stripped
            .notices
            .contains(&"It may discard the file without telling you.".to_owned())
    );
}

#[test]
fn a_prusaslicer_project_launched_in_prusaslicer_still_draws_the_extension_driven_warning() {
    let env = Env::new();
    let h = Harness::new(&env, HarnessOptions::default());
    let project_id = env.project("PrusaOwn");
    let (file_id, _) = env.add_file(&project_id, "own.3mf", |path| prusa_project(path, None));

    let result = h
        .launcher
        .open(&file_id, &project_id, &as_is(None))
        .unwrap();

    assert_eq!(result.slicer_id, SlicerId::Prusaslicer);
    assert!(result.notices.contains(
        &"It will ask what to do with the file before opening it, and nothing loads until you answer."
            .to_owned()
    ));
}

#[test]
fn the_slice_info_fixture_still_labels_the_lineage_the_way_classify_3mf_reads_it() {
    // Guards the two Bambu-lineage assertions above against a fixture that silently stopped
    // producing the header they are about.
    assert!(slice_info(&["X-BBL-Client-Type"]).contains("X-BBL-Client-Type"));
}
