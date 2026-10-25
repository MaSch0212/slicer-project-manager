//! Ported from the legacy `raster.test.ts`: the software rasterizer.
//!
//! The pixel values are the legacy ones, asserted exactly: the renderer does the same arithmetic
//! on the same inputs (`f32` positions, `f64` everything after), so the bytes match and no
//! tolerance was needed beyond the ones the legacy tests already carried.
//!
//! Not ported, because the Rust types make them unrepresentable: "a mesh without positions"
//! (`positions` is a `Vec<f32>`, not an optional typed array), a negative `triangleCount`
//! (`usize`), and a fractional/`NaN`/infinite `size` (`usize`). The remaining halves of those two
//! tests (zero triangles, a length that disagrees with the count, sizes 0 and 100 000) are kept.

use std::collections::BTreeSet;

use spm_core::AppErrorCode;
use spm_core::previews::Mesh;
use spm_core::previews::raster::{
    AZIMUTH_DEGREES, CAMERA_BASIS, DEFAULT_SIZE, ELEVATION_DEGREES, RenderedImage, render_mesh,
    render_mesh_sized,
};

use crate::mesh_fixtures::{
    concat_meshes, cube_mesh, degenerate_triangle_mesh, far_degenerate_triangle_mesh,
    many_triangles_mesh, mesh, rotated_box_mesh, scale_mesh, sphere_mesh, tetrahedron_mesh,
    thin_plate_mesh,
};

/// The four colours an axis-aligned cube can produce, written out rather than recomputed.
///
/// A cube shows the camera exactly three normals (+Z on top, -Y in front, +X on the right), and
/// `abs(dot(normal, light))` gives their three hidden opposites the same shades, so the whole
/// image is these four values and nothing else. They are literals on purpose: deriving them from
/// the rasterizer's own light vector and ambient term would make the test agree with whatever the
/// code does, including a light pointed the wrong way.
const BACKGROUND: [u8; 3] = [31, 35, 42];
const TOP: [u8; 3] = [188, 116, 50]; // +Z, the brightest: the light comes from above
const FRONT: [u8; 3] = [151, 93, 41]; // -Y, the mid tone: the light also comes from the front
const RIGHT: [u8; 3] = [111, 68, 30]; // +X, the darkest of the three

fn render(mesh: &Mesh) -> RenderedImage {
    render_mesh(mesh).unwrap()
}

/// A failed render's code and message, so a test can check *which* guard fired.
///
/// Several of the guards in the rasterizer sit in front of each other: remove one and a malformed
/// mesh still fails `Validation`, just from the wrong place and with a message that misdirects
/// whoever reads the queue's error. Matching the message is what keeps each guard independently
/// covered.
fn failure(result: spm_core::Result<RenderedImage>) -> (AppErrorCode, String) {
    let error = result.expect_err("the render was expected to fail");
    (error.code, error.message)
}

fn assert_validation_saying(result: spm_core::Result<RenderedImage>, fragment: &str) {
    let (code, message) = failure(result);
    assert_eq!(code, AppErrorCode::Validation, "{message}");
    assert!(
        message.contains(fragment),
        "expected a message containing {fragment:?}, got {message:?}"
    );
}

/// Compares two byte buffers and, when they differ, says so in one short line.
fn assert_same_bytes(actual: &[u8], expected: &[u8], what: &str) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "{what}: buffer lengths differ"
    );
    let differing = actual.iter().zip(expected).filter(|(a, b)| a != b).count();
    let first = actual.iter().zip(expected).position(|(a, b)| a != b);
    assert_eq!(
        differing,
        0,
        "{what}: {differing} of {} bytes differ, first at byte {first:?}",
        actual.len()
    );
}

fn at(image: &RenderedImage, x: usize, y: usize) -> [u8; 3] {
    let i = (y * image.width as usize + x) * 3;
    [image.rgb[i], image.rgb[i + 1], image.rgb[i + 2]]
}

fn distinct_colours(rgb: &[u8]) -> BTreeSet<[u8; 3]> {
    rgb.as_chunks::<3>()
        .0
        .iter()
        .map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect()
}

fn colours(list: &[[u8; 3]]) -> BTreeSet<[u8; 3]> {
    list.iter().copied().collect()
}

