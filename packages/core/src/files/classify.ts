import type { FileKind, SlicerId } from '@spm/contract/dtos.ts'
import { findZipEntry, readZipEntries, readZipEntryText, type ZipEntry } from './zip.ts'

export type Classification = { kind: FileKind; slicer: SlicerId | null }

/**
 * Order is load-bearing (spec 3.4). OrcaSlicer's slice_info header is a SUPERSET of Bambu
 * Studio's — it keeps X-BBL-Client-Type and adds OrcaSlicer-Version — so Orca must be tested
 * first or every Orca project is labelled bambu. Another Orca derivative is one row above
 * X-BBL-Client-Type. Matching is on the KEY only; version values are never discriminators.
 */
export const SLICER_HEADER_REGISTRY: ReadonlyArray<{ key: string; slicer: SlicerId }> = [
  { key: 'X-ACNext-Client-Type', slicer: 'anycubic' },
  { key: 'OrcaSlicer-Version', slicer: 'orca' },
  { key: 'X-BBL-Client-Type', slicer: 'bambu' },
]

export function slicerFromSliceInfo(xml: string): SlicerId | null {
  const keys = new Set<string>()
  for (const match of xml.matchAll(/<header_item\s+key="([^"]+)"/g)) keys.add(match[1]!)
  for (const { key, slicer } of SLICER_HEADER_REGISTRY) if (keys.has(key)) return slicer
  return null
}

export function classify3mf(absPath: string): Classification {
  let entries: ZipEntry[]
  try {
    entries = readZipEntries(absPath)
  } catch {
    // A .3mf that is not a readable zip is not a model we can do anything with.
    return { kind: 'other', slicer: null }
  }

  // 1. Cura
  if (entries.some((entry) => entry.name.startsWith('Cura/'))) {
    return { kind: 'slicer_project', slicer: 'cura' }
  }
  // 2. PrusaSlicer
  if (findZipEntry(entries, 'Metadata/Slic3r_PE.config')) {
    return { kind: 'slicer_project', slicer: 'prusaslicer' }
  }
  // 3. Bambu lineage: identified only by the slice_info.config header items.
  const sliceInfo = findZipEntry(entries, 'Metadata/slice_info.config')
  if (sliceInfo) {
    let slicer: SlicerId | null = null
    try {
      slicer = slicerFromSliceInfo(readZipEntryText(absPath, sliceInfo))
    } catch {
      slicer = null
    }
    return { kind: 'slicer_project', slicer }
  }
  // 4. Saved but never sliced: still a project, slicer unknown rather than guessed.
  if (findZipEntry(entries, 'Metadata/project_settings.config')) {
    return { kind: 'slicer_project', slicer: null }
  }
  // 5. A plain 3MF mesh.
  return { kind: 'model', slicer: null }
}

export function classifyFile(absPath: string): Classification {
  const lower = absPath.toLowerCase()
  if (lower.endsWith('.stl') || lower.endsWith('.obj')) return { kind: 'model', slicer: null }
  if (lower.endsWith('.3mf')) return classify3mf(absPath)
  return { kind: 'other', slicer: null }
}
