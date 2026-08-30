import type { FileKind, SlicerId } from '@spm/contract/dtos.ts'
import { isAppError } from '@spm/contract/errors.ts'
import { findZipEntry, readZipEntries, readZipEntryText, type ZipEntry } from './zip.ts'

export type Classification = {
  kind: FileKind
  slicer: SlicerId | null
  /**
   * Set when the `kind` beside it is a **fallback for a file that could not be opened** rather
   * than something read out of the file's bytes — a slicer holding a `.3mf` open, an `EACCES`, a
   * path that went away between the walk and the read.
   *
   * It exists for `rescan`'s version-mismatch branch, which is the one place that would otherwise
   * record such a fallback as this classifier's answer and so make a transient failure permanent.
   * Only `classify3mf` can set it; classification by extension reads no bytes and cannot fail.
   *
   * **Absent rather than `false` on every answer that was actually read**, because a dozen tests
   * pin the classifier by comparing its whole result against a two-key literal, and a third key
   * on the ordinary answers would be a change to all of them for the sake of one.
   */
  unreadable?: true
}

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
  } catch (error) {
    // Two failures wearing one shape, and only one of them is an answer.
    //
    // Every way `readZipEntries` rejects the *contents* — too small for an end-of-central-directory
    // record, no such record, a corrupt directory — is an `AppError('Validation')` it raises
    // itself, and it means what it says: this `.3mf` is not a readable zip and not a model we can
    // do anything with. Anything else came out of the `openSync`/`statSync` at the top of it —
    // `EBUSY` while a slicer holds the file, `EACCES`, `ENOENT` — and says nothing about the
    // contents at all. `unreadable` is what keeps `rescan` from filing the second as the first.
    //
    // An unexpected non-`AppError` out of the parser lands in the second arm too, deliberately:
    // the cost of that mistake is re-asking the question on the next rescan, and the cost of the
    // other one is a `kind` that is wrong for good.
    if (isAppError(error) && error.code === 'Validation') return { kind: 'other', slicer: null }
    return { kind: 'other', slicer: null, unreadable: true }
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
 * on the next rescan, once — except for a `.3mf` that could not be *opened* on the bump pass,
 * which is left unstamped on purpose and re-asked each rescan until it opens (see `unreadable`
 * above). For the reference library that is 2 946 calls of which 402 are `.3mf` and therefore a
 * zip read each; everything else is a string comparison. It does **not** re-hash — the content
 * hash is untouched, because nothing about the bytes changed — so it costs a normal rescan's
 * classification work and not a backfill's. Previews are re-pended only for the files whose kind
 * actually moved, so a bump made for `.step` does not re-render 1 311 STLs.
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
