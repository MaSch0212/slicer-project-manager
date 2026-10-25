//! Ported from the legacy `threemf.test.ts`: the streaming 3MF mesh parser.
//!
//! Three legacy tests measured the parser by patching a JavaScript runtime (counting
//! `Uint8Array.prototype.indexOf` calls, and the size of every `TextDecoder.decode` input). Neither
//! seam exists here, and the parser has no decode step at all: it reads attributes straight out of
//! the bytes of one tag. Their intent is kept against what this parser does have: the
//! `ScanProbe` it reports (`bytes_walked` for the linearity test, `peak_window_bytes` for the
//! bounded-buffer tests), and `tests/memory.rs` measures real allocation.

use std::fs;
use std::path::{Path, PathBuf};

use spm_core::AppErrorCode;
use spm_core::previews::Mesh;
use spm_core::previews::MeshLimits;
use spm_core::previews::mesh::threemf::{
    ScanProbe, WINDOW_BYTES, parse_3mf_mesh, parse_3mf_mesh_probed,
};
use tempfile::{TempDir, tempdir};

use crate::common::code_of;
use crate::fixtures::{stored, write_zip};

struct ObjectSpec {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[usize; 3]>,
}

/// Builds `3D/3dmodel.model` XML with one `<object>` per entry in `objects`, each with its own
/// `<mesh>`. Triangle indices are local to their own object's vertex list, matching the 3MF spec
/// (and exercising the parser's per-mesh index scoping).
fn build_model_xml(objects: &[ObjectSpec]) -> String {
    let mut objects_xml = String::new();
    for (i, object) in objects.iter().enumerate() {
        let vertices: String = object
            .vertices
            .iter()
            .map(|[x, y, z]| format!(r#"<vertex x="{x}" y="{y}" z="{z}"/>"#))
            .collect();
        let triangles: String = object
            .triangles
            .iter()
            .map(|[v1, v2, v3]| format!(r#"<triangle v1="{v1}" v2="{v2}" v3="{v3}"/>"#))
            .collect();
        objects_xml.push_str(&format!(
            r#"<object id="{}" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object>"#,
            i + 1
        ));
    }
    let items: String = (0..objects.len())
        .map(|i| format!(r#"<item objectid="{}"/>"#, i + 1))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>{objects_xml}</resources><build>{items}</build></model>"#
    )
}

fn single_triangle() -> ObjectSpec {
    ObjectSpec {
        vertices: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
        triangles: vec![[0, 1, 2]],
    }
}

/// A grid-free line of `n` vertices with `n` triangles, each referencing valid local indices.
fn build_grid_model_xml(n: usize) -> String {
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
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#
    )
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

/// A temp directory and one `.3mf` written into it.
fn fixture(name: &str, model_xml: &str) -> (TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let path = dir.path().join(name);
    write_3mf(&path, model_xml);
    (dir, path)
}

fn parse(path: &Path) -> spm_core::Result<Mesh> {
    parse_3mf_mesh(path, &MeshLimits::default())
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

/// The model part around one mesh body, for tests that only vary the geometry.
fn wrap(body: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh>{body}</mesh></object></resources><build><item objectid="1"/></build></model>"#
    )
}

#[test]
fn a_hand_built_3mf_with_a_single_triangle_parses_to_that_triangle() {
    let (_dir, path) = fixture("a.3mf", &build_model_xml(&[single_triangle()]));
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn a_two_object_3mf_concatenates_both_meshes_each_with_its_own_local_vertex_indices() {
    let xml = build_model_xml(&[
        single_triangle(),
        // Deliberately reuses local indices 0,1,2: they must resolve against this object's own
        // vertex list, not a global index space shared with the first object.
        ObjectSpec {
            vertices: vec![[0.0, 0.0, 5.0], [1.0, 0.0, 5.0], [1.0, 1.0, 5.0]],
            triangles: vec![[0, 1, 2]],
        },
    ]);
    let (_dir, path) = fixture("two.3mf", &xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 2);
    assert_eq!(
        mesh.positions,
        [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 5.0, 1.0, 0.0, 5.0, 1.0, 1.0,
            5.0
        ]
    );
}

#[test]
fn an_out_of_range_triangle_vertex_index_is_rejected() {
    let xml = build_model_xml(&[ObjectSpec {
        vertices: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
        triangles: vec![[0, 1, 5]],
    }]);
    let (_dir, path) = fixture("bad-index.3mf", &xml);
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

#[test]
fn a_3mf_with_vertices_but_no_triangles_is_rejected() {
    let xml = build_model_xml(&[ObjectSpec {
        triangles: vec![],
        ..single_triangle()
    }]);
    let (_dir, path) = fixture("no-triangles.3mf", &xml);
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

#[test]
fn a_3mf_with_no_3d_3dmodel_model_entry_is_rejected() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("no-model.3mf");
    write_zip(&path, &[stored("[Content_Types].xml", "<Types/>")], None);
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

#[test]
fn a_vertex_with_a_non_finite_coordinate_is_rejected() {
    let xml = build_model_xml(&[single_triangle()])
        .replace(r#"x="1" y="0" z="0""#, r#"x="nan" y="0" z="0""#);
    let (_dir, path) = fixture("nan.3mf", &xml);
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

#[test]
fn the_scanner_does_not_go_quadratic_on_a_mesh_with_many_vertices_and_triangles() {
    // ## Why this counts work per byte instead of comparing two sizes
    //
    // The scanner reads the document in fixed-size windows. A scan that restarts from the front of
    // its *window* on every call is quadratic in the window, not in the document, so its total
    // work still grows linearly with the document and the ratio between a 3k-tag file and a
    // 30k-tag one stays around 10. A ratio of two timings would miss that mutant entirely, and a
    // wall clock flakes on a loaded machine. So the property to assert is the constant itself: the
    // scan walks a small, bounded number of bytes per document byte, whatever the document's size.
    // That is what "linear" means here, and it is what a cursor that never rewinds buys.
    //
    // `bytes_walked` is the distance every `memchr` of every search covered, the same quantity
    // the legacy test read off `indexOf`: the scanner's linearity is a property of one primitive,
    // searched from a position that only ever moves forward.
    let small_n = 3000;
    let large_n = 30000; // 10x the tags of the small fixture
    let small_xml = build_grid_model_xml(small_n);
    let large_xml = build_grid_model_xml(large_n);
    let (_small_dir, small_path) = fixture("small.3mf", &small_xml);
    let (_large_dir, large_path) = fixture("large.3mf", &large_xml);

    let measure = |path: &Path| {
        let mut probe = ScanProbe::default();
        let mesh = parse_3mf_mesh_probed(path, &MeshLimits::default(), &mut probe).unwrap();
        (mesh, probe.bytes_walked)
    };
    let (small_mesh, small_walked) = measure(&small_path);
    let (large_mesh, large_walked) = measure(&large_path);
    assert_eq!(small_mesh.triangle_count, small_n);
    assert_eq!(large_mesh.triangle_count, large_n);

    let small_per_byte = small_walked as f64 / small_xml.len() as f64;
    let large_per_byte = large_walked as f64 / large_xml.len() as f64;

    // Two passes, four monotonic cursors, and the `>` searches that close each tag: measured at
    // 7.95 bytes per document byte on the large fixture, the same figure the legacy scanner
    // measured (it is the same traversal). 20 leaves room for another cursor without leaving room
    // for a rescan, which costs hundreds.
    assert!(
        large_per_byte < 20.0,
        "scan walked {large_per_byte} bytes per document byte, expected a small constant"
    );
    // The counter would also read near zero for an implementation that stopped searching: a
    // figure below 1 means the instrument, not the scanner, is what changed.
    assert!(
        small_per_byte >= 1.0,
        "scan walked {small_per_byte} bytes per document byte; the counter is no longer observing it"
    );
    // And the constant must not grow with the document, which is the part a single measurement
    // cannot show.
    let growth = large_per_byte / small_per_byte;
    assert!(
        growth < 1.5,
        "work per byte grew {growth}x over a 10x document, expected flat"
    );
}

#[test]
fn a_large_fan_produces_the_exact_expected_geometry_under_the_two_pass_rewrite() {
    // Exercises the counting pass and the filling pass agreeing on size and order at a scale where
    // a bookkeeping bug in the write offsets or the per-mesh vertex base would show up as wrong
    // data rather than merely a wrong count.
    let n = 2000;
    let (_dir, path) = fixture("large-fan.3mf", &build_grid_model_xml(n));
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, n);
    assert_eq!(mesh.positions, expected_grid(n));
}

#[test]
fn a_vertex_or_triangle_inside_an_xml_comment_is_ignored_not_ingested_as_geometry() {
    let xml = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><mesh><vertices>"#,
        // An empty comment sits exactly on the boundary the `-->` search anchors against: its
        // closing marker begins at the first byte the search is allowed to look at, so an
        // off-by-one in the anchor offset would step straight over it and report the comment
        // unterminated.
        "<!---->",
        r#"<!-- a phantom vertex that must not shift real indices: <vertex x="99" y="99" z="99"/> -->"#,
        r#"<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
        "</vertices><triangles>",
        r#"<!-- <triangle v1="0" v2="0" v3="0"/> a phantom degenerate triangle -->"#,
        r#"<triangle v1="0" v2="1" v3="2"/>"#,
        "</triangles></mesh></object>",
        r#"</resources><build><item objectid="1"/></build></model>"#,
    );
    let (_dir, path) = fixture("commented.3mf", xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn single_quoted_attribute_values_parse_the_same_as_double_quoted_ones() {
    let xml = concat!(
        "<?xml version='1.0'?><model unit='millimeter'><resources>",
        "<object id='1' type='model'><mesh><vertices>",
        "<vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='1' y='1' z='0'/>",
        "</vertices><triangles><triangle v1='0' v2='1' v3='2'/></triangles></mesh></object>",
        "</resources><build><item objectid='1'/></build></model>",
    );
    let (_dir, path) = fixture("single-quotes.3mf", xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn a_newline_or_tab_after_the_element_name_pretty_printed_xml_still_parses() {
    let xml = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><mesh>"#,
        "\n  <vertices>\n",
        "    <vertex\n      x=\"0\"\n      y=\"0\"\n      z=\"0\"/>\n",
        "    <vertex x=\"1\" y=\"0\" z=\"0\"/>\n",
        "    <vertex x=\"1\" y=\"1\" z=\"0\"/>\n",
        "  </vertices>\n  <triangles>\n",
        "    <triangle\ty=\"ignored\"\tv1=\"0\" v2=\"1\" v3=\"2\"/>\n",
        "  </triangles>\n</mesh></object>",
        r#"</resources><build><item objectid="1"/></build></model>"#,
    );
    let (_dir, path) = fixture("pretty.3mf", xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn an_empty_or_whitespace_only_attribute_value_is_rejected_not_coerced_to_0() {
    let vertices = |first: &str| {
        format!(
            "<vertices>{first}<vertex x=\"1\" y=\"0\" z=\"0\"/><vertex x=\"1\" y=\"1\" z=\"0\"/></vertices>"
        )
    };
    let triangle =
        |v1: &str| format!("<triangles><triangle v1=\"{v1}\" v2=\"1\" v3=\"2\"/></triangles>");

    for (name, body) in [
        (
            "empty-x",
            vertices(r#"<vertex x="" y="0" z="0"/>"#) + &triangle("0"),
        ),
        (
            "whitespace-x",
            vertices(r#"<vertex x="   " y="0" z="0"/>"#) + &triangle("0"),
        ),
        (
            "empty-v1",
            vertices(r#"<vertex x="0" y="0" z="0"/>"#) + &triangle(""),
        ),
    ] {
        let (_dir, path) = fixture(&format!("{name}.3mf"), &wrap(&body));
        assert_eq!(code_of(parse(&path)), AppErrorCode::Validation, "{name}");
    }
}

#[test]
fn a_hyphenated_decoy_attribute_does_not_leak_into_the_real_one_anchored_not_word_boundary() {
    let xml = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><mesh><vertices>"#,
        r#"<vertex p-x="77" x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>"#,
        r#"<vertex x="1" y="1" z="0"/>"#,
        r#"</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#,
        r#"</resources><build><item objectid="1"/></build></model>"#,
    );
    let (_dir, path) = fixture("decoy.3mf", xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    // If a word boundary (rather than the whitespace anchor) matched the attribute name, the
    // decoy `p-x="77"` would win and the first vertex would come out at x=77, not x=0.
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn a_3mf_whose_objects_are_only_components_no_inline_mesh_anywhere_is_rejected() {
    let xml = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><components><component objectid="2"/></components></object>"#,
        r#"<object id="2" type="model"><components><component objectid="1"/></components></object>"#,
        r#"</resources><build><item objectid="1"/></build></model>"#,
    );
    let (_dir, path) = fixture("components-only.3mf", xml);
    // Must fail loudly (a blank or partial thumbnail reported as success is worse than a failed
    // preview), not return an empty or partial mesh.
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

#[test]
fn multi_byte_utf8_around_and_inside_the_geometry_does_not_shift_the_byte_cursors() {
    // The scan walks raw UTF-8 bytes, so anything that makes a character wider than one byte is
    // where a byte/character confusion would surface: a slice that starts or ends mid-character,
    // or a marker offset read as a character index. Umlauts (2 bytes), a CJK quotation mark (3)
    // and an emoji (4) are placed in a comment, in element text, in a non-geometry attribute, and
    // inside a <vertex> tag's own slice.
    let xml = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><model unit=\"millimeter\">",
        "<metadata name=\"Title\">K\u{f6}ln Pokal \u{2014} Kugel \u{300c}\u{4e09}\u{6b21}\u{5143}\u{300d} \u{1f600}</metadata>",
        "<resources><object id=\"1\" type=\"model\" name=\"Gr\u{fc}\u{df}e\"><mesh><vertices>",
        "<!-- Kommentar mit Umlauten: \u{e4}\u{f6}\u{fc}\u{df} \u{1f600} und ein Phantom: <vertex x=\"99\" y=\"99\" z=\"99\"/> -->",
        "<vertex x=\"0\" y=\"0\" z=\"0\"/>",
        "<vertex note=\"gr\u{f6}\u{df}er \u{1f600} \u{300c}\u{4e09}\u{6b21}\u{5143}\u{300d}\" x=\"1\" y=\"0\" z=\"0\"/>",
        "<vertex x=\"1\" y=\"1\" z=\"0\"/>",
        "</vertices><triangles><triangle v1=\"0\" v2=\"1\" v3=\"2\"/></triangles>",
        "</mesh></object></resources><build><item objectid=\"1\"/></build></model>",
    );
    let (_dir, path) = fixture("utf8.3mf", xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn the_parsers_buffer_never_grows_with_the_document_so_the_parse_never_materializes_it() {
    // The point of the byte scan. A whole-document decode is not merely wasteful: the three
    // largest files in the reference library inflate to a 674 MB model part, past the character
    // cap of the runtime the first parser ran on, and died with a bare error instead of a
    // `Validation`. Those real files are the motivating cases and were verified by hand; no
    // >512 MB fixture is built here (`tests/memory.rs` runs a synthetic one of ~120 MB instead).
    //
    // The legacy test measured the largest `TextDecoder.decode` input. There is no decode step
    // here, so what is bounded is the one buffer the document passes through: `peak_window_bytes`
    // is the most it ever held. Two fixtures, one four times the other, express the property
    // *relatively* rather than against a hard-coded ceiling that would silently become
    // meaningless if the fixture or the window were retuned: quadrupling the document must not
    // move it at all.
    let n = 6000;
    let small_xml = build_grid_model_xml(n);
    let large_xml = build_grid_model_xml(n * 4);
    let (_small_dir, small) = fixture("small.3mf", &small_xml);
    let (_large_dir, large) = fixture("large.3mf", &large_xml);

    let measure = |path: &Path| {
        let mut probe = ScanProbe::default();
        let mesh = parse_3mf_mesh_probed(path, &MeshLimits::default(), &mut probe).unwrap();
        (mesh.triangle_count, probe.peak_window_bytes)
    };
    let (small_triangles, small_peak) = measure(&small);
    let (large_triangles, large_peak) = measure(&large);

    assert_eq!(small_triangles, n);
    assert_eq!(large_triangles, n * 4);
    // Guards the guard: if the probe stopped observing, the bounds below would hold vacuously.
    assert!(small_peak > 0 && large_peak > 0, "the probe saw no window");
    assert!(
        large_peak <= small_peak.max(WINDOW_BYTES),
        "the buffer grew from {small_peak} to {large_peak} bytes when the document grew 4x"
    );
    assert!(large_peak <= WINDOW_BYTES);
    // And that constant must be a small fraction of the larger document, so that "buffer it in a
    // few big pieces" does not pass the invariant above.
    assert!(
        large_peak * 4 <= large_xml.len(),
        "the buffer was {large_peak} bytes against a {}-byte model part",
        large_xml.len()
    );
}

#[test]
fn a_document_spanning_many_windows_with_a_multi_byte_character_parses_exactly() {
    // The legacy parser decoded a fixed span at a time and sliced tags out of it by byte offset,
    // which is only valid while every code unit came from exactly one byte; this fixture put a
    // 4-byte character in the middle of a long run to cross aligned windows, one that was not, and
    // the transitions in both directions. This parser never decodes, so the hazard is gone by
    // construction, but the fixture is still the right regression: far larger than one window,
    // with a wide multi-byte tag in the middle of it.
    let n = 2000;
    let marked = 1200;
    let mut vertices = String::new();
    let mut triangles = String::new();
    for i in 0..n {
        if i == marked {
            vertices.push_str(&format!(
                "<vertex note=\"{}gr\u{f6}\u{df}er\" x=\"{i}\" y=\"0\" z=\"0\"/>",
                "\u{1f600}".repeat(24)
            ));
        } else {
            vertices.push_str(&format!(r#"<vertex x="{i}" y="0" z="0"/>"#));
        }
        triangles.push_str(&format!(
            r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
            i % n,
            (i + 1) % n,
            (i + 2) % n
        ));
    }
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#
    );
    let (_dir, path) = fixture("windows.3mf", &xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, n);
    assert_eq!(mesh.positions, expected_grid(n));
}

#[test]
fn a_tag_wider_than_one_decode_window_parses_and_the_tags_after_it_still_do() {
    // The legacy reader could not serve a tag that did not fit its 8 KB decode window and decoded
    // that one tag on its own; what had to hold was that it decoded the *whole* tag (the padding
    // pushes `x` past the window edge, so a clipped slice loses the attribute entirely) and that
    // the tags after it were still read correctly. Kept as is: the padding is still wider than
    // anything the old window held, and it is well inside this parser's 256 KB one.
    let padding = "p".repeat(9000);
    let xml = format!(
        concat!(
            r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
            r#"<object id="1" type="model"><mesh><vertices>"#,
            r#"<vertex note="{}" x="0" y="0" z="0"/>"#,
            r#"<vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>"#,
            r#"</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#,
            r#"</resources><build><item objectid="1"/></build></model>"#,
        ),
        padding
    );
    let (_dir, path) = fixture("wide-tag.3mf", &xml);
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(mesh.positions, UNIT_TRIANGLE);
}

#[test]
fn an_unterminated_vertex_tag_or_xml_comment_fails_as_a_validation_error() {
    // Both markers are found, then the search for their terminator runs off the end of the
    // buffer. Without the explicit guards this would be a confusing attribute error, or a loop,
    // rather than a `Validation` error.
    let (_dir, cut_tag) = fixture(
        "cut-tag.3mf",
        concat!(
            r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
            r#"<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0""#,
        ),
    );
    assert_eq!(code_of(parse(&cut_tag)), AppErrorCode::Validation);

    let (_dir, cut_comment) = fixture(
        "cut-comment.3mf",
        concat!(
            r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
            r#"<object id="1" type="model"><mesh><vertices><!-- never closed"#,
        ),
    );
    assert_eq!(code_of(parse(&cut_comment)), AppErrorCode::Validation);
}

#[test]
fn a_namespace_prefixed_tag_m_vertex_yields_no_geometry_and_fails_cleanly() {
    let xml = concat!(
        r#"<?xml version="1.0"?><model unit="millimeter"><resources>"#,
        r#"<object id="1" type="model"><mesh><vertices>"#,
        r#"<m:vertex x="0" y="0" z="0"/><m:vertex x="1" y="0" z="0"/><m:vertex x="1" y="1" z="0"/>"#,
        r#"</vertices><triangles><m:triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#,
        r#"</resources><build><item objectid="1"/></build></model>"#,
    );
    let (_dir, path) = fixture("namespaced.3mf", xml);
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}

// --- Rust-only ---------------------------------------------------------------------------------

#[test]
fn a_deflated_model_part_parses_through_the_inflater_not_just_a_stored_one() {
    // The legacy fixtures wrote this entry stored; every real 3MF deflates it, and the bounded
    // reader is the inflater's, so this is the path production takes.
    let dir = tempdir().unwrap();
    let path = dir.path().join("deflated.3mf");
    write_zip(
        &path,
        &[crate::fixtures::deflated(
            "3D/3dmodel.model",
            build_grid_model_xml(5000),
        )],
        None,
    );
    let mesh = parse(&path).unwrap();
    assert_eq!(mesh.triangle_count, 5000);
    assert_eq!(mesh.positions, expected_grid(5000));
}

#[test]
fn a_file_that_is_not_a_zip_is_a_validation_error_not_an_io_failure() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("not.3mf");
    fs::write(
        &path,
        b"this is not an archive, just text of a decent length",
    )
    .unwrap();
    assert_eq!(code_of(parse(&path)), AppErrorCode::Validation);
}
