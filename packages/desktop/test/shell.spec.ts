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

    // Task 1 asserted the login page here. Task 2's bridge answers `capabilities()` with
    // `requiresAuth: false`, so the auth guard no longer redirects and the settled route is
    // /projects — see the note in the navigation test below.
    const projectsPage = page.locator('spm-projects-page')
    await expect(projectsPage.locator('h1')).toHaveText('Projects')
    await expect(projectsPage.locator('input[jigInput]').first()).toBeVisible()

    // Task 1 measured a bounding box here, on the login form. That was a weak instrument and it
    // is worth saying why rather than porting it: an *unstyled* block element containing a row
    // of inputs also has a width and a height, so the numbers only ever ruled out a collapsed
    // box. This asks styles.css directly instead. `.spm-card` gets its border and padding from
    // there and from nowhere else, and both are resolved from jig theme custom properties that
    // only exist once provideJigControls has injected its rules — so a missing stylesheet, an
    // unstyled shell and a theme that never initialised are all `0px` / `0px none`.
    const card = await projectsPage.locator('.spm-filters').evaluate((element) => {
      const style = getComputedStyle(element)
      return { padding: style.paddingTop, border: style.borderTopWidth, box: element.clientWidth }
    })
    expect(card.padding).not.toBe('0px')
    expect(card.border).not.toBe('0px')
    expect(card.box).toBeGreaterThan(100)
  })

  test('the renderer is served from spm://, and the router can navigate', async () => {
    // Not `loadFile`: the Angular build emits `<base href="/">`, so under file:// every asset
    // resolves to file:///main.js and <app-root> stays empty. Measured -- as was the correction
    // to it, since this comment first claimed history.pushState throws there and it does not.
    // See app.ts for why `spm://app/` is still the right answer over a relative base href.
    //
    // The settled route is /projects. Task 1 settled at /login instead: the guard is
    // `!capabilities.requiresAuth || auth.isAuthenticated()`, and with no bridge neither arm
    // held -- CapabilitiesStore fell back to offline defaults (requiresAuth true) and
    // AuthStore.refresh() had nothing to ask. Task 2's bridge satisfies both, and measured by
    // mutation, *either* one alone is enough to get here. See bridge.spec.ts, which asserts the
    // capability value itself; this line only says the router got somewhere -- the initial URL
    // was spm://app/ and this is two redirects later.
    await expect.poll(() => page.url()).toBe('spm://app/projects')
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

  test('the reserved prefix 404s instead of being answered by the SPA shell', async () => {
    // Ruling C-7 chose a path prefix over a second host, and the price of a path prefix is that
    // the renderer's own index.html fallback will happily answer it: `_spm/files/<id>/raw` has
    // no extension resolveRendererFile knows, so before the guard every URL task 2 emits came
    // back **200 text/html** with the SPA in the body -- measured, and B2's viewer then reported
    // an intact model as damaged. Task 3 replaces these 404s with real bytes; until then they
    // must fail closed.
    //
    // The status *and* the body, because a 200 with HTML is the failure being guarded against
    // and a status-only assertion would pass on any 404-shaped mistake while missing this one.
    //
    // Every alias of the prefix this handler could be reached through. The first version of the
    // guard tested the decoded-but-unresolved path and let three of these through with a 200:
    // `x/..%2f_spm/…` (the encoded separator resolve() collapses afterwards -- the same escape
    // the containment check three lines up exists for), and `_spm.` and `_spm%20`, which NTFS
    // treats as the same directory. They are the reason the check now runs on the resolved path.
    const RESERVED_URLS = [
      'spm://app/_spm/files/abc/raw',
      'spm://app/_spm/files/abc/thumb',
      'spm://app/_spm',
      // NTFS is case-insensitive, so this reaches a real `_spm` directory.
      'spm://app/_SPM/files/abc/raw',
      // Percent-encoded, because the check runs after decodeURIComponent.
      'spm://app/%5f%73%70%6d/files/abc/raw',
      // The encoded separator: `x` looks like the first segment until resolve() removes it.
      'spm://app/x/..%2f_spm/files/abc/raw',
      'spm://app/x/..%5c_spm/files/abc/raw',
      // NTFS strips a trailing dot and a trailing space from a path component.
      'spm://app/_spm./files/abc/raw',
      'spm://app/_spm%20/files/abc/raw',
      // Win32 path APIs truncate at a NUL, so these name the reserved directory in the same
      // sense `_spm.` does. They answered 200 until a NUL anywhere in the path became a refusal
      // outright -- the trailing-character trim could never have caught `_spm%00x`.
      'spm://app/_spm%00/files/abc/raw',
      'spm://app/_spm%00x/files/abc/raw',
      // Canonicalised by Chromium before the handler sees them; here so a change to that
      // canonicalisation shows up as a failure rather than as a new hole.
      'spm://app//_spm/files/abc/raw',
      'spm://app/./_spm/files/abc/raw',
      'spm://app/x/../_spm/files/abc/raw',
      'spm://app/_spm%2ffiles/abc/raw',
      'spm://app/_spm?x=1',
      'spm://app/_spm#frag',
    ]

    /*
     * The other half of the boundary, and the reason this list exists at all: these are *not*
     * aliases for the reserved directory, and the SPA is the right answer for every one of them.
     * Without them the guard could be widened until it swallowed ordinary routes and no test
     * would notice. A tab and a non-breaking space are not stripped by Win32 the way a trailing
     * dot or space is, and `_spmx` shares only a prefix -- the reservation is the whole segment.
     */
    const PASSTHROUGH_URLS = [
      'spm://app/projects/some-id',
      'spm://app/_spmx/files/abc/raw',
      'spm://app/_spm%09/files/abc/raw',
      'spm://app/_spm%c2%a0/files/abc/raw',
    ]
    const answers = await page.evaluate(
      async (urls: string[]) => {
        const out: Record<string, string> = {}
        for (const url of urls) {
          try {
            const response = await fetch(url)
            out[url] = `${response.status} ${(await response.text()).slice(0, 15)}`
          } catch (error) {
            out[url] = `threw ${String(error)}`
          }
        }
        return out
      },
      [...RESERVED_URLS, ...PASSTHROUGH_URLS],
    )

    const expected: Record<string, string> = Object.fromEntries([
      ...RESERVED_URLS.map((url) => [url, '404 not found']),
      ...PASSTHROUGH_URLS.map((url) => [url, '200 <!doctype html>']),
    ])
    // `\` is a path separator on Windows and an ordinary filename character everywhere else, so
    // this one URL names two different things and only one of them is a bypass. On win32 the
    // `..\` collapses and it lands on the reserved directory, which must 404. On Linux and macOS
    // `..\_spm` is a single directory name that does not exist inside the renderer folder, so the
    // request never names the reserved directory at all and the SPA fallback is the correct
    // answer -- the same one any other unknown deep link gets. Written on Windows and measured on
    // both: the CI runner is what showed the second half.
    if (process.platform !== 'win32') {
      expected['spm://app/x/..%5c_spm/files/abc/raw'] = '200 <!doctype html>'
    }
    expect(answers).toEqual(expected)
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
      // is unavoidable. The `?? null` keeps the expression well typed if the method ever goes;
      // it is not load-bearing for the assertion, which was the original claim here and is
      // wrong -- measured: `toMatchObject(undefined)` throws in this Playwright version too, so
      // both spellings fail loudly.
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

  test('the preload bridge is installed on the window, and hands out nothing else', async () => {
    // A sandboxed preload that fails to load takes the whole bridge with it and says so only in
    // the renderer console. The members and not just the object: task 2 filled the bridge, and an
    // empty one is what a preload bundled as ESM by mistake would leave behind -- see build.ts.
    //
    // `canStreamFromDisk` answering a *boolean* is the property, not an implementation detail.
    // The first version of this handed the renderer an opaque token from a preload-side map of
    // live paths; that map was unbounded and its entries never expired -- 20 000 minted from the
    // main world in 12 ms, the first still redeemable -- so there is deliberately nothing here
    // now that the renderer can hold on to, store or replay.
    expect(
      await page.evaluate(() => {
        const bridge = (globalThis as { spm?: Record<string, unknown> }).spm
        return {
          typeofBridge: typeof bridge,
          keys: bridge ? Object.keys(bridge).sort() : null,
          typeofInvoke: typeof bridge?.['invoke'],
          answersABoolean: typeof (
            bridge?.['canStreamFromDisk'] as ((f: unknown) => unknown) | undefined
          )?.(new Blob([new Uint8Array([1])])),
        }
      }),
    ).toEqual({
      typeofBridge: 'object',
      keys: ['canStreamFromDisk', 'invoke'],
      typeofInvoke: 'function',
      answersABoolean: 'boolean',
    })
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
  await expect.poll(() => page.url()).toBe('spm://app/projects')
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
