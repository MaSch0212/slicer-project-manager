//! Ports `strip3mf.test.ts`. Each legacy loop over named shapes is one table-driven test here with
//! every row kept.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use spm_core::dto::{FileKind, SlicerId};
use spm_core::files::classify::{Classification, classify_3mf};
use spm_core::files::strip3mf::{StripRefusalReason, strip_refusal_reason, strip3mf};
use spm_core::files::zip::{ZipEntry, read_zip_entries, read_zip_entry_bytes, read_zip_entry_text};
use spm_core::files::zip_write::{ZipRewrite, crc32, rewrite_zip};
use spm_core::{AppError, AppErrorCode};
use tempfile::tempdir;

use crate::fixtures::{
    MODEL_XML, deflated, get_u16, patch_zip_headers, set_u16, slice_info, stored, write_zip,
};

const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4];

const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
<Relationship Id="rel1" Target="Metadata/thumbnail.png" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
<Relationship Id="rel2" Target="/Metadata/custom_gcode_per_layer.xml" Type="http://example.invalid/gcode"/>
<Relationship Id="rel3" Target="http://example.invalid/elsewhere" TargetMode="External" Type="http://example.invalid/external"/>
</Relationships>"#;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/Metadata/slice_info.config" ContentType="application/xml"/>
</Types>"#;

/// A Bambu-lineage project carrying **all five** entries of the strip set, plus the two kinds of
/// part that can name another part, plus every flavour of artwork the strip must keep.
fn bambu_all_five(path: &Path) {
    write_zip(
        path,
        &[
            stored("[Content_Types].xml", CONTENT_TYPES),
            stored("_rels/.rels", RELS),
            deflated("3D/3dmodel.model", MODEL_XML),
            stored(
                "Metadata/slice_info.config",
                slice_info(&["X-BBL-Client-Type"]),
            ),
            deflated(
                "Metadata/project_settings.config",
                r#"{"version":"02.08.02.61"}"#,
            ),
            stored("Metadata/model_settings.config", "<config/>"),
            stored("Metadata/custom_gcode_per_layer.xml", "<custom_gcodes/>"),
            stored("Metadata/cut_information.xml", "<objects/>"),
            stored("Metadata/plate_1.png", PNG),
            stored("Metadata/pick_1.png", PNG),
            stored("Metadata/top_1.png", PNG),
            stored("Metadata/thumbnail.png", PNG),
        ],
        None,
    );
}

const BAMBU_SET: [&str; 5] = [
    "Metadata/slice_info.config",
    "Metadata/project_settings.config",
    "Metadata/model_settings.config",
    "Metadata/custom_gcode_per_layer.xml",
    "Metadata/cut_information.xml",
];

fn names(path: &Path) -> Vec<String> {
    read_zip_entries(path)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect()
}

fn find(path: &Path, name: &str) -> ZipEntry {
    read_zip_entries(path)
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.name == name)
        .unwrap_or_else(|| panic!("no entry {name}"))
}

fn model() -> Classification {
    Classification {
        kind: FileKind::Model,
        slicer: None,
        unreadable: false,
    }
}

fn slicer_project(slicer: Option<SlicerId>) -> Classification {
    Classification {
        kind: FileKind::SlicerProject,
        slicer,
        unreadable: false,
    }
}

fn refused(error: &AppError, reason: StripRefusalReason) {
    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(strip_refusal_reason(error), Some(reason), "{error}");
}

