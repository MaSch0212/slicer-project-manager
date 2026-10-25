//! The handler chain, in the order the queue must try it.

use std::sync::Arc;

use super::embedded::extract_embedded_thumbnail;
use super::mesh::limits::MeshLimits;
use super::mesh_handler::MeshHandler;
use super::queue::{PreviewHandler, PreviewJob, PreviewOutput, PreviewSource, SharedHandler};
use crate::dto::FileKind;
use crate::error::Result;

/// The embedded-thumbnail handler: the picture the slicer itself wrote into the file.
///
/// Two coverages exist and they are deliberately not both public values:
///
/// * `slicer_project` alone is the queue's default (see `QueueOptions`);
/// * `slicer_project` and `model` is the production chain's, because that chain can afford it.
///
/// A plain 3MF carries thumbnails as readily as a slicer project does: the 28 zip64 files in the
/// reference library classify as `model` (no slicer metadata at all, so `classify_3mf` rule 5) and
/// 16 of them ship a 512 or 1024 pixel `Metadata/thumbnail.png`. Claiming only `slicer_project`
/// meant all 28 were rasterized to 256: slower than reading the picture out of the file, and a
/// quarter of the resolution that was already sitting in it. What makes the wider claim safe
/// *there* is [`MeshHandler`] behind it: a handler that declines returns `None`, and `None` from
/// the last matching handler is a terminal `unsupported`. In the production chain an `.stl` or
/// `.obj` (not a zip, so nothing to read) declines and lands on the rasterizer, which is the
/// answer it wanted anyway. In a list where this were the only handler, the same decline would
/// blank the file permanently.
struct EmbeddedHandler {
    kinds: &'static [FileKind],
}

impl PreviewHandler for EmbeddedHandler {
    fn kinds(&self) -> &[FileKind] {
        self.kinds
    }

    fn run(&self, job: &PreviewJob) -> Result<Option<PreviewOutput>> {
        Ok(
            extract_embedded_thumbnail(&job.abs_path)?.map(|found| PreviewOutput {
                bytes: found.bytes,
                width: found.width,
                height: found.height,
                source: PreviewSource::Embedded,
            }),
        )
    }
}

/// The queue's default handler, and deliberately the *narrow* one: `slicer_project` only.
pub fn embedded_handler() -> SharedHandler {
    Arc::new(EmbeddedHandler {
        kinds: &[FileKind::SlicerProject],
    })
}

/// The full preview chain, in the order the queue must try it.
///
/// **The order is the whole content of this function, and it exists exactly once.** Embedded
/// first because it is both cheaper (a zip entry read against a full mesh parse and rasterize) and
/// more faithful: it is the picture the slicer itself showed the user, plate and all. Rasterizing
/// is the fallback for the file that has no such picture, which in the reference library is 326 of
/// 374 projects. A test runs the real queue over a file that has both and asserts which source
/// wins, so inverting this array cannot leave the suite green.
///
/// A function, because the rasterizer's memory ceiling is an operator's setting
/// (`SPM_MAX_MESH_MB`) and the order is not.
pub fn make_preview_handlers(limits: &MeshLimits) -> Vec<SharedHandler> {
    vec![
        Arc::new(EmbeddedHandler {
            kinds: &[FileKind::SlicerProject, FileKind::Model],
        }),
        Arc::new(MeshHandler::new(*limits)),
    ]
}
