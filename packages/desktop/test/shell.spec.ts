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

  test.beforeAll(async () => {
    ;({ app, libraryDir } = await launchApp())
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('opens exactly one window, named for the app', async () => {
    expect(app.windows()).toHaveLength(1)
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
    // The renderer cannot be loaded with `loadFile`. The Angular build emits `<base href="/">`,
    // so under file:// every asset resolves to file:///main.js and <app-root> stays empty
    // (measured); and a file:// document has an opaque origin, where history.pushState throws
    // and the router cannot move. `spm://app/` is a standard scheme with a real origin, so
    // both work.
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
    // An encoded slash survives Chromium's URL canonicalisation, where a literal `..` and a
    // `%2e%2e` do not. Without the containment check in resolveRendererFile this exact URL
    // returns 200 and a file from outside the renderer directory. Task 3 owns the library's
    // own path containment; this is only about what the renderer host can reach.
    const status = await page.evaluate(
      async () => (await fetch('spm://app/..%2f..%2f..%2fpackage.json')).status,
    )
    expect(status).toBe(404)
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
