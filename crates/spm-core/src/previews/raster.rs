//! A software rasterizer: fixed three-quarter camera, z-buffer, flat shading, one light.
//!
//! Pure arithmetic over the input in triangle order: no clock, no randomness, no iteration over an
//! unordered collection, no transcendental function in the render path. Positions are `f32` and
//! every operation after the load is `f64`, which is the arithmetic the legacy renderer ran
//! (JavaScript numbers over a `Float32Array`), so the bytes it produces are the same bytes.

use serde_json::{Map, Value};

use super::mesh::Mesh;
use crate::error::{AppError, Result};

/// Spec section 7.2: preview tiles are square 256px thumbnails in the projects grid.
pub const DEFAULT_SIZE: usize = 256;

/// An upper bound on `size`, not a product requirement.
///
/// The frame buffers are the only allocation that scales with it (`size² * 3` bytes of RGB plus
/// `size² * 4` bytes of depth), so 4096 caps a single render at ~118 MB. Anything larger is a
/// caller mistake worth failing loudly on rather than an out-of-memory in the preview worker.
const MAX_SIZE: usize = 4096;

/// Fraction of the frame left blank on each side, so tiles do not touch their grid cell.
const MARGIN_FRACTION: f64 = 0.06;

// --- Camera ------------------------------------------------------------------------------
//
// A fixed three-quarter view: world +Z is up, the camera sits at the isometric elevation
// (atan(1/sqrt 2), about 35.26 degrees above the ground plane) and 32 degrees round from the
// model's front. Z-up matches how slicers and printers treat a model (the bed is the XY plane), so
// the three visible faces of a box are its top, its front and its right.
//
// 32 degrees rather than a perfectly diagonal 45. Exact isometric looks down (1,-1,1), and any
// face whose normal is perpendicular to that, i.e. every 45 degree wall or chamfer, projects to a
// line and vanishes; a box rotated 45 degrees to fit the plate is a routine orientation, and under
// an exact isometric it collapses into a flat two-tone rectangle. Of 45, 57 and 32 the user picked
// 32 from renders: it weights the view towards the front face, which is the one models usually
// carry their detail on.
//
// That is a trade, not a fix. Every fixed camera flattens *some* one-parameter family of
// orientations, and moving the camera only moves the family. At this azimuth the flattened family
// is a box rotated **32 degrees** about Z: measured as the third face's share of the visible area,
// 45 degrees is healthy at 11.8% and 60 at 22.8%, but 30 gives 2.0%, 31 gives 1.0% and 32 gives
// 0.0%, a full collapse, with anything inside roughly 32 +- 0.6 degrees reading as flat. That is a
// known and accepted cost of the chosen view.
//
// Retuning: edit the two angle constants, run the camera test, and paste the nine literals it
// prints. Two other tests are anchored to *this* camera and fail after an otherwise correct retune
// at roughly half the angles tried (`the depth buffer, not triangle order, decides which surface
// is visible` names the pixel (42,42), and `geometry too thin to reach a sample point` depends on
// where the sample grid falls across a sliver): re-anchor those from the renders; do not weaken
// them. The light below is fixed in *world* space and the palette's tone separation was tuned
// against this azimuth, so changing it shifts the relationships between the face tones as well as
// the geometry, and the tests will still pass. Look at the renders.

/// Camera azimuth in degrees, measured from +X. -58 is 32 degrees round from the model's front.
pub const AZIMUTH_DEGREES: f64 = -58.0;

/// Camera elevation in degrees above the bed. atan(1/sqrt 2), the isometric elevation.
pub const ELEVATION_DEGREES: f64 = 35.264_389_682_754_65;

// The basis, written out as literals so that no transcendental function runs in the render path
// at all. IEEE 754 pins `sqrt` to a correctly rounded result everywhere, but says nothing about
// `cos` and `sin`: they are implementation-defined to the last bit, so deriving these at run time
// would make "the same mesh renders the same bytes on every machine" true by coincidence rather
// than by construction. Every value is the shortest decimal that round-trips to exactly the
// double its expression produces on the legacy engine, so this is a substitution, not an
// approximation. The camera test regenerates and checks all nine.
//
// RIGHT maps to +X on screen, UP to +Y on screen (flipped when writing rows, which run
// downwards), and VIEW points from the model towards the camera, so a larger dot product is
// nearer. RIGHT x UP = VIEW: right-handed.
const RIGHT_X: f64 = 0.848_048_096_156_426_1;
const RIGHT_Y: f64 = 0.529_919_264_233_204_9;
const RIGHT_Z: f64 = 0.0;

