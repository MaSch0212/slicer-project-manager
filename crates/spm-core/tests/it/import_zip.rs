//! Ported from the legacy `import-zip.test.ts`: planning an archive, and importing one.

use std::fs;
use std::path::PathBuf;

use serde_json::json;
use spm_core::dto::{CoreProjectDto, ProjectQuery};
use spm_core::files::zip::{ZipEntry, read_zip_entries};
use spm_core::projects::import_curamanager::ImportProgress;
use spm_core::projects::import_zip::plan_zip_import;
use spm_core::testing::{TempLibrary, seed_user_in};
use spm_core::validate::ProjectPatch;
use spm_core::{
    AppErrorCode, Ctx, Library, get_project, import_curamanager_zip, list_projects, new_id,
    update_project,
};

use crate::common::code_of;
use crate::fixtures::{ZipInput, deflated, stored, write_zip};

fn marc(lib: &Library) -> Ctx {
    seed_user_in(lib, "marc", "marc", None)
}

/// Writes a zip into the library's own scratch area and returns its path.
fn make_zip(lib: &Library, entries: &[ZipInput]) -> PathBuf {
    let path = lib.dir().join(format!("{}.zip", new_id()));
    write_zip(&path, entries, None);
    path
}

fn library_entries() -> Vec<ZipInput> {
    vec![
        stored("MyLibrary/Widget A/part.stl", "solid a"),
        stored(
            "MyLibrary/Widget A/metadata.json",
            json!({"Tags": ["toys"], "Website": "https://example.invalid/a", "IsArchived": true})
                .to_string(),
        ),
        stored("MyLibrary/Bracket/model.3mf", "not a real 3mf"),
    ]
}

/// `plan_zip_import` reads a parsed central directory, so the fixture round-trips through a real
/// zip rather than through hand-built entry objects that could drift from the parser.
fn entries_of(entries: &[ZipInput]) -> Vec<ZipEntry> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plan.zip");
    write_zip(&path, entries, None);
    read_zip_entries(&path).unwrap()
}

fn rel_paths(plan: &spm_core::projects::import_zip::ZipPlan) -> Vec<String> {
    let mut paths: Vec<String> = plan.files.iter().map(|f| f.rel_path.clone()).collect();
    paths.sort();
    paths
}

fn all_projects(lib: &Library, ctx: &Ctx) -> Vec<CoreProjectDto> {
    let query = ProjectQuery {
        include_archived: Some(true),
        ..ProjectQuery::default()
    };
    list_projects(lib, ctx, &query).unwrap()
}

#[test]
fn a_single_wrapping_folder_holding_project_folders_is_stripped() {
    let plan = plan_zip_import(&entries_of(&library_entries()));
    assert_eq!(plan.stripped_root.as_deref(), Some("MyLibrary"));
    assert_eq!(plan.project_dirs, ["Bracket", "Widget A"]);
    assert_eq!(
        rel_paths(&plan),
        [
            "Bracket/model.3mf",
            "Widget A/metadata.json",
            "Widget A/part.stl"
        ]
    );
}

#[test]
fn a_single_top_level_folder_of_plain_files_is_one_project_not_a_wrapper() {
    // Stripping here would scatter the project's files across the library root, so the heuristic
    // has to see nesting before it strips anything.
    let plan = plan_zip_import(&entries_of(&[
        stored("Widget A/part.stl", "solid a"),
        stored("Widget A/notes.txt", "hi"),
    ]));
    assert_eq!(plan.stripped_root, None);
    assert_eq!(plan.project_dirs, ["Widget A"]);
}

#[test]
fn projects_at_the_archive_root_need_no_wrapper() {
    let plan = plan_zip_import(&entries_of(&[
        stored("Widget A/part.stl", "solid a"),
        stored("Bracket/model.3mf", "x"),
    ]));
    assert_eq!(plan.stripped_root, None);
    assert_eq!(plan.project_dirs, ["Bracket", "Widget A"]);
}

#[test]
fn noise_loose_root_files_and_traversal_entries_are_skipped_not_written() {
    let plan = plan_zip_import(&entries_of(&[
        stored("Widget A/part.stl", "solid a"),
        stored("Bracket/model.3mf", "x"),
        // A file directly at the library root belongs to no project.
        stored("metadata-cache.json", "{}"),
        stored("__MACOSX/._Widget A", "junk"),
        stored("Widget A/.DS_Store", "junk"),
        stored("../escape.txt", "nope"),
        stored("Widget A/../../escape2.txt", "nope"),
    ]));
    assert_eq!(plan.skipped, 5);
    assert_eq!(rel_paths(&plan), ["Bracket/model.3mf", "Widget A/part.stl"]);
    // The decisive assertion: nothing that could escape survived into the write list.
    assert!(!plan.files.iter().any(|f| f.rel_path.contains("..")));
}

