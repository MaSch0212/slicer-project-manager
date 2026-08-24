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
 * Renders a 256px isometric thumbnail for a `model` file that carries no thumbnail of its own.
 *
 * Not part of the queue's default handler list: rasterizing is the expensive path, so a library
 * consumer opts into it (see `packages/server/main.ts`) rather than getting it by accident.
 *
 * **`null` and a throw are different outcomes, and the difference is the point.** `null` is
 * "there is deterministically nothing to render here" and the queue records `unsupported`,
 * never retrying — the right answer for a `model` file in a format this handler cannot read,
 * because reading it again will not change that. A throw is "this file should have rendered and
 * did not", which the queue records as `failed` against the retry budget that
 * `MAX_PREVIEW_ATTEMPTS` bounds. So an exotic extension that somehow reached `kind: 'model'`
 * returns `null`, while a `.stl` whose bytes are corrupt lets the parser's
 * `AppError('Validation', …)` propagate. Catching that here would bury a real problem as a
 * permanent, unretried "unsupported" and lose the error message with it.
 */
export const MESH_HANDLER: PreviewHandler = {
  kinds: ['model'],
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
