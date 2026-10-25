// Runs spm-server for local development: bound to loopback only (no firewall prompt), with a
// throwaway library in the gitignored `.dev/library`, serving the UI from the Vite dev server.
//
//   pnpm dev:web      in one terminal  (Vite on http://127.0.0.1:5173)
//   pnpm dev:server   in another       (open http://127.0.0.1:8000)
//
// Any SPM_* variable already in the environment wins, so `SPM_PORT=9000 pnpm dev:server` works.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const library = join(root, '.dev', 'library')
mkdirSync(library, { recursive: true })

const child = spawn('cargo', ['run', '-p', 'spm-server'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    SPM_HOST: '127.0.0.1',
    SPM_LIBRARY_DIR: library,
    SPM_DEV_UI_ORIGIN: 'http://127.0.0.1:5173',
    ...process.env,
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code) => process.exit(code ?? 1))
