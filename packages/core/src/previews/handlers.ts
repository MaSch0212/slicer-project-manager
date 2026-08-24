import { MESH_HANDLER } from './mesh-handler.ts'
import { EMBEDDED_HANDLER, type PreviewHandler } from './queue.ts'

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
 * owns only the question of what order to try things in once you have opted in.
 */
export const PREVIEW_HANDLERS: readonly PreviewHandler[] = [EMBEDDED_HANDLER, MESH_HANDLER]
