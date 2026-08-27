import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { PREVIEWS_DIR, SPM_DIR } from '../../core/src/db/open.ts'
import { encodePng } from '../../core/src/previews/png.ts'

/**
 * A thumbnail, made the way the preview queue will make one — because the preview queue is task
 * 4's work and this task still has to serve a `ready` preview end to end.
 *
 * It writes real PNG bytes to the real path (`.spm/previews/<fileId>.png`) and sets the real row,
 * so nothing about `resolvePreviewPath` is stubbed: the same `png_path` join, the same
 * `state = 'ready'` filter and the same `existsSync` run as in production.
 *
 * Shared by `files.test.ts` (plain Node) and `files.spec.ts` (Playwright), which is why it lives
 * here rather than in `fixtures.ts` — that module imports `@playwright/test`, and pulling
 * Playwright into a `node --test` file to reach one PNG would be a strange trade.
 */

export const PREVIEW_WIDTH = 6
export const PREVIEW_HEIGHT = 4

/**
 * A colour nothing else in the pipeline could produce by accident. Black is the wrong choice: a
 * blank canvas, a failed decode and `make-png.ts`'s all-black fixture are all black too, so a
 * pixel assertion against it would pass on three different kinds of nothing.
 */
export const PREVIEW_RGB: readonly [number, number, number] = [0x2f, 0x9e, 0x44]

export function previewPng(): Uint8Array {
  const rgb = new Uint8Array(PREVIEW_WIDTH * PREVIEW_HEIGHT * 3)
  for (let i = 0; i < rgb.length; i += 3) rgb.set(PREVIEW_RGB, i)
  return encodePng(rgb, PREVIEW_WIDTH, PREVIEW_HEIGHT)
}

export function markPreviewReady(db: DatabaseSync, libraryDir: string, fileId: string): Uint8Array {
  const png = previewPng()
  writeFileSync(join(libraryDir, SPM_DIR, PREVIEWS_DIR, `${fileId}.png`), png)
  const changes = db
    .prepare(
      `UPDATE previews SET state = 'ready', png_path = ?, width = ?, height = ?, updated_at = ?
       WHERE file_id = ?`,
    )
    .run(
      [SPM_DIR, PREVIEWS_DIR, `${fileId}.png`].join('/'),
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
      Date.now(),
      fileId,
    )
  // Both `uploadFile` and `rescan` insert a `pending` row, so there is always one to update. If
  // that ever stops being true this fixture would silently mark nothing ready and every test
  // built on it would fail somewhere far from the cause.
  if (Number(changes.changes) !== 1) {
    throw new Error(`no previews row for ${fileId}; the fixture marked nothing ready`)
  }
  return png
}