#[test]
fn a_fully_stripped_bambu_lineage_project_classifies_model_and_keeps_every_thumbnail() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    bambu_all_five(&input);
    assert_eq!(classify_3mf(&input), slicer_project(Some(SlicerId::Bambu)));

    let result = strip3mf(&input, &output).unwrap();

    assert!(result.stripped);
    assert_eq!(result.removed, BAMBU_SET);
    // `model`, and never `slicer_project` with no slicer.
    assert_eq!(classify_3mf(&output), model());
    assert_eq!(
        names(&output),
        [
            "[Content_Types].xml",
            "_rels/.rels",
            "3D/3dmodel.model",
            "Metadata/plate_1.png",
            "Metadata/pick_1.png",
            "Metadata/top_1.png",
            "Metadata/thumbnail.png",
        ]
    );
    for art in ["plate_1", "pick_1", "top_1", "thumbnail"] {
        let entry = find(&output, &format!("Metadata/{art}.png"));
        assert_eq!(read_zip_entry_bytes(&output, &entry).unwrap(), PNG);
    }
}

#[test]
fn the_half_strip_this_refuses_to_do_is_what_produces_an_unattributable_project() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let half = dir.path().join("half.3mf");
    bambu_all_five(&input);
    // Not a call to strip3mf: this drives the rewriter directly to build the file the
    // all-or-nothing rule exists to prevent, so the classification assertion above has teeth.
    rewrite_zip(
        &input,
        &half,
        &ZipRewrite {
            drop: HashSet::from(["Metadata/slice_info.config".to_owned()]),
            ..ZipRewrite::default()
        },
    )
    .unwrap();
    assert_eq!(classify_3mf(&half), slicer_project(None));
}

#[test]
fn content_types_is_still_first_and_its_override_for_a_removed_part_is_gone() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    bambu_all_five(&input);

    let result = strip3mf(&input, &output).unwrap();

    assert_eq!(names(&output)[0], "[Content_Types].xml");
    assert!(result.rewritten.contains(&"[Content_Types].xml".to_owned()));
    let types = read_zip_entry_text(&output, &find(&output, "[Content_Types].xml")).unwrap();
    assert!(!types.contains("slice_info.config"));
    assert!(types.contains(r#"Extension="png""#));
    assert!(types.contains(r#"Extension="model""#));
}

#[test]
fn a_rels_part_that_referenced_a_removed_target_no_longer_does_and_its_crc_32_matches() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    bambu_all_five(&input);

    let result = strip3mf(&input, &output).unwrap();

    assert!(result.rewritten.contains(&"_rels/.rels".to_owned()));
    let entry = find(&output, "_rels/.rels");
    let rels = read_zip_entry_text(&output, &entry).unwrap();
    assert!(!rels.contains("custom_gcode_per_layer.xml"));
    assert!(rels.contains("/3D/3dmodel.model"));
    assert!(rels.contains("Metadata/thumbnail.png"));
    // An external relationship names a URI, not a part; it must survive untouched.
    assert!(rels.contains("http://example.invalid/elsewhere"));
    // The easy mistake is carrying the original CRC across a rewritten part: an archive most
    // readers still open, until one does not.
    let bytes = read_zip_entry_bytes(&output, &entry).unwrap();
    assert_eq!(entry.crc, crc32(&bytes));
    assert_eq!(entry.method, 0);
    assert_eq!(entry.uncompressed_size, bytes.len() as u64);
}

#[test]
fn surviving_entries_are_byte_identical_decompressed_and_as_stored_compressed_bytes() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    bambu_all_five(&input);
    let source = fs::read(&input).unwrap();

    strip3mf(&input, &output).unwrap();

    let copy = fs::read(&output).unwrap();
    // One deflated part and one stored part, which is the pair the "no recompression" rule is
    // about: a decompress/recompress round trip would keep the first column and break the second.
    for name in ["3D/3dmodel.model", "Metadata/plate_1.png"] {
        let before = find(&input, name);
        let after = find(&output, name);
        assert_eq!(after.method, before.method, "{name}");
        assert_eq!(
            read_zip_entry_bytes(&output, &after).unwrap(),
            read_zip_entry_bytes(&input, &before).unwrap(),
            "{name}"
        );
        assert_eq!(slice(&copy, &after), slice(&source, &before), "{name}");
    }
    assert_eq!(find(&output, "3D/3dmodel.model").method, 8);
    assert_eq!(find(&output, "Metadata/plate_1.png").method, 0);
}

#[test]
fn a_cura_project_loses_every_cura_entry_and_keeps_its_thumbnail() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(
        &input,
        &[
            stored("[Content_Types].xml", "<Types/>"),
            deflated("3D/3dmodel.model", MODEL_XML),
            stored("Cura/plugin_metadata.json", "{}"),
            stored("Cura/preferences.cfg", "[general]"),
            stored("Cura/nested/deep.cfg", "x"),
            stored("Metadata/thumbnail.png", PNG),
        ],
        None,
    );

    let result = strip3mf(&input, &output).unwrap();

    assert_eq!(
        result.removed,
        [
            "Cura/plugin_metadata.json",
            "Cura/preferences.cfg",
            "Cura/nested/deep.cfg"
        ]
    );
    assert_eq!(classify_3mf(&output), model());
    assert_eq!(
        names(&output),
        [
            "[Content_Types].xml",
            "3D/3dmodel.model",
            "Metadata/thumbnail.png"
        ]
    );
}

