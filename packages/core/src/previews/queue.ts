import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileKind } from '@spm/contract/dtos.ts'
import type { Library } from '../db/open.ts'
import { previewPath } from '../files/paths.ts'
import { RELATIVE_PATH_SEPARATOR } from '../projects/rescan.ts'
import { PREVIEWS_DIR, SPM_DIR } from '../db/open.ts'
import { extractEmbeddedThumbnail } from './embedded.ts'

export type PreviewJob = {
  fileId: string
  absPath: string
  kind: FileKind
  contentHash: Uint8Array | null
}

export type PreviewOutput = {
  bytes: Uint8Array
  width: number
  height: number
  source: 'embedded' | 'rasterized'
}

/** A handler declares the kinds it covers; anything uncovered is left pending. */
export type PreviewHandler = {
  kinds: readonly FileKind[]
  run(job: PreviewJob): Promise<PreviewOutput | null>
}

/** Bounds a malformed mesh to a fixed number of attempts instead of looping forever (7.3). */
export const MAX_PREVIEW_ATTEMPTS = 3
export const DEFAULT_CONCURRENCY = 2

/**
 * How long a claim on a preview row is honoured. Well beyond any single job (subsystem B's
 * rasterizer against a 54 MB 3MF, spec 7.1, is minutes at worst), so it never cuts a live
 * job short; short enough that a killed process does not strand a row until the next rescan.
 */
export const PREVIEW_LEASE_MS = 15 * 60 * 1000

