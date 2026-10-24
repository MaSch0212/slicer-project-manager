//! Ported from the legacy `import-curamanager.test.ts`: the sidecar reader and the library
//! importer.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use spm_core::dto::{CoreProjectDto, ProjectQuery};
use spm_core::projects::import_curamanager::{
    CuraManagerSidecar, apply_curamanager_sidecars, move_flat_library_into_user_folder,
    read_curamanager_sidecar,
};
use spm_core::testing::{TempLibrary, seed_user_in};
use spm_core::{AppErrorCode, Ctx, Library, import_curamanager_library, list_projects};

use crate::common::code_of;

/// Writes a CuraManager-shaped project folder: files plus a PascalCase sidecar.
fn curamanager_project(root: &Path, name: &str, sidecar: Option<Value>) {
    fs::create_dir_all(root.join(name)).unwrap();
    fs::write(root.join(name).join(format!("{name}.stl")), "solid").unwrap();
    if let Some(sidecar) = sidecar {
        fs::write(root.join(name).join("metadata.json"), sidecar.to_string()).unwrap();
    }
}

fn all_projects(lib: &Library, ctx: &Ctx) -> Vec<CoreProjectDto> {
    let query = ProjectQuery {
        include_archived: Some(true),
        ..ProjectQuery::default()
    };
    list_projects(lib, ctx, &query).unwrap()
}

fn visible_names(lib: &Library, ctx: &Ctx) -> Vec<String> {
    list_projects(lib, ctx, &ProjectQuery::default())
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect()
}

#[test]
fn read_curamanager_sidecar_accepts_the_pascal_case_shape_and_tolerates_a_missing_file() {
    let lib = TempLibrary::new();
    curamanager_project(
        lib.dir(),
        "Benchy",
        Some(json!({
            "Tags": ["boat", "benchmark"],
            "Website": "https://thingiverse.com/thing:763622",
            "IsArchived": true,
        })),
    );
    assert_eq!(
        read_curamanager_sidecar(&lib.dir().join("Benchy")),
        Some(CuraManagerSidecar {
            tags: vec!["boat".to_owned(), "benchmark".to_owned()],
            website: Some("https://thingiverse.com/thing:763622".to_owned()),
            is_archived: true,
        })
    );

    curamanager_project(lib.dir(), "Bare", None);
    assert_eq!(read_curamanager_sidecar(&lib.dir().join("Bare")), None);
}

#[test]
fn malformed_sidecar_json_is_ignored_rather_than_fatal() {
    let lib = TempLibrary::new();
    fs::create_dir(lib.dir().join("Broken")).unwrap();
    fs::write(
        lib.dir().join("Broken").join("metadata.json"),
        "{ this is not json",
    )
    .unwrap();
    assert_eq!(read_curamanager_sidecar(&lib.dir().join("Broken")), None);
}

#[test]
fn a_top_level_json_array_is_not_a_valid_sidecar() {
    let lib = TempLibrary::new();
    fs::create_dir(lib.dir().join("ArrayJson")).unwrap();
    fs::write(lib.dir().join("ArrayJson").join("metadata.json"), "[]").unwrap();
    assert_eq!(read_curamanager_sidecar(&lib.dir().join("ArrayJson")), None);
}

#[test]
fn a_flat_curamanager_library_imports_into_local_mode_with_no_restructuring() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "local", ".", None);
    curamanager_project(
        lib.dir(),
        "Benchy",
        Some(json!({"Tags": ["boat"], "Website": "https://a.example", "IsArchived": false})),
    );
    curamanager_project(
        lib.dir(),
        "Bracket",
        Some(json!({"Tags": ["petg", "functional"], "IsArchived": true})),
    );
    curamanager_project(lib.dir(), "Plain", None);

    let result = import_curamanager_library(&lib, &ctx, false, None).unwrap();
    assert_eq!(result.moved, 0);
    assert_eq!(result.rescan.adopted, 3);
    assert_eq!(result.projects_updated, 2);
    assert_eq!(result.tags_applied, 3);

    let projects = all_projects(&lib, &ctx);
    let by_name = |name: &str| projects.iter().find(|p| p.name == name).unwrap();
    assert_eq!(by_name("Benchy").tags, ["boat"]);
    assert_eq!(
        by_name("Benchy").website.as_deref(),
        Some("https://a.example")
    );
    assert!(by_name("Bracket").is_archived);
    assert!(by_name("Plain").tags.is_empty());
}

#[test]
fn importing_into_a_server_library_moves_each_folder_under_the_target_user() {
    let lib = TempLibrary::new();
    let marc = seed_user_in(&lib, "marc", "marc", None);
    let anna = seed_user_in(&lib, "anna", "anna", None);
    curamanager_project(lib.dir(), "Benchy", Some(json!({"Tags": ["boat"]})));

    let result = import_curamanager_library(&lib, &marc, true, None).unwrap();
    assert_eq!(result.moved, 1);
    assert!(
        lib.dir()
            .join("marc")
            .join("Benchy")
            .join("Benchy.stl")
            .exists()
    );
    assert!(!lib.dir().join("Benchy").exists());
    // Another user's library root is never swept up.
    assert!(lib.dir().join("anna").exists());
    assert!(all_projects(&lib, &anna).is_empty());
    assert_eq!(visible_names(&lib, &marc), ["Benchy"]);
}

