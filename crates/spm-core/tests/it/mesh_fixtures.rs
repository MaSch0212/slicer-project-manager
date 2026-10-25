//! Mesh, PNG and 3MF-with-geometry builders for the preview tests, ported from the legacy
//! `make-mesh.ts`, `make-png.ts` and the geometry half of `make-3mf.ts`.

#![allow(dead_code)]

use std::f64::consts::PI;
use std::io::Write;
use std::path::Path;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use spm_core::files::zip_write::crc32;
use spm_core::previews::Mesh;

use crate::fixtures::{deflated, slice_info, stored, write_zip};

/// Builds triangle soup from flat x,y,z triples, checking the count as it goes.
pub fn mesh(values: &[f64]) -> Mesh {
    assert_eq!(
        values.len() % 9,
        0,
        "mesh fixture needs 9 floats per triangle"
    );
    Mesh {
        positions: values.iter().map(|value| *value as f32).collect(),
        triangle_count: values.len() / 9,
    }
}

/// Serialises a mesh as a binary STL, so a test can put a real, parseable model file on disk.
///
/// Binary rather than ASCII because it is the encoding a file this size actually ships in, and
/// because its length is a function of the triangle count, which is what the parser keys its
/// format detection on: a fixture written this way exercises the same branch a real file does.
pub fn binary_stl(source: &Mesh) -> Vec<u8> {
    let mut out = vec![0u8; 84 + source.triangle_count * 50];
    out[80..84].copy_from_slice(&(source.triangle_count as u32).to_le_bytes());
    let mut offset = 84;
    for triangle in source.positions.as_chunks::<9>().0 {
        offset += 12; // facet normal left zero; the rasterizer recomputes shading from geometry
        for value in triangle {
            out[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            offset += 4;
        }
        offset += 2; // attribute byte count
    }
    out
}

/// Applies a uniform scale, for the "renders the same at any absolute size" tests.
pub fn scale_mesh(source: &Mesh, factor: f64) -> Mesh {
    Mesh {
        positions: source
            .positions
            .iter()
            .map(|value| (f64::from(*value) * factor) as f32)
            .collect(),
        triangle_count: source.triangle_count,
    }
}

/// Concatenates two meshes, so a test can splice an extra triangle into a known model.
pub fn concat_meshes(a: &Mesh, b: &Mesh) -> Mesh {
    Mesh {
        positions: [a.positions.as_slice(), b.positions.as_slice()].concat(),
        triangle_count: a.triangle_count + b.triangle_count,
    }
}

const CUBE_CORNERS: [[f64; 3]; 8] = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
];

// Two triangles per face, counter-clockwise seen from outside. The winding is consistent here only
// so the fixture is easy to reason about; the rasterizer must not depend on it.
const CUBE_FACES: [[usize; 4]; 6] = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [1, 2, 6, 5], // +X
    [3, 0, 4, 7], // -X
];

/// An axis-aligned unit cube centred on the origin: 12 triangles, 6 axis-aligned normals.
pub fn cube_mesh() -> Mesh {
    let mut values = Vec::new();
    for [a, b, c, d] in CUBE_FACES {
        for [i, j, k] in [[a, b, c], [a, c, d]] {
            values.extend(CUBE_CORNERS[i]);
            values.extend(CUBE_CORNERS[j]);
            values.extend(CUBE_CORNERS[k]);
        }
    }
    mesh(&values)
}

/// A tetrahedron standing on its base: four triangles, four distinct normals.
///
/// Deliberately *not* the version built on alternating cube corners. That one has a face normal of
/// exactly (1, -1, 1), which is the isometric camera's own view direction, so it renders as a flat
/// triangle: correct, but useless as a test of a three-dimensional shape.
pub fn tetrahedron_mesh() -> Mesh {
    let h = 3f64.sqrt() / 4.0; // half-height of an equilateral base of side 1
    let v = [
        [0.0, 2.0 * h, -0.3],
        [0.5, -h, -0.3],
        [-0.5, -h, -0.3],
        [0.0, 0.0, 0.5],
    ];
    let mut values = Vec::new();
    for [i, j, k] in [
        [0, 2, 1], // base
        [0, 1, 3],
        [1, 2, 3],
        [2, 0, 3],
    ] {
        values.extend(v[i]);
        values.extend(v[j]);
        values.extend(v[k]);
    }
    mesh(&values)
}

