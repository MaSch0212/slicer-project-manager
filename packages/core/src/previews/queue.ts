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
  /**
   * The lease this job was handed the row under — the exact `claimed_at` `claimPendingPreviews`
   * wrote. It is what `runOne` writes its result back *against*, so a result is only recorded
   * while the row is still the one that was claimed. See `finish` there.
   */
  claimedAt: number
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

/**
 * Bounds how often one row may be *claimed* while it is still `pending` (spec 7.3).
 *
 * Narrower than it sounds, and worth being exact about. A handler that returns or throws moves
 * the row to a terminal state in the same tick, and `claimPendingPreviews` selects only
 * `state = 'pending'`, so an ordinary failure is not what this bounds — reaching the terminal
 * state is. What this bounds is the row that never gets one: a job that hangs, or a process
 * killed mid-run, leaves `pending` with a lease that later expires and is re-claimed. Without a
 * ceiling that file is picked up again on every restart, forever.
 *
 * A rescan that sees the file's content hash change resets `attempts` to 0 along with the state,
 * so the budget is per unchanged-bytes, not per file for all time.
 */
export const MAX_PREVIEW_ATTEMPTS = 3

/**
 * How many preview jobs run at once by default.
 *
 * **One, and that is a memory decision rather than a throughput one.** A rasterizing job's peak is
 * its mesh plus a fixed reader window, and the reference library's largest mesh is 208.8 MB
 * (2 899 850 triangles over 8 699 550 unshared vertices, the Köln Pokal 3MF), so a worker is worth
 * about 290 MB at the worst. Measured backfilling the whole library on Deno: 400–410 MB of peak RSS
 * at one worker across nine runs on two machines, 620–621 MB at two — and the deployment target is
 * a 2 GB NAS with a 500 MB budget. The second worker is not even paying for itself in time: 1.5%
 * faster here, 0% on the second machine, because parsing and rasterizing are CPU-bound JavaScript
 * on one thread. `SPM_PREVIEW_CONCURRENCY` raises it for a library that waits on I/O instead; the
 * README carries the table.
 *
 * **Since STEP support there is a second term, and it does not behave like the first.** A process
 * that has parsed one STEP file peaks at ~244 MB while parsing any of them, whatever the file:
 * measured across ten, an 8 KB file cost 207 MB and the largest 278 MB, and peak RSS stayed flat
 * over a second pass. **That floor does not multiply with concurrency, and that is a property of
 * the code rather than a hope** — the "workers" below are plain async functions racing over one job
 * array in one process on one thread, so there is one module instance and one WASM heap however
 * many of them there are. A process that never parses a STEP file pays none of it.
 *
 * The arithmetic an operator needs before raising this, in full, because a formula that holds only
 * at the default is worse here than no formula:
 *
 * | Case                | Peak                                                             |
 * | ------------------- | ---------------------------------------------------------------- |
 * | Before STEP support | `concurrency × (mesh + ~80 MB) + ~120 MB`                         |
 * | At concurrency 1    | larger of `mesh + ~80 MB + ~120 MB` and ~244 MB — **not** the sum  |
 * | At concurrency ≥ 2  | they add: `(concurrency − 1) × (mesh + ~80 MB) + ~120 MB + ~244 MB` |
 *
 * Why row two is "whichever is larger" and row three is a sum: at one worker a mesh job and a STEP
 * parse cannot be in flight together, so only one of the two terms is ever the peak. At two or more
 * a worker can be *holding* an allocated `positions` array across an `await` when the STEP parse
 * starts, and the reference library's worst is 208.8 MB of it.
 *
 * **Row three is arithmetic over two separately measured processes, not a measurement.** The
 * 400–410 MB backfill figure is the mesh path alone and the ~244 MB figure is the STEP path alone;
 * nobody has measured a process that does both. The direction is up and the shape is the one above;
 * the number is not claimed.
 */
export const DEFAULT_CONCURRENCY = 1

/**
 * How long a claim on a preview row is honoured. Well beyond any single job (subsystem B's
 * rasterizer against a 54 MB 3MF, spec 7.1, is minutes at worst), so it never cuts a live
 * job short; short enough that a killed process does not strand a row until the next rescan.
 */
