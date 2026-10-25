// `pnpm --filter @spm/desktop dev`: the desktop app with the web app served by Vite.
//
// Starts `tauri dev`, which runs the web dev server (`beforeDevCommand`) and the app, with the app
// told to serve its UI from that dev server (`SPM_DEV_UI_ORIGIN`) instead of the bundle compiled
// into it. This opens a real window; it is for a developer at a desk, never for a test.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const child = spawn('pnpm', ['exec', 'tauri', 'dev', ...process.argv.slice(2)], {
  cwd: here,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, SPM_DEV_UI_ORIGIN: 'http://127.0.0.1:5173' },
})
child.on('exit', (code) => process.exit(code ?? 1))
