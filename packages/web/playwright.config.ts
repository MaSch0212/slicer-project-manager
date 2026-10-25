import { defineConfig, devices } from '@playwright/test'

// Its own port, so a developer's `pnpm dev:web` on 5173 never collides with a test run.
const PORT = 5174
const ORIGIN = `http://127.0.0.1:${PORT}`

/**
 * Headless is forced, here and not left to a flag: a test run must never open a window or take
 * focus. Every listener binds 127.0.0.1 for the same reason (a firewall prompt on Windows
 * otherwise).
 *
 * The suite runs against real `spm-server` processes over throwaway libraries, serving the built
 * bundle (`pnpm e2e` builds it first): each spec file starts its own (see `e2e/support.ts`), so
 * files run in parallel workers without sharing data or the login rate limit. Only the UI gallery
 * spec needs the Vite dev server below, because `/_ui` exists in development builds only.
 */
export default defineConfig({
  testDir: './e2e',
  // Tests inside a file share that file's server and run in order; files run in parallel.
  fullyParallel: false,
  workers: Number(process.env['SPM_E2E_WORKERS'] ?? 3),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  // CI also writes the HTML report (with traces of failures) the workflow uploads.
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: ORIGIN,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true } }],
  webServer: {
    command: 'pnpm exec vite',
    env: { SPM_VITE_PORT: String(PORT) },
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
