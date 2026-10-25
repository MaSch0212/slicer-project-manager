//! Ported from the legacy `obj.test.ts`: Wavefront OBJ parsed from a buffer.

use spm_core::AppErrorCode;
use spm_core::previews::MeshLimits;
use spm_core::previews::mesh::obj::parse_obj;

use crate::common::code_of;

fn parse(text: &str) -> spm_core::Result<spm_core::previews::Mesh> {
    parse_obj(text.as_bytes(), &MeshLimits::default())
}

#[test]
fn a_triangle_face_parses_to_one_triangle() {
    let mesh = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n").unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(
        mesh.positions,
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
}

#[test]
fn a_quad_face_fan_triangulates_into_two_triangles() {
    let mesh = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n").unwrap();
    assert_eq!(mesh.triangle_count, 2);
    assert_eq!(
        mesh.positions,
        // Fan around vertex 0: (0,1,2) then (0,2,3).
        [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0,
            0.0
        ]
    );
}

#[test]
fn negative_relative_face_indices_resolve_against_the_vertex_count_seen_so_far() {
    let mesh = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3 -2 -1\n").unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(
        mesh.positions,
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
}

#[test]
fn v_vt_vn_face_index_forms_ignore_the_texture_and_normal_indices() {
    let mesh = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n").unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(
        mesh.positions,
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
}

#[test]
fn a_v_slash_slash_vn_face_index_form_no_texture_index_also_resolves_correctly() {
    let mesh = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n").unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(
        mesh.positions,
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
}

#[test]
fn a_file_of_only_comments_and_no_faces_is_rejected() {
    assert_eq!(
        code_of(parse("# just a comment\n# another one\n")),
        AppErrorCode::Validation
    );
}

#[test]
fn a_file_with_vertices_but_no_faces_is_rejected() {
    assert_eq!(
        code_of(parse("v 0 0 0\nv 1 0 0\nv 1 1 0\n")),
        AppErrorCode::Validation
    );
}

#[test]
fn a_face_with_a_non_finite_vertex_coordinate_is_rejected() {
    assert_eq!(
        code_of(parse("v 0 0 0\nv 1 0 0\nv nan 1 0\nf 1 2 3\n")),
        AppErrorCode::Validation
    );
}

#[test]
fn a_face_vertex_index_out_of_range_is_rejected() {
    assert_eq!(
        code_of(parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 4\n")),
        AppErrorCode::Validation
    );
}

#[test]
fn a_face_with_fewer_than_3_vertices_is_rejected_even_alongside_a_valid_face() {
    // A preceding valid triangle means a mesh with only the degenerate-face check disabled would
    // still produce non-empty output (and thus not trip the separate "no faces" check), so this
    // specifically exercises the fewer-than-3-vertices guard.
    assert_eq!(
        code_of(parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\nf 1 2\n")),
        AppErrorCode::Validation
    );
}

#[test]
fn g_usemtl_and_other_directives_are_ignored_rather_than_failing_the_parse() {
    let mesh = parse(
        "g mygroup\nusemtl material0\nv 0 0 0\nv 1 0 0\nv 1 1 0\ns off\nf 1 2 3\nmtllib x.mtl\n",
    )
    .unwrap();
    assert_eq!(mesh.triangle_count, 1);
}

#[test]
fn a_hash_comment_starting_partway_through_a_line_is_truncated_not_just_one_at_line_start() {
    let mesh = parse("v 0 0 0 # first corner\nv 1 0 0\nv 1 1 0\nf 1 2 3 # the face\n").unwrap();
    assert_eq!(mesh.triangle_count, 1);
    assert_eq!(
        mesh.positions,
        [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
}

#[test]
fn a_large_fan_produces_the_exact_expected_geometry_under_the_two_pass_rewrite() {
    // Exercises the counting pass and the filling pass agreeing on size and order at a scale where
    // an off-by-one in either pass (or in the write bookkeeping) would show up as wrong data
    // rather than just a wrong count.
    let n = 2000usize;
    let mut text = String::new();
    for i in 0..n {
        text.push_str(&format!("v {i} {} 0\n", i * 2));
    }
    text.push('f');
    for i in 1..=n {
        text.push_str(&format!(" {i}"));
    }
    text.push('\n');
    let mesh = parse(&text).unwrap();

    let expected_triangle_count = n - 2;
    assert_eq!(mesh.triangle_count, expected_triangle_count);
    let mut expected = Vec::with_capacity(expected_triangle_count * 9);
    for k in 1..n - 1 {
        for vi in [0, k, k + 1] {
            expected.extend([vi as f32, (vi * 2) as f32, 0.0]);
        }
    }
    assert_eq!(mesh.positions, expected);
}

// --- Rust-only: the `Number()` grammar the legacy parser read coordinates and indices with ----

#[test]
fn indices_and_coordinates_follow_the_javascript_number_grammar() {
    // `Number("0x2")`, `Number("1e0")` and `Number("2.0")` are integers to the legacy parser, and a
    // padded or exponent coordinate was a finite one.
    let mesh = parse("v 0x1 1e0 0\nv 1 0 0\nv 1 1 0\nf 1.0 2e0 0x3\n").unwrap();
    assert_eq!(
        mesh.positions,
        [1.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]
    );
    // A fractional index is not an integer, and a zero index is not an index.
    for bad in ["f 1.5 2 3", "f 0 2 3"] {
        assert_eq!(
            code_of(parse(&format!("v 0 0 0\nv 1 0 0\nv 1 1 0\n{bad}\n"))),
            AppErrorCode::Validation,
            "{bad}"
        );
    }
}