const UP_X: f64 = -0.305_949_029_853_809_2;
const UP_Y: f64 = 0.489_620_796_601_662_1;
const UP_Z: f64 = 0.816_496_580_927_726_1;

const VIEW_X: f64 = 0.432_677_267_414_148_1;
const VIEW_Y: f64 = -0.692_428_370_973_989_5;
const VIEW_Z: f64 = 0.577_350_269_189_625_6;

/// The camera basis, exposed so a test can check the literals against the two angles above.
///
/// Worth exposing because nothing else can catch a mistyped digit: a wrong digit in the eighth
/// place moves a 256px render by two hundred-thousandths of a pixel, which no rendering test will
/// ever see.
#[derive(Debug, Clone, Copy)]
pub struct CameraBasis {
    pub right: [f64; 3],
    pub up: [f64; 3],
    pub view: [f64; 3],
}

pub const CAMERA_BASIS: CameraBasis = CameraBasis {
    right: [RIGHT_X, RIGHT_Y, RIGHT_Z],
    up: [UP_X, UP_Y, UP_Z],
    view: [VIEW_X, VIEW_Y, VIEW_Z],
};

// --- Light and palette -------------------------------------------------------------------
//
// One directional light, fixed in world space, coming from above and from the viewer's
// front-left. Its three components are deliberately well separated (0.30 / 0.55 / 0.78) because a
// tile is read at a glance: the three faces of an axis-aligned box must land on three obviously
// different tones, which is what tells the eye it is looking at a box and not a hexagon.
//
// World space, not the camera frame: printed models sit axis-aligned on a bed, so pinning the
// light to the world axes is what guarantees a box's top, front and right never converge.

fn light() -> (f64, f64, f64) {
    let length = (0.3f64 * 0.3 + 0.55 * 0.55 + 0.78 * 0.78).sqrt();
    (-0.3 / length, -0.55 / length, 0.78 / length)
}

/// Floor on the shading term.
///
/// Set high (0.28) so a face turned away from the light still separates from the background,
/// because at 256px in a grid the silhouette carries more information than the shading does. What
/// the eye picks up is *hue* rather than lightness: warm brown against cool slate. It works
/// against this dark background; it would need raising to about 0.35 if the grid is ever
/// lightened.
const AMBIENT: f64 = 0.28;

/// Filament amber; light enough at full shade to stay legible against the background.
const BASE: [f64; 3] = [224.0, 138.0, 60.0];

/// Flat dark slate. Opaque, since the PNG encoder writes truecolour with no alpha channel.
const BACKGROUND: [u8; 3] = [31, 35, 42];

// --- Per-triangle scratch -----------------------------------------------------------------

/// One triangle projected into the camera's screen plane, with its face normal.
///
/// [`prepare_triangle`] is the single definition of what one triangle is and whether it can put
/// ink on the canvas. Both passes over the mesh call it with the same operands, so they cannot
/// disagree about which triangles exist: the fit is never sized for geometry the fill then
/// declines to draw.
struct Prepared {
    normal: [f64; 3],
    normal_length: f64,
    /// Screen x, screen y and depth of each vertex. Unscaled: the fit has not happened yet when
    /// pass one calls this.
    screen: [[f64; 3]; 3],
    screen_area: f64,
}

