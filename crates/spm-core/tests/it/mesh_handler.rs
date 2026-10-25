//! Ported from the legacy `mesh-handler.test.ts`: the production handler chain (embedded
//! thumbnail first, rasterizer second) run by the real queue over real files.
//!
//! STEP: the legacy case "a model the handler cannot read is unsupported, not failed" had to use a
//! `.ply` once the STEP parser shipped, because `.step` had started reaching OCCT. STEP is not
//! read any more (migration spec 4.1), so the case is re-targeted to its original subject: a
//! `.step` and a `.stp` are `model` files with no parser, and end `unsupported`. The `.ply` form
//! stays too, because it pins the handler's contract for any format it has no arm for.

use std::fs;

use rusqlite::params;
use spm_core::clock::now_ms;
use spm_core::dto::FileKind;
use spm_core::previews::png::read_png_size;
use spm_core::previews::{
    MAX_PREVIEW_ATTEMPTS, MeshLimits, QueueOptions, claim_pending_previews, make_preview_handlers,
    run_preview_queue,
};
use spm_core::testing::{TempLibrary, seed_file_row, seed_user};
use spm_core::{Library, rescan};

use crate::fixtures::{bambu_lineage_project, plain_mesh_3mf};
use crate::mesh_fixtures::{
    binary_stl, cube_mesh, make_png, mesh_geometry_3mf, slicer_project_with_mesh,
};
use crate::preview_support::{counts, only_row, png_on_disk, preview_rows, seed_project_dir};

/// The production chain itself, not a local array spelling out the same two handlers.
///
/// Rebuilding an equivalent array in each test is what made the order untested in the first
/// implementation: inverting the one the server used left every suite green, because every order
/// assertion was checking a copy.
fn run_chain(lib: &Library) -> spm_core::BatchResult {
    run_with_limits(lib, MeshLimits::default())
}

fn run_with_limits(lib: &Library, limits: MeshLimits) -> spm_core::BatchResult {
    run_preview_queue(
        lib,
        &QueueOptions {
            handlers: make_preview_handlers(&limits),
            ..QueueOptions::default()
        },
    )
    .unwrap()
}

/// One vertex per triangle corner: verbose, but valid OBJ that needs no index bookkeeping.
fn obj_text(mesh: &spm_core::previews::Mesh) -> String {
    let mut text = String::new();
    for point in mesh.positions.as_chunks::<3>().0 {
        text.push_str(&format!("v {} {} {}\n", point[0], point[1], point[2]));
    }
    for t in 0..mesh.triangle_count {
        text.push_str(&format!("f {} {} {}\n", t * 3 + 1, t * 3 + 2, t * 3 + 3));
    }
    text
}

/// 200 bytes of 0xff: long enough to carry a binary STL header, its triangle count (0xffffffff)
/// disagrees wildly with the file length, and there is no ASCII "solid" keyword to fall back on.
/// The parser rejects exactly this with a `Validation` error.
fn malformed_stl() -> Vec<u8> {
    vec![0xff; 200]
}

fn assert_png_256(lib: &Library, file_id: &str) {
    let bytes = fs::read(png_on_disk(lib, file_id)).unwrap();
    assert_eq!(read_png_size(&bytes), Some((256, 256)));
}

#[test]
fn an_stl_model_is_rasterized_to_a_256px_png_on_disk_by_the_real_queue() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("cube.stl"), binary_stl(&cube_mesh())).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(1, 0, 0, 1));

    let row = only_row(&lib);
    assert_eq!(row.state, "ready");
    assert_eq!(row.source.as_deref(), Some("rasterized"));
    assert_eq!((row.width, row.height), (Some(256), Some(256)));
    assert_eq!(
        row.png_path,
        Some(format!(".spm/previews/{}.png", row.file_id))
    );
    // The row can only claim a png exists; the bytes on disk are what the UI actually serves.
    assert!(png_on_disk(&lib, &row.file_id).exists());
    assert_png_256(&lib, &row.file_id);
}

