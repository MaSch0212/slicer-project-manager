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

/**
 * The extensions that classify as `model` on their name alone. Enumerated by the frozen
 * snapshot in `test/classify.test.ts`, so an addition here with no row there fails.
 *
 * A list rather than the chain of `endsWith` it replaces, and that is the only reason it exists:
 * a chain is a set no test can read, so adding `.ply` to it would change nothing already asserted
 * and force no new row into the snapshot — the commonest future bump, going unnoticed. `.3mf` is
 * deliberately not here; it is a name two entirely different things share, and only `classify3mf`
 * can tell them apart.
 */
export const MODEL_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'] as const

/**
 * What `classifyFile`'s answers are worth, and the only thing `rescan` compares to decide whether
 * to ask again.
 *
 * **Bump this in the same commit as any change to what `classifyFile` returns.** A row records the
 * version that classified it (`files.classified_by`), and `rescan`'s stat-match path re-runs
 * `classifyFile` exactly when that number is not this one. Without a bump the change is invisible
 * in the field: every existing row still claims to have been classified by the current version, so
 * nothing is re-asked and the new answer reaches only files the library has never seen. The frozen
 * snapshot in `test/classify.test.ts` is what makes forgetting it fail rather than ship.
 *
 * **What a bump costs, so the decision is priced.** One extra `classifyFile` call per indexed file
 * on the next rescan, once. For the reference library that is 2 946 calls of which 402 are `.3mf`
 * and therefore a zip read each; everything else is a string comparison. It does **not** re-hash —
 * the content hash is untouched, because nothing about the bytes changed — so it costs a normal
 * rescan's classification work and not a backfill's. Previews are re-pended only for the files
 * whose kind actually moved, so a bump made for `.step` does not re-render 1 311 STLs.
 *
 * Never 0: that value means "this row predates the mechanism" and is what migration 003 backfills.
 */
export const CLASSIFIER_VERSION = 1

export function classifyFile(absPath: string): Classification {
  const lower = absPath.toLowerCase()
  if (MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext))) return { kind: 'model', slicer: null }
  if (lower.endsWith('.3mf')) return classify3mf(absPath)
  return { kind: 'other', slicer: null }
}
