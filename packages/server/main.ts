import {
  closeLibrary,
  ensureBootstrapAdmin,
  openLibrary,
  pruneExpiredSessions,
  runPreviewQueue,
} from '@spm/core'
import { makeHandler } from './src/router.ts'
import { routes } from './src/routes/index.ts'

const libraryDir = Deno.env.get('SPM_LIBRARY_DIR')
if (!libraryDir) {
  console.error('SPM_LIBRARY_DIR is required')
  Deno.exit(1)
}
const port = Number(Deno.env.get('SPM_PORT') ?? '8000')

const lib = openLibrary(libraryDir)

const boot = await ensureBootstrapAdmin(lib)
if (boot) {
  // No default password exists anywhere (spec 5.4); this link is the only way in.
  console.log(`First run: activate "${boot.username}" at /activate#${boot.token}`)
}

const PREVIEW_INTERVAL_MS = 30_000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
setInterval(() => {
  runPreviewQueue(lib, { limit: 20 }).catch((error) => console.error('preview queue', error))
}, PREVIEW_INTERVAL_MS)
setInterval(() => pruneExpiredSessions(lib.db), PRUNE_INTERVAL_MS)

const handler = makeHandler(routes, { lib })
const server = Deno.serve({ port }, handler)

Deno.addSignalListener('SIGINT', () => {
  server.shutdown().finally(() => {
    closeLibrary(lib)
    Deno.exit(0)
  })
})

console.log(`slicer-project-manager listening on http://localhost:${port}`)
