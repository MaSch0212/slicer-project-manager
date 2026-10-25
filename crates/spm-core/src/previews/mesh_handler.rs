//! The rasterizing handler: parse a model, draw it, encode it.

use std::path::Path;

use super::mesh::Mesh;
use super::mesh::limits::MeshLimits;
use super::mesh::obj::parse_obj_file;
use super::mesh::stl::parse_stl_file;
use super::mesh::threemf::parse_3mf_mesh;
use super::png::encode_png;
use super::queue::{PreviewHandler, PreviewJob, PreviewOutput, PreviewSource};
use super::raster::render_mesh;
use crate::dto::FileKind;
use crate::error::Result;

/// The lowercased extension including its dot, or `""` when the path has no dot at all.
///
/// Lowercased because the reference library contains `.STL` files and `classify_file` lowercases
/// before matching, so they reach this handler as `kind: model`. Dropping the fold would return
/// "nothing to render" for them, and `unsupported` is terminal: every uppercase model in the
/// library would go permanently blank. A test pins it.
///
/// The last dot of the whole path rather than of its file name, and that is safe rather than
/// merely untested: any dot in a *directory* name is necessarily followed by a separator, and no
/// separator can appear inside any of the extensions matched below. So a dotted directory can only
/// ever produce a false negative, for a file with no extension of its own (`v1.2/README`), and
/// "nothing to render" is the right answer there anyway. It can never produce a false positive.
fn extension_of(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.rfind('.')
        .map_or_else(String::new, |dot| text[dot..].to_lowercase())
}

/// Reads whichever mesh format `path` names, or `None` if it names none of them.
///
/// Every arm takes the path rather than bytes, and **none of them ever holds the file**: an STL
/// and an OBJ are read in 256 KB chunks, and a 3MF's model part is inflated straight into the
/// parser's window. The peak of a preview job is its `positions` array plus a fixed window, not a
/// function of the file at all, which for the reference library's 164 MB STL and 674 MB inflated
/// 3MF model part is the difference between fitting on a 2 GB NAS and not.
///
/// STEP (`.step`, `.stp`) has no arm. The format is not read (migration spec 4.1), so such a file
/// has deterministically nothing to render and ends `unsupported`.
fn read_mesh(path: &Path, limits: &MeshLimits) -> Result<Option<Mesh>> {
    match extension_of(path).as_str() {
        ".stl" => parse_stl_file(path, limits).map(Some),
        ".obj" => parse_obj_file(path, limits).map(Some),
        ".3mf" => parse_3mf_mesh(path, limits).map(Some),
        _ => Ok(None),
    }
}

/// Renders a 256px isometric thumbnail for a file that carries no thumbnail of its own.
///
/// Not part of the queue's default handler list: rasterizing is the expensive path, so a host
/// opts into it (see [`super::run_preview_batch`]) rather than getting it by accident.
///
/// `limits` is a field rather than a constant so the ceiling on one mesh can be an operator's
/// decision: the same server runs on a 2 GB NAS and on a Mac mini, and the number that is prudent
/// on one is an arbitrary refusal on the other.
///
/// **`slicer_project` is covered as well as `model`**, because a project saved but never sliced
/// embeds no thumbnail, and 326 of the 374 slicer projects in the reference library are in that
/// state: every one of them blank, because `unsupported` was the only outcome available to them.
/// Widening the kind is safe: `classify_file` only reaches `classify_3mf`, the sole producer of
/// `slicer_project`, for a path ending `.3mf`, so every job of that kind lands on the `.3mf` arm
/// of [`read_mesh`]. It is second in the production chain, so a project that *does* carry a
/// thumbnail still uses it: cheaper, and closer to what the slicer showed the user.
///
/// **`None` and an error are different outcomes, and the difference is the point.** `None` is
/// "there is deterministically nothing to render here" and the queue records `unsupported`, the
/// right answer for a `model` file in a format this handler cannot read (a STEP file, say),
/// because reading the same bytes again will not change that. An error is "this file should have
/// rendered and did not", which the queue records as `failed`. So a `.stl` whose bytes are corrupt
/// lets the parser's `Validation` error propagate: catching it here would file a real defect
/// under the same blank, message-less row as a file there was never anything to draw from. A
/// model refused by `limits` fails the same way, carrying the message that names its size and the
/// permitted one.
#[derive(Debug, Clone, Copy, Default)]
pub struct MeshHandler {
    pub limits: MeshLimits,
}

impl MeshHandler {
    pub fn new(limits: MeshLimits) -> MeshHandler {
        MeshHandler { limits }
    }
}

impl PreviewHandler for MeshHandler {
    fn kinds(&self) -> &[FileKind] {
        &[FileKind::Model, FileKind::SlicerProject]
    }

    fn run(&self, job: &PreviewJob) -> Result<Option<PreviewOutput>> {
        let Some(mesh) = read_mesh(&job.abs_path, &self.limits)? else {
            return Ok(None);
        };
        let image = render_mesh(&mesh)?;
        // The mesh is the largest thing this job holds; drop it before the PNG is built.
        drop(mesh);
        Ok(Some(PreviewOutput {
            bytes: encode_png(&image.rgb, image.width, image.height)?,
            width: image.width,
            height: image.height,
            source: PreviewSource::Rasterized,
        }))
    }
}
