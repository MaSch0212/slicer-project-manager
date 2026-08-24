import {
  closeLibrary,
  consoleSink,
  createLogger,
  ensureBootstrapAdmin,
  makePreviewHandlers,
  openLibrary,
  pruneExpiredSessions,
  runPreviewQueue,
} from '@spm/core'
import { denoDevProxy } from './src/dev-proxy.ts'
import { readServerEnv } from './src/env.ts'
import { makeHandler } from './src/router.ts'
import { routes } from './src/routes/index.ts'

/**
 * Every misconfiguration reaches the operator the same way: the one sentence the resolver in
 * `src/env.ts` wrote, naming the variable and what it wanted, then a non-zero exit.
 *
 * A sentence rather than a stack trace, because the fault is in their config and not in this
 * code, and because this runs before the logger exists — there is nowhere else for it to go.
 */
function orExit<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
  }
}

const {
  libraryDir,
  level,
  port,
  previewIntervalMs,
  previewConcurrency,
  maxMeshBytes,
  devUiOrigin,
  publicOrigin,
  webRoot,
} = orExit(() => readServerEnv((name) => Deno.env.get(name)))

const log = createLogger({ level, sink: consoleSink })
const lib = openLibrary(libraryDir, { logger: log })
log.info('library opened', { dir: lib.dir, logLevel: level })

const boot = await ensureBootstrapAdmin(lib)
if (boot) {
  // No default password exists anywhere (spec 5.4); this link is the only way in. It stays a
  // bare console.log rather than a log record: it is a one-off instruction to the operator,
  // and it must survive SPM_LOG_LEVEL=silent or the first run is unrecoverable.
  console.log(`First run: activate "${boot.username}" at /activate#${boot.token}`)
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// Belt to claimPendingPreviews's braces. The claim in core is what makes an overlap
// *harmless*; this is what stops one happening in the first place, so a batch that takes
// longer than the interval does not pile up a tick's worth of no-op runs behind it.
let previewRunInFlight = false
// Built once rather than per tick: the chain is stateless, and the only thing the environment
// contributes to it is the mesh ceiling read above.
const previewHandlers = makePreviewHandlers({ maxMeshBytes })
setInterval(() => {
  if (previewRunInFlight) {
    log.debug('preview tick skipped, previous run still in flight')
    return
  }
  previewRunInFlight = true
  // The chain passed explicitly rather than leaning on the core default, which stays "only what
  // needs no rendering": deciding to spend CPU on rasterizing belongs to whoever runs the
  // library, not to core. Its *order* is core's, and is not respelled here -- see
  // makePreviewHandlers, which is the one place it exists and the one place a test can pin it.
  //
  // `concurrency` is the other half of the memory budget: each worker may hold one mesh of up to
  // `maxMeshBytes`, so these two variables multiply. See the README.
  runPreviewQueue(lib, { limit: 20, concurrency: previewConcurrency, handlers: previewHandlers })
    .catch((error) => log.error('preview queue run failed', { err: error }))
    .finally(() => (previewRunInFlight = false))
}, previewIntervalMs)
setInterval(() => {
  const pruned = pruneExpiredSessions(lib.db)
  if (pruned) log.info('pruned expired sessions', { count: pruned })
}, PRUNE_INTERVAL_MS)

// Development only: everything outside /api/ is forwarded to a running `ng serve` so one
// origin serves both halves of the app and the UI does not have to be rebuilt to be seen.
if (devUiOrigin) log.warn('serving the UI from the dev server', { origin: devUiOrigin })

const handler = makeHandler(routes, {
  lib,
  log,
  publicOrigin,
  webRoot,
  serveUi: devUiOrigin ? denoDevProxy(devUiOrigin, log) : undefined,
})
const server = Deno.serve({ port, onListen: () => {} }, handler)

Deno.addSignalListener('SIGINT', () => {
  log.info('shutting down')
  server.shutdown().finally(() => {
    closeLibrary(lib)
    Deno.exit(0)
  })
})

log.info('listening', { url: `http://localhost:${port}` })
