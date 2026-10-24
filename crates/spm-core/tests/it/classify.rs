//! Ports `classify.test.ts`. The legacy test file also holds the zip reader's first two cases and
//! the content-hash case, which sit here with it.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use spm_core::dto::{FileKind, SlicerId};
use spm_core::files::classify::{
    CLASSIFIER_VERSION, Classification, MODEL_EXTENSIONS, classify_3mf, classify_file,
    slicer_from_slice_info,
};
use spm_core::files::hash::file_content_hash;
use spm_core::files::zip::{find_zip_entry, read_zip_entries, read_zip_entry_text};
use tempfile::tempdir;

use crate::fixtures::{
    bambu_lineage_project, cura_project, plain_mesh_3mf, prusa_project, slice_info,
    unsliced_bambu_project,
};

fn answer(kind: FileKind, slicer: Option<SlicerId>) -> Classification {
    Classification {
        kind,
        slicer,
        unreadable: false,
    }
}

#[test]
fn the_zip_reader_lists_entries_and_inflates_a_deflated_one() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("p.3mf");
    plain_mesh_3mf(&path);
    let entries = read_zip_entries(&path).unwrap();
    let mut names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["3D/3dmodel.model", "[Content_Types].xml"]);
    let model = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    assert_eq!(model.method, 8);
    assert!(
        read_zip_entry_text(&path, model)
            .unwrap()
            .starts_with("<?xml")
    );
}

#[test]
fn the_zip_reader_rejects_a_file_that_is_not_a_zip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("not.3mf");
    fs::write(&path, "just some text, definitely not a zip archive").unwrap();
    assert!(read_zip_entries(&path).is_err());
}

#[test]
fn cura_is_identified_by_its_cura_prefix() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("benchy.3mf");
    cura_project(&path, None);
    assert_eq!(
        classify_3mf(&path),
        answer(FileKind::SlicerProject, Some(SlicerId::Cura))
    );
}

#[test]
fn prusaslicer_is_identified_by_metadata_slic3r_pe_config() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bracket.3mf");
    prusa_project(&path, None);
    assert_eq!(
        classify_3mf(&path),
        answer(FileKind::SlicerProject, Some(SlicerId::Prusaslicer))
    );
}

#[test]
fn anycubic_is_identified_by_its_xacnext_header_item() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("ac.3mf");
    bambu_lineage_project(
        &path,
        &["X-ACNext-Client-Type", "X-ACNext-Client-Version"],
        None,
    );
    assert_eq!(
        classify_3mf(&path),
        answer(FileKind::SlicerProject, Some(SlicerId::Anycubic))
    );
}

#[test]
fn bambu_studio_is_identified_by_xbbl_client_type() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bbl.3mf");
    bambu_lineage_project(&path, &["X-BBL-Client-Type", "X-BBL-Client-Version"], None);
    assert_eq!(
        classify_3mf(&path),
        answer(FileKind::SlicerProject, Some(SlicerId::Bambu))
    );
}

#[test]
fn orcaslicer_wins_over_bambu_even_though_it_carries_the_xbbl_keys_too() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("orca.3mf");
    // Orca's header is a superset of Bambu's; registry order is what separates them.
    bambu_lineage_project(
        &path,
        &[
            "X-BBL-Client-Type",
            "X-BBL-Client-Version",
            "OrcaSlicer-Version",
        ],
        None,
    );
    assert_eq!(
        classify_3mf(&path),
        answer(FileKind::SlicerProject, Some(SlicerId::Orca))
    );
}

#[test]
fn an_unsliced_bambu_lineage_project_is_a_slicer_project_of_unknown_slicer() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("unsliced.3mf");
    unsliced_bambu_project(&path);
    // Reported as `None` rather than guessed, so the UI falls back to the default slicer.
    assert_eq!(classify_3mf(&path), answer(FileKind::SlicerProject, None));
}

