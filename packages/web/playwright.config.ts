import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const libraryDir = process.env['SPM_E2E_LIBRARY'] ?? mkdtempSync(join(tmpdir(), 'spm-e2e-'))
// The tests reach into the library on disk (the rescan case drops a folder into it), so the
// path has to be visible to the test process too, not just to the server it starts.
process.env['SPM_E2E_LIBRARY'] = libraryDir

export default defineConfig({
  testDir: './e2e',
  // Every spec drives the same server against the same library on disk, so they are not
  // independent: the import spec's rescan will adopt a folder the rescan spec is about to
  // assert on, and that spec then sees "Adopted 0". CI defaults to a worker per core, which
  // is what turned a latent sharing problem into a failure. Serial is also barely slower
  // here -- the whole suite is a few seconds.
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:8123' },
  webServer: {
    // `--config ../../deno.json` is load-bearing, not belt-and-braces. Deno discovers its
    // configuration by walking up from the entrypoint and stops at the first config it
    // meets — here that is `packages/web/package.json`, whose dependencies do not include
    // `@spm/core`, so the root import map is never consulted and the seed script dies with
    // `Import "@spm/core" not a dependency`. Naming the root config skips that.
    command: [
      'pnpm --filter @spm/web exec ng build',
      `deno run -A --config ../../deno.json ../../packages/web/e2e/seed.ts "${libraryDir}"`,
      'deno run -A --config ../../deno.json ../server/main.ts',
    ].join(' && '),
    cwd: '.',
    url: 'http://localhost:8123/api/capabilities',
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      SPM_LIBRARY_DIR: libraryDir,
      SPM_PORT: '8123',
      SPM_WEB_ROOT: 'dist/web/browser',
    },
  },
})