export const EMBEDDED_HANDLER: PreviewHandler = {
  kinds: ['slicer_project'],
  run: (job) => {
    const found = extractEmbeddedThumbnail(job.absPath)
    return Promise.resolve(found ? { ...found, source: 'embedded' as const } : null)
  },
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/**
 * Takes ownership of up to `limit` pending rows and returns them as jobs.
 *
 * This *claims*: it writes `claimed_at` (the lease) and increments `attempts` before the
 * caller runs anything.
 *
 * - **Claiming, not just selecting.** The queue is fired on a fixed interval with no
 *   guarantee a batch finishes inside it. Selecting on `state = 'pending'` alone let the
 *   next tick re-select the identical rows and redo the whole batch, compounding every tick
 *   once a job is slower than the interval — which subsystem B's rasterizer will be (spec
 *   7.1). A row with a live lease is invisible here.
 * - **Atomic without a transaction.** `DatabaseSync` is synchronous and there is exactly one
 *   process, so nothing may `await` between the SELECT and the UPDATE below. That, not
 *   locking, is what makes the claim indivisible: another `runPreviewQueue` can only observe
 *   the rows before or after both statements, never between them.
 * - **attempts moves here, not on failure.** Incrementing only in the caught-throw branch
 *   meant a handler that hung or a process that died never counted, so the same malformed
 *   file was retried forever across restarts — exactly what spec 7.3's retry budget exists
 *   to bound.
 * - **An expired lease is reclaimable**, so a crash costs one attempt rather than stranding
 *   the row until the next rescan.
 */
export function claimPendingPreviews(
  lib: Library,
  handlers: readonly PreviewHandler[],
  limit: number,
  now: number = Date.now(),
): PreviewJob[] {
  const kinds = [...new Set(handlers.flatMap((handler) => [...handler.kinds]))]
  if (kinds.length === 0) return []

  const rows = lib.db
    .prepare(
      `SELECT pv.file_id AS fileId, f.kind AS kind, f.rel_path AS relPath, f.content_hash AS contentHash,
              p.dir_name AS dirName, u.library_dir AS libraryDir
       FROM previews pv
       JOIN files f ON f.id = pv.file_id
       JOIN projects p ON p.id = f.project_id
       JOIN users u ON u.id = p.owner_id
       WHERE pv.state = 'pending' AND pv.attempts < ? AND p.state = 'ok'
         AND (pv.claimed_at IS NULL OR pv.claimed_at <= ?)
         AND f.kind IN (${placeholders(kinds.length)})
       ORDER BY pv.updated_at
       LIMIT ?`,
    )
    .all(MAX_PREVIEW_ATTEMPTS, now - PREVIEW_LEASE_MS, ...kinds, limit) as {
    fileId: string
    kind: FileKind
    relPath: string
    contentHash: Uint8Array | null
    dirName: string
    libraryDir: string
  }[]
  if (rows.length === 0) return []

  // No await between the SELECT above and this UPDATE: see the doc comment.
  const claim = lib.db.prepare(
    'UPDATE previews SET claimed_at = ?, attempts = attempts + 1 WHERE file_id = ?',
  )
  for (const row of rows) claim.run(now, row.fileId)

  return rows.map((row) => ({
    fileId: row.fileId,
    kind: row.kind,
    contentHash: row.contentHash,
    absPath: join(
      lib.dir,
      ...(row.libraryDir === '.' ? [] : [row.libraryDir]),
      row.dirName,
      ...row.relPath.split(RELATIVE_PATH_SEPARATOR),
    ),
  }))
}

async function runOne(
  lib: Library,
  job: PreviewJob,
  handlers: readonly PreviewHandler[],
  counts: { ready: number; failed: number; unsupported: number },
): Promise<void> {
  const handler = handlers.find((candidate) => candidate.kinds.includes(job.kind))
  if (!handler) {
    // Unreachable via claimPendingPreviews, which only claims covered kinds; releasing the
    // lease anyway keeps a hand-built job list from parking a row for PREVIEW_LEASE_MS.
    lib.db.prepare('UPDATE previews SET claimed_at = NULL WHERE file_id = ?').run(job.fileId)
    return
  }

  const now = Date.now()
  try {
    const output = await handler.run(job)
    if (!output) {
      // Deterministic absence: never retried.
      lib.db
        .prepare(
          `UPDATE previews SET state = 'unsupported', error = NULL, claimed_at = NULL,
                               updated_at = ?
           WHERE file_id = ?`,
        )
        .run(now, job.fileId)
      counts.unsupported++
      return
    }

    const target = previewPath(lib, job.fileId)
    writeFileSync(target, output.bytes)
    lib.db
      .prepare(
        `UPDATE previews SET state = 'ready', source = ?, png_path = ?, width = ?, height = ?,
                             source_hash = ?, error = NULL, claimed_at = NULL, updated_at = ?
         WHERE file_id = ?`,
      )
      .run(
        output.source,
        [SPM_DIR, PREVIEWS_DIR, `${job.fileId}.png`].join(RELATIVE_PATH_SEPARATOR),
        output.width,
        output.height,
        job.contentHash,
        now,
        job.fileId,
      )
    counts.ready++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // attempts is NOT incremented here: claimPendingPreviews already charged this attempt,
    // so doing it again would halve the retry budget for the failures it is meant to bound.
    // The lease is released, because this row has reached a terminal state.
    lib.db
      .prepare(
        `UPDATE previews SET state = 'failed', error = ?, claimed_at = NULL, updated_at = ?
         WHERE file_id = ?`,
      )
      .run(message.slice(0, 500), now, job.fileId)
    counts.failed++
  }
}

export async function runPreviewQueue(
  lib: Library,
  opts: { concurrency?: number; limit?: number; handlers?: readonly PreviewHandler[] } = {},
): Promise<{ ready: number; failed: number; unsupported: number }> {
  const handlers = opts.handlers ?? [EMBEDDED_HANDLER]
  const jobs = claimPendingPreviews(lib, handlers, opts.limit ?? 100)
  const counts = { ready: 0, failed: 0, unsupported: 0 }

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const job = jobs[index]
      if (!job) return
      await runOne(lib, job, handlers, counts)
    }
  }

  const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, jobs.length))
  await Promise.all(Array.from({ length: width }, worker))
  return counts
}
