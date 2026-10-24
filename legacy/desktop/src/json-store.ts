import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * The one way this process replaces a JSON file under `app.getPath('userData')`.
 *
 * Extracted from `state.ts`, unchanged, when `slicers.json` arrived (D plan decision 4). The two
 * files share a **writer, not a file**: `state.json` is three keys written when a user answers a
 * question about which library there is, and `slicers.json` is a list rewritten by every
 * detection scan and every binding change. One corrupt write should cost the user their slicer
 * bindings or their library choice, never both.
 *
 * Nothing here imports `electron`, so `test/json-store.test.ts` drives every branch under plain
 * `node --test` against a real temporary file.
 */

/**
 * The filesystem calls the writer makes, injected so that the *sequence* is assertable.
 *
 * This is the one part of the module that exists for the tests, and it is here because the
 * guarantee that matters most is the one a test cannot otherwise see. `fsyncSync` has no
 * observable effect in user space: remove the call and every assertion about the file's contents,
 * the temp file's absence and the rename's atomicity still passes, on every platform. That is
 * precisely the silent regression this extraction was flagged for, so the sequence is recorded
 * rather than inferred — `test/json-store.test.ts` asserts that the handle is flushed, that it is
 * flushed *before* the rename, and that it is the same handle the bytes were written to.
 *
 * Declared with method syntax so the real `node:fs` functions, whose parameters are wider than
 * these, assign to it.
 */
export type JsonStoreIo = {
  mkdirSync(dir: string, options: { recursive: true }): unknown
  openSync(path: string, flags: 'w'): number
  writeFileSync(handle: number, data: string): void
  fsyncSync(handle: number): void
  closeSync(handle: number): void
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { force: true }): void
}

/** The real filesystem. The default, and the only one anything outside a test passes. */
export const NODE_IO: JsonStoreIo = {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
}

/**
 * Replaces `file` with `value`, atomically.
 *
 * Write to a temp file, flush it, then rename over the real one. A torn `state.json` used to cost
 * one forgotten folder, which `readState` already degrades to first run — but that object now
 * carries the shell's mode and a remote server URL as well, and a torn `slicers.json` costs every
 * binding the user has made; then half a file loses the whole configuration rather than one path.
 * `renameSync` replaces an existing file on Windows as well as on POSIX, which is what lets this
 * be a rename and not a delete-then-write.
 *
 * **The `fsync` is the half that makes it survive a crash and not only a concurrent reader.**
 * Without it the rename can reach the directory before the data reaches the disk — ext4's
 * `data=ordered` and NTFS both allow it — and what a reader finds afterwards is a zero-length
 * file, which is the exact outcome the paragraph above says this prevents.
 *
 * The temp file carries this process's pid, so two instances of the app writing the same file at
 * the same moment cannot land on each other's temp: each renames its own complete file over the
 * target, and the loser of the race is a whole write that was overwritten rather than a torn one.
 *
 * What is still not forced is the *directory* entry: an fsync on the containing directory (not
 * possible on Windows) is what would make the rename itself durable. Left, and stated: the
 * failure it guards is a power cut in the millisecond after the rename, and its cost is one
 * forgotten choice, not a corrupt one.
 */
export function writeJsonFile(file: string, value: unknown, io: JsonStoreIo = NODE_IO): void {
  io.mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    const handle = io.openSync(temp, 'w')
    try {
      io.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`)
      io.fsyncSync(handle)
    } finally {
      io.closeSync(handle)
    }
    io.renameSync(temp, file)
  } catch (error) {
    // A temp file that never became the real file is litter in the user's `userData`. This
    // removes the one this call made; a hard kill *between* the flush and the rename still leaves
    // one behind, and nothing sweeps those — a sweep would race a second instance of the app
    // mid-write, and the litter is one short file per crash.
    io.rmSync(temp, { force: true })
    throw error
  }
}