/// Projects one triangle and reports whether it is drawable.
///
/// Drawable means two independent things, both exact-zero tests rather than tolerances ("nearly
/// degenerate" is a threshold nobody can defend):
///
/// - a non-zero face normal. Zero means three collinear or coincident vertices: no area, no
///   meaningful normal, and dividing by it would smear NaN across both buffers.
/// - a non-zero *screen* area. Zero means the triangle is exactly edge-on, its plane holding the
///   view direction, so it projects to a line and covers nothing.
///
/// Neither test can change a rendered pixel, and both stay anyway: the zero-normal test because
/// without it a degenerate triangle shades to NaN (it can never paint, but it would steer the
/// fit), the zero-area test because it guards the division below and is why the fit and the fill
/// cannot frame for different geometry.
fn prepare_triangle(positions: &[f32], offset: usize) -> Option<Prepared> {
    let p = |i: usize| f64::from(positions[offset + i]);
    let (ax, ay, az) = (p(0), p(1), p(2));
    let (bx, by, bz) = (p(3), p(4), p(5));
    let (cx, cy, cz) = (p(6), p(7), p(8));

    let (e1x, e1y, e1z) = (bx - ax, by - ay, bz - az);
    let (e2x, e2y, e2z) = (cx - ax, cy - ay, cz - az);
    let normal_x = e1y * e2z - e1z * e2y;
    let normal_y = e1z * e2x - e1x * e2z;
    let normal_z = e1x * e2y - e1y * e2x;
    let normal_length = (normal_x * normal_x + normal_y * normal_y + normal_z * normal_z).sqrt();

    let project = |x: f64, y: f64, z: f64| {
        [
            x * RIGHT_X + y * RIGHT_Y + z * RIGHT_Z,
            x * UP_X + y * UP_Y + z * UP_Z,
            x * VIEW_X + y * VIEW_Y + z * VIEW_Z,
        ]
    };
    let screen = [
        project(ax, ay, az),
        project(bx, by, bz),
        project(cx, cy, cz),
    ];
    let screen_area = (screen[1][0] - screen[0][0]) * (screen[2][1] - screen[0][1])
        - (screen[1][1] - screen[0][1]) * (screen[2][0] - screen[0][0]);

    // NaN compares unequal to zero, so a triangle with a NaN coordinate is "drawable" here and
    // is caught by the finite check in the fit.
    if normal_length != 0.0 && screen_area != 0.0 {
        Some(Prepared {
            normal: [normal_x, normal_y, normal_z],
            normal_length,
            screen,
            screen_area,
        })
    } else {
        None
    }
}

/// A rendered tile: `width * height * 3` bytes, row-major, three bytes per pixel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedImage {
    pub rgb: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn invalid(message: &str, details: &[(&str, Value)]) -> AppError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert((*key).to_owned(), value.clone());
    }
    AppError::validation(message).with_details(map)
}

/// [`render_mesh_sized`] at [`DEFAULT_SIZE`].
pub fn render_mesh(mesh: &Mesh) -> Result<RenderedImage> {
    render_mesh_sized(mesh, DEFAULT_SIZE)
}

