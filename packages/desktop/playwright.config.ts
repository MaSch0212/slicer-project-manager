import { defineConfig } from '@playwright/test'

/**
 * The desktop suite drives a real Electron process, not a browser, so it has its own config
 * rather than joining `packages/web`'s: that one starts the Deno server and a Chromium against
 * it, and none of that applies here.
 */
export default defineConfig({
  testDir: './test',
  /* Builds before anything runs, and fails the whole run if the build produced nothing. The
     tests must never be able to pass against a stale dist/. */
  globalSetup: './test/build.setup.ts',
  /* Each spec launches its own Electron process against its own library folder; running two at
     once on one runner is contention for no gain, and the whole suite is a few seconds. */
  workers: 1,
  fullyParallel: false,
  /* A launch that never produces a window would otherwise sit on Playwright's 30s default and
     then fail with nothing useful; 60s is room for a cold Electron start on a loaded runner. */
  timeout: 60_000,
})
