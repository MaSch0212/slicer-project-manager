import { defineConfig } from '@playwright/test'

/**
 * The desktop suite drives a real Electron process, not a browser, so it has its own config
 * rather than joining `packages/web`'s: that one starts the Deno server and a Chromium against
 * it, and none of that applies here.
 */
export default defineConfig({
  testDir: './test',
  /* `.spec.ts` only. `test/dispatch.test.ts` is a `node --test` suite over the dispatch table
     with no Electron in it at all, and it runs in `deno task verify`; Playwright's default
     testMatch would also pick it up and run it a second time, under a runner whose `test()` it
     does not use. */
  testMatch: '**/*.spec.ts',
  /* Builds before anything runs, and fails the whole run if the build produced nothing. The
     tests must never be able to pass against a stale dist/. */
  globalSetup: './test/build.setup.ts',
  /* One retry, on CI only, and only because of what four consecutive CI failures turned out to
     be: the Electron process starts, prints Chromium's usual dbus and GPU complaints, and then
     never produces a window. Every one of the four passed on a re-run of the same commit, and
     the last of them held out for a full **90 seconds** — so it is not slowness, and it is not a
     failing assertion. The process stays alive throughout (`app.exit` would have closed it and
     given Playwright a different error), and nothing in the shell's own output says why; the
     startup warnings this suite's stderr pipe would show are emitted before the pipe can attach.

     What this is, and is not. A retried test is reported as **flaky**, not as passed, so the
     signal stays in the run rather than being deleted — and a test that fails twice still fails
     the job. It is not a licence for a flaky assertion: everything in this suite is
     deterministic against a library it created itself, and a genuine regression fails both
     attempts. Locally there are no retries at all, so a flake introduced during development is
     as loud as it ever was.

     **The cause is now known, and it is not this app.** Ruling C-21's diagnostic caught it twice:
     the main process reported `isReady: true, windowCount: 1, urls: ["spm://app/projects"]` for
     the whole ninety seconds Playwright spent waiting for the event announcing that window, and
     `app.windows()` was empty at the same moment. The event and the list come from one
     attachment, and when Playwright misses it neither has anything. That is a race between the
     harness and an Electron process this suite cannot close from the inside — see
     `firstWindowOf` in test/fixtures.ts, including the fallback that was tried and measured not
     to work. The retry stays until Playwright's Electron support stops dropping it. */
  retries: process.env['CI'] ? 1 : 0,
  /* Each spec launches its own Electron process against its own library folder; running two at
     once on one runner is contention for no gain, and the whole suite is a few seconds. */
  workers: 1,
  fullyParallel: false,
  /* A launch that never produces a window would otherwise sit on Playwright's 30s default and
     then fail with nothing useful.

     60s was "room for a cold Electron start on a loaded runner" and turned out not to be, three
     times in a row: the desktop job failed on first attempt with
     `firstWindow: Timeout 30000ms exceeded` and passed on a re-run of the same commit, once on
     the software-WebGL launch and twice on ordinary ones. `firstWindowOf` in test/fixtures.ts
     now waits 90s for the window, and a test's own budget has to be larger than the wait inside
     it or the hook simply fails first and reports the same slowness under a different name.

     This is patience, not a weaker assertion: the whole suite runs in about a minute and a half,
     so nothing on the normal path is anywhere near this, and the job's `timeout-minutes` is what
     bounds a genuine hang. */
  timeout: 120_000,
})
