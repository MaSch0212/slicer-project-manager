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

export function claimPendingPreviews(
  lib: Library,
  handlers: readonly PreviewHandler[],
  limit: number,
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
         AND f.kind IN (${placeholders(kinds.length)})
       ORDER BY pv.updated_at
       LIMIT ?`,
    )
    .all(MAX_PREVIEW_ATTEMPTS, ...kinds, limit) as {
    fileId: string
    kind: FileKind
    relPath: string
    contentHash: Uint8Array | null
    dirName: string
    libraryDir: string
  }[]

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
  if (!handler) return

  const now = Date.now()
  try {
    const output = await handler.run(job)
    if (!output) {
      // Deterministic absence: never retried.
      lib.db
        .prepare(
          "UPDATE previews SET state = 'unsupported', error = NULL, updated_at = ? WHERE file_id = ?",
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
                             source_hash = ?, error = NULL, updated_at = ?
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
    lib.db
      .prepare(
        `UPDATE previews SET state = 'failed', error = ?, attempts = attempts + 1, updated_at = ?
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
