import type { MeshLimits } from './mesh/limits.ts'
import { makeMeshHandler } from './mesh-handler.ts'
import { EMBEDDED_HANDLER, type PreviewHandler } from './queue.ts'

/**
 * The embedded-thumbnail handler, widened to `model` because this chain can afford it.
 *
 * A plain 3MF carries thumbnails as readily as a slicer project does — the 28 zip64 files in the
 * reference library classify as `model` (no slicer metadata at all, so `classify3mf` rule 5) and
 * 16 of them ship a 512² or 1024² `Metadata/thumbnail.png`. Claiming only `slicer_project` meant
 * all 28 were rasterized to 256²: slower than reading the picture out of the file, and a quarter
 * of the resolution that was already sitting in it.
 *
 * What makes the wider claim safe *here* and not in `queue.ts`'s default is `MESH_HANDLER` behind
 * it. A handler that declines returns `null`, and `null` from the last matching handler is a
 * terminal `unsupported`. In this chain an `.stl`, `.obj`, `.step` or `.stp` — not a zip, so
 * nothing to read — declines and lands on the rasterizer, which is the answer it wanted anyway.
 * In a list where this were the only handler, the same decline would blank the file permanently.
 *
 * Spread from `EMBEDDED_HANDLER` rather than rebuilt beside it, so there is exactly one `run` and
 * one base list of kinds. This constant is also deliberately not exported: the widening is a
 * property of *this chain*, and a second public handler constant differing only in coverage is
 * the kind of pair a future caller picks the wrong half of.
 */
const EMBEDDED_HANDLER_WITH_MODELS: PreviewHandler = {
  ...EMBEDDED_HANDLER,
  kinds: [...EMBEDDED_HANDLER.kinds, 'model'],
}

/**
 * The full preview chain, in the order `runPreviewQueue` must try it.
 *
 * **The order is the whole content of this file, and it exists exactly once.** It used to be
 * spelled out at the call site in `packages/server/main.ts` and again, independently, in the
 * test that pins it — so inverting the production array left every suite green and the property
 * "an embedded thumbnail wins" was asserted nowhere that could observe the running server.
 * Anything that wants the chain imports this, tests included; there is no second copy to drift.
 *
 * Embedded first because it is both cheaper (a zip entry read against a full mesh parse and
 * rasterize) and more faithful — it is the picture the slicer itself showed the user, plate and
 * all. Rasterizing is the fallback for the file that has no such picture, which in the reference
 * library is 326 of 374 projects.
 *
 * Not the queue's default. `runPreviewQueue`'s default stays `[EMBEDDED_HANDLER]`, because
 * deciding to spend CPU rasterizing belongs to whoever runs the library and not to core; core
 * owns only the question of what order to try things in once you have opted in. That is also why
 * the `model`-covering variant above is defined here and not exported from `queue.ts`: its wider
 * claim is only correct with a rasterizer behind it, which is exactly what this array is.
 *
 * A function, because the rasterizer's memory ceiling is an operator's setting (`SPM_MAX_MESH_MB`)
 * and the order is not. `main.ts` calls this with the ceiling it read; everything else takes
 * `PREVIEW_HANDLERS` below and gets the same order with the default.
 */
export function makePreviewHandlers(limits?: MeshLimits): readonly PreviewHandler[] {
  return [EMBEDDED_HANDLER_WITH_MODELS, makeMeshHandler(limits)]
}

/** The chain at its default mesh ceiling. */
export const PREVIEW_HANDLERS: readonly PreviewHandler[] = makePreviewHandlers()
