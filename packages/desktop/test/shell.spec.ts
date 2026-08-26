import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { launchApp } from './fixtures.ts'

/**
 * What "the shell works" means, asserted on what the app actually rendered.
 *
 * A window count and an element-exists check both pass against a blank window — B2 shipped a
 * viewer that rendered every model on its side under 203 green tests, and a bundle guard whose
 * markers matched nothing at all. So every assertion here is either on painted content, on the
 * process's own exit status, or on bytes the app wrote to disk.
 */

const APP_TITLE = 'Slicer Project Manager'

test.describe('the desktop shell', () => {
  let app: ElectronApplication
  let page: Page
  let libraryDir: string

  // One Electron process and one library folder for every test in this block, because starting
  // one costs a couple of seconds and none of these tests writes anything the next reads. That
  // holds only while playwright.config.ts keeps `workers: 1` and `fullyParallel: false`: a test
  // added here that navigates the page, closes the window or writes to the library would be
  // changing state the tests around it are asserting on. Anything like that gets its own
  // `launchApp()`, the way the exit-status test at the bottom does.
  test.beforeAll(async () => {
    ;({ app, libraryDir } = await launchApp())
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('opens exactly one window, named for the app', async () => {
    // Polled, not snapshotted. `app.windows()` is whatever Playwright had seen by the time it
    // was called, so a second window opened a tick late would slip past a bare read — and the
    // failure this guards against is one window too many, which arrives after the first.
    await expect.poll(() => app.windows().length).toBe(1)
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe(APP_TITLE)

    const [nativeTitle] = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.getTitle()),
    )
    expect(nativeTitle).toBe(APP_TITLE)
    // On its own the line above is worthless, and it took two mutations to see it: a window
    // with no document at all still reports this title, because a BrowserWindow with no
    // `title` option falls back to `app.getName()`. So it is pinned to the document's own
    // title, which is empty when nothing loaded. Together they say the OS window is showing
    // what the app rendered, rather than Electron's default.
    expect(nativeTitle).toBe(await page.title())
  })

  test('the Angular app boots inside it and paints', async () => {
    // Every string below is rendered by Angular from the translation bundle, not present in
    // the built index.html: finding them means bootstrapApplication ran, the app initializer
    // resolved translations, the router ran its guards, and a lazily-loaded route component
    // compiled and painted. Serving index.html alone gets none of them.
    await expect(page).toHaveTitle(APP_TITLE)

    const brand = page.locator('app-root .spm-brand')
    await expect(brand).toBeVisible()
    await expect(brand).toHaveText(APP_TITLE)

    const loginPage = page.locator('spm-login-page')
    await expect(loginPage.locator('h1')).toHaveText('Sign in')
    await expect(loginPage.locator('input[autocomplete="username"]')).toBeVisible()

    // Visible is Playwright's non-empty-bounding-box check, but only of the element itself;
    // this says the form as a whole occupies real space, which a stylesheet that failed to
    // load would not produce.
    const box = await loginPage.locator('form').boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(100)
    expect(box?.height ?? 0).toBeGreaterThan(100)
  })

  test('the renderer is served from spm://, and the router can navigate', async () => {
    // Not `loadFile`: the Angular build emits `<base href="/">`, so under file:// every asset
    // resolves to file:///main.js and <app-root> stays empty. Measured -- as was the correction
    // to it, since this comment first claimed history.pushState throws there and it does not.
    // See app.ts for why `spm://app/` is still the right answer over a relative base href.
    //
    // The settled route is /login, not /projects: the app asks for /projects, the auth guard
    // reads `requiresAuth` from CapabilitiesStore, and until task 2's IPC bridge exists there
    // is nothing to answer `capabilities()` with, so the store falls back to its offline
    // defaults where requiresAuth is true. That the router *got here* is the proof of
    // navigation -- the initial URL was spm://app/ and this is three redirects later. Task 2
    // changes the expected value below to spm://app/projects.
    await expect.poll(() => page.url()).toBe('spm://app/login')
  })

  test('refuses a renderer request that escapes the renderer directory', async () => {
    // An encoded separator survives Chromium's URL canonicalisation, where a literal `..` and a
    // `%2e%2e` do not. Without the containment check in resolveRendererFile the first of these
    // returns 200 and a file from outside the renderer directory. Both separators are here
    // because this handler runs on Windows too, where `resolve()` treats `\` as one.
    //
    // `%zz` is not an escape at all: it made decodeURIComponent throw URIError, which rejected
    // the handler's promise and reached the renderer as a bare `TypeError: Failed to fetch`
    // with an unhandled rejection logged in the main process. A malformed path is a 404.
    //
    // Task 3 owns path containment for the library itself; this is only about what the renderer
    // host can reach.
    const statuses = await page.evaluate(async () => {
      const urls = [
        'spm://app/..%2f..%2f..%2fpackage.json',
        'spm://app/..%5c..%5c..%5cpackage.json',
        'spm://app/%zz',
      ]
      const out: Record<string, number | string> = {}
      for (const url of urls) {
        try {
          out[url] = (await fetch(url)).status
        } catch (error) {
          out[url] = `threw ${String(error)}`
        }
      }
      return out
    })
    expect(statuses).toEqual({
      'spm://app/..%2f..%2f..%2fpackage.json': 404,
      'spm://app/..%5c..%5c..%5cpackage.json': 404,
      'spm://app/%zz': 404,
    })
  })

  test('the window keeps the three webPreferences the trust model rests on', async () => {
    // Constraint 3 of the plan, and the reason the renderer can be treated as untrusted at all.
    // Nothing else in this file notices if they change: with `nodeIntegration: true` and
    // `sandbox: false` every other test here stays green, including the preload-bridge one,
    // which looks like it covers this and does not.
    //
    // Read from the main process on purpose. A renderer-side `typeof require` check is the
    // obvious test and the wrong one -- `contextIsolation: true` keeps Node's globals out of
    // the main world even with nodeIntegration back on, so it stays green through exactly the
    // change it is supposed to catch. getLastWebPreferences() is what the window is actually
    // running with, not what was passed in.
    //
    // This lives in task 1 rather than task 2 because task 2 is where someone reaches for
    // `sandbox: false` to make a preload easier to write -- see the note in preload.ts.
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      // Present and documented at runtime, but absent from electron.d.ts in 44.0.0, so the cast
      // is unavoidable. It is written to yield null rather than throw if the method ever goes:
      // toMatchObject on null fails, where an optional call quietly returning undefined into a
      // loose assertion would not.
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences?: () => Record<string, unknown> | null
      }
      return contents.getLastWebPreferences?.() ?? null
    })
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    })
  })

  test('the preload bridge is installed on the window', async () => {
    // Task 2 puts invoke() on this object. Asserting it exists now is not ceremony: a
    // sandboxed preload that fails to load takes the whole bridge with it and says so only in
    // the renderer console, so the first symptom without this test would be task 2's IPC
    // "not working" for a reason that has nothing to do with task 2.
    expect(await page.evaluate(() => typeof (globalThis as { spm?: unknown }).spm)).toBe('object')
  })

  test('opens, migrates and seeds the library it was pointed at', async () => {
    // Ruling C-3: the shell takes a library path and opens it, so task 4 can replace where the
    // path comes from without touching any of this. Asserting on the database the app wrote,
    // because "no error was thrown" is not evidence that a migration ran.
    await expect
      .poll(() => {
        try {
          const db = new DatabaseSync(join(libraryDir, '.spm', 'app.db'), { readOnly: true })
          try {
            const { user_version } = db.prepare('PRAGMA user_version').get() as {
              user_version: number
            }
            const users = db.prepare('SELECT username, library_dir FROM users').all()
            return { user_version, users }
          } finally {
            db.close()
          }
        } catch {
          return null
        }
      })
      .toEqual({
        // The migrations were bundled next to main.js and read through import.meta.url; a CJS
        // bundle or a missing dist/migrations leaves this at 0.
        user_version: 2,
        // ensureLocalUser's single flat-library user (spec 2.6), not reimplemented here.
        users: [{ username: 'local', library_dir: '.' }],
      })
  })
})