#[test]
fn a_prusaslicer_project_loses_both_slic3r_pe_parts() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(
        &input,
        &[
            deflated("3D/3dmodel.model", MODEL_XML),
            stored("Metadata/Slic3r_PE.config", "; generated by PrusaSlicer"),
            stored("Metadata/Slic3r_PE_model.config", "<config/>"),
            stored(
                "Metadata/Prusa_Slicer_wipe_tower_information.xml",
                "<wipe/>",
            ),
            stored("Metadata/thumbnail.png", PNG),
        ],
        None,
    );

    let result = strip3mf(&input, &output).unwrap();

    assert_eq!(
        result.removed,
        [
            "Metadata/Slic3r_PE.config",
            "Metadata/Slic3r_PE_model.config"
        ]
    );
    assert_eq!(classify_3mf(&output), model());
    assert!(
        names(&output).contains(&"Metadata/Prusa_Slicer_wipe_tower_information.xml".to_owned())
    );
}

#[test]
fn a_project_saved_but_never_sliced_gets_the_bambu_lineage_set() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(
        &input,
        &[
            deflated("3D/3dmodel.model", MODEL_XML),
            stored(
                "Metadata/project_settings.config",
                r#"{"version":"02.06.00.51"}"#,
            ),
            stored("Metadata/model_settings.config", "<config/>"),
        ],
        None,
    );
    assert_eq!(classify_3mf(&input), slicer_project(None));

    let result = strip3mf(&input, &output).unwrap();

    assert_eq!(result.classification, slicer_project(None));
    assert_eq!(classify_3mf(&output), model());
    assert_eq!(names(&output), ["3D/3dmodel.model"]);
}

#[test]
fn a_file_carrying_two_flavours_is_refused_rather_than_half_stripped() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // The measured cross-slicer artefact, in miniature: classification is first-match-wins, so
    // this is `cura`, gets the Cura set, and comes out `prusaslicer`.
    write_zip(
        &input,
        &[
            deflated("3D/3dmodel.model", MODEL_XML),
            stored("Cura/preferences.cfg", "[general]"),
            stored("Metadata/Slic3r_PE.config", "; generated by PrusaSlicer"),
        ],
        None,
    );
    assert_eq!(classify_3mf(&input), slicer_project(Some(SlicerId::Cura)));

    let error = strip3mf(&input, &output).unwrap_err();
    refused(&error, StripRefusalReason::ConfigurationLeftBehind);
    assert!(!output.exists());
}

#[test]
fn a_model_kind_3mf_is_copied_byte_for_byte_and_reports_that_nothing_was_stripped() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(
        &input,
        &[
            stored("[Content_Types].xml", "<Types/>"),
            deflated("3D/3dmodel.model", MODEL_XML),
        ],
        None,
    );

    let result = strip3mf(&input, &output).unwrap();

    assert!(!result.stripped);
    assert!(result.removed.is_empty());
    assert!(result.rewritten.is_empty());
    assert_eq!(fs::read(&output).unwrap(), fs::read(&input).unwrap());
}