#[test]
fn obj_3mf_and_an_uppercase_extension_are_rasterized_too_not_just_lowercase_stl() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // Extension dispatch is the whole job of this handler, so every branch of it is covered:
    // covering only .stl would leave two thirds of the match untested.
    fs::write(dir.join("cube.obj"), obj_text(&cube_mesh())).unwrap();
    mesh_geometry_3mf(&dir.join("tetra.3mf"), None);
    // Uppercase is not a curiosity: the reference library contains `.STL` files, and
    // `classify_file` lowercases before matching, so they arrive here as `kind: model`. Pinned by
    // a test because getting it wrong is silent *and* self-concealing: a case-sensitive match
    // returns "nothing to render", the queue records `unsupported`, and it re-claims only
    // `pending` rows, so shipping the fix would not revisit a single one of them. Every uppercase
    // model in the library stays blank, with CI green, until its bytes change.
    fs::write(dir.join("CUBE.STL"), binary_stl(&cube_mesh())).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(3, 0, 0, 3));

    for row in preview_rows(&lib) {
        assert_eq!(row.state, "ready");
        assert_eq!(row.source.as_deref(), Some("rasterized"));
        assert_png_256(&lib, &row.file_id);
    }
}

#[test]
fn a_malformed_stl_fails_and_stops_after_max_preview_attempts() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("broken.stl"), malformed_stl()).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    // Deliberately run more times than the budget, re-queueing the row to pending before each run
    // the way a rescan would. What stops the retries has to be MAX_PREVIEW_ATTEMPTS, not this loop
    // running out.
    let mut failures = 0;
    let mut at_budget = None;
    for i in 0..MAX_PREVIEW_ATTEMPTS + 2 {
        lib.db()
            .execute(
                "UPDATE previews SET state = 'pending', claimed_at = NULL",
                [],
            )
            .unwrap();
        failures += run_chain(&lib).failed;
        if i == MAX_PREVIEW_ATTEMPTS - 1 {
            at_budget = Some(only_row(&lib));
        }
    }

    // The parser's error reached the queue's failure path rather than being swallowed into an
    // `unsupported`, and its message is on the row so the file is diagnosable from it alone.
    let at_budget = at_budget.unwrap();
    assert_eq!(at_budget.state, "failed");
    let error = at_budget.error.unwrap();
    assert!(
        error.contains("binary STL") || error.contains("solid"),
        "{error}"
    );

    // Two runs past the budget added nothing: the row was claimed, and charged an attempt,
    // exactly MAX_PREVIEW_ATTEMPTS times.
    let row = only_row(&lib);
    assert_eq!(row.attempts, MAX_PREVIEW_ATTEMPTS);
    assert_eq!(failures as i64, MAX_PREVIEW_ATTEMPTS);
    assert!(
        claim_pending_previews(
            &lib,
            &make_preview_handlers(&MeshLimits::default()),
            10,
            now_ms()
        )
        .unwrap()
        .is_empty()
    );
    // Nothing was written for it.
    assert!(!png_on_disk(&lib, &row.file_id).exists());
}

#[test]
fn a_file_classified_as_other_is_never_claimed() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // `notes.txt` and not `part.step`: what this pins is the claim filter, a job is offered only
    // to a handler that claims its kind, and `.step` is a `model` (which the chain claims, and
    // ends `unsupported`), so it cannot stand in for an `other`.
    fs::write(dir.join("notes.txt"), "PETG, 0.2mm").unwrap();
    fs::write(dir.join("cube.stl"), binary_stl(&cube_mesh())).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    let jobs = claim_pending_previews(
        &lib,
        &make_preview_handlers(&MeshLimits::default()),
        10,
        now_ms(),
    )
    .unwrap();
    assert_eq!(
        jobs.iter().map(|job| job.kind).collect::<Vec<_>>(),
        [FileKind::Model]
    );
}

#[test]
fn a_step_model_is_unsupported_not_failed() {
    // Re-targeted from "[STEP] a model the handler cannot read": STEP is now exactly that. The
    // bytes are a bare `ISO-10303-21;` with no body, which the legacy OCCT arm refused and
    // recorded `failed`; nothing reads them now, so the answer is deterministic absence.
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("part.step"), "ISO-10303-21;\n").unwrap();
    fs::write(dir.join("other.STP"), "ISO-10303-21;\n").unwrap();
    rescan(&lib, &ctx, None).unwrap();

    // Classification still calls both of them models, which is what puts them in the queue.
    let kinds: Vec<String> = {
        let conn = lib.db();
        let mut statement = conn
            .prepare("SELECT kind FROM files ORDER BY rel_path")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(kinds, ["model", "model"]);

    assert_eq!(run_chain(&lib), counts(0, 0, 2, 2));
    for row in preview_rows(&lib) {
        assert_eq!(row.state, "unsupported");
        assert_eq!(row.error, None);
        // Unsupported is terminal: the row is not re-queued and burns no further budget.
        assert_eq!(row.attempts, 1);
        assert!(!png_on_disk(&lib, &row.file_id).exists());
    }
}