export const PREVIEW_LEASE_MS = 15 * 60 * 1000

/**
 * The queue's default handler, and deliberately the *narrow* one: `slicer_project` only.
 *
 * A plain `model` 3MF can carry a thumbnail too, and one should be used when it is there — but
 * covering `model` here would be wrong, because coverage is a claim and a claim that comes back
 * `null` is recorded as `unsupported`, which is terminal. Alone in the default list this handler
 * has nothing behind it, so every `.stl` and `.obj` — not a zip, no thumbnail, nothing this can
 * ever answer — would go permanently blank instead of staying `pending` for an operator who
 * enables the rasterizer later. Nothing re-queues a row whose bytes have not changed.
 *
 * `model` coverage therefore lives in `handlers.ts`, which spreads this handler and adds the kind
 * on the chain that has a rasterizer behind it and can afford the fall-through.
 */
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
 * - **The lease is also the job's write token.** `claimed_at` goes onto the `PreviewJob`, and
 *   `runOne` writes its outcome back only while the row still carries it — see `finish`. Without
 *   that, a `rescan` that re-pends a file mid-render had the stale result written straight over
 *   the row it had just reset.
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
  lib.log.debug('claimed preview jobs', { count: rows.length })

  return rows.map((row) => ({
    fileId: row.fileId,
    kind: row.kind,
    contentHash: row.contentHash,
    claimedAt: now,
    absPath: join(
      lib.dir,
      ...(row.libraryDir === '.' ? [] : [row.libraryDir]),
      row.dirName,
      ...row.relPath.split(RELATIVE_PATH_SEPARATOR),
    ),
  }))
}

/**
 * Writes one job's outcome, **and only while the row is still the one that job claimed**.
 *
 * Every terminal write goes through here, and every one of them carries the same two extra
 * conditions: `state = 'pending'` (a claimed row is still pending — the claim writes only
 * `claimed_at` and `attempts`) and `claimed_at = <this job's lease>`. Together they say "nobody
 * has touched this row since I took it".
 *
 * **The bug this closes, measured.** `rescan` re-pends a file whose content hash changed —
 * `state = 'pending'`, `claimed_at = NULL`, `attempts = 0` — and it does that whether or not a
 * job is in flight for that file. With the write unguarded, the in-flight job then wrote
 * `state = 'ready'` over the fresh `pending` row with the picture it had rendered from the *old*
 * bytes, and `source_hash` set to the old hash. Nothing recovered from it: the same rescan had
 * already written the new `size_bytes` and `mtime_ms`, so the next rescan takes the cheap
 * stat-match `continue` and never looks at `source_hash` again. The user's edited model kept its
 * pre-edit thumbnail for as long as the file stayed untouched. Guarded, the stale result is
 * dropped and the row is left `pending` for the next tick, which renders the bytes that are
 * actually there.
 *
 * **What it does not make atomic, and this is the honest bound.** The PNG is written to
 * `<fileId>.png` before this runs, so a dropped result has already replaced the bytes at that
 * path. That is harmless where it matters — a `pending` row's `png_path` is NULL, so nothing
 * serves those bytes, and the run that re-renders the file overwrites them — but it is not
 * nothing, and no comment here should say the pair is transactional.
 *
 * Returns whether the write landed, so the caller can count only outcomes it actually recorded.
 */
function finish(lib: Library, job: PreviewJob, sql: string, params: unknown[]): boolean {
  const changes = lib.db
    .prepare(`${sql} AND state = 'pending' AND claimed_at = ?`)
    .run(...(params as never[]), job.claimedAt).changes
  if (Number(changes) === 1) return true
  // debug, not warn: the only way here is a row somebody else moved on purpose — today that is
  // `rescan` re-pending an edited file — and the queue picking it up again is the right answer,
  // not an incident.
  lib.log.debug('preview result dropped, the row was no longer the one claimed', {
    fileId: job.fileId,
  })
  return false
}