#[test]
fn a_3mf_that_is_not_a_readable_zip_is_refused_as_unreadable() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    fs::write(&input, "not a zip at all, just some bytes").unwrap();

    let error = strip3mf(&input, &output).unwrap_err();
    refused(&error, StripRefusalReason::Unreadable);
    assert!(!output.exists());
}

#[test]
fn an_encrypted_entry_is_refused_as_encrypted_not_as_something_else() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    bambu_all_five(&input);
    patch_zip_headers(&input, |entry| {
        if entry.name == "3D/3dmodel.model" {
            set_u16(entry.file, entry.central_at + 8, 1);
            set_u16(entry.file, entry.local_at + 6, 1);
        }
    });

    let error = strip3mf(&input, &output).unwrap_err();
    refused(&error, StripRefusalReason::Encrypted);
    assert!(!output.exists());
}

#[test]
fn stripping_a_file_onto_itself_is_refused_rather_than_destroying_it() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("in.3mf");
    bambu_all_five(&path);
    let before = fs::read(&path).unwrap();

    let error = strip3mf(&path, &path).unwrap_err();
    refused(&error, StripRefusalReason::Unreadable);
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn strip_refusal_reason_ignores_anything_that_is_not_one_of_the_three() {
    // An ordinary error, one that carries no details, and a validation error whose `reason` is
    // not one of the three. (The legacy case of a plain object merely carrying `details.reason`
    // cannot be spelled: the function only accepts an `AppError`.)
    assert_eq!(strip_refusal_reason(&AppError::internal("nope")), None);
    assert_eq!(strip_refusal_reason(&AppError::validation("nope")), None);
    let mut details = serde_json::Map::new();
    details.insert("reason".into(), "invalid-request".into());
    assert_eq!(
        strip_refusal_reason(&AppError::validation("nope").with_details(details)),
        None
    );
}

#[test]
fn the_refusal_is_an_app_error_the_boundary_can_carry() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    fs::write(&input, "not a zip").unwrap();
    let error = strip3mf(&input, &dir.path().join("out.3mf")).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Validation);
    assert_eq!(
        error.to_envelope().error.details["reason"],
        serde_json::json!("unreadable")
    );
}

/// The compressed payload of one entry, straight out of the archive's bytes.
fn slice(bytes: &[u8], entry: &ZipEntry) -> Vec<u8> {
    let at = entry.local_header_offset as usize;
    let start =
        at + 30 + usize::from(get_u16(bytes, at + 26)) + usize::from(get_u16(bytes, at + 28));
    bytes[start..start + entry.compressed_size as usize].to_vec()
}

/// A Bambu-lineage project whose `_rels/.rels` is exactly the given text.
fn with_rels(path: &Path, rels: &str) {
    write_zip(
        path,
        &[
            deflated("3D/3dmodel.model", MODEL_XML),
            stored("_rels/.rels", rels),
            stored(
                "Metadata/slice_info.config",
                slice_info(&["X-BBL-Client-Type"]),
            ),
            stored("Metadata/custom_gcode_per_layer.xml", "<custom_gcodes/>"),
        ],
        None,
    );
}

const GONE: &str = "/Metadata/custom_gcode_per_layer.xml";

fn rels_text(path: &Path) -> String {
    read_zip_entry_text(path, &find(path, "_rels/.rels")).unwrap()
}

