import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { closeLibrary, openLibrary, PREVIEWS_DIR, SPM_DIR } from '../../core/src/db/open.ts'
import { encodePng } from '../../core/src/previews/png.ts'
import { rescan } from '../../core/src/projects/rescan.ts'
import { ensureLocalUser } from '../../core/src/users/bootstrap.ts'

/**
 * A thumbnail, made the way the preview queue makes one, for a test that needs to *know* which
 * picture it is looking at.
 *
 * It writes real PNG bytes to the real path (`.spm/previews/<fileId>.png`) and sets the real row,
 * so nothing about `resolvePreviewPath` is stubbed: the same `png_path` join, the same
 * `state = 'ready'` filter and the same `existsSync` run as in production.
 *
 * **It is not the only producer, and against a running shell it loses.** This docblock used to
 * explain itself as standing in for a queue the shell did not yet have — "the preview queue is
 * task 4's work" — and that stopped being true when task 4 shipped `startPreviewTicker`. A shell
 * with a folder open renders its own 256x256 picture for every model, into this same row and this
 * same path, and the renderer then holds what it was served for a minute. So this function is for
 * a library **no shell has opened yet**: `seedReadyPreview` below is how a Playwright spec reaches
 * that moment, and `files.test.ts` is under plain Node with no shell at all.
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

/**
 * Adopts a seeded folder and marks one file's preview ready — **before any shell opens it**.
 *
 * This is the whole answer to the contest described above, and it is a property of ordering
 * rather than of speed. The shell's `LibraryHost.open()` starts the preview ticker and fires its
 * first tick before it rescans, and `claimPendingPreviews` selects `state = 'pending'` and
 * nothing else; a row that is already `ready` when the process starts is therefore invisible to
 * every tick it will ever run. The adoption rescan does not undo that either: it re-pends a row
 * only where `size_bytes` or `mtime_ms` moved, or where a `CLASSIFIER_VERSION` bump gives the file
 * a different kind — and the rescan below has already recorded the first two and stamped the
 * third, so the shell's rescan finds nothing to re-ask.
 *
 * So the app never renders a competing picture for this file, never paints one, and never caches
 * one — which matters as much as the database does, because a thumb is served with
 * `cache-control: private, max-age=60` behind a URL that does not change with its bytes.
 *
 * Takes the file's path within the library rather than an id, because the id does not exist
 * until this function creates it.
 */
export async function seedReadyPreview(libraryDir: string, relPath: string): Promise<void> {
  const lib = openLibrary(libraryDir)
  try {
    await rescan(lib, ensureLocalUser(lib))
    const row = lib.db.prepare('SELECT id FROM files WHERE rel_path = ?').get(relPath) as
      { id: string } | undefined
    // The same reasoning as `markPreviewReady`'s row count, one step earlier: a seed whose file
    // this rescan did not adopt would leave the caller asserting against a thumbnail nothing had
    // written, and the failure would land in the assertion rather than here.
    if (!row) throw new Error(`the rescan adopted no file named ${relPath}`)
    // The bytes `markPreviewReady` answers with are dropped rather than passed on: the caller is
    // a Playwright spec that compares what Chromium painted against `PREVIEW_RGB`, and handing it
    // a second copy of the same constants would give it something else to compare instead.
    markPreviewReady(lib.db, libraryDir, row.id)
  } finally {
    closeLibrary(lib)
  }
}