/// 1 where a pixel belongs to the model, 0 where it is untouched background.
fn silhouette(image: &RenderedImage) -> Vec<u8> {
    let width = image.width as usize;
    (0..width * image.height as usize)
        .map(|i| u8::from(at(image, i % width, i / width) != BACKGROUND))
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct Bounds {
    min_x: usize,
    max_x: usize,
    min_y: usize,
    max_y: usize,
}

fn silhouette_bounds(image: &RenderedImage) -> Option<Bounds> {
    let mask = silhouette(image);
    let width = image.width as usize;
    let mut bounds: Option<Bounds> = None;
    for y in 0..image.height as usize {
        for x in 0..width {
            if mask[y * width + x] == 0 {
                continue;
            }
            let b = bounds.get_or_insert(Bounds {
                min_x: x,
                max_x: x,
                min_y: y,
                max_y: y,
            });
            b.min_x = b.min_x.min(x);
            b.max_x = b.max_x.max(x);
            b.min_y = b.min_y.min(y);
            b.max_y = b.max_y.max(y);
        }
    }
    bounds
}

/// The model colours present in one row: a row is usually one face at the extremes.
fn model_colours_in_row(image: &RenderedImage, y: usize) -> BTreeSet<[u8; 3]> {
    (0..image.width as usize)
        .map(|x| at(image, x, y))
        .filter(|colour| *colour != BACKGROUND)
        .collect()
}

#[test]
fn render_mesh_produces_a_square_rgb_buffer_of_the_default_256px_size() {
    let image = render(&cube_mesh());
    assert_eq!(DEFAULT_SIZE, 256);
    assert_eq!((image.width, image.height), (256, 256));
    // Exactly what encode_png demands; a byte more or less and the PNG is unencodable.
    assert_eq!(image.rgb.len(), 256 * 256 * 3);
}

#[test]
fn the_camera_literals_encode_the_constants_they_document_and_are_orthonormal() {
    // The nine numbers are literals so no transcendental function runs in the render path.
    // Nothing else in this suite can catch a mistyped digit: an error in the eighth decimal shifts
    // a 256px render by about two hundred-thousandths of a pixel. When this fails it prints the
    // replacements, so retuning the camera is: edit the two angles, run the tests, paste what they
    // say.
    let azimuth = AZIMUTH_DEGREES.to_radians();
    let elevation = ELEVATION_DEGREES.to_radians();
    let (sin_a, cos_a) = azimuth.sin_cos();
    let (sin_e, cos_e) = elevation.sin_cos();
    let right = [-sin_a, cos_a, 0.0];
    let up = [-sin_e * cos_a, -sin_e * sin_a, cos_e];
    let view = [cos_e * cos_a, cos_e * sin_a, sin_e];

    let names = ["RIGHT", "UP", "VIEW"];
    let expected = [right, up, view];
    let actual = [CAMERA_BASIS.right, CAMERA_BASIS.up, CAMERA_BASIS.view];
    let mut stale = Vec::new();
    for v in 0..3 {
        for i in 0..3 {
            // Close, not equal: asserting equality would re-promise the libm determinism the
            // literals exist to avoid depending on. 1e-12 still catches any transcription mistake.
            if (actual[v][i] - expected[v][i]).abs() < 1e-12 {
                continue;
            }
            stale.push(format!(
                "const {}_{}: f64 = {:?};",
                names[v],
                ["X", "Y", "Z"][i],
                expected[v][i]
            ));
        }
    }
    assert!(
        stale.is_empty(),
        "camera literals are stale, replace with:\n{}",
        stale.join("\n")
    );

    // Orthonormal and right-handed: what the projection and the derived pixel area both assume.
    // Tighter than the 1e-12 above because this is arithmetic on the literals themselves, not a
    // comparison against libm, but not exact, because at a general azimuth the residuals are a
    // couple of ulp.
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let basis = CAMERA_BASIS;
    for (axis, vector) in [
        ("right", basis.right),
        ("up", basis.up),
        ("view", basis.view),
    ] {
        assert!(
            (dot(vector, vector) - 1.0).abs() < 1e-15,
            "{axis} is not a unit vector"
        );
    }
    assert!(
        dot(basis.right, basis.up).abs() < 1e-15,
        "right and up are not perpendicular"
    );
    assert!(
        dot(basis.right, basis.view).abs() < 1e-15,
        "right and view are not perpendicular"
    );
    assert!(
        dot(basis.up, basis.view).abs() < 1e-15,
        "up and view are not perpendicular"
    );
    let cross = [
        basis.right[1] * basis.up[2] - basis.right[2] * basis.up[1],
        basis.right[2] * basis.up[0] - basis.right[0] * basis.up[2],
        basis.right[0] * basis.up[1] - basis.right[1] * basis.up[0],
    ];
    for (i, component) in cross.iter().enumerate() {
        assert!(
            (component - basis.view[i]).abs() < 1e-15,
            "right x up is not view at {i}"
        );
    }
}

#[test]
fn render_mesh_honours_an_explicit_size() {
    let image = render_mesh_sized(&cube_mesh(), 64).unwrap();
    assert_eq!((image.width, image.height), (64, 64));
    assert_eq!(image.rgb.len(), 64 * 64 * 3);
}

#[test]
fn a_cube_renders_as_exactly_three_face_shades_over_one_background_colour() {
    let image = render(&cube_mesh());
    assert_eq!(
        distinct_colours(&image.rgb),
        colours(&[BACKGROUND, RIGHT, FRONT, TOP])
    );
}

#[test]
fn the_cube_face_shades_land_on_the_right_faces_so_the_render_is_not_flipped_or_unlit() {
    let image = render(&cube_mesh());
    // Three points well inside the three visible faces of the fitted cube: the top face, and the
    // lower-left and lower-right ones.
    assert_eq!(at(&image, 128, 70), TOP);
    assert_eq!(at(&image, 70, 170), FRONT);
    assert_eq!(at(&image, 180, 170), RIGHT);
    // Three *different* tones at those three points, which is what makes the cube read as a cube.
    // Asserted over the sampled pixels, not over the literals above, so the check depends on the
    // render.
    assert_eq!(
        colours(&[
            at(&image, 128, 70),
            at(&image, 70, 170),
            at(&image, 180, 170)
        ])
        .len(),
        3
    );
    // And the brightest of the three really is the one on top: a vertically mirrored render would
    // put a side shade in the topmost row and the top shade in the bottom one.
    let bounds = silhouette_bounds(&image).unwrap();
    assert_eq!(model_colours_in_row(&image, bounds.min_y), colours(&[TOP]));
    assert_ne!(model_colours_in_row(&image, bounds.max_y), colours(&[TOP]));
}

#[test]
fn the_light_points_where_it_is_documented_to_point_in_all_three_axes() {
    // The cube tests cannot see this. `abs(dot(normal, light))` erases the sign, and a cube's
    // faces come in opposite pairs, so negating any single light component leaves an axis-aligned
    // box pixel-for-pixel identical. Negating one genuinely changes every curved or oblique model
    // in the library, so the signs need a mesh whose normals are not symmetric about the light.
    //
    // The tetrahedron is that mesh: none of its four faces opposes another. Its face tones depend
    // only on the fixed world normals and the fixed world light, not on the camera, so these are
    // golden values rather than anything derived from the rasterizer's own light vector. Negating
    // LIGHT_X gives (121,74,32), LIGHT_Y (96,59,26) and (81,50,22), LIGHT_Z (180,111,48): each
    // set differs from this one.
    let shades = distinct_colours(&render(&tetrahedron_mesh()).rgb);
    assert_eq!(shades, colours(&[BACKGROUND, [201, 124, 54], [89, 55, 24]]));
}

#[test]
fn the_cube_silhouette_has_the_point_symmetry_the_mesh_has() {
    // The cube is invariant under p -> -p, and projection is linear, so its projected outline must
    // be invariant under a 180 degree rotation about the frame centre. This holds for *any* camera
    // basis, unlike a left-right mirror, which was only available while the camera sat on an exact
    // diagonal, so it survives a change of view direction. An off-centre fit or a non-uniform
    // scale breaks it.
    let image = render(&cube_mesh());
    let mask = silhouette(&image);
    let last = DEFAULT_SIZE - 1;
    let width = image.width as usize;
    let mut mismatches = 0;
    for y in 0..image.height as usize {
        for x in 0..width {
            if mask[y * width + x] != mask[(last - y) * width + (last - x)] {
                mismatches += 1;
            }
        }
    }
    assert_eq!(mismatches, 0);
}

#[test]
fn a_box_rotated_45_degrees_about_z_still_reads_as_a_box() {
    // The orientation an exact isometric camera cannot draw: both side normals would be
    // perpendicular to a (1,-1,1) view direction and the box would flatten into a two-tone
    // rectangle. Rotating a part 45 degrees to fit the bed is routine, so the camera's azimuth
    // offset exists for this case. Three distinct model tones means three faces survived.
    let image = render(&rotated_box_mesh(45.0));
    let mut shades = distinct_colours(&image.rgb);
    shades.remove(&BACKGROUND);
    assert_eq!(
        shades.len(),
        3,
        "expected three visible faces, got {shades:?}"
    );
}

#[test]
fn the_fitted_mesh_fills_the_frame_minus_the_6_percent_margin() {
    // A sphere is the honest test of the fit: its projected outline is a circle inscribed in the
    // projected bounding box, so fitting the box corners instead of the vertices would leave it
    // visibly short of the frame.
    let image = render(&sphere_mesh(64, 32));
    let bounds = silhouette_bounds(&image).unwrap();
    let span = 256.0 * (1.0 - 2.0 * 0.06);
    let horizontal = (bounds.max_x - bounds.min_x + 1) as f64;
    let vertical = (bounds.max_y - bounds.min_y + 1) as f64;
    assert!(
        (horizontal - span).abs() <= 2.0,
        "horizontal span {horizontal} is not within 2px of {span}"
    );
    assert!(
        (vertical - span).abs() <= 2.0,
        "vertical span {vertical} is not within 2px of {span}"
    );
    // Centred: the margin is the same on opposite sides.
    assert_eq!(bounds.min_x, DEFAULT_SIZE - 1 - bounds.max_x);
    assert_eq!(bounds.min_y, DEFAULT_SIZE - 1 - bounds.max_y);
}

#[test]
fn a_sphere_fills_its_bounding_box_like_a_round_outline_not_a_polygon() {
    // What this measures is *shape*, not scale. Filled area over bounding-box area is pi/4 for any
    // ellipse, so this cannot see anisotropy (anisotropic scale is covered by the fit test above,
    // which asserts both spans against the same number). What it does catch is an outline that
    // stops being round: a hexagon, a diamond, a silhouette torn by a coverage bug. The UV
    // tessellation costs about 0.8% of the ideal pi/4.
    let image = render(&sphere_mesh(64, 32));
    let bounds = silhouette_bounds(&image).unwrap();
    let area = ((bounds.max_x - bounds.min_x + 1) * (bounds.max_y - bounds.min_y + 1)) as f64;
    let filled: usize = silhouette(&image).iter().map(|on| usize::from(*on)).sum();
    let ratio = filled as f64 / area;
    assert!(
        (ratio - std::f64::consts::FRAC_PI_4).abs() < 0.02,
        "filled/bounding-box ratio {ratio} is not a disc's {}",
        std::f64::consts::FRAC_PI_4
    );
}

#[test]
fn nothing_is_drawn_outside_the_frame() {
    for mesh in [cube_mesh(), tetrahedron_mesh(), sphere_mesh(32, 16)] {
        let image = render(&mesh);
        let last = DEFAULT_SIZE - 1;
        for i in 0..DEFAULT_SIZE {
            assert_eq!(at(&image, i, 0), BACKGROUND);
            assert_eq!(at(&image, i, last), BACKGROUND);
            assert_eq!(at(&image, 0, i), BACKGROUND);
            assert_eq!(at(&image, last, i), BACKGROUND);
        }
    }
}

#[test]
fn the_depth_buffer_not_triangle_order_decides_which_surface_is_visible() {
    // Two overlapping triangles with different normals; the second is nearer the camera. An
    // implementation that simply painted in array order would render the two orderings
    // differently.
    let far = [-1.0, -1.0, 0.0, 1.2, -1.0, 0.0, 0.0, 1.2, 0.0];
    let near = [-1.0, -1.0, 1.0, 1.2, -1.0, 1.0, 0.0, 1.2, 2.0];
    let far_first = render_mesh_sized(&mesh(&[far, near].concat()), 64).unwrap();
    let near_first = render_mesh_sized(&mesh(&[near, far].concat()), 64).unwrap();
    // Both triangles are visible somewhere, so the test would still have teeth if one of them
    // happened to be hidden entirely.
    assert_eq!(distinct_colours(&far_first.rgb).len(), 3);
    assert_same_bytes(&far_first.rgb, &near_first.rgb, "far-first vs near-first");

    // Order-independence alone does not pin the *direction*: a depth test with the sign inverted,
    // where the far surface wins, is equally order-independent. So name the winner. Flat shading
    // makes a face's colour a property of its normal alone, independent of the fit, which is what
    // lets a solo render supply the expected value.
    let near_colour = at(&render_mesh_sized(&mesh(&near), 64).unwrap(), 32, 32);
    let far_colour = at(&render_mesh_sized(&mesh(&far), 64).unwrap(), 32, 32);
    assert_ne!(near_colour, far_colour);
    // (42, 42) sits inside both outlines: at that row the far triangle spans x 28..49 and the near
    // one covers 40..47, so whichever surface the depth test prefers is what shows here.
    assert_eq!(at(&far_first, 42, 42), near_colour);
    assert_eq!(at(&near_first, 42, 42), near_colour);
}

fn worst_channel_difference(a: &RenderedImage, b: &RenderedImage) -> u8 {
    a.rgb
        .iter()
        .zip(&b.rgb)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

#[test]
fn a_cube_renders_the_same_at_1x_and_at_1000x_its_size() {
    // Not asserted byte-identical: normalising a bounding box measured from floats a thousand
    // times larger can leave a shade one step apart. The silhouette must match exactly, and no
    // channel may differ by more than a single level.
    let small = render(&cube_mesh());
    let large = render(&scale_mesh(&cube_mesh(), 1000.0));
    assert_same_bytes(
        &silhouette(&small),
        &silhouette(&large),
        "silhouette at 1x vs 1000x",
    );
    let worst = worst_channel_difference(&small, &large);
    assert!(worst <= 1, "channels differ by up to {worst}");
}

#[test]
fn a_cube_renders_the_same_at_1x_and_at_1_500th_its_size() {
    let small = render(&scale_mesh(&cube_mesh(), 0.002));
    let plain = render(&cube_mesh());
    assert_same_bytes(
        &silhouette(&small),
        &silhouette(&plain),
        "silhouette at 1/500x vs 1x",
    );
    let worst = worst_channel_difference(&plain, &small);
    assert!(worst <= 1, "channels differ by up to {worst}");
}

#[test]
fn render_mesh_is_byte_identical_across_two_runs_in_the_same_process() {
    assert_same_bytes(
        &render(&sphere_mesh(32, 16)).rgb,
        &render(&sphere_mesh(32, 16)).rgb,
        "sphere twice",
    );
    assert_same_bytes(
        &render(&cube_mesh()).rgb,
        &render(&cube_mesh()).rgb,
        "cube twice",
    );
}

#[test]
fn a_degenerate_triangle_alongside_real_geometry_changes_nothing() {
    // It must be skipped, not divided by: a zero-length normal would otherwise smear NaN through
    // the shading, and NaN written into a byte silently becomes 0.
    //
    // Both fixtures, because they are rejected by different halves of the drawability test. The
    // first one's projection cancels to an area of exactly zero, so the edge-on half also catches
    // it; the second one's does not, so only the zero-normal half stands between it and the frame.
    let plain = render(&cube_mesh()).rgb;
    for spoiler in [degenerate_triangle_mesh(), far_degenerate_triangle_mesh()] {
        let image = render(&concat_meshes(&cube_mesh(), &spoiler));
        assert_same_bytes(&image.rgb, &plain, "cube plus a degenerate triangle");
        assert_eq!(
            distinct_colours(&image.rgb),
            colours(&[BACKGROUND, RIGHT, FRONT, TOP])
        );
    }
}

#[test]
fn a_mesh_whose_triangles_are_all_degenerate_is_a_validation_error_not_a_blank_tile() {
    // The message matters, not just the code: an all-degenerate mesh leaves the bounding box
    // untouched, so without its own guard it would fail *by accident* on the infinite extent that
    // follows, and this test could not tell the two apart.
    let no_area = "covers any area in this view";
    assert_validation_saying(render_mesh(&degenerate_triangle_mesh()), no_area);
    assert_validation_saying(render_mesh(&far_degenerate_triangle_mesh()), no_area);
    // Every vertex at one point.
    assert_validation_saying(
        render_mesh(&mesh(&[1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 1.0, 2.0, 3.0])),
        no_area,
    );
    // Collinear along (1,-1,1). That was the view direction back when the camera was an exact
    // isometric, so this projected to a single point; at 32 degrees off the front it is 10.6
    // degrees away from VIEW and projects to a short line instead. It is still rejected, and
    // still for the right reason (three collinear vertices have no normal), so the fixture stays
    // as a plain collinear case rather than being re-aimed at a view direction that will move
    // again.
    assert_validation_saying(
        render_mesh(&mesh(&[0.0, 0.0, 0.0, 1.0, -1.0, 1.0, 2.0, -2.0, 2.0])),
        no_area,
    );
}

#[test]
fn geometry_too_thin_to_reach_a_sample_point_is_a_validation_error_not_a_blank_tile() {
    // Every triangle here has a normal and a non-zero projected area, so it passes every
    // drawability test the rasterizer applies, and still paints nothing, because once the fit
    // stretches the long axis across the frame the short one is a fraction of a pixel wide and
    // slips between the sample points. Counting attempts instead of writes misses this entirely
    // and hands back an all-background tile as if it had worked.
    assert_validation_saying(
        render_mesh(&thin_plate_mesh(100_000.0)),
        "rendered no pixels",
    );
    // A plate only a hundred times longer than it is wide still draws, so the guard is not simply
    // rejecting anything thin.
    assert!(distinct_colours(&render(&thin_plate_mesh(100.0)).rgb).len() > 1);
}

#[test]
fn non_finite_coordinates_are_a_validation_error_rather_than_a_blank_tile() {
    // The parsers reject these before the rasterizer sees them, but `render_mesh` is callable
    // without one, and NaN would otherwise flow through the fit and return an empty image.
    let non_finite = "non-finite vertex coordinate";
    assert_validation_saying(
        render_mesh(&mesh(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, f64::NAN, 0.0])),
        non_finite,
    );
    assert_validation_saying(
        render_mesh(&mesh(&[
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            f64::INFINITY,
            0.0,
        ])),
        non_finite,
    );
}

#[test]
fn a_degenerate_triangle_reaching_past_the_model_does_not_shrink_the_fit() {
    // The whole reason the fitting pass skips undrawable triangles. These collinear ones run out
    // to (1,1,1) and to 13.5 while the cube spans +-0.5, so framing to every vertex would size the
    // frame around geometry that draws nothing: the far one would shrink the cube to a speck a
    // twentieth of its proper size.
    let expected = silhouette_bounds(&render(&cube_mesh()));
    for spoiler in [degenerate_triangle_mesh(), far_degenerate_triangle_mesh()] {
        let stretched = concat_meshes(&cube_mesh(), &spoiler);
        assert_eq!(silhouette_bounds(&render(&stretched)), expected);
    }
}

#[test]
fn an_empty_or_inconsistent_mesh_is_a_validation_error() {
    // Again message-specific: an empty mesh would otherwise fall through to the "no triangle with
    // any area" guard, and an over-long triangle count to the non-finite guard (reading past the
    // end of the array would be out of range). Both are the wrong diagnosis for the caller.
    assert_validation_saying(
        render_mesh(&Mesh {
            positions: Vec::new(),
            triangle_count: 0,
        }),
        "no triangles",
    );
    assert_validation_saying(
        render_mesh(&Mesh {
            positions: vec![0.0; 9],
            triangle_count: 2,
        }),
        "does not match triangleCount * 9",
    );
    assert_validation_saying(
        render_mesh(&Mesh {
            positions: vec![0.0; 18],
            triangle_count: 1,
        }),
        "does not match triangleCount * 9",
    );
}

#[test]
fn a_nonsensical_size_is_a_validation_error() {
    let cube = cube_mesh();
    for size in [0, 100_000] {
        let (code, _) = failure(render_mesh_sized(&cube, size));
        assert_eq!(code, AppErrorCode::Validation, "size {size} was accepted");
    }
}

#[test]
fn a_mesh_in_the_size_class_of_the_real_library_renders_without_blowing_up() {
    // 600k triangles is a big model, not the biggest: the reference library's largest is
    // Baby Groot/Body_high_detail.stl at 3,295,832 triangles, 26 models are over 600k and 16 are
    // over 1M. 600k is used here because it renders quickly, and what is being tested is that
    // memory stays bounded (nothing per-triangle is retained) and the result is still a valid
    // tile.
    let image = render(&many_triangles_mesh(600_000));
    assert_eq!(image.rgb.len(), 256 * 256 * 3);
    assert!(
        distinct_colours(&image.rgb).len() > 1,
        "the large mesh rendered a blank tile"
    );
}