#[test]
fn a_relationship_element_is_repaired_whatever_legal_shape_it_is_written_in() {
    // Attribute order, quoting, the paired form, a comment in the way, a percent-encoded target,
    // and a namespace prefix: all legal OPC, none of them what the measured files use.
    let shapes = [
        (
            "reordered",
            format!(r#"<Relationships><Relationship Type="t" Target="{GONE}" Id="a"/></Relationships>"#),
        ),
        (
            "singleQuoted",
            format!("<Relationships><Relationship Id='a' Target='{GONE}' Type='t'/></Relationships>"),
        ),
        (
            "paired",
            format!(
                r#"<Relationships><Relationship Id="a" Target="{GONE}" Type="t"></Relationship></Relationships>"#
            ),
        ),
        (
            "commented",
            format!(
                r#"<Relationships><!-- note --><Relationship Id="a" Target="{GONE}" Type="t"/></Relationships>"#
            ),
        ),
        (
            "encoded",
            r#"<Relationships><Relationship Id="a" Target="/Metadata/custom_gcode_per_layer%2Exml" Type="t"/></Relationships>"#
                .to_owned(),
        ),
        (
            "prefixed",
            format!(
                r#"<r:Relationships xmlns:r="u"><r:Relationship Id="a" Target="{GONE}" Type="t"/></r:Relationships>"#
            ),
        ),
    ];
    let dir = tempdir().unwrap();
    for (label, rels) in shapes {
        let input = dir.path().join(format!("{label}.3mf"));
        let output = dir.path().join(format!("{label}-out.3mf"));
        with_rels(&input, &rels);

        let result = strip3mf(&input, &output).unwrap();

        assert_eq!(result.rewritten, ["_rels/.rels"], "{label}");
        assert!(
            !rels_text(&output).contains("custom_gcode_per_layer"),
            "{label}"
        );
    }
}

#[test]
fn a_reference_the_element_patterns_cannot_match_is_refused_not_shipped_dangling() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // `>` inside an attribute value defeats `[^>]*?`, so the element is never matched and the
    // relationship survives. Before the outcome check this returned success with nothing
    // rewritten and an archive naming a part that was gone: no edit, and no signal either.
    with_rels(
        &input,
        &format!(
            r#"<Relationships><Relationship Id="a>b" Target="{GONE}" Type="t"/></Relationships>"#
        ),
    );

    let error = strip3mf(&input, &output).unwrap_err();
    refused(&error, StripRefusalReason::ConfigurationLeftBehind);
    assert!(!output.exists());
}

#[test]
fn the_outcome_check_does_not_fire_on_references_to_parts_that_survived() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // The same unmatchable shape, but naming a part that is still there. A check that merely
    // looked for "an attribute the patterns missed" would refuse this too.
    with_rels(
        &input,
        r#"<Relationships><Relationship Id="a>b" Target="/3D/3dmodel.model" Type="t"/></Relationships>"#,
    );

    let result = strip3mf(&input, &output).unwrap();

    assert!(result.rewritten.is_empty());
    assert!(rels_text(&output).contains("/3D/3dmodel.model"));
}

#[test]
fn an_entity_encoded_target_is_resolved_the_way_a_parser_would_resolve_it() {
    // Legal XML: a conforming consumer is handed `/Metadata/custom_gcode_per_layer.xml`. This
    // slipped past both the element patterns and the outcome check until part-name resolution
    // learned to decode character references, and it slipped past because `&#46;` contains the
    // `#` that the fragment split was eating.
    let shapes = [
        ("decimal", "/Metadata/custom_gcode_per_layer&#46;xml"),
        ("hex", "/Metadata/custom_gcode_per_layer&#x2E;xml"),
        ("mixed", "/Metadata/custom&#x5F;gcode_per_layer&#46;xml"),
    ];
    let dir = tempdir().unwrap();
    for (label, target) in shapes {
        let input = dir.path().join(format!("{label}.3mf"));
        let output = dir.path().join(format!("{label}-out.3mf"));
        with_rels(
            &input,
            &format!(
                r#"<Relationships><Relationship Id="a" Target="{target}" Type="t"/></Relationships>"#
            ),
        );

        let result = strip3mf(&input, &output).unwrap();

        assert_eq!(result.rewritten, ["_rels/.rels"], "{label}");
        assert!(!rels_text(&output).contains("custom"), "{label}");
    }
}

