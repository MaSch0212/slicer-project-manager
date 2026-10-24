import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { parseFileRequest } from '../src/files.ts'
import { windowIconFile } from '../src/icons.ts'
import { firstWindowOf, launchApp, MAIN_BUNDLE } from './fixtures.ts'

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
    page = await firstWindowOf(app)
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
    // an intact model as damaged.
    //
    // **Four of these entries changed meaning in task 3, and the list did not.** A first attempt
    // at this paragraph said two, counted by eye; it was wrong, and the count is now *derived*
    // below instead of written down, because this is the third time in this subsystem that a
    // comment has described a list more confidently than it could support.
    //
    // The four are the ones whose pathname, once canonicalised, *is* the canonical spelling:
    // `_spm/files/abc/{raw,thumb}` plainly, and `./_spm/…` and `x/../_spm/…` because Chromium
    // resolves `.` and `..` before the handler sees anything -- exactly as the inline comment
    // further down already said. Those four are claimed by `parseFileRequest` and answered by
    // `serveLibraryFile`, which 404s because this library holds no file `abc`. The other
    // thirteen are still refused by the SPA-fallback guard, and must stay refused: an alias that
    // answered would be a second way to name a file.
    //
    // Both branches answer an identical `404 not found` -- deliberate, since "no such id" and
    // "not a file request" are the same non-answer to a caller -- so the status assertion below
    // cannot tell them apart. That is what the derived split is for.
    //
    // Measured rather than reasoned, with a temporary marker body on the SPA branch and every
    // URL below fetched through the real protocol: four came back from the file branch and
    // thirteen from the guard. `new URL(...).pathname` in Node agreed with Chromium's own
    // canonicalisation on all seventeen, which is what makes the derivation below trustworthy.
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
     *
     * These are *routes*, and they are answered with index.html. The root-level **files** the
     * public folder contributes -- the six icon assets and the manifest, all new since this list
     * was written -- are not here on purpose: they are served as themselves, so `200 <!doctype
     * html>` is the wrong expectation for them and a right-looking entry would assert the
     * opposite of what should happen. They have their own test below, which asserts the content
     * type each one comes back with.
     */
    const PASSTHROUGH_URLS = [
      'spm://app/projects/some-id',
      'spm://app/_spmx/files/abc/raw',
      'spm://app/_spm%09/files/abc/raw',
      'spm://app/_spm%c2%a0/files/abc/raw',
    ]

    // Which branch answers which, derived from the parser itself rather than asserted by hand.
    // This is the count the paragraph above used to get wrong, and now it cannot: adding an
    // alias that canonicalises onto the reserved path, or changing `parseFileRequest` so it
    // claims one more spelling, moves an entry between the two lists and fails here.
    const claimedByFileBranch = RESERVED_URLS.filter(
      (url) => parseFileRequest(new URL(url).pathname) !== null,
    )
    expect(claimedByFileBranch).toEqual([
      'spm://app/_spm/files/abc/raw',
      'spm://app/_spm/files/abc/thumb',
      // `.` and `x/..` are gone by the time the handler sees the path.
      'spm://app/./_spm/files/abc/raw',
      'spm://app/x/../_spm/files/abc/raw',
    ])
    // And every alias that is *not* claimed has its canonicalised pathname in `files.test.ts`'s
    // not-a-file-request list, so the parser's refusal of it is covered there directly. Checked
    // when this was written and kept honest by the assertion above, which is what would show up
    // red if a new alias joined the list without joining that one.
    expect(RESERVED_URLS.length - claimedByFileBranch.length).toBe(13)

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

  test('every root-level icon asset is served, with its own content type', async () => {
    // These six files arrived with the app icons, and they are the only things in the renderer
    // directory that nothing in the bundle imports -- so a build that stopped emitting them, or a
    // handler that stopped recognising one, breaks nothing that any other test in this repo
    // watches. What it breaks is a tab with no favicon and an Android home screen with a grey
    // square, which nobody notices until a user says so.
    //
    // The content type is the assertion and not the status, because the status was never the
    // failure. `.webmanifest` was missing from CONTENT_TYPES when this was written and the file
    // came back **200 application/octet-stream** -- measured, from the renderer, before the map
    // gained its tenth entry. Chromium refuses a manifest that is not served as JSON, so the
    // Android icon would not have worked in a browser either. A status-only assertion is green
    // through all of that.
    //
    // They are also the other half of what `PASSTHROUGH_URLS` above is for. That list proves the
    // reserved-prefix guard does not swallow ordinary routes; this proves it does not swallow the
    // root-level *files* the public folder now contributes, which are new since the guard was
    // written. `urls.ts` carries the reasoning for why none of them may begin with `_`.
    const served = await page.evaluate(async () => {
      const out: Record<string, string> = {}
      for (const name of [
        'favicon.ico',
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'manifest.webmanifest',
      ]) {
        const response = await fetch(`spm://app/${name}`)
        const head = new Uint8Array((await response.arrayBuffer()).slice(0, 4))
        const hex = [...head].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        const magic = hex.startsWith('89504e47')
          ? 'png'
          : hex.startsWith('00000100')
            ? 'ico'
            : hex.startsWith('3c3f786d')
              ? 'svg'
              : hex.startsWith('3c21646f')
                ? 'html'
                : head[0] === 0x7b
                  ? 'json'
                  : hex
        out[name] = `${response.status} ${response.headers.get('content-type')} ${magic}`
      }
      return out
    })
    // The third field is the file's own magic bytes, classified. A status and a content type
    // together still pass against a handler that answered every one of these with index.html --
    // which is exactly what a missing asset looks like -- so the body has to say what it is.
    // `html` is in the classifier for that reason: it is the wrong answer this is looking for,
    // and it reads as one in the diff rather than as a hex string.
    //
    // A byte count was the first version of this and it was worse in a way worth recording: the
    // manifest is 464 bytes, so `byteLength > 500` failed on the one file whose type mattered most.
    expect(served).toEqual({
      'favicon.ico': '200 image/x-icon ico',
      'favicon.svg': '200 image/svg+xml svg',
      'apple-touch-icon.png': '200 image/png png',
      'icon-192.png': '200 image/png png',
      'icon-512.png': '200 image/png png',
      'manifest.webmanifest': '200 application/manifest+json json',
    })
  })

  test('the app manifest is fetched and parsed under the renderer own CSP', async () => {
    // `manifest-src 'self'` in CONTENT_SECURITY_POLICY, and this test exists because the obvious
    // way to check it reports nothing. Adding `<link rel="manifest">` to index.html and loading
    // the shell produced **no violation at all**: Chromium fetches a manifest lazily and nothing
    // in Electron asks for one, because there is no install prompt here. So the block was latent,
    // and a test that watched `securitypolicyviolation` on a normal load would have been green
    // with the directive removed.
    //
    // `Page.getAppManifest` is what asks. Measured with `manifest-src` absent: `errors` empty but
    // `url` and `data` both **empty strings**, and `manifest-src <- spm` fired on the document at
    // the same moment. With it present, this.
    const cdp = await page.context().newCDPSession(page)
    const manifest = (await cdp.send('Page.getAppManifest')) as {
      url: string
      data: string
      errors: unknown[]
    }
    expect(manifest.errors).toEqual([])
    expect(manifest.url).toBe('spm://app/manifest.webmanifest')
    // Parsed here rather than asserted as a string: what matters is that Chromium handed back the
    // real file, and `tools/icons.test.ts` is what holds the contents to their meaning.
    const parsed = JSON.parse(manifest.data) as { name: string; icons: { src: string }[] }
    expect(parsed.name).toBe(APP_TITLE)
    expect(parsed.icons.map((icon) => icon.src)).toEqual(['icon-192.png', 'icon-512.png'])
  })

  test('the brand mark beside the title is loaded, not a broken image', async () => {
    // `naturalWidth`, because every cheaper check passes on a broken image: the element is in the
    // DOM either way, and `complete` is true for a failed load too. This is also the one assertion
    // that covers the path -- the `<img src="favicon.svg">` in app.ts resolves through
    // `<base href="/">`, so it is `spm://app/favicon.svg` here and not a lookup relative to
    // whatever route the window happens to be on.
    const mark = page.locator('.spm-brand-mark')
    await expect(mark).toBeVisible()
    const loaded = await mark.evaluate((element: HTMLImageElement) => ({
      src: element.currentSrc,
      width: element.naturalWidth,
      hidden: element.getAttribute('aria-hidden'),
      alt: element.getAttribute('alt'),
    }))
    expect(loaded.src).toBe('spm://app/favicon.svg')
    expect(loaded.width).toBeGreaterThan(0)
    // Decorative, and it has to stay that way: the link's own text already names the app, so an
    // alt here would have a screen reader announce the name twice. The link's accessible name is
    // asserted below, which is what would fail if someone gave the image one of its own.
    expect(loaded.alt).toBe('')
    expect(loaded.hidden).toBe('true')
    await expect(page.getByRole('link', { name: APP_TITLE, exact: true })).toBeVisible()
  })

  test('the window icon is beside the bundle and Electron decodes it', async () => {
    // Two failures in one, and neither is visible from the repo. `windowIconPath()` resolves
    // `./icons/<file>` against the *bundle*, so an icon left in `packages/desktop/icons/` and
    // never copied by build.ts resolves to nothing -- and `BrowserWindow`'s `icon` option does not
    // throw on a missing path, it silently shows Electron's own default. A developer never sees
    // that, because in the repo layout the file happens to be findable anyway.
    //
    // `nativeImage.createFromPath` is the decoder that actually consumes this file, which is why
    // the check runs in the main process rather than against a byte count here.
    // `tools/icons.test.ts` takes the same two files apart frame by frame; this is the part that
    // only Electron can answer.
    const file = windowIconFile(process.platform)
    expect(file).not.toBeNull()
    const iconPath = resolve(dirname(MAIN_BUNDLE), 'icons', file as string)
    const decoded = await app.evaluate(({ nativeImage }, path) => {
      const image = nativeImage.createFromPath(path)
      return { empty: image.isEmpty(), size: image.getSize() }
    }, iconPath)
    expect(decoded.empty).toBe(false)
    // Electron picks one frame out of an .ico rather than reporting them all; whichever it picked
    // has to be square and a real size, which is what a zero-sized 256 frame would fail.
    expect(decoded.size.width).toBe(decoded.size.height)
    expect(decoded.size.width).toBeGreaterThanOrEqual(16)
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

  test('the menu bar is hidden, and the menu it would have shown still exists', async () => {
    // `autoHideMenuBar` is a live property of the real `BrowserWindow` `createMainWindow` returned,
    // not an option echoed back -- reading it here is reading the window Electron is actually
    // running, the same reasoning as the webPreferences test above. There is no seam that reports
    // the constructor argument on its own, and building one for this would test a mock's call
    // record rather than the window.
    const autoHide = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.autoHideMenuBar,
    )
    expect(autoHide).toBe(true)

    // Hiding the bar must not have taken the menu with it: `Menu.setApplicationMenu(null)` was
    // rejected for exactly this (spec 5) because it deletes the item `remote.spec.ts` drives by
    // id. Resolving the id here is the same claim at rest, without clicking it -- the click is
    // that other file's job.
    const hasChooseLibrary = await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('spm-choose-library') != null,
    )
    expect(hasChooseLibrary).toBe(true)
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
          mode: bridge?.['mode'],
          answersABoolean: typeof (
            bridge?.['canStreamFromDisk'] as ((f: unknown) => unknown) | undefined
          )?.(new Blob([new Uint8Array([1])])),
        }
      }),
    ).toEqual({
      typeofBridge: 'object',
      // `mode` is task 5's, and it is a *value* rather than a call for the reason the other two
      // are calls: `API_CLIENT`'s Angular factory is synchronous, so the transport has to be
      // readable without awaiting anything. This launch has a library folder, so it is `local`.
      keys: ['canStreamFromDisk', 'invoke', 'mode'],
      typeofInvoke: 'function',
      mode: 'local',
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
        user_version: 3,
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
  const page = await firstWindowOf(app)
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

test('the app own session refuses what nothing asks for, and grants the one thing that does', async () => {
  /*
   * Open question 9.20, closed. Spec 3.7 recorded that `defaultSession` had **no** permission
   * handler of either kind, which is Electron's "neither handler" column: geolocation and
   * notifications granted with no prompt. It was recorded rather than fixed because a blanket deny
   * could have removed `users.page.ts`'s copy control and nothing in the suite would have noticed.
   *
   * That is now measured rather than reasoned about, and this is the assertion that keeps it
   * measured. Both halves are one test on purpose: a handler that denied everything would pass the
   * geolocation half and silently break the copy, and a session with no handler at all would pass
   * the copy half and grant geolocation to anything.
   *
   * **The clipboard write is driven by a real click**, because `writeText` needs transient user
   * activation on a focused document and `page.evaluate` supplies neither — an unactivated call
   * rejects for a reason that has nothing to do with the permission handler, which is a green test
   * that proves nothing. Its own launch, because it appends a node to the document.
   */
  const { app } = await launchApp()
  const page = await firstWindowOf(app)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'spm-clipboard-probe'
    button.addEventListener('click', () => {
      const store = window as unknown as { copied?: string }
      navigator.clipboard.writeText('spm').then(
        () => {
          store.copied = 'ok'
        },
        (error: unknown) => {
          store.copied = `rejected: ${String(error)}`
        },
      )
    })
    document.body.append(button)
  })
  await page.click('#spm-clipboard-probe')
  // `clipboard-sanitized-write` is the permission Chromium raises for `writeText`, measured — a
  // handler written against the web API's own spelling, `clipboard-write`, denies this.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied))
    .toBe('ok')

  // And the check handler, which is the half that answers `navigator.permissions.query` without
  // ever raising a request: with the request handler alone this reads `granted`, measured on the
  // browse partition and again here.
  const states = await page.evaluate(async () => {
    const names = ['geolocation', 'notifications', 'clipboard-write']
    const out: Record<string, string> = {}
    for (const name of names) {
      out[name] = (await navigator.permissions.query({ name } as never)).state
    }
    return out
  })
  expect(states).toEqual({
    geolocation: 'denied',
    notifications: 'denied',
    'clipboard-write': 'granted',
  })
  await app.close()
})

test('the process exits 0 when the last window closes', async () => {
  const { app } = await launchApp()
  await firstWindowOf(app)
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
