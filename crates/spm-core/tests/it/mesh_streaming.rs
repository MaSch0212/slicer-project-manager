//! Ported from the parser cases of the legacy `mesh-streaming.test.ts`: the mesh parsers fed a
//! file far longer than one read chunk or one parser window.
//!
//! The legacy file also held the chunk-plumbing cases (the line sink, `read_file_chunks`,
//! `OpenFile` after close, `drain_sink` against `feed_sink`); those test `files/chunks.rs`, which
//! part 2 ported, and live in `tests/it/chunks.rs`.
//!
//! The legacy case "the 3MF parse scales with triangle count, not with file size" measured the
//! largest `TextDecoder.decode` input. This parser has no decode step; it is kept here against
//! the window the document passes through, and against real allocation in `tests/memory.rs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use spm_core::AppErrorCode;
use spm_core::previews::MeshLimits;
use spm_core::previews::mesh::limits::allocate_mesh;
use spm_core::previews::mesh::obj::{parse_obj, parse_obj_file};
use spm_core::previews::mesh::stl::{parse_stl, parse_stl_file};
use spm_core::previews::mesh::threemf::{
    ScanProbe, WINDOW_BYTES, parse_3mf_mesh, parse_3mf_mesh_probed,
};
use tempfile::{TempDir, tempdir};

use crate::common::code_of;
use crate::fixtures::{stored, write_zip};

/// Comfortably more than the 256 KB window `threemf.rs` holds and the 256 KB chunk the file reader
/// reads, so every fixture built to this size crosses several boundaries rather than sitting
/// inside one. Kept as a number the tests can reason about rather than imported: a test that
/// scales itself to the implementation's window cannot notice the window growing to swallow the
/// document.
const WELL_PAST_ONE_WINDOW: usize = 1_500_000;

fn limits() -> MeshLimits {
    MeshLimits::default()
}

fn write_3mf(path: &Path, model_xml: &str) {
    write_zip(
        path,
        &[
            stored("[Content_Types].xml", "<Types/>"),
            stored("3D/3dmodel.model", model_xml),
        ],
        None,
    );
}

fn fixture_dir() -> (TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let path = dir.path().to_path_buf();
    (dir, path)
}