#[test]
fn a_folder_already_present_at_the_destination_is_a_conflict_and_nothing_is_moved_or_adopted() {
    let lib = TempLibrary::new();
    let marc = seed_user_in(&lib, "marc", "marc", None);
    curamanager_project(lib.dir(), "Benchy", Some(json!({"Tags": ["boat"]})));
    // The destination already holds a folder with the same name.
    fs::create_dir_all(lib.dir().join("marc").join("Benchy")).unwrap();
    fs::write(
        lib.dir()
            .join("marc")
            .join("Benchy")
            .join("preexisting.txt"),
        "do not touch",
    )
    .unwrap();

    let error = import_curamanager_library(&lib, &marc, true, None).expect_err("a collision");
    assert_eq!(error.code, AppErrorCode::Conflict);
    assert!(error.message.contains("Benchy"));
    assert_eq!(error.details.unwrap()["existing"], json!(["Benchy"]));

    // All-or-nothing: the source is untouched...
    assert!(lib.dir().join("Benchy").join("Benchy.stl").exists());
    // ...the pre-existing destination folder is untouched...
    assert!(
        lib.dir()
            .join("marc")
            .join("Benchy")
            .join("preexisting.txt")
            .exists()
    );
    assert!(
        !lib.dir()
            .join("marc")
            .join("Benchy")
            .join("Benchy.stl")
            .exists()
    );
    // ...and no project rows were created at all.
    assert!(all_projects(&lib, &marc).is_empty());
}

#[test]
fn the_spm_folder_is_never_moved_or_adopted_by_the_importer() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "marc", "marc", None);
    curamanager_project(lib.dir(), "Benchy", None);

    import_curamanager_library(&lib, &ctx, true, None).unwrap();
    assert!(lib.dir().join(".spm").join("app.db").exists());
    assert_eq!(visible_names(&lib, &ctx), ["Benchy"]);
}

#[test]
fn importing_twice_applies_no_duplicate_tags_and_no_duplicate_projects() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "local", ".", None);
    curamanager_project(lib.dir(), "Benchy", Some(json!({"Tags": ["boat", "BOAT"]})));

    import_curamanager_library(&lib, &ctx, false, None).unwrap();
    let second = import_curamanager_library(&lib, &ctx, false, None).unwrap();

    assert_eq!(second.rescan.adopted, 0);
    let projects = all_projects(&lib, &ctx);
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].tags, ["boat"]);
}

// ---------------------------------------------------------------------------------------------
// Beyond the legacy suite
// ---------------------------------------------------------------------------------------------

#[test]
fn camel_case_keys_are_accepted_and_null_falls_through_to_the_other_spelling() {
    let lib = TempLibrary::new();
    curamanager_project(
        lib.dir(),
        "Hand",
        Some(
            json!({"Tags": null, "tags": ["x", 7, "y"], "website": "https://h.example", "isArchived": true}),
        ),
    );
    assert_eq!(
        read_curamanager_sidecar(&lib.dir().join("Hand")),
        Some(CuraManagerSidecar {
            tags: vec!["x".to_owned(), "y".to_owned()],
            website: Some("https://h.example".to_owned()),
            is_archived: true,
        })
    );
}

#[test]
fn a_sidecar_with_an_odd_website_is_applied_as_written() {
    // The importer must accept whatever a sidecar holds: a website the app's own form would
    // refuse must not abort the whole import.
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "local", ".", None);
    curamanager_project(lib.dir(), "Odd", Some(json!({"Website": "not a url"})));

    import_curamanager_library(&lib, &ctx, false, None).unwrap();
    assert_eq!(
        all_projects(&lib, &ctx)[0].website.as_deref(),
        Some("not a url")
    );
}

#[test]
fn moving_into_a_flat_library_moves_nothing() {
    let lib = TempLibrary::new();
    let ctx = seed_user_in(&lib, "local", ".", None);
    curamanager_project(lib.dir(), "Benchy", None);
    assert_eq!(move_flat_library_into_user_folder(&lib, &ctx).unwrap(), 0);
    assert!(lib.dir().join("Benchy").exists());
}

#[test]
fn sidecars_are_never_applied_to_another_users_projects() {
    let lib = TempLibrary::new();
    let marc = seed_user_in(&lib, "marc", "marc", None);
    let anna = seed_user_in(&lib, "anna", "anna", None);
    curamanager_project(
        &lib.dir().join("anna"),
        "Hers",
        Some(json!({"IsArchived": true})),
    );
    spm_core::rescan(&lib, &anna, None).unwrap();

    let applied = apply_curamanager_sidecars(&lib, &marc, None, None).unwrap();
    assert_eq!(applied.projects_updated, 0);
    assert!(!all_projects(&lib, &anna)[0].is_archived);
}

#[test]
fn a_user_that_does_not_exist_is_not_found() {
    let lib = TempLibrary::new();
    let ghost = Ctx {
        user_id: "nobody".to_owned(),
        is_admin: false,
    };
    assert_eq!(
        code_of(import_curamanager_library(&lib, &ghost, false, None)),
        AppErrorCode::NotFound
    );
}
