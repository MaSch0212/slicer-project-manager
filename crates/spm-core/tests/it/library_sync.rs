//! The server's half of the desktop sync: the manifest, writing at a relative path with a base
//! version, and deleting into the trash.

use std::fs;
use std::io::Cursor;

use spm_core::AppErrorCode;
use spm_core::files::hash::file_content_hash;
use spm_core::library_sync::{
    BaseVersion, put_file_at, sync_manifest, to_hex, trash_file, trash_project,
};
use spm_core::testing::{TempLibrary, seed_user};
use spm_core::validate::CreateProjectInput;
use spm_core::{Ctx, Library, create_project, list_projects};

use crate::common::code_of;

fn project(lib: &Library, ctx: &Ctx, name: &str) -> String {
    create_project(
        lib,
        ctx,
        CreateProjectInput {
            name: name.to_owned(),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn put(
    lib: &Library,
    ctx: &Ctx,
    project_id: &str,
    rel_path: &str,
    base: BaseVersion,
    text: &str,
) -> spm_core::Result<spm_core::library_sync::SyncFile> {
    put_file_at(
        lib,
        ctx,
        project_id,
        rel_path,
        base,
        text.len() as i64,
        Cursor::new(text.as_bytes().to_vec()),
    )
}

#[test]
fn a_file_put_at_a_nested_path_is_on_disk_indexed_and_in_the_manifest() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let id = project(&lib, &ctx, "Robot");

    let file = put(
        &lib,
        &ctx,
        &id,
        "parts/arm.stl",
        BaseVersion::Absent,
        "solid arm",
    )
    .unwrap();
    let path = lib
        .dir()
        .join("marc")
        .join("Robot")
        .join("parts")
        .join("arm.stl");
    assert_eq!(fs::read_to_string(&path).unwrap(), "solid arm");
    assert_eq!(file.sha256, to_hex(&file_content_hash(&path).unwrap()));

    let manifest = sync_manifest(&lib, &ctx).unwrap();
    assert_eq!(manifest.projects.len(), 1);
    assert_eq!(manifest.projects[0].dir_name, "Robot");
    assert_eq!(manifest.projects[0].files, [file]);
    // No temporary is left beside it.
    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, ["arm.stl"]);
}

#[test]
fn a_replacement_needs_the_base_it_replaces_and_keeps_the_file_id() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let id = project(&lib, &ctx, "Robot");
    let first = put(&lib, &ctx, &id, "arm.stl", BaseVersion::Absent, "one").unwrap();

    // Creating over an existing file, or replacing with a stale base, is a conflict.
    assert_eq!(
        code_of(put(&lib, &ctx, &id, "arm.stl", BaseVersion::Absent, "two")),
        AppErrorCode::Conflict
    );
    assert_eq!(
        code_of(put(
            &lib,
            &ctx,
            &id,
            "arm.stl",
            BaseVersion::Hash([9; 32]),
            "two",
        )),
        AppErrorCode::Conflict
    );

    let base = spm_core::library_sync::parse_hex(&first.sha256).unwrap();
    let second = put(&lib, &ctx, &id, "arm.stl", BaseVersion::Hash(base), "two").unwrap();
    assert_eq!(second.id, first.id);
    assert_ne!(second.sha256, first.sha256);
    assert_eq!(
        fs::read_to_string(lib.dir().join("marc").join("Robot").join("arm.stl")).unwrap(),
        "two"
    );
}

#[test]
fn a_body_shorter_or_longer_than_declared_leaves_nothing() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let id = project(&lib, &ctx, "Robot");
    assert_eq!(
        code_of(put_file_at(
            &lib,
            &ctx,
            &id,
            "a.stl",
            BaseVersion::Absent,
            10,
            Cursor::new(b"abc".to_vec()),
        )),
        AppErrorCode::Validation
    );
    assert_eq!(
        code_of(put_file_at(
            &lib,
            &ctx,
            &id,
            "a.stl",
            BaseVersion::Absent,
            1,
            Cursor::new(b"abc".to_vec()),
        )),
        AppErrorCode::Validation
    );
    assert_eq!(
        fs::read_dir(lib.dir().join("marc").join("Robot"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn a_trashed_file_and_project_are_moved_into_the_trash_not_deleted() {
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let id = project(&lib, &ctx, "Robot");
    let file = put(&lib, &ctx, &id, "arm.stl", BaseVersion::Absent, "one").unwrap();

    // A stale base refuses the delete.
    assert_eq!(
        code_of(trash_file(&lib, &ctx, &file.id, BaseVersion::Hash([9; 32]))),
        AppErrorCode::Conflict
    );

    let base = spm_core::library_sync::parse_hex(&file.sha256).unwrap();
    trash_file(&lib, &ctx, &file.id, BaseVersion::Hash(base)).unwrap();
    assert!(
        !lib.dir()
            .join("marc")
            .join("Robot")
            .join("arm.stl")
            .exists()
    );
    assert!(
        sync_manifest(&lib, &ctx).unwrap().projects[0]
            .files
            .is_empty()
    );
    let trash = lib.dir().join(".spm").join("trash");
    let slots: Vec<_> = fs::read_dir(&trash)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(slots.len(), 1);
    assert_eq!(fs::read_to_string(slots[0].join("arm.stl")).unwrap(), "one");

    trash_project(&lib, &ctx, &id).unwrap();
    assert!(!lib.dir().join("marc").join("Robot").exists());
    assert!(
        list_projects(&lib, &ctx, &Default::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read_dir(&trash).unwrap().count(), 2);
}

#[test]
fn another_users_project_is_not_found() {
    let lib = TempLibrary::new();
    let marc = seed_user(&lib, "marc");
    let anna = seed_user(&lib, "anna");
    let id = project(&lib, &marc, "Robot");
    assert_eq!(
        code_of(put(&lib, &anna, &id, "arm.stl", BaseVersion::Absent, "x")),
        AppErrorCode::NotFound
    );
    assert!(sync_manifest(&lib, &anna).unwrap().projects.is_empty());
}