/// `n` vertices and `n` triangles, with `pad` bytes of filler on the `<model>` element.
///
/// The padding is the point of the fixture: it shifts every byte of the geometry by a controlled
/// amount, so sweeping it moves each window boundary through a different position inside a tag:
/// the middle of an attribute name, the middle of a number, between `<` and `v`. A parser that
/// mishandles one of those alignments fails for one padding and not the others, which no single
/// fixture can catch.
fn grid_model_xml(n: usize, pad: usize) -> String {
    let mut vertices = String::new();
    let mut triangles = String::new();
    for i in 0..n {
        vertices.push_str(&format!(r#"<vertex x="{i}" y="0" z="0"/>"#));
        triangles.push_str(&format!(
            r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
            i % n,
            (i + 1) % n,
            (i + 2) % n
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" pad="{}"><resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#,
        "p".repeat(pad)
    )
}

fn expected_grid(n: usize) -> Vec<f32> {
    let mut expected = Vec::with_capacity(n * 9);
    for i in 0..n {
        for vi in [i % n, (i + 1) % n, (i + 2) % n] {
            expected.extend([vi as f32, 0.0, 0.0]);
        }
    }
    expected
}

const UNIT_TRIANGLE: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

#[test]
fn a_3mf_model_part_many_windows_long_parses_exactly_at_every_window_alignment() {
    // 25 000 tag pairs is ~1.8 MB of model part, six times the parser's window, and the padding
    // sweep walks the boundary across a whole tag's width in one-byte steps. A boundary handled by
    // "retain from the last marker" rather than "retain from the last *safe* marker" loses exactly
    // one vertex or one triangle, at exactly one of these alignments.
    let (_dir, root) = fixture_dir();
    let n = 25_000;
    let expected = expected_grid(n);
    for pad in [0, 1, 7, 13, 28, 45] {
        let path = root.join(format!("grid-{pad}.3mf"));
        let xml = grid_model_xml(n, pad);
        assert!(
            xml.len() > WELL_PAST_ONE_WINDOW,
            "fixture must span several windows"
        );
        write_3mf(&path, &xml);
        let mesh = parse_3mf_mesh(&path, &limits()).unwrap();
        assert_eq!(mesh.triangle_count, n, "triangle count at pad={pad}");
        assert!(mesh.positions == expected, "positions at pad={pad}");
    }
}

#[test]
fn an_xml_comment_far_longer_than_the_parser_window_is_skipped_not_buffered() {
    // The one construct that may legally be longer than anything the parser is allowed to hold. It
    // is skipped *through* the stream, so the file grows by a megabyte and the parse does not.
    let (_dir, root) = fixture_dir();
    let path = root.join("long-comment.3mf");
    let comment = format!(
        r#"<!-- {} <vertex x="99" y="99" z="99"/> -->"#,
        "x".repeat(WELL_PAST_ONE_WINDOW)
    );
    write_3mf(
        &path,
        &format!(
            concat!(
                r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
                r#"<object id="1" type="model"><mesh><vertices>"#,
                "{comment}",
                r#"<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
                "</vertices><triangles>",
                "{comment}",
                r#"<triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#,
                r#"</resources><build><item objectid="1"/></build></model>"#,
            ),
            comment = comment
        ),
    );
    let mut probe = ScanProbe::default();
    let mesh = parse_3mf_mesh_probed(&path, &limits(), &mut probe).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    // The commented-out vertex must not have been ingested: if it had, index 0 would resolve to
    // (99,99,99) and every coordinate below would be wrong.
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
    assert!(probe.peak_window_bytes <= WINDOW_BYTES);
}

#[test]
fn a_single_tag_longer_than_the_parser_window_is_refused_not_buffered_without_limit() {
    // The deliberate boundary of the design: a tag has to fit in the window because its attributes
    // are read out of one slice. Growing the window for it would make the parser's memory a
    // function of the document again, so it is refused instead, with a `Validation` error and not
    // an out-of-memory.
    let (_dir, root) = fixture_dir();
    let path = root.join("huge-tag.3mf");
    write_3mf(
        &path,
        &format!(
            concat!(
                r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
                r#"<object id="1" type="model"><mesh><vertices>"#,
                r#"<vertex note="{}" x="0" y="0" z="0"/>"#,
                r#"<vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
                r#"</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#,
                r#"</resources><build><item objectid="1"/></build></model>"#,
            ),
            "p".repeat(WELL_PAST_ONE_WINDOW)
        ),
    );
    assert_eq!(
        code_of(parse_3mf_mesh(&path, &limits())),
        AppErrorCode::Validation
    );
}

#[test]
fn a_comment_that_closes_past_a_window_edge_is_not_partly_re_read_as_document_text() {
    // The narrowest hole in a windowed scan, and the one that produces a *wrong answer* rather
    // than an error. A comment may legally close past the point where a marker near the window
    // edge stops being trustworthy; if the window then only discards up to that point, the last
    // few bytes of the comment's interior survive into the next window and are scanned as real
    // XML. Here those bytes are `<mesh`, which begins a new object and rebases every following
    // triangle index: the triangle then indexes vertex 3 of a mesh that has none, so the symptom
    // is an out-of-range error rather than a quietly wrong picture. The parser must consume at
    // least as far as the comment's close.
    //
    // Only a handful of byte alignments can express the hole at all, so the fixture aims at 2^18
    // and sweeps a tag's width either side rather than asserting one exact offset. The geometry
    // has to come out right at all seventeen; which of them is the live one is an implementation
    // detail this test does not want to encode.
    let (_dir, root) = fixture_dir();
    let head = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><mesh><vertices>"#,
        r#"<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
        "</vertices>",
    );
    // A comment whose interior *ends* with a bare `<mesh`, followed by a run of marker-free text
    // long enough that the scan genuinely runs out of markers at the window edge rather than
    // finding the real `<triangles>` there.
    let comment = "<!--<mesh-->";
    let tail = concat!(
        "...............................<triangles><triangle v1=\"0\" v2=\"1\" v3=\"2\"/></triangles>",
        "</mesh></object></resources><build><item objectid=\"1\"/></build></model>",
    );

    for offset in -8i64..=8 {
        // Place the comment's `<mesh` at 2^18 + offset, one window's worth of document into the
        // part, plus or minus a tag's width.
        let filler_length = (262_144 + offset) as usize - head.len() - "<!--".len();
        let path = root.join(format!("edge-{}.3mf", offset + 8));
        write_3mf(
            &path,
            &format!("{head}{}{comment}{tail}", "p".repeat(filler_length)),
        );
        let mesh = parse_3mf_mesh(&path, &limits()).unwrap();
        assert_eq!(mesh.triangle_count, 1, "triangle count at offset {offset}");
        assert_eq!(
            mesh.positions, UNIT_TRIANGLE,
            "positions at offset {offset}"
        );
    }
}

#[test]
fn a_3mf_whose_two_passes_disagree_is_refused_not_returned_half_filled() {
    // The counting pass sizes the arrays and the filling pass writes them. A filling pass that saw
    // one tag fewer would return a mesh missing a triangle, and one that saw more would overflow
    // it: both plausible pictures, and neither an error unless something checks. `obj.rs` and
    // `stl.rs` already refused this; 3MF is the one with the most ways to disagree with itself.
    //
    // Provoked the way a real deployment provokes it: the file changes between the two streams,
    // because a slicer rewrote the project during a backfill. The seam is the probe's
    // `before_fill`, which runs after the counting pass and before the filling one (the legacy
    // test swapped the file from inside the first window decode of pass two, which is the same
    // moment).
    //
    // The substitute is the *same length* with one `<triangle>` blanked to spaces. Equal length
    // is what makes this reach the guard at all: a shorter entry is caught earlier and elsewhere,
    // by the chunked reader's own "does not yield its declared uncompressed size" check, and it
    // is also the harder case, since every other cross-check in the stack still passes.
    let (_dir, root) = fixture_dir();
    let path = root.join("swapped.3mf");
    let n = 25_000;
    let full = grid_model_xml(n, 0);
    let doomed = format!(
        r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
        n - 1000,
        n - 999,
        n - 998
    );
    let blanked = full.replace(&doomed, &" ".repeat(doomed.len()));
    assert_ne!(blanked, full);
    assert_eq!(blanked.len(), full.len());
    write_3mf(&path, &full);

    let swapped = Arc::new(AtomicBool::new(false));
    let mut probe = ScanProbe::default();
    let swap_path = path.clone();
    let swap_flag = Arc::clone(&swapped);
    probe.before_fill = Some(Box::new(move || {
        write_3mf(&swap_path, &blanked);
        swap_flag.store(true, Ordering::SeqCst);
    }));
    let result = parse_3mf_mesh_probed(&path, &limits(), &mut probe);
    assert!(
        swapped.load(Ordering::SeqCst),
        "the substitution never happened, so nothing was actually tested"
    );
    assert_eq!(code_of(result), AppErrorCode::Validation);
}

#[test]
fn an_ascii_stl_vertex_record_that_is_not_three_numbers_on_one_line_is_refused() {
    // The narrowing that comes with reading a line at a time, made loud. A record split across
    // lines, or truncated, matches nothing, and a non-match is silent in both passes at once, so
    // the counts still agree and "a multiple of 3 per facet" still holds whenever the number of
    // dropped records is itself a multiple of three. That is a mesh quietly missing whole facets,
    // which is the one outcome worse than a refusal.
    let (_dir, root) = fixture_dir();
    let facet = |x: i32| {
        format!(
            "facet normal 0 0 0\nouter loop\nvertex {x} 0 0\nvertex {x} 1 0\nvertex {x} 1 1\nendloop\nendfacet\n"
        )
    };
    let good = format!(
        "solid s\n{}{}{}{}endsolid s\n",
        facet(0),
        facet(1),
        facet(2),
        facet(3)
    );
    assert_eq!(
        parse_stl(good.as_bytes(), &limits())
            .unwrap()
            .triangle_count,
        4
    );

    // Exactly three records split across lines, so the survivors are still a multiple of 9 floats
    // and every other guard in the parser is satisfied. Without the start-count check this parses
    // to three facets instead of four and says nothing.
    let split = good.replace(
        "vertex 1 0 0\nvertex 1 1 0\nvertex 1 1 1\n",
        "vertex 1 0\n0\nvertex 1 1\n0\nvertex 1 1\n1\n",
    );
    assert_ne!(split, good);
    assert_eq!(
        code_of(parse_stl(split.as_bytes(), &limits())),
        AppErrorCode::Validation
    );

    let path = root.join("split.stl");
    fs::write(&path, &split).unwrap();
    assert_eq!(
        code_of(parse_stl_file(&path, &limits())),
        AppErrorCode::Validation
    );

    // A truncated last record, which the old whole-document regex caught only because it could
    // reach across the newline into the next line's tokens.
    let truncated = format!("solid s\n{}vertex 9 9\nendsolid s\n", facet(0));
    assert_eq!(
        code_of(parse_stl(truncated.as_bytes(), &limits())),
        AppErrorCode::Validation
    );

    // Three records written as the keyword on one line and its numbers on the next. Exactly three,
    // so what survives is still a multiple of 9 floats and the facet-count guard stays quiet: the
    // file would otherwise parse to three facets instead of four and say nothing at all. Nothing
    // follows `vertex` on those lines, so only the end-of-line half of the start pattern sees
    // them: a check written as "keyword followed by whitespace" walks straight past this fixture.
    let wrapped_facet = "facet normal 0 0 0\nouter loop\nvertex\n1 0 0\nvertex\n1 1 0\nvertex\n1 1 1\nendloop\nendfacet\n";
    let wrapped = format!(
        "solid s\n{}{wrapped_facet}{}{}endsolid s\n",
        facet(0),
        facet(2),
        facet(3)
    );
    assert_eq!(
        code_of(parse_stl(wrapped.as_bytes(), &limits())),
        AppErrorCode::Validation
    );

    // And the shape that must keep parsing: "vertex" inside a solid's name is not a record.
    let named = format!(
        "solid vertexcube\n{}{}endsolid vertexcube\n",
        facet(0),
        facet(1)
    );
    assert_eq!(
        parse_stl(named.as_bytes(), &limits())
            .unwrap()
            .triangle_count,
        2
    );
}

#[test]
fn the_3mf_parse_scales_with_triangle_count_not_with_file_size() {
    // The property the whole design exists to establish, expressed as the difference between two
    // documents with *identical geometry*: one small, one with a megabyte of comment in it. If any
    // buffer were a function of the document rather than of the mesh, the second would hold more
    // than the first. (Wall clock is deliberately not asserted on: it is a function of the
    // machine, and this is a statement about memory.)
    //
    // The legacy test compared the largest single decode. The parser here has one document-side
    // buffer, the window, and the property is that it is the same fixed size whatever the file;
    // `tests/memory.rs` repeats the comparison against real allocation.
    let (_dir, root) = fixture_dir();
    let geometry = concat!(
        r#"<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
        r#"</vertices><triangles><triangle v1="0" v2="1" v3="2"/>"#,
    );
    let wrap = |body: &str| {
        format!(
            concat!(
                r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
                r#"<object id="1" type="model"><mesh><vertices>{}</triangles></mesh></object>"#,
                r#"</resources><build><item objectid="1"/></build></model>"#,
            ),
            body
        )
    };
    let small = root.join("small.3mf");
    let padded = root.join("padded.3mf");
    write_3mf(&small, &wrap(geometry));
    write_3mf(
        &padded,
        &wrap(&format!(
            "<!-- {} -->{geometry}",
            "x".repeat(WELL_PAST_ONE_WINDOW)
        )),
    );

    let measure = |path: &Path| {
        let mut probe = ScanProbe::default();
        let mesh = parse_3mf_mesh_probed(path, &limits(), &mut probe).unwrap();
        (mesh, probe.peak_window_bytes)
    };
    let (small_mesh, small_window) = measure(&small);
    let (padded_mesh, padded_window) = measure(&padded);
    assert!(small_window > 0, "expected the parse to observe its window");
    assert!(
        padded_window <= WINDOW_BYTES,
        "the window held {padded_window} bytes for the same geometry in a document a megabyte larger"
    );
    assert_eq!(padded_mesh, small_mesh);
}

/// A binary STL of `n` triangles whose coordinates are all distinct, so order is checkable.
fn binary_stl_bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; 84 + n * 50];
    out[80..84].copy_from_slice(&(n as u32).to_le_bytes());
    for t in 0..n {
        let base = 84 + t * 50 + 12;
        for i in 0..9 {
            out[base + i * 4..base + i * 4 + 4]
                .copy_from_slice(&((t * 9 + i) as f32).to_le_bytes());
        }
    }
    out
}

#[test]
fn a_binary_stl_far_longer_than_one_read_chunk_streams_to_the_same_mesh_as_the_buffer_does() {
    // 30 000 records is 1.5 MB, six read chunks, and 50 does not divide 262 144, so records
    // straddle every boundary rather than lining up with it, which is the case the reassembly
    // buffer exists for and the only one where an off-by-one produces plausible-looking garbage
    // instead of a crash.
    let (_dir, root) = fixture_dir();
    let bytes = binary_stl_bytes(30_000);
    assert!(bytes.len() > WELL_PAST_ONE_WINDOW);
    let path = root.join("big.stl");
    fs::write(&path, &bytes).unwrap();

    let streamed = parse_stl_file(&path, &limits()).unwrap();
    let buffered = parse_stl(&bytes, &limits()).unwrap();
    assert_eq!(streamed.triangle_count, 30_000);
    assert!(streamed.positions == buffered.positions);
}

#[test]
fn an_ascii_stl_far_longer_than_one_read_chunk_streams_to_the_same_mesh_as_the_buffer_does() {
    let (_dir, root) = fixture_dir();
    let mut lines = vec!["solid big".to_owned()];
    for t in 0..20_000 {
        lines.push("  facet normal 0 0 0".into());
        lines.push("    outer loop".into());
        for i in 0..3 {
            lines.push(format!("      vertex {t} {i} {}", t * 3 + i));
        }
        lines.push("    endloop".into());
        lines.push("  endfacet".into());
    }
    lines.push("endsolid big".into());
    // CRLF, so a line ending straddling a chunk boundary is exercised as well as a line body.
    let bytes = lines.join("\r\n").into_bytes();
    assert!(bytes.len() > WELL_PAST_ONE_WINDOW);
    let path = root.join("big-ascii.stl");
    fs::write(&path, &bytes).unwrap();

    let streamed = parse_stl_file(&path, &limits()).unwrap();
    assert_eq!(streamed.triangle_count, 20_000);
    assert!(streamed.positions == parse_stl(&bytes, &limits()).unwrap().positions);
}

#[test]
fn an_obj_far_longer_than_one_read_chunk_streams_to_the_same_mesh_as_the_buffer_does() {
    // Every 500th line carries a comment with a 4-byte character in it, so multi-byte sequences
    // land on chunk boundaries repeatedly. A non-streaming decoder would turn each split one into
    // two replacement characters, and since they are inside comments the damage would be invisible
    // in the mesh, which is why the assertion is against the buffered parse of the identical bytes
    // rather than against a hand-written expectation.
    let (_dir, root) = fixture_dir();
    let n = 20_000;
    let mut text = String::new();
    for i in 0..n {
        if i % 500 == 0 {
            text.push_str(&format!(
                "# gr\u{fc}\u{df}e \u{1f600} \u{300c}\u{4e09}\u{6b21}\u{5143}\u{300d} {i}\n"
            ));
        }
        text.push_str(&format!("v {i} {} {}\n", i % 7, i % 13));
    }
    let mut i = 0;
    while i + 3 <= n {
        text.push_str(&format!("f {} {} {}\n", i + 1, i + 2, i + 3));
        i += 3;
    }
    assert!(
        text.len() > 300_000,
        "fixture must span several read chunks"
    );
    let path = root.join("big.obj");
    fs::write(&path, &text).unwrap();

    let streamed = parse_obj_file(&path, &limits()).unwrap();
    let buffered = parse_obj(text.as_bytes(), &limits()).unwrap();
    assert_eq!(streamed.triangle_count, buffered.triangle_count);
    assert!(streamed.positions == buffered.positions);
}

#[test]
fn the_mesh_ceiling_refuses_a_model_before_its_arrays_are_allocated_naming_both_sizes() {
    // One ceiling, every entry point in this file: three buffered, four streamed. (The legacy
    // test named an eighth, the STEP parser, pinned in its own file; STEP is not read any more,
    // so there is no eighth.) A ceiling of one byte is deliberately absurd, because the
    // interesting question is not where the line sits (that is a deployment decision and lives in
    // the README) but that each format consults it at all, that the refusal is a `Validation`
    // error rather than an allocation failure, and that the message an operator reads names what
    // was needed and what is allowed.
    let (_dir, root) = fixture_dir();
    let tiny = MeshLimits { max_mesh_bytes: 1 };

    let stl_path = root.join("cap.stl");
    let stl_bytes = binary_stl_bytes(100);
    fs::write(&stl_path, &stl_bytes).unwrap();
    let obj_bytes = b"v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n";
    let obj_path = root.join("cap.obj");
    fs::write(&obj_path, obj_bytes).unwrap();
    let ascii_bytes = b"solid s\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\nendloop\nendfacet\nendsolid s\n";
    let ascii_path = root.join("cap-ascii.stl");
    fs::write(&ascii_path, ascii_bytes).unwrap();
    let threemf_path = root.join("cap.3mf");
    write_3mf(&threemf_path, &grid_model_xml(10, 0));

    let invalid = AppErrorCode::Validation;
    assert_eq!(code_of(parse_stl(&stl_bytes, &tiny)), invalid);
    assert_eq!(code_of(parse_stl(ascii_bytes, &tiny)), invalid);
    assert_eq!(code_of(parse_obj(obj_bytes, &tiny)), invalid);
    assert_eq!(code_of(parse_stl_file(&stl_path, &tiny)), invalid);
    assert_eq!(code_of(parse_stl_file(&ascii_path, &tiny)), invalid);
    assert_eq!(code_of(parse_obj_file(&obj_path, &tiny)), invalid);
    assert_eq!(code_of(parse_3mf_mesh(&threemf_path, &tiny)), invalid);

    // The same model parses when the ceiling is one it fits under, so the refusals above are the
    // ceiling doing its job and not the fixtures being broken.
    let roomy = MeshLimits {
        max_mesh_bytes: 1_000_000,
    };
    assert_eq!(parse_stl(&stl_bytes, &roomy).unwrap().triangle_count, 100);
    assert_eq!(
        parse_3mf_mesh(&threemf_path, &roomy)
            .unwrap()
            .triangle_count,
        10
    );

    let message = parse_stl(&stl_bytes, &tiny).unwrap_err().message;
    // Both numbers, because "too big" without them tells an operator nothing about whether the
    // fix is a bigger ceiling or a smaller model.
    assert!(message.contains("0.0 MB"), "{message}");
    assert!(message.contains("100 triangles"), "{message}");
    assert!(
        message.contains("more than the 0.0 MB this server permits"),
        "{message}"
    );
}

#[test]
fn a_mesh_too_large_for_the_machine_to_allocate_is_a_validation_error_not_an_abort() {
    // `SPM_MAX_MESH_MB` is an operator's ceiling and the same configuration ships to a NAS and to
    // a workstation, so the allocation can still fail under it, for want of memory. The length
    // came out of a file either way, and everything a file can cause has to arrive as an error
    // rather than as an allocator abort. (The legacy case allocated 2^40 floats; 2^48 is the same
    // idea with room to spare on a 64-bit address space.)
    let error = allocate_mesh(1 << 48, "triangles").unwrap_err();
    assert_eq!(error.code, AppErrorCode::Validation);
    assert!(
        error
            .message
            .contains("too large to allocate its triangles"),
        "{}",
        error.message
    );
    // The ordinary case still returns room for what was asked, so the assertion above is not
    // vacuous. (The vector is empty: the parsers push into it up to this capacity, so nothing is
    // zero-filled and nothing ever reallocates.)
    let room = allocate_mesh(9, "triangles").unwrap();
    assert!(room.capacity() >= 9);
    assert!(room.is_empty());
}