#[test]
fn a_zip_import_extracts_adopts_and_applies_each_sidecar() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let zip = make_zip(&lib, &library_entries());

    let result = import_curamanager_zip(&lib, &ctx, &zip, None).unwrap();

    assert_eq!(result.projects_extracted, 2);
    assert_eq!(result.files_extracted, 3);
    assert_eq!(result.stripped_root.as_deref(), Some("MyLibrary"));
    assert_eq!(result.rescan.adopted, 2);
    assert_eq!(result.rescan.files_added, 3);
    assert_eq!(result.tags_applied, 1);

    // On disk, under the user's own root and with the wrapper folder gone.
    let marc_dir = lib.dir().join("marc");
    assert!(marc_dir.join("Widget A").join("part.stl").exists());
    assert!(marc_dir.join("Bracket").join("model.3mf").exists());
    assert!(!marc_dir.join("MyLibrary").exists());
    assert_eq!(
        fs::read_to_string(marc_dir.join("Widget A").join("part.stl")).unwrap(),
        "solid a"
    );

    // And in the database, with the sidecar applied.
    let projects = all_projects(&lib, &ctx);
    let widget = projects
        .iter()
        .find(|p| p.name == "Widget A")
        .expect("Widget A was not adopted");
    assert!(widget.is_archived);
    assert_eq!(widget.tags, ["toys"]);
    assert_eq!(
        get_project(&lib, &ctx, &widget.id)
            .unwrap()
            .project
            .website
            .as_deref(),
        Some("https://example.invalid/a")
    );
}

#[test]
fn a_colliding_project_folder_refuses_the_whole_archive_and_writes_nothing() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    fs::create_dir_all(lib.dir().join("marc").join("Bracket")).unwrap();

    let zip = make_zip(&lib, &library_entries());
    let error = import_curamanager_zip(&lib, &ctx, &zip, None).expect_err("a collision");
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("Bracket"));

    // All-or-nothing: the non-colliding folder must not have been written either.
    assert!(!lib.dir().join("marc").join("Widget A").exists());
    assert_eq!(
        fs::read_dir(lib.dir().join("marc").join("Bracket"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn an_archive_that_would_exceed_the_quota_is_refused_before_extracting() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "marc", "marc", Some(8));
    let zip = make_zip(&lib, &[stored("Widget A/big.stl", "x".repeat(4096))]);

    assert_eq!(
        code_of(import_curamanager_zip(&lib, &ctx, &zip, None)),
        AppErrorCode::QuotaExceeded
    );
    assert!(!lib.dir().join("marc").join("Widget A").exists());
}

#[test]
fn an_archive_with_no_project_folders_is_refused_with_an_explanation() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let zip = make_zip(&lib, &[stored("just-a-file.txt", "hello")]);
    let error = import_curamanager_zip(&lib, &ctx, &zip, None).expect_err("nothing to import");
    assert_eq!(error.code, AppErrorCode::Validation);
    assert!(error.message.contains("no project folders"));
}

#[test]
fn a_second_import_leaves_the_first_import_edits_alone() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    import_curamanager_zip(&lib, &ctx, &make_zip(&lib, &library_entries()), None).unwrap();

    // The user then curates Widget A in the app: un-archives it and clears the website. Its
    // metadata.json is still sitting in the folder, saying the opposite.
    let widget = all_projects(&lib, &ctx)
        .into_iter()
        .find(|p| p.name == "Widget A")
        .unwrap();
    update_project(
        &lib,
        &ctx,
        &widget.id,
        ProjectPatch {
            is_archived: Some(false),
            website: Some(None),
            ..ProjectPatch::default()
        },
    )
    .unwrap();

    // A completely unrelated second archive must not re-run the sidecar pass over it.
    import_curamanager_zip(
        &lib,
        &ctx,
        &make_zip(
            &lib,
            &[
                stored("Later/part.stl", "solid later"),
                stored("Later/metadata.json", json!({"Tags": ["new"]}).to_string()),
            ],
        ),
        None,
    )
    .unwrap();

    let after = get_project(&lib, &ctx, &widget.id).unwrap().project;
    assert!(
        !after.is_archived,
        "the second import re-archived an edited project"
    );
    assert_eq!(
        after.website, None,
        "the second import restored a cleared website"
    );
    // And the new archive did land, so the guard above is not just an import that did nothing.
    let visible = list_projects(&lib, &ctx, &ProjectQuery::default()).unwrap();
    assert!(visible.iter().any(|p| p.name == "Later"));
}

#[test]
fn a_stored_file_keeps_its_exact_bytes_through_the_round_trip() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    // Deflated, so this exercises the inflate path rather than a stored copy.
    let body = "solid deflate-me\n".repeat(400);
    let zip = make_zip(&lib, &[deflated("Widget/part.stl", &body)]);
    import_curamanager_zip(&lib, &ctx, &zip, None).unwrap();
    assert_eq!(
        fs::read_to_string(lib.dir().join("marc").join("Widget").join("part.stl")).unwrap(),
        body
    );
}