test('the renderer boots without a console error or warning', async () => {
  // Its own launch, because the listener has to be attached before the document loads and the
  // shared app in the block above is already past that by the time a test runs.
  //
  // The reason this exists is the content security policy: without one Chromium accepts a
  // fetch to anywhere, and Electron says so on every start with "Electron Security Warning
  // (Insecure Content-Security-Policy)". That warning is a console message like any other, so
  // rather than assert on the header — which says only that a string was sent — this asserts
  // that Chromium and Electron between them had nothing to complain about. It doubles as a
  // tripwire for the renderer's own errors, of which there are currently none.
  const { app } = await launchApp()
  const page = await app.firstWindow()
  const complaints: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      complaints.push(`${message.type()}: ${message.text().replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  })
  page.on('pageerror', (error) => complaints.push(`pageerror: ${error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.url()).toBe('spm://app/login')
  expect(complaints).toEqual([])
  await app.close()
})

test('the process exits 0 when the last window closes', async () => {
  const { app } = await launchApp()
  await app.firstWindow()
  const exited = new Promise<number | null>((resolveExit) => {
    app.process().once('exit', (code) => resolveExit(code))
  })
  // Closing the window, not app.quit(): what is under test is the window-all-closed handler,
  // and that the library opened at startup is closed cleanly on the way out.
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close()
    })
    .catch(() => {
      // The app may already be gone by the time the reply would come back.
    })
  expect(await exited).toBe(0)
})
