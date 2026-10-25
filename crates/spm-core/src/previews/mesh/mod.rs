//! Reading a model file into triangle soup, without ever holding the file.
//!
//! Every parser here returns the one [`Mesh`] shape, so the rasterizer only has to know one
//! format. STL and OBJ are read in 256 KB chunks; a 3MF's model part is inflated straight into a
//! 256 KB window. What is left in the peak is the mesh itself, at 36 bytes per triangle plus 12
//! per distinct vertex of a 3MF or OBJ, and a decompressor that costs kilobytes.
//!
//! STEP is not read (migration spec 4.1): a `.step`/`.stp` file has no parser, so its preview is
//! `unsupported`.

pub mod limits;
pub mod obj;
pub mod stl;
pub mod threemf;

pub(crate) mod jsnum;

/// Triangle soup: three vertices per triangle, back to back, no shared-index buffer.
///
/// `positions` holds `triangle_count * 9` floats: x, y, z for each of a triangle's three vertices,
/// in triangle order. A flat `Vec<f32>` rather than per-triangle values, per the bounded-memory
/// constraint. The fields are public so a caller can build a mesh, and the rasterizer refuses one
/// whose two disagree.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mesh {
    pub positions: Vec<f32>,
    pub triangle_count: usize,
}
