//! The thumbnail a slicer embedded in its own project file.

use std::path::Path;

use super::png::read_png_size;
use crate::error::Result;
use crate::files::zip::{find_zip_entry, open_zip};

/// Measured 2026-08-22 (spec 7.1). Cura and PrusaSlicer both use `Metadata/thumbnail.png`; the
/// Bambu lineage uses `Metadata/plate_1.png` specifically: `plate_1_small.png` is 128x128 (below
/// the 256 target), `plate_no_light_1.png` is unlit, `top_1.png` is a top-down orthographic view,
/// and `pick_1.png` is an object-picking mask rather than a visual.
pub const EMBEDDED_THUMBNAIL_ENTRIES: [&str; 2] =
    ["Metadata/thumbnail.png", "Metadata/plate_1.png"];

/// The largest thumbnail entry read, inflated. Slicers write pictures of a megabyte at most; this
/// stops a hostile archive from making the one buffered read of a preview job into a large one.
/// An entry over it is treated as absent, which falls through to the rasterizer.
pub const MAX_EMBEDDED_THUMBNAIL_BYTES: u64 = 32 * 1024 * 1024;

/// An embedded picture, stored verbatim.
///
/// Not downscaled, despite parent spec 7.1's "extract, downscale" (follow-up decision 2 of the
/// rasterizer plan): a 512 or 1024 pixel Bambu thumbnail renders better than 256 on a HiDPI grid,
/// and downscaling would need a PNG decoder for a loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedThumbnail {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The first of [`EMBEDDED_THUMBNAIL_ENTRIES`] present in the archive at `path` and holding a PNG.
///
/// `None` for everything that means "nothing to read here": not a zip, a corrupt directory, no
/// such entry, an entry that is not a PNG. The caller treats it as "not my job" and the next
/// handler in the chain gets the file. An entry that is there but cannot be read (a corrupt
/// deflate stream) is an error, as it always was: the archive should have yielded a picture and
/// did not, which is a `failed` preview with a message, not a quiet fall-through.
pub fn extract_embedded_thumbnail(path: &Path) -> Result<Option<EmbeddedThumbnail>> {
    let Ok(zip) = open_zip(path) else {
        return Ok(None);
    };
    for name in EMBEDDED_THUMBNAIL_ENTRIES {
        let Some(entry) = find_zip_entry(zip.entries(), name) else {
            continue;
        };
        if entry.uncompressed_size > MAX_EMBEDDED_THUMBNAIL_BYTES {
            continue;
        }
        let bytes = zip.read(entry)?;
        let Some((width, height)) = read_png_size(&bytes) else {
            continue;
        };
        return Ok(Some(EmbeddedThumbnail {
            bytes,
            width,
            height,
        }));
    }
    Ok(None)
}
