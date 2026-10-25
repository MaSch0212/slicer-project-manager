//! The ceiling on one mesh's geometry arrays.

use serde_json::{Map, Value};

use crate::error::{AppError, Result};

/// `positions` holds nine `f32` slots (three vertices, x/y/z each) per triangle.
const BYTES_PER_TRIANGLE: u64 = 36;
/// The index table the 3MF and OBJ parsers resolve faces through: x/y/z per distinct vertex.
const BYTES_PER_VERTEX: u64 = 12;

/// The default ceiling on one mesh's geometry arrays: 256 MB.
///
/// **A backstop, not the mechanism.** Every read here is streamed, so the document is not part of
/// the peak and nothing in the reference library is refused by this. The two worst files are a
/// 3MF of 2 899 850 triangles over 8 699 550 unshared vertices (104.4 MB of `positions` beside
/// 104.4 MB of vertex table, 208.8 MB) and a 164 MB binary STL at 3 295 832 triangles, which needs
/// 118.7 MB and no vertex table. What this exists for is input whose triangle count is a function
/// of an attacker rather than of a printer: a model part declaring a billion degenerate triangles
/// asks for 36 GB, and asking is all it takes.
///
/// 256 MB is the library's worst file plus 23%, the smallest round number that is a backstop
/// rather than a filter. The host raises it with `SPM_MAX_MESH_MB`; the README carries the
/// arithmetic for pairing it with `SPM_PREVIEW_CONCURRENCY`.
///
/// STEP has no ceiling of its own any more: the format is not read at all (migration spec 4.1),
/// so there is no `SPM_MAX_STEP_MB` to bound a geometry kernel.
pub const DEFAULT_MAX_MESH_BYTES: u64 = 256_000_000;

/// Options every mesh parser takes, so the ceiling is the caller's to raise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshLimits {
    /// The most a mesh's `positions` and vertex table may allocate. Defaults to
    /// [`DEFAULT_MAX_MESH_BYTES`].
    pub max_mesh_bytes: u64,
}

impl Default for MeshLimits {
    fn default() -> Self {
        MeshLimits {
            max_mesh_bytes: DEFAULT_MAX_MESH_BYTES,
        }
    }
}

/// What a parser is about to allocate for a mesh of this shape, in bytes.
pub fn mesh_bytes_for(vertex_count: u64, triangle_count: u64) -> u64 {
    vertex_count
        .saturating_mul(BYTES_PER_VERTEX)
        .saturating_add(triangle_count.saturating_mul(BYTES_PER_TRIANGLE))
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// Refuses a mesh that would not fit, **before** the allocation rather than after it.
///
/// The counts come from a counting pass that allocates nothing, so this runs while the process
/// holds only the parser's fixed window, which is the only order in which a limit is worth
/// having. The message names both sizes because the operator's next question is always "by how
/// much", and the answer decides whether `SPM_MAX_MESH_MB` is the fix or the file is.
pub fn assert_mesh_fits(vertex_count: u64, triangle_count: u64, limits: &MeshLimits) -> Result<()> {
    let needed = mesh_bytes_for(vertex_count, triangle_count);
    if needed <= limits.max_mesh_bytes {
        return Ok(());
    }
    let mut details = Map::new();
    details.insert("vertexCount".into(), Value::from(vertex_count));
    details.insert("triangleCount".into(), Value::from(triangle_count));
    details.insert("neededBytes".into(), Value::from(needed));
    details.insert("maxMeshBytes".into(), Value::from(limits.max_mesh_bytes));
    Err(AppError::validation(format!(
        "model geometry needs {} ({triangle_count} triangles), more than the {} this server permits",
        megabytes(needed),
        megabytes(limits.max_mesh_bytes),
    ))
    .with_details(details))
}

/// An empty `Vec<f32>` with room for exactly `floats` values, the failure to get it turned into
/// the contract the rest of the system reads.
///
/// [`assert_mesh_fits`] is the ceiling an operator sets, and it is deliberately allowed to be
/// larger than a given machine: the same configuration ships to a NAS and to a workstation. So
/// the allocation can still fail, and the length came out of a file, and the rule for anything a
/// file can cause is a `Validation` error rather than an abort. The parsers `push` into the result
/// up to its capacity, so nothing is zero-filled and nothing ever reallocates.
pub fn allocate_mesh(floats: usize, what: &str) -> Result<Vec<f32>> {
    let mut values: Vec<f32> = Vec::new();
    if values.try_reserve_exact(floats).is_err() {
        let mut details = Map::new();
        details.insert("floats".into(), Value::from(floats as u64));
        details.insert(
            "bytes".into(),
            Value::from((floats as u64).saturating_mul(4)),
        );
        return Err(
            AppError::validation(format!("model is too large to allocate its {what}"))
                .with_details(details),
        );
    }
    Ok(values)
}