#[test]
fn a_model_the_handler_has_no_parser_for_is_unsupported_not_failed() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // PLY is a real mesh format that nothing here parses, so the fixture is not a nonsense
    // extension nobody would ever meet. `.ply` is not one of the extensions `classify_file` calls
    // a model, so this is forced: the point is the handler's contract for a `model` job in a
    // format it has no parser for. "Nothing to render" (`unsupported`, never retried) is right and
    // a failure (`failed`, against the retry budget) is wrong, because re-reading the file will
    // never make it readable.
    fs::write(dir.join("part.ply"), "ply\nformat ascii 1.0\nend_header\n").unwrap();
    rescan(&lib, &ctx, None).unwrap();
    lib.db()
        .execute(
            "UPDATE files SET kind = 'model' WHERE rel_path = ?",
            params!["part.ply"],
        )
        .unwrap();

    assert_eq!(run_chain(&lib), counts(0, 0, 1, 1));
    let row = only_row(&lib);
    assert_eq!(row.state, "unsupported");
    assert_eq!(row.error, None);
    assert_eq!(row.attempts, 1);
}

#[test]
fn a_ready_step_preview_in_an_existing_library_is_left_alone() {
    // Migration spec 4.1: previews already `ready` for STEP are kept. A library indexed by the
    // legacy server holds rows like this one, and nothing here may revisit or blank them.
    let lib = TempLibrary::new();
    let ctx = seed_user(&lib, "marc");
    let project = spm_core::create_project(
        &lib,
        &ctx,
        spm_core::validate::CreateProjectInput {
            name: "Old".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let file_id = seed_file_row(&lib, &project.id, "part.step", "model", "ready");
    lib.db()
        .execute(
            "UPDATE previews SET source = 'rasterized', png_path = ?, width = 256, height = 256
             WHERE file_id = ?",
            params![format!(".spm/previews/{file_id}.png"), file_id],
        )
        .unwrap();
    fs::write(png_on_disk(&lib, &file_id), make_png(256, 256)).unwrap();
    let before = only_row(&lib);

    assert_eq!(run_chain(&lib), counts(0, 0, 0, 0));

    assert_eq!(only_row(&lib), before);
    assert!(png_on_disk(&lib, &file_id).exists());
    // And it is still served: resolving the preview finds the file.
    assert!(
        spm_core::resolve_preview_path(&lib, &ctx, &file_id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn a_slicer_project_with_no_embedded_thumbnail_is_rasterized_rather_than_left_unsupported() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    slicer_project_with_mesh(&dir.join("unsliced.3mf"), None);
    rescan(&lib, &ctx, None).unwrap();

    // Pinned, because the whole point is the *slicer_project* path: if the fixture ever stopped
    // classifying as a project this test would silently become another `model` rasterizer test
    // and cover nothing new.
    let kind: String = lib
        .db()
        .query_row("SELECT kind FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kind, "slicer_project");

    // 326 of the reference library's 374 projects look exactly like this. Before the handler
    // chain, the embedded handler's "nothing" ended the job as `unsupported`, which is terminal:
    // the rows were permanently blank and no rescan would revisit them.
    assert_eq!(run_chain(&lib), counts(1, 0, 0, 1));

    let row = only_row(&lib);
    assert_eq!(row.state, "ready");
    assert_eq!(row.source.as_deref(), Some("rasterized"));
    assert_png_256(&lib, &row.file_id);
}

#[test]
fn a_slicer_project_that_has_an_embedded_thumbnail_still_uses_it_not_the_rasterizer() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // Geometry *and* a plate render, so both handlers could answer and only the order decides.
    // 311x233 is nothing the rasterizer can produce (it always writes 256x256), which is what
    // makes the size assertion below able to tell the two sources apart on the bytes alone.
    slicer_project_with_mesh(&dir.join("sliced.3mf"), Some(&make_png(311, 233)));
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(1, 0, 0, 1));

    let row = only_row(&lib);
    // Asserting `source`, not merely that a png exists: with the handler order inverted a png
    // would still be written and a file-exists check would stay green.
    assert_eq!(row.source.as_deref(), Some("embedded"));
    assert_eq!((row.width, row.height), (Some(311), Some(233)));
    let bytes = fs::read(png_on_disk(&lib, &row.file_id)).unwrap();
    assert_eq!(read_png_size(&bytes), Some((311, 233)));
}

#[test]
fn a_slicer_project_whose_model_part_holds_no_geometry_fails_and_is_not_silently_unsupported() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // Every handler in the chain is out of answers, but for two different reasons: no embedded
    // thumbnail (`None`) and a model part with nothing in it (an error). The error has to win, or a
    // broken project becomes a permanent `unsupported` with no message to debug it from.
    bambu_lineage_project(&dir.join("empty.3mf"), &["X-BBL-Client-Type"], None);
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(0, 1, 0, 1));
    let row = only_row(&lib);
    assert_eq!(row.state, "failed");
    assert!(row.error.unwrap().contains("no triangles"));
}

#[test]
fn a_model_kind_3mf_with_an_embedded_thumbnail_uses_it_rather_than_being_rasterized() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // `mesh_geometry_3mf` has no slicer metadata, so `classify_3mf` calls it a plain `model`: the
    // same kind the 28 zip64 files in the reference library get. Before the embedded handler
    // covered `model`, all 28 were rasterized to 256 while 16 of them carried a 512 or 1024 pixel
    // picture that nothing ever read. 311x233 is a size the rasterizer cannot produce, so the
    // assertion below can tell the two sources apart from the bytes alone.
    mesh_geometry_3mf(&dir.join("plain.3mf"), Some(&make_png(311, 233)));
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(1, 0, 0, 1));
    let row = only_row(&lib);
    assert_eq!(row.source.as_deref(), Some("embedded"));
    assert_eq!((row.width, row.height), (Some(311), Some(233)));
}