async function runOne(
  lib: Library,
  job: PreviewJob,
  handlers: readonly PreviewHandler[],
  counts: { ready: number; failed: number; unsupported: number },
): Promise<void> {
  const matching = handlers.filter((candidate) => candidate.kinds.includes(job.kind))
  if (matching.length === 0) {
    // Unreachable via claimPendingPreviews, which only claims covered kinds; releasing the
    // lease anyway keeps a hand-built job list from parking a row for PREVIEW_LEASE_MS. Guarded
    // like every other write here, so a release cannot land on somebody else's claim.
    finish(lib, job, 'UPDATE previews SET claimed_at = NULL WHERE file_id = ?', [job.fileId])
    return
  }

  const now = Date.now()
  try {
    // Every matching handler in order, first non-null wins. `null` means "not my job, ask the
    // next one", so a slicer project whose slicer embedded no thumbnail falls through from
    // EMBEDDED_HANDLER to the rasterizer instead of ending `unsupported` — which the queue
    // never revisits, so the 326 unsliced projects in the reference library stayed blank until
    // something edited them on disk.
    //
    // A throw is the *other* answer: "this file is broken". It leaves this loop immediately and
    // lands in the catch below as `failed`. That is why there is no try/catch inside the loop:
    // catching here to try the next handler would record the corrupt model as `unsupported`,
    // which writes `error = NULL` — the same row a genuinely unrenderable file gets, with
    // nothing left to say which it was or why.
    let output: PreviewOutput | null = null
    for (const handler of matching) {
      output = await handler.run(job)
      if (output) break
    }
    if (!output) {
      // Deterministic absence. Like `failed`, this leaves the queue for good: claimPendingPreviews
      // selects `state = 'pending'` only, so neither is ever re-claimed on its own. What does
      // bring a row back is `rescan`, which re-pends it — from any state, attempts reset — when
      // the file's content hash changes. So this is "nothing to render from these bytes", not
      // "nothing to render, ever".
      if (
        !finish(
          lib,
          job,
          `UPDATE previews SET state = 'unsupported', error = NULL, claimed_at = NULL,
                               updated_at = ?
           WHERE file_id = ?`,
          [now, job.fileId],
        )
      ) {
        return
      }
      lib.log.debug('preview unsupported', { fileId: job.fileId, kind: job.kind })
      counts.unsupported++
      return
    }

    const target = previewPath(lib, job.fileId)
    writeFileSync(target, output.bytes)
    if (
      !finish(
        lib,
        job,
        `UPDATE previews SET state = 'ready', source = ?, png_path = ?, width = ?, height = ?,
                             source_hash = ?, error = NULL, claimed_at = NULL, updated_at = ?
         WHERE file_id = ?`,
        [
          output.source,
          [SPM_DIR, PREVIEWS_DIR, `${job.fileId}.png`].join(RELATIVE_PATH_SEPARATOR),
          output.width,
          output.height,
          job.contentHash,
          now,
          job.fileId,
        ],
      )
    ) {
      return
    }
    lib.log.debug('preview ready', {
      fileId: job.fileId,
      source: output.source,
      width: output.width,
      height: output.height,
    })
    counts.ready++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // attempts is NOT incremented here: claimPendingPreviews already charged this attempt,
    // so doing it again would halve the retry budget for the failures it is meant to bound.
    // The lease is released, because this row has reached a terminal state.
    if (
      !finish(
        lib,
        job,
        `UPDATE previews SET state = 'failed', error = ?, claimed_at = NULL, updated_at = ?
         WHERE file_id = ?`,
        [message.slice(0, 500), now, job.fileId],
      )
    ) {
      return
    }
    // warn, not error: a single malformed file is expected traffic for an importer, and
    // MAX_PREVIEW_ATTEMPTS already bounds it. The path is what makes it actionable.
    lib.log.warn('preview failed', { fileId: job.fileId, path: job.absPath, err: error })
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
  // Silent when there was nothing to do: this runs every 30 seconds and an idle library
  // would otherwise fill the log with zeroes at the default level.
  if (jobs.length > 0) lib.log.info('preview batch', { claimed: jobs.length, ...counts })
  return counts
}