/// A UV sphere of unit radius: the smooth-ish model in the visual set.
///
/// Flat-shaded facets are the point: a sphere is where a broken normal or a light aimed from
/// inside the model shows up as banding rather than a smooth gradient.
pub fn sphere_mesh(segments: usize, rings: usize) -> Mesh {
    let at = |ring: usize, segment: usize| -> [f64; 3] {
        let theta = ring as f64 / rings as f64 * PI;
        let phi = segment as f64 / segments as f64 * 2.0 * PI;
        [
            theta.sin() * phi.cos(),
            theta.sin() * phi.sin(),
            theta.cos(),
        ]
    };
    let mut values = Vec::new();
    for ring in 0..rings {
        for segment in 0..segments {
            let a = at(ring, segment);
            let b = at(ring + 1, segment);
            let c = at(ring + 1, segment + 1);
            let d = at(ring, segment + 1);
            // The pole rings collapse to a point on one side, which would make one of the two
            // triangles degenerate; emit only the triangle that has area there.
            if ring > 0 {
                values.extend([a, b, d].concat());
            }
            if ring < rings - 1 {
                values.extend([b, c, d].concat());
            }
        }
    }
    mesh(&values)
}

/// Three collinear points: a triangle with no area, which parsers happily pass through.
pub fn degenerate_triangle_mesh() -> Mesh {
    mesh(&[0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0])
}

/// A grid of pillars, sized to a triangle count in the range of the largest real models.
pub fn many_triangles_mesh(triangle_target: usize) -> Mesh {
    let boxes = triangle_target.div_ceil(12);
    let side = (boxes as f64).sqrt().ceil() as usize;
    let side_f = side as f64;
    let mut values = Vec::with_capacity(boxes * 12 * 9);
    for n in 0..boxes {
        let ox = (n % side) as f64 / side_f;
        let oy = (n / side) as f64 / side_f;
        let oz = ((n * 7) % 13) as f64 / 13.0;
        for [a, b, c, d] in CUBE_FACES {
            for [i, j, k] in [[a, b, c], [a, c, d]] {
                for corner in [CUBE_CORNERS[i], CUBE_CORNERS[j], CUBE_CORNERS[k]] {
                    values.extend([
                        corner[0] / side_f + ox,
                        corner[1] / side_f + oy,
                        corner[2] / side_f + oz,
                    ]);
                }
            }
        }
    }
    mesh(&values)
}

/// A box rotated about Z, as a part is routinely rotated to fit the print bed.
///
/// At 45 degrees this is the orientation an *exact* isometric camera cannot draw: the two side
/// normals become (1,1,0) and (1,-1,0), both perpendicular to the (1,-1,1) view direction, so the
/// box collapses into a flat two-tone rectangle. The camera's azimuth offset is what keeps it a
/// box.
pub fn rotated_box_mesh(degrees: f64) -> Mesh {
    let angle = degrees * PI / 180.0;
    let (sin, cos) = angle.sin_cos();
    let source = cube_mesh();
    let mut positions = Vec::with_capacity(source.positions.len());
    for point in source.positions.as_chunks::<3>().0 {
        let (x, y) = (f64::from(point[0]), f64::from(point[1]));
        positions.push((x * cos - y * sin) as f32);
        positions.push((x * sin + y * cos) as f32);
        positions.push(point[2]);
    }
    Mesh {
        positions,
        triangle_count: source.triangle_count,
    }
}

/// A flat plate `aspect` times longer than it is wide: two triangles, real area, real normal.
///
/// Drawable by every test the rasterizer applies, and yet it paints nothing. Once the fit
/// stretches its long axis across the frame, the short one is a fraction of a pixel wide and
/// slips between the sample points. This is the shape that shows why "did any triangle have area"
/// is not the same question as "did anything get drawn".
pub fn thin_plate_mesh(aspect: f64) -> Mesh {
    let w = 0.5 / aspect;
    mesh(&[
        -0.5, -w, 0.0, 0.5, -w, 0.0, 0.5, w, 0.0, -0.5, -w, 0.0, 0.5, w, 0.0, -0.5, w, 0.0,
    ])
}