#[test]
fn a_slice_info_config_with_no_known_key_yields_a_null_slicer() {
    assert_eq!(
        slicer_from_slice_info(&slice_info(&["X-Unknown-Client-Type"])),
        None
    );
}

#[test]
fn the_version_value_is_never_used_as_a_discriminator() {
    // printer_model and version strings are traps (spec 3.4); only keys are matched.
    assert_eq!(
        slicer_from_slice_info(&slice_info(&["X-BBL-Client-Version"])),
        None
    );
}

#[test]
fn a_plain_mesh_3mf_is_a_model_not_a_slicer_project() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mesh.3mf");
    plain_mesh_3mf(&path);
    assert_eq!(classify_3mf(&path), answer(FileKind::Model, None));
}

#[test]
fn classify_file_routes_by_extension_and_falls_back_to_other() {
    let dir = tempdir().unwrap();
    for name in ["a.stl", "b.STL", "c.obj"] {
        let path = dir.path().join(name);
        fs::write(&path, "solid x").unwrap();
        assert_eq!(
            classify_file(&path),
            answer(FileKind::Model, None),
            "{name}"
        );
    }
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, "hi").unwrap();
    assert_eq!(classify_file(&notes), answer(FileKind::Other, None));

    let project = dir.path().join("x.3mf");
    cura_project(&project, None);
    assert_eq!(
        classify_file(&project),
        answer(FileKind::SlicerProject, Some(SlicerId::Cura))
    );
}

/// The two ways a `.3mf` fails to classify, which are the same answer and not the same failure.
///
/// Both come back `other`. Rescan records which version produced a row's `kind` and does not ask
/// again until the bytes move, which splits them: "we read the file and it is not a zip" is an
/// answer worth recording, and "we could not open the file" is a transient that must not be
/// recorded as one. `unreadable` is the only thing here that tells them apart.
#[test]
fn a_3mf_that_is_not_a_zip_answers_other_one_that_cannot_be_opened_says_so() {
    let dir = tempdir().unwrap();
    let corrupt = dir.path().join("corrupt.3mf");
    fs::write(&corrupt, "PK garbage").unwrap();
    assert_eq!(classify_file(&corrupt), answer(FileKind::Other, None));

    // Not a lock (no portable way to hold one from a test) but the identical failure at the
    // identical call: the open rejects before a byte of content has been looked at.
    let gone = dir.path().join("gone.3mf");
    assert_eq!(
        classify_file(&gone),
        Classification {
            kind: FileKind::Other,
            slicer: None,
            unreadable: true,
        }
    );
}

#[test]
fn file_content_hash_is_a_stable_32_byte_digest_that_follows_content() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("a.stl");
    fs::write(&path, "solid one").unwrap();
    let first = file_content_hash(&path).unwrap();
    assert_eq!(first.len(), 32);
    assert_eq!(file_content_hash(&path).unwrap(), first);

    fs::write(&path, "solid two").unwrap();
    assert_ne!(file_content_hash(&path).unwrap(), first);
}

