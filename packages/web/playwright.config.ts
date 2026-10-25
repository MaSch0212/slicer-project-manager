import { defineConfig, devices } from '@playwright/test'

// Its own port, so a developer's `pnpm dev:web` on 5173 never collides with a test run.
const PORT = 5174
const ORIGIN = `http://127.0.0.1:${PORT}`

/**
 * Headless is forced, here and not left to a flag: a test run must never open a window or take
 * focus. The server binds 127.0.0.1 for the same reason as every other local listener (a firewall
 * prompt on Windows otherwise).
 *
 * Web part 3 replaces this webServer with `spm-server` over a temporary library.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
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