/// A collinear triangle that reaches far past a unit model, and whose *projected* area is not
/// exactly zero.
///
/// `degenerate_triangle_mesh` runs along (1,1,1) through the origin, so its three projected points
/// land on exact halves and the screen-space cross product cancels to exactly 0. That makes it
/// indistinguishable from an edge-on triangle, and it cannot show that the zero-normal half of the
/// drawability test is doing anything.
///
/// This one can. Every coordinate is a multiple of 1/64, so the vertices are exact in `f32` and
/// `a`, `a + 3d`, `a + 8d` are exactly collinear (the face normal is exactly zero), but the
/// projection rounds to a screen area of +3.55e-15 rather than 0. Only the zero-normal test
/// rejects it, and it reaches to 13.5, so a fit that failed to reject it would shrink a unit cube
/// to a speck.
pub fn far_degenerate_triangle_mesh() -> Mesh {
    mesh(&[
        0.453125, 0.15625, -0.546875, 3.796875, -4.40625, -1.546875, 10.484375, -13.53125,
        -3.546875,
    ])
}

// --- PNG --------------------------------------------------------------------------------

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend((data.len() as u32).to_be_bytes());
    out.extend(kind);
    out.extend(data);
    out.extend(crc32(&[kind.as_slice(), data].concat()).to_be_bytes());
    out
}

/// A valid all-black 8-bit RGB PNG of the requested size.
///
/// Deliberately not built on top of `encode_png`: this fixture is used by tests that exercise the
/// *reading* side (`read_png_size`, thumbnail extraction). Routing it through the encoder would
/// make those tests pass or fail together with the encoder instead of independently of it, which
/// is the opposite of what a fixture is for.
pub fn make_png(width: u32, height: u32) -> Vec<u8> {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    // Each scanline is one filter byte followed by width RGB triples; zeros are fine.
    let raw = vec![0u8; (width as usize * 3 + 1) * height as usize];
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).unwrap();
    let idat = encoder.finish().unwrap();

    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    out.extend(png_chunk(b"IHDR", &ihdr));
    out.extend(png_chunk(b"IDAT", &idat));
    out.extend(png_chunk(b"IEND", &[]));
    out
}

// --- 3MF with geometry --------------------------------------------------------------------

const TETRAHEDRON_MODEL_XML: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>"#,
    r#"<object id="1" type="model"><mesh><vertices>"#,
    r#"<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>"#,
    r#"<vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/>"#,
    r#"</vertices><triangles>"#,
    r#"<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>"#,
    r#"<triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>"#,
    r#"</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#,
);

/// A plain-mesh 3MF that actually contains geometry: a tetrahedron, four triangles with four
/// distinct normals, so a rasterized thumbnail of it is a shape rather than a flat blob.
///
/// Kept separate from `plain_mesh_3mf` rather than folded into it. That one has an empty
/// `<resources/>` on purpose: it exists to prove classification, and classification is exactly the
/// question of what a 3MF is when it has no slicer metadata, geometry or not.
pub fn mesh_geometry_3mf(path: &Path, thumbnail: Option<&[u8]>) {
    let mut entries = vec![
        stored("[Content_Types].xml", "<Types/>"),
        deflated("3D/3dmodel.model", TETRAHEDRON_MODEL_XML),
    ];
    // A plain mesh with an embedded thumbnail is not a contradiction: the 28 zip64 files in the
    // reference library classify as `model` (no slicer metadata at all) and 16 of them carry one.
    entries.extend(thumbnail.map(|bytes| stored("Metadata/thumbnail.png", bytes)));
    write_zip(path, &entries, None);
}

/// A slicer project (`slicer_project`, by rule 3 of `classify_3mf`) that holds real geometry, with
/// an embedded thumbnail only if one is passed.
///
/// This is the common shape in the reference library and the reason the handler chain exists: 326
/// of its 374 projects were saved but never sliced, so the slicer wrote no plate render.
/// `bambu_lineage_project` cannot stand in: its model part is deliberately empty, which makes it
/// useful for classification and useless for rasterizing.
pub fn slicer_project_with_mesh(path: &Path, thumbnail: Option<&[u8]>) {
    let mut entries = vec![
        // Not read by anything under test, but every real 3MF is an OPC package and has one.
        stored("[Content_Types].xml", "<Types/>"),
        deflated("3D/3dmodel.model", TETRAHEDRON_MODEL_XML),
        stored(
            "Metadata/project_settings.config",
            r#"{"version": "02.08.02.61"}"#,
        ),
        stored("Metadata/model_settings.config", "<config/>"),
        stored(
            "Metadata/slice_info.config",
            slice_info(&["X-BBL-Client-Type"]),
        ),
    ];
    entries.extend(thumbnail.map(|bytes| stored("Metadata/plate_1.png", bytes)));
    write_zip(path, &entries, None);
}