/// `classify_file`'s complete answer set, paired with the version that produced it.
///
/// **What breaks this test.** Changing what any extension classifies as, or adding one to
/// `MODEL_EXTENSIONS`, makes the computed table below differ from this literal. The only edit that
/// repairs it is one that touches `CLASSIFIER_VERSION` **in the same commit**, because `version`
/// sits inside the literal being edited: that is the whole mechanism. A forgotten bump ships a
/// classifier that answers differently with every existing row still marked as classified by it,
/// so a rescan never re-asks the question and the change is invisible in the field.
///
/// **`version: 1` here and `0 < CLASSIFIER_VERSION` in the db test are not in conflict.** They are
/// opposite tests of the same constant. The migration test must survive a bump; this one exists to
/// be broken by a bump: going red *is* how the edit that changes an answer is forced to touch the
/// version beside it.
///
/// **An answer is `kind/slicer`, not `kind`.** A wrong `slicer` is as permanent as a wrong `kind`.
/// Reorder `SLICER_HEADER_REGISTRY` so `X-BBL-Client-Type` is tested before `OrcaSlicer-Version`
/// and every Orca project becomes `bambu`: the per-slicer tests above go red, get updated, and the
/// change ships **without a bump**. A null slicer is written `none` so the literal reads without
/// ambiguity.
///
/// `.step` and `.stp` are in the table as models: they are classified (and listed) even though
/// their geometry is not parsed.
///
/// **What it cannot catch**: a change inside `classify_3mf` that produces the same answers on the
/// fixtures below; a branch added outside `MODEL_EXTENSIONS`; and `unreadable`, which no fixture
/// here reaches through this loop.
const SNAPSHOT_VERSION: i64 = 1;
const SNAPSHOT_ANSWERS: [(&str, &str); 14] = [
    (".stl", "model/none"),
    (".obj", "model/none"),
    (".step", "model/none"),
    (".stp", "model/none"),
    (".3mf/cura", "slicer_project/cura"),
    (".3mf/prusaslicer", "slicer_project/prusaslicer"),
    (".3mf/orca", "slicer_project/orca"),
    (".3mf/bambu", "slicer_project/bambu"),
    (".3mf/anycubic", "slicer_project/anycubic"),
    (".3mf/unsliced", "slicer_project/none"),
    (".3mf/mesh", "model/none"),
    (".3mf/not-a-zip", "other/none"),
    (".gcode", "other/none"),
    (".txt", "other/none"),
];

/// The whole of a `Classification` that this snapshot freezes, in one string per fixture.
fn answer_of(path: &Path) -> String {
    let classification = classify_file(path);
    format!(
        "{}/{}",
        classification.kind.as_str(),
        classification.slicer.map_or("none", SlicerId::as_str)
    )
}

#[test]
fn the_classifier_version_and_every_answer_it_gives_are_frozen_together() {
    let dir = tempdir().unwrap();
    let mut answers: BTreeMap<String, String> = BTreeMap::new();

    // Computed from MODEL_EXTENSIONS rather than hand-listed, and that is the point. A
    // hand-written key set catches a *changed* answer and misses an *added* extension: `.ply`
    // added to MODEL_EXTENSIONS would change nothing already listed, force no new row, and leave
    // the version unbumped with the suite green. Iterating puts the new key into `answers`, where
    // the whole-map comparison below is what notices it.
    for ext in MODEL_EXTENSIONS {
        let path = dir.path().join(format!("part{ext}"));
        fs::write(
            &path,
            "not read by classify_file, which looks only at the name",
        )
        .unwrap();
        answers.insert(ext.to_owned(), answer_of(&path));
    }

    type Writer = fn(&Path);
    let three_mf: [(&str, Writer); 8] = [
        ("cura", |p| cura_project(p, None)),
        ("prusaslicer", |p| prusa_project(p, None)),
        ("orca", |p| {
            bambu_lineage_project(p, &["X-BBL-Client-Type", "OrcaSlicer-Version"], None)
        }),
        ("bambu", |p| {
            bambu_lineage_project(p, &["X-BBL-Client-Type"], None)
        }),
        ("anycubic", |p| {
            bambu_lineage_project(p, &["X-ACNext-Client-Type"], None)
        }),
        ("unsliced", unsliced_bambu_project),
        ("mesh", plain_mesh_3mf),
        ("not-a-zip", |p| fs::write(p, "PK not really").unwrap()),
    ];
    for (label, write) in three_mf {
        let path = dir.path().join(format!("{label}.3mf"));
        write(&path);
        answers.insert(format!(".3mf/{label}"), answer_of(&path));
    }

    for ext in [".gcode", ".txt"] {
        let path = dir.path().join(format!("f{ext}"));
        fs::write(&path, "x").unwrap();
        answers.insert(ext.to_owned(), answer_of(&path));
    }

    let expected: BTreeMap<String, String> = SNAPSHOT_ANSWERS
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    assert_eq!((CLASSIFIER_VERSION, answers), (SNAPSHOT_VERSION, expected));
}