#[test]
fn progress_is_reported_for_extraction_indexing_and_sidecars_in_that_order() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let mut phases: Vec<&'static str> = Vec::new();
    let mut record = |event: &ImportProgress| {
        phases.push(match event {
            ImportProgress::Extracting { .. } => "extracting",
            ImportProgress::Indexing(_) => "indexing",
            ImportProgress::Sidecars { .. } => "sidecars",
        });
    };
    import_curamanager_zip(
        &lib,
        &ctx,
        &make_zip(&lib, &library_entries()),
        Some(&mut record),
    )
    .unwrap();

    let first = |name| phases.iter().position(|p| *p == name);
    let last = |name| phases.iter().rposition(|p| *p == name);
    assert!(first("extracting").is_some(), "no extraction progress");
    assert!(first("indexing").is_some(), "no indexing progress");
    assert!(first("sidecars").is_some(), "no sidecar progress");
    assert!(
        last("extracting") < first("indexing"),
        "phases out of order: {phases:?}"
    );
    assert!(
        last("indexing") < first("sidecars"),
        "phases out of order: {phases:?}"
    );
}

#[test]
fn the_writes_land_inside_the_user_own_folder_never_a_sibling_user() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    seed_user_in(&lib, "other", "other", None);
    fs::write(lib.dir().join("other").join("keep.txt"), "untouched").unwrap();

    import_curamanager_zip(&lib, &ctx, &make_zip(&lib, &library_entries()), None).unwrap();

    let names: Vec<String> = fs::read_dir(lib.dir().join("other"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["keep.txt"]);
}

#[test]
fn a_backslash_separated_entry_is_judged_the_same_way_on_every_platform() {
    // A Windows tool can write backslashes into an entry name even though the format says not to.
    // Splitting on them lets the '..' rule see the traversal, so the archive is judged
    // identically everywhere, rather than being refused by safe_join on Windows, where those
    // really are separators, and quietly written as one absurd filename on Linux, where they are
    // not.
    let plan = plan_zip_import(&entries_of(&[
        stored("Widget A/part.stl", "solid a"),
        stored("Widget A/sub\\..\\..\\..\\escape.txt", "nope"),
        stored("Widget A\\nested\\ok.stl", "solid ok"),
        // A second top-level folder, so the nesting above does not read as a wrapper to strip and
        // this case stays about separators rather than about the wrapper heuristic.
        stored("Bracket/model.3mf", "x"),
    ]));

    assert_eq!(plan.stripped_root, None);
    assert_eq!(plan.skipped, 1);
    // The traversal is gone; the innocuous backslash path became real nested segments.
    assert_eq!(
        rel_paths(&plan),
        [
            "Bracket/model.3mf",
            "Widget A/nested/ok.stl",
            "Widget A/part.stl"
        ]
    );
}

#[test]
fn an_archive_carrying_a_traversal_never_writes_outside_the_user_root() {
    let plan = plan_zip_import(&entries_of(&[
        stored("Widget A/part.stl", "solid a"),
        stored("Widget A/sub\\..\\..\\..\\escape.txt", "nope"),
        stored("../../escape2.txt", "nope"),
    ]));
    assert!(!plan.files.iter().any(|f| f.rel_path.contains("..")));
    assert_eq!(plan.project_dirs, ["Widget A"]);
}

// ---------------------------------------------------------------------------------------------
// Beyond the legacy suite
// ---------------------------------------------------------------------------------------------

#[test]
fn a_corrupt_entry_mid_extraction_removes_the_folders_this_import_created() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let zip = make_zip(
        &lib,
        &[
            stored("Good/part.stl", "solid good"),
            stored("Bad/part.stl", "solid bad bytes"),
        ],
    );
    // Cut the archive's second entry short by corrupting its stored size in both headers is
    // fragile; instead corrupt the central directory's declared method to an unsupported one.
    crate::fixtures::patch_zip_headers(&zip, |patch| {
        if patch.name == "Bad/part.stl" {
            crate::fixtures::set_u16(patch.file, patch.central_at + 10, 99);
        }
    });

    let result = import_curamanager_zip(&lib, &ctx, &zip, None);
    assert!(result.is_err());
    assert!(!lib.dir().join("marc").join("Good").exists());
    assert!(!lib.dir().join("marc").join("Bad").exists());
    assert!(all_projects(&lib, &ctx).is_empty());
}

#[test]
fn an_archive_that_is_not_a_zip_is_a_validation_error() {
    let lib = TempLibrary::new();
    let ctx = marc(&lib);
    let path = lib.dir().join("not-a-zip.zip");
    fs::write(&path, vec![7u8; 1000]).unwrap();
    assert_eq!(
        code_of(import_curamanager_zip(&lib, &ctx, &path, None)),
        AppErrorCode::Validation
    );
}
