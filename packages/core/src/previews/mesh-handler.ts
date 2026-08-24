import { readFileSync } from 'node:fs'
import type { Mesh } from './mesh/mesh.ts'
import { parseObj } from './mesh/obj.ts'
import { parseStl } from './mesh/stl.ts'
import { parse3mfMesh } from './mesh/threemf.ts'
import { encodePng } from './png.ts'
import { renderMesh } from './raster.ts'
import type { PreviewHandler, PreviewJob, PreviewOutput } from './queue.ts'

/**
 * The lowercased extension including its dot, or '' when the path has no dot at all.
 *
 * Lowercased because the reference library contains `.STL` files and `classifyFile` lowercases
 * before matching, so they reach this handler as `kind: 'model'`. Dropping the fold would
 * return `null` for them, and `unsupported` is terminal — every uppercase model in the library
 * would go permanently blank. A test pins it.
 *
 * `lastIndexOf` over the whole path rather than over its basename, and that is safe rather than
 * merely untested: any dot in a *directory* name is necessarily followed by a separator, and no
 * separator can appear inside one of the three extensions matched below. So a dotted directory
 * can only ever produce a false negative, for a file with no extension of its own
 * (`v1.2/README`) — and `null`, meaning unsupported, is the right answer there anyway. It can
 * never produce a false positive. `classifyFile` reasons about the whole path the same way.
 */
function extensionOf(absPath: string): string {
  const dot = absPath.lastIndexOf('.')
  return dot === -1 ? '' : absPath.slice(dot).toLowerCase()
}

/**
 * Reads whichever mesh format `absPath` names, or `null` if it names none of them.
 *
 * The three parsers are deliberately *not* forced into one shape. STL and OBJ are single
 * files, so they take the bytes this function reads; 3MF's geometry is one entry inside a zip,
 * and `parse3mfMesh` seeks straight to it. Reading a 3MF whole here just to hand it over would
 * hold the entire archive in memory — for the 54 MB projects the reference library contains,
 * next to the mesh it is about to allocate — for no gain at all.
 */
function readMesh(absPath: string): Mesh | null {
  switch (extensionOf(absPath)) {
    case '.stl':
      return parseStl(readFileSync(absPath))
    case '.obj':
      return parseObj(readFileSync(absPath))
    case '.3mf':
      return parse3mfMesh(absPath)
    default:
      return null
  }
}

/**
 * Renders a 256px isometric thumbnail for a file that carries no thumbnail of its own.
 *
 * Not part of the queue's default handler list: rasterizing is the expensive path, so a library
 * consumer opts into it (see `packages/server/main.ts`) rather than getting it by accident.
 *
 * **`slicer_project` is covered as well as `model`**, because a project saved but never sliced
 * embeds no thumbnail, and 326 of the 374 slicer projects in the reference library are in that
 * state — every one of them blank, because `unsupported` was the only outcome available to them
 * and nothing re-queues a row whose bytes have not changed. Widening the kind is safe rather
 * than merely convenient: `classifyFile` only ever reaches `classify3mf`, the sole producer of
 * `slicer_project`, for a path ending `.3mf`, so every job of that kind lands on the `.3mf` arm
 * of `readMesh` below. It is second in `PREVIEW_HANDLERS`, so a project that *does* carry a
 * thumbnail still uses it — cheaper, and closer to what the slicer showed the user.
 *
 * **`null` and a throw are different outcomes, and the difference is the point.** `null` is
 * "there is deterministically nothing to render here" and the queue records `unsupported` — the
 * right answer for a `model` file in a format this handler cannot read, because reading the same
 * bytes again will not change that. A throw is "this file should have rendered and did not",
 * which the queue records as `failed`.
 *
 * Neither state is retried by the queue itself (`claimPendingPreviews` selects only `pending`),
 * and both come back if `rescan` sees the file's content hash change. What actually separates
 * them is the row they leave behind: `failed` carries the error message, `unsupported` writes
 * `error = NULL`. So an exotic extension that somehow reached `kind: 'model'` returns `null`,
 * while a `.stl` whose bytes are corrupt lets the parser's `AppError('Validation', …)`
 * propagate — catching it here would file a real defect under the same blank, message-less row
 * as a file there was never anything to draw from.
 */
export const MESH_HANDLER: PreviewHandler = {
  kinds: ['model', 'slicer_project'],
  run: (job: PreviewJob): Promise<PreviewOutput | null> => {
    const mesh = readMesh(job.absPath)
    if (!mesh) return Promise.resolve(null)
    const { rgb, width, height } = renderMesh(mesh)
    return Promise.resolve({
      bytes: encodePng(rgb, width, height),
      width,
      height,
      source: 'rasterized' as const,
    })
  },
}
