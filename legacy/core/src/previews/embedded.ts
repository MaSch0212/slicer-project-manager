import { findZipEntry, readZipEntries, readZipEntryBytes } from '../files/zip.ts'
import { readPngSize } from './png.ts'

/**
 * Measured 2026-08-22 (spec 7.1). Cura and PrusaSlicer both use Metadata/thumbnail.png;
 * the Bambu lineage uses Metadata/plate_1.png specifically — plate_1_small.png is 128x128
 * (below the 256 target), plate_no_light_1.png is unlit, top_1.png is a top-down
 * orthographic view, and pick_1.png is an object-picking mask rather than a visual.
 */
export const EMBEDDED_THUMBNAIL_ENTRIES: readonly string[] = [
  'Metadata/thumbnail.png',
  'Metadata/plate_1.png',
]

export function extractEmbeddedThumbnail(
  absPath: string,
): { bytes: Uint8Array; width: number; height: number } | null {
  let entries
  try {
    entries = readZipEntries(absPath)
  } catch {
    return null
  }

  for (const name of EMBEDDED_THUMBNAIL_ENTRIES) {
    const entry = findZipEntry(entries, name)
    if (!entry) continue
    const bytes = readZipEntryBytes(absPath, entry)
    const size = readPngSize(bytes)
    if (!size) continue
    // Stored verbatim: resizing needs a PNG codec, which arrives with the rasterizer in spec B.
    return { bytes, width: size.width, height: size.height }
  }
  return null
}