#[test]
fn a_reference_that_only_looks_entity_encoded_is_left_as_the_literal_text_it_is() {
    // Two shapes, one per degenerate branch, and deliberately not one shape carrying both: with
    // both in the same target each branch masks the other and a mutation to either stays green.
    // `&#999999999;` is not a character and `&nope;` is not an entity, so a parser resolves
    // neither and neither target names a part in the package. Each is chosen so that *swallowing*
    // the reference it cannot resolve would spell `/Metadata/custom_gcode_per_layer.xml`, a part
    // that was removed, and the relationship would be deleted on the strength of text that does
    // not say that. Leaving it literal is the safe direction.
    let shapes = [
        (
            "outOfRange",
            "/Metadata/custom_gcode_per_layer&#999999999;.xml",
        ),
        (
            "unknownEntity",
            "/Metadata/custom_gcode_per_layer&nope;.xml",
        ),
    ];
    let dir = tempdir().unwrap();
    for (label, target) in shapes {
        let input = dir.path().join(format!("{label}.3mf"));
        let output = dir.path().join(format!("{label}-out.3mf"));
        with_rels(
            &input,
            &format!(
                r#"<Relationships><Relationship Id="a" Target="{target}" Type="t"/></Relationships>"#
            ),
        );

        let result = strip3mf(&input, &output).unwrap();

        assert!(result.rewritten.is_empty(), "{label}");
        assert!(rels_text(&output).contains(target), "{label}");
    }
}

#[test]
fn the_three_known_false_positives_of_the_outcome_check_are_refusals_deliberately() {
    // Each of these is legal and would have stripped cleanly before the outcome check existed.
    // Pinned so a later change to that check has to notice it moved them, and because a refusal
    // that nobody wrote down is indistinguishable from a bug. Naming the part beats the silent
    // success this replaced. None occurs in a measured flavour.
    let shapes = [
        (
            "comment",
            format!(
                r#"<Relationships><!-- was Target="{GONE}" --><Relationship Id="a" Target="/3D/3dmodel.model" Type="t"/></Relationships>"#
            ),
        ),
        (
            "cdata",
            format!(
                r#"<Relationships><![CDATA[ Target="{GONE}" ]]><Relationship Id="a" Target="/3D/3dmodel.model" Type="t"/></Relationships>"#
            ),
        ),
        (
            "externalRelative",
            r#"<Relationships><Relationship Id="a" Target="Metadata/custom_gcode_per_layer.xml" TargetMode="External" Type="t"/></Relationships>"#
                .to_owned(),
        ),
    ];
    let dir = tempdir().unwrap();
    for (label, rels) in shapes {
        let input = dir.path().join(format!("{label}.3mf"));
        let output = dir.path().join(format!("{label}-out.3mf"));
        with_rels(&input, &rels);
        let error = strip3mf(&input, &output).unwrap_err();
        refused(&error, StripRefusalReason::ConfigurationLeftBehind);
        assert!(!output.exists(), "{label}");
    }
}

#[test]
fn a_comment_wrapping_a_whole_well_formed_relationship_is_still_repaired_not_refused() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // The distinction that keeps the false-positive class as narrow as it is: the element pattern
    // matches inside a comment too, so the reference is removed rather than merely detected.
    with_rels(
        &input,
        &format!(
            r#"<Relationships><!-- <Relationship Id="a" Target="{GONE}" Type="t"/> --><Relationship Id="b" Target="/3D/3dmodel.model" Type="t"/></Relationships>"#
        ),
    );

    let result = strip3mf(&input, &output).unwrap();

    assert_eq!(result.rewritten, ["_rels/.rels"]);
    assert!(!rels_text(&output).contains("custom_gcode_per_layer"));
}
