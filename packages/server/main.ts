import {
  closeLibrary,
  consoleSink,
  createLogger,
  DEFAULT_LOG_LEVEL,
  EMBEDDED_HANDLER,
  ensureBootstrapAdmin,
  LOG_LEVELS,
  MESH_HANDLER,
  openLibrary,
  parseLogLevel,
  pruneExpiredSessions,
  runPreviewQueue,
} from '@spm/core'
import { denoDevProxy, resolveDevUiOrigin } from './src/dev-proxy.ts'
import { makeHandler } from './src/router.ts'
import { routes } from './src/routes/index.ts'

const libraryDir = Deno.env.get('SPM_LIBRARY_DIR')
if (!libraryDir) {
  console.error('SPM_LIBRARY_DIR is required')
  Deno.exit(1)
}
const port = Number(Deno.env.get('SPM_PORT') ?? '8000')

// Refused rather than ignored, matching how SPM_PUBLIC_ORIGIN treats a malformed value: a
// typo'd level that silently fell back to the default would look like the logging itself
// was broken. Unset is not a typo, so it takes the default without complaint.
const rawLevel = Deno.env.get('SPM_LOG_LEVEL')
const level = rawLevel === undefined ? DEFAULT_LOG_LEVEL : parseLogLevel(rawLevel)
if (level === null) {
  console.error(
    `SPM_LOG_LEVEL="${rawLevel}" is not a log level. Use one of: silent, ${LOG_LEVELS.join(', ')}`,
  )
  Deno.exit(1)
}

const DEFAULT_PREVIEW_INTERVAL_MS = 30_000

// Refused rather than clamped, for the same reason as the log level above. Overridable mainly
// because 30 seconds is a bad edit-refresh loop for anyone working on previews, and because the
// e2e suite has to watch a thumbnail actually appear rather than sit out a tick to do it.
const rawPreviewInterval = Deno.env.get('SPM_PREVIEW_INTERVAL_MS')
const previewIntervalMs =
  rawPreviewInterval === undefined ? DEFAULT_PREVIEW_INTERVAL_MS : Number(rawPreviewInterval)
if (!Number.isInteger(previewIntervalMs) || previewIntervalMs < 1) {
  console.error(
    `SPM_PREVIEW_INTERVAL_MS="${rawPreviewInterval}" is not a whole number of milliseconds above zero`,
  )
  Deno.exit(1)
}

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
setInterval(() => {
  if (previewRunInFlight) {
    log.debug('preview tick skipped, previous run still in flight')
    return
  }
  previewRunInFlight = true
  // Both handlers passed explicitly rather than leaning on the core default, which stays
  // "only what needs no rendering": deciding to spend CPU on rasterizing belongs to whoever
  // runs the library, not to core.
  runPreviewQueue(lib, { limit: 20, handlers: [EMBEDDED_HANDLER, MESH_HANDLER] })
    .catch((error) => log.error('preview queue run failed', { err: error }))
    .finally(() => (previewRunInFlight = false))
}, previewIntervalMs)
setInterval(() => {
  const pruned = pruneExpiredSessions(lib.db)
  if (pruned) log.info('pruned expired sessions', { count: pruned })
}, PRUNE_INTERVAL_MS)

// Development only: forward everything outside /api/ to a running `ng serve` so one
// origin serves both halves of the app and the UI does not have to be rebuilt to be seen.
const devUiOrigin = resolveDevUiOrigin(Deno.env.get('SPM_DEV_UI_ORIGIN'))
if (devUiOrigin) log.warn('serving the UI from the dev server', { origin: devUiOrigin })

const handler = makeHandler(routes, {
  lib,
  log,
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