/// Renders a mesh to a square RGB tile with a fixed three-quarter camera and flat shading.
///
/// This function does not encode; the caller does.
///
/// Shading uses `abs(dot(normal, light))`, so winding order is irrelevant: STLs in the wild are
/// routinely inconsistent about it, and a signed dot would render half of such a model black.
/// There is no back-face culling for the same reason: the depth buffer already resolves which
/// surface is visible, and culling on an untrustworthy winding would punch holes in the
/// silhouette.
///
/// Never returns a blank tile. Anything that would produce one (no triangles, no drawable
/// triangle, geometry too thin to reach a single sample point) is a `Validation` error, because
/// the preview queue can record an error but cannot tell an empty image from a good one.
pub fn render_mesh_sized(mesh: &Mesh, size: usize) -> Result<RenderedImage> {
    if !(1..=MAX_SIZE).contains(&size) {
        return Err(invalid(
            &format!("preview size must be an integer in 1..{MAX_SIZE}"),
            &[("size", Value::from(size as u64))],
        ));
    }

    let positions = mesh.positions.as_slice();
    let triangle_count = mesh.triangle_count;
    if triangle_count < 1 {
        return Err(invalid(
            "cannot render a mesh with no triangles",
            &[("triangleCount", Value::from(triangle_count as u64))],
        ));
    }
    if positions.len() != triangle_count.saturating_mul(9) {
        return Err(invalid(
            "mesh positions length does not match triangleCount * 9",
            &[
                ("triangleCount", Value::from(triangle_count as u64)),
                ("length", Value::from(positions.len() as u64)),
            ],
        ));
    }

    // Pass one: the projected bounding box of every drawable triangle.
    //
    // Measured from vertices, not from the eight corners of the world-space box: projecting the
    // box only bounds the mesh from outside, so a sphere inside its own bounding box would render
    // noticeably short of the frame it was meant to fill. Restricted to drawable triangles
    // because framing for something invisible is indefensible: one stray degenerate or edge-on
    // triangle reaching past the model would otherwise shrink the whole render to a speck.
    //
    // Known boundary, deliberately not chased: *drawable* is not the same question as *paints*.
    // A triangle with a real normal and a real projected area still contributes nothing if it is
    // thinner than the sample grid, and it steers the fit anyway. Closing it would mean fitting
    // to coverage, which needs the scale the fit is trying to compute. The blank-tile guard still
    // catches the case where *nothing* paints.
    let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut min_depth = f64::INFINITY;
    let mut drawable = 0usize;
    for t in 0..triangle_count {
        let Some(triangle) = prepare_triangle(positions, t * 9) else {
            continue;
        };
        if !triangle.normal_length.is_finite() {
            // Any NaN or infinite coordinate poisons at least two of the three cross-product
            // terms, so one check per triangle catches all of them, and it has to be a check:
            // `x < min` is false for NaN, so bad vertices would otherwise slip past the bounds
            // untouched and the render would come back blank rather than failing.
            return Err(invalid(
                "mesh contains a non-finite vertex coordinate",
                &[("triangleIndex", Value::from(t as u64))],
            ));
        }
        drawable += 1;
        for vertex in &triangle.screen {
            min_x = min_x.min(vertex[0]);
            max_x = max_x.max(vertex[0]);
            min_y = min_y.min(vertex[1]);
            max_y = max_y.max(vertex[1]);
            min_depth = min_depth.min(vertex[2]);
        }
    }

    if drawable == 0 {
        // Checked before the extent, so that a mesh of nothing but degenerate or edge-on
        // triangles reports what is actually wrong with it instead of tripping over the untouched
        // infinite bounds below.
        return Err(invalid(
            "mesh has no triangle that covers any area in this view",
            &[("triangleCount", Value::from(triangle_count as u64))],
        ));
    }

    let extent_x = max_x - min_x;
    let extent_y = max_y - min_y;
    let extent = if extent_x > extent_y {
        extent_x
    } else {
        extent_y
    };
    if extent.is_nan() || extent <= 0.0 {
        // A backstop, not a case anyone has produced: a drawable triangle has non-zero screen
        // area, which forces a non-zero extent on both axes. It stays because the alternative
        // failure is silent: dividing by zero here scales every vertex to NaN and the caller gets
        // a plausible-looking blank tile instead of an error.
        return Err(invalid(
            "mesh has zero extent in the projected view",
            &[("triangleCount", Value::from(triangle_count as u64))],
        ));
    }

    let size_f = size as f64;
    // The larger projected axis fills the frame minus the margin; the shorter one is centred.
    let scale = (size_f * (1.0 - 2.0 * MARGIN_FRACTION)) / extent;
    let centre_x = (min_x + max_x) / 2.0;
    let centre_y = (min_y + max_y) / 2.0;
    let half = size_f / 2.0;
    let (light_x, light_y, light_z) = light();

    let mut rgb = vec![0u8; size * size * 3];
    for pixel in rgb.as_chunks_mut::<3>().0 {
        *pixel = BACKGROUND;
    }
    // `f32`, as the legacy depth buffer was: the comparison below is a double against a float's
    // value, and storing at full width would change which of two nearly coplanar surfaces wins.
    let mut depth_buffer = vec![f32::NEG_INFINITY; size * size];

    // Everything from here to the end of the loop is scalar locals: with meshes of ~600k
    // triangles, one allocation per triangle is 600k allocations per thumbnail.
    let mut painted = 0usize;
    let last = size as i64 - 1;
    for t in 0..triangle_count {
        // Same call, same operands, same result as pass one: that identity is the whole reason
        // the fit and the fill cannot frame for different geometry.
        let Some(triangle) = prepare_triangle(positions, t * 9) else {
            continue;
        };

        // Clamped because rounding can push a unit dot product a hair past 1, and a shade above 1
        // would overflow a colour byte and wrap round to near-black.
        let mut lambert = (triangle.normal[0] * light_x
            + triangle.normal[1] * light_y
            + triangle.normal[2] * light_z)
            / triangle.normal_length;
        if lambert < 0.0 {
            lambert = -lambert;
        }
        if lambert > 1.0 {
            lambert = 1.0;
        }
        let shade = AMBIENT + (1.0 - AMBIENT) * lambert;
        let face = [
            (BASE[0] * shade).round() as u8,
            (BASE[1] * shade).round() as u8,
            (BASE[2] * shade).round() as u8,
        ];

        let [s0, s1, s2] = triangle.screen;
        let (p0x, p0y, p0z) = (
            (s0[0] - centre_x) * scale + half,
            half - (s0[1] - centre_y) * scale,
            (s0[2] - min_depth) * scale,
        );
        let (p1x, p1y, p1z) = (
            (s1[0] - centre_x) * scale + half,
            half - (s1[1] - centre_y) * scale,
            (s1[2] - min_depth) * scale,
        );
        let (p2x, p2y, p2z) = (
            (s2[0] - centre_x) * scale + half,
            half - (s2[1] - centre_y) * scale,
            (s2[2] - min_depth) * scale,
        );

        // Pixel space is the screen plane scaled by `scale` and flipped in Y, so its signed area
        // is `-scale²` times the screen area. Derived rather than recomputed from the pixel
        // coordinates: recomputing could round to zero for a triangle pass one accepted, and then
        // the fill would silently skip geometry the frame was sized around. Signed, so dividing
        // the edge functions by it normalises both windings to positive barycentrics and the
        // coverage test needs no per-triangle orientation branch.
        let area = -triangle.screen_area * scale * scale;
        let inv_area = 1.0 / area;

        let lo_x = p0x.min(p1x).min(p2x);
        let hi_x = p0x.max(p1x).max(p2x);
        let lo_y = p0y.min(p1y).min(p2y);
        let hi_y = p0y.max(p1y).max(p2y);

        // The fit already places every vertex inside the margin, so these clamps never fire in
        // practice. They stay because "never writes outside the frame" should hold even if a
        // future camera change makes the fit less than exact.
        let x0 = (lo_x.floor() as i64).max(0);
        let x1 = (hi_x.ceil() as i64).min(last);
        let y0 = (lo_y.floor() as i64).max(0);
        let y1 = (hi_y.ceil() as i64).min(last);

        for py in y0..=y1 {
            let sample_y = py as f64 + 0.5;
            let row_base = py as usize * size;
            for px in x0..=x1 {
                let sample_x = px as f64 + 0.5;
                let w0 = ((p1x - sample_x) * (p2y - sample_y)
                    - (p1y - sample_y) * (p2x - sample_x))
                    * inv_area;
                if w0 < 0.0 {
                    continue;
                }
                let w1 = ((p2x - sample_x) * (p0y - sample_y)
                    - (p2y - sample_y) * (p0x - sample_x))
                    * inv_area;
                if w1 < 0.0 {
                    continue;
                }
                let w2 = ((p0x - sample_x) * (p1y - sample_y)
                    - (p0y - sample_y) * (p1x - sample_x))
                    * inv_area;
                if w2 < 0.0 {
                    continue;
                }

                // Orthographic projection is affine, so depth interpolates linearly in screen
                // space: no perspective-correct division needed.
                let depth = w0 * p0z + w1 * p1z + w2 * p2z;
                let index = row_base + px as usize;
                if depth <= f64::from(depth_buffer[index]) {
                    continue;
                }
                depth_buffer[index] = depth as f32;
                let at = index * 3;
                rgb[at..at + 3].copy_from_slice(&face);
                painted += 1;
            }
        }
    }

    if painted == 0 {
        // Counted at the point of writing, not at the point of trying: a triangle can be drawable
        // and still miss every sample point. Anything whose projection is thinner than about a
        // thousandth of its length does exactly that: after the fit stretches the long axis to
        // 226px, the short one lands under a pixel and falls between the sample grid. Returning
        // the resulting all-background image would report a broken thumbnail as a working one.
        return Err(invalid(
            "mesh rendered no pixels: too thin to show at this size",
            &[
                ("triangleCount", Value::from(triangle_count as u64)),
                ("size", Value::from(size as u64)),
            ],
        ));
    }

    Ok(RenderedImage {
        rgb,
        width: size as u32,
        height: size as u32,
    })
}
