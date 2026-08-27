import {
  DEFAULT_MAX_MESH_BYTES,
  makePreviewHandlers,
  runPreviewQueue,
  type Library,
  type PreviewHandler,
} from '@spm/core'

/**
 * Who ticks the preview queue when there is no server.
 *
 * In the browser arm the Deno server does it (`packages/server/main.ts`), on a `setInterval` it
 * reads out of `SPM_PREVIEW_INTERVAL_MS`. In local-folder mode there is no server at all, so
 * without this a freshly opened folder shows every model as `pending` for ever and task 3's
 * `spm://app/_spm/files/<id>/thumb` has nothing to serve. This is the server's loop, in the same
 * shape and for the same reasons — the in-flight guard, the handler chain built once rather than
 * per tick, `runPreviewQueue` with `.catch(...).finally(...)` — with the three numbers re-derived
 * for a machine the user is also using for something else.
 *
 * It imports nothing from `electron`, so `test/previews.test.ts` drives it under plain
 * `node --test` against a real library on disk.
 */

/**
 * How often the queue is looked at, in milliseconds. **5 s, and 30 s (the server's default) is
 * the number it was weighed against.**
 *
 * What a tick costs when there is nothing to do is measured, not assumed: one full
 * `runPreviewQueue` against an idle library — the claim SELECT, which is indexed and returns no
 * rows — is **114 µs** (1 000 calls in 114.3 ms, Node 24.19.0 on Windows, a real library with one
 * project in it). At 5 s that is 0.002 % of one core, which is not a number worth trading
 * anything for.
 *
 * What it buys is latency, and on a desktop that latency is *watched*. The user picks a folder
 * and looks at a grid of blank tiles; every tick that passes with nothing claimed is a tile that
 * stays blank. `PREVIEW_BATCH_LIMIT` bounds a batch to 20 files, so draining a library of 374
 * projects (the reference library) costs 19 ticks of pure waiting: 95 s at 5 s, 570 s at 30 s.
 * Rendering dominates that total when the queue is rasterizing, but not when it is reading
 * embedded thumbnails out of slicer projects — which is the fast path and the common one.
 *
 * Not shorter than 5 s, because the win keeps shrinking against the batch size while the cost of
 * waking a laptop out of an idle state every second does not. The first tick does not wait for
 * the interval at all — `startPreviewTicker` runs one immediately — so this number never delays
 * the first batch, only the ones after it.
 */
export const PREVIEW_INTERVAL_MS = 5_000

/**
 * How many previews are rendered at once. **One**, which is core's `DEFAULT_CONCURRENCY`, passed
 * explicitly rather than left to the default so the budget below is visible at the call site.
 *
 * It is a memory decision, and it multiplies with `PREVIEW_MAX_MESH_BYTES`: each worker may hold
 * one mesh, so the two numbers are one budget. B1 measured a worker's peak at about 290 MB
 * against a 256 MB ceiling (208.8 MB for the largest mesh in the reference library, plus a fixed
 * reader window), and the whole backfill at 400–410 MB of peak RSS with one worker against
 * 620 MB with two — for 1.5 % less wall-clock on one machine and 0 % on another, because parsing
 * and rasterizing are CPU-bound JavaScript on one thread.
 *
 * The desktop shell has two reasons to keep it at one where a server might not. This process is
 * not only the queue: it is also Electron's browser process, the IPC dispatch table and the
 * `spm://` handler that serves the very thumbnails this produces, all on the same thread. And it
 * is sharing the machine with whatever the user is doing — a slicer, a browser, the model they
 * are printing from. A second worker doubles the peak of the one process the UI cannot afford to
 * have swapped out, and buys nothing measurable.
 */
export const PREVIEW_CONCURRENCY = 1

/** The mesh ceiling, and with `PREVIEW_CONCURRENCY` the whole memory budget: 1 x 256 MB. */
export const PREVIEW_MAX_MESH_BYTES = DEFAULT_MAX_MESH_BYTES

/**
 * How many rows one tick claims. The server's number.
 *
 * It bounds neither memory (that is `PREVIEW_CONCURRENCY`) nor total throughput — only how much
 * work one run holds the in-flight guard for, and so how long a run keeps a closed library's
 * handle alive when the user switches folders mid-render. `LibraryHost` does not wait for it (see
 * the release path there), which is what keeps this from being a latency number as well.
 */
export const PREVIEW_BATCH_LIMIT = 20

export type PreviewTicker = {
  /**
   * Stops the timer and resolves when the run that may be in flight has finished. Callers that
   * are about to close the library must await this, or `runPreviewQueue` writes its result into
   * a database that is no longer open.
   */
  stop(): Promise<void>
}

export type PreviewTickerOptions = {
  intervalMs?: number
  concurrency?: number
  limit?: number
  maxMeshBytes?: number
  /**
   * The chain to run, defaulting to core's full one at the ceiling above. `runPreviewQueue` takes
   * the same option for the same reason: the order belongs to core, the decision to spend CPU on
   * rasterizing belongs to whoever runs the library. `test/previews.test.ts` passes a handler it
   * can block, which is how the in-flight guard and `stop()` are observed at all.
   */
  handlers?: readonly PreviewHandler[]
}

export function startPreviewTicker(lib: Library, opts: PreviewTickerOptions = {}): PreviewTicker {
  const intervalMs = opts.intervalMs ?? PREVIEW_INTERVAL_MS
  const limit = opts.limit ?? PREVIEW_BATCH_LIMIT
  const concurrency = opts.concurrency ?? PREVIEW_CONCURRENCY
  // Once, not per tick: the chain is stateless and the only thing this shell contributes to it
  // is the mesh ceiling. Its *order* is core's and is not respelled here — see
  // `makePreviewHandlers`, which is the one place it exists.
  const handlers =
    opts.handlers ??
    makePreviewHandlers({ maxMeshBytes: opts.maxMeshBytes ?? PREVIEW_MAX_MESH_BYTES })

  let inFlight: Promise<void> | null = null
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    // Belt to `claimPendingPreviews`'s braces. The claim is what makes an overlap *harmless*;
    // this is what stops one happening, so a batch slower than the interval does not pile up a
    // tick's worth of no-op runs behind it.
    if (inFlight) {
      lib.log.debug('preview tick skipped, previous run still in flight')
      return
    }
    inFlight = runPreviewQueue(lib, { limit, concurrency, handlers })
      .then(() => {})
      .catch((error: unknown) => lib.log.error('preview queue run failed', { err: error }))
      .finally(() => {
        inFlight = null
      })
  }

  const timer = setInterval(tick, intervalMs)
  // Immediately, before the first interval elapses: the folder was just opened and the user is
  // looking at the grid it produced. Everything a rescan queued is already claimable.
  tick()

  return {
    async stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