#[test]
fn an_stl_still_rasterizes_the_embedded_handler_covering_model_declines_rather_than_claims() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    // The risk in widening the embedded handler to `model`: a kind it cannot read must fall
    // through, not end the chain. An STL is not a zip at all, so extraction finds nothing and the
    // rasterizer behind it still gets the job.
    fs::write(dir.join("cube.stl"), binary_stl(&cube_mesh())).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(1, 0, 0, 1));
    let row = only_row(&lib);
    assert_eq!(row.source.as_deref(), Some("rasterized"));
    assert_eq!((row.width, row.height), (Some(256), Some(256)));
}

#[test]
fn a_model_over_the_configured_mesh_ceiling_fails_with_a_message_naming_both_sizes() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("cube.stl"), binary_stl(&cube_mesh())).unwrap();
    slicer_project_with_mesh(&dir.join("project.3mf"), None);
    rescan(&lib, &ctx, None).unwrap();

    // Through `make_preview_handlers`, not by calling a parser directly: what is being pinned is
    // that the operator's ceiling reaches the rasterizer at all, across the whole chain the host
    // builds. A ceiling of 1 byte refuses everything, which is the point: the ceiling's *value* is
    // a deployment decision and belongs in the README, not in an assertion here.
    assert_eq!(
        run_with_limits(&lib, MeshLimits { max_mesh_bytes: 1 }),
        counts(0, 2, 0, 2)
    );

    for row in preview_rows(&lib) {
        // `failed`, not `unsupported`: a refusal carries a reason, and `unsupported` writes
        // `error = NULL`, which would leave an operator with a blank thumbnail and nothing to
        // read.
        assert_eq!(row.state, "failed");
        let error = row.error.unwrap();
        assert!(
            error.contains("needs ")
                && error.contains(" MB")
                && error.contains("more than the ")
                && error.contains(" MB this server permits"),
            "{error}"
        );
    }
}

#[test]
fn the_default_handler_list_still_leaves_models_pending_so_rasterizing_is_opt_in() {
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    fs::write(dir.join("cube.stl"), binary_stl(&cube_mesh())).unwrap();
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(
        run_preview_queue(&lib, &QueueOptions::default()).unwrap(),
        counts(0, 0, 0, 0)
    );
    assert_eq!(only_row(&lib).state, "pending");
}

#[test]
fn a_plain_3mf_with_no_slicer_metadata_and_no_geometry_fails_rather_than_staying_blank() {
    // Rust-only: `plain_mesh_3mf` has an empty `<resources/>`, so it classifies as a model, has no
    // thumbnail and no triangles. It must end `failed` with the reason, not `unsupported`.
    let lib = TempLibrary::new();
    let (ctx, dir) = seed_project_dir(&lib);
    plain_mesh_3mf(&dir.join("empty.3mf"));
    rescan(&lib, &ctx, None).unwrap();

    assert_eq!(run_chain(&lib), counts(0, 1, 0, 1));
    assert!(only_row(&lib).error.unwrap().contains("no triangles"));
}
