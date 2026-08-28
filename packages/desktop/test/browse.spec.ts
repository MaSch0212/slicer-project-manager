import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BROWSE_PARTITION } from '../src/browse/host.ts'
import { firstWindowOf, launchApp } from './fixtures.ts'

/**
 * The containment, against a real Electron window.
 *
 * **This file exists because the obvious instrument is the wrong one.** `getLastWebPreferences()`
 * — which `shell.spec.ts` uses correctly for the main window's trust flags — returns 15 keys and
 * **`preload` is not one of them**, and the object it returns is byte-identical for the
 * bridge-holding window and for a view with no bridge at all. So a test that reads it to assert
 * "the browse view has no preload" passes in the exact configuration measured to hand `ipcMain` to
 * a model site. The only instrument that answered is `typeof window.spm` read **inside the
 * embedded document**, and that is the first test below.
 *
 * **Everything is pointed at a local HTTP server this file starts.** Nothing in CI may depend on
 * Thingiverse being up, on a Cloudflare challenge clearing, or on a consent dialog's shape.
 *
 * A note on what several of these assertions can and cannot discriminate, because two of them look
 * stronger than they are. Chromium refuses a renderer-initiated navigation to an unregistered
 * custom scheme on its own, and the browse partition refuses `spm://` on its own — so "the view
 * stayed put" is true whether or not this app's policy is attached. Where that is the case the
 * assertion that actually goes red is the **refusal record**: `BrowseStateDto.lastError` carries a
 * sentence this app writes, and deleting the hook that writes it leaves either `null` or Chromium's
 * own error text in its place. Each such test says so where it stands.
 */

/** What the local server answers with, so a page's identity is assertable from its title. */
function pageHtml(title: string, body = ''): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

test.describe('the model browser', () => {
  let app: ElectronApplication
  let page: Page
  let server: Server
  let base: string

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0]
      if (path === '/redirect-to-custom-scheme') {
        // The shape that only `will-redirect` sees. Measured on Electron 44: this reaches
        // `will-redirect` and **not** `will-navigate`, so a suite that drives `will-navigate`
        // alone is green with that arm missing.
        response.writeHead(302, { location: 'bambustudio://open?model=1' })
        response.end()
        return
      }
      if (path === '/redirect-to-page') {
        response.writeHead(302, { location: '/second' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        pageHtml(`spm test ${path}`, `<a id="lnk" href="/second" target="_blank">go</a>`),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    ;({ app } = await launchApp())
    page = await firstWindowOf(app)
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /* -----------------------------------------------------------------------------------------
   * Helpers
   * -------------------------------------------------------------------------------------- */

  /** One `ApiClient` call, over the real bridge, exactly as the `/browse` page will make it. */
  async function invoke(path: string, args: unknown[] = []): Promise<unknown> {
    const result = await page.evaluate(
      ([callPath, callArgs]) => globalThis.spm.invoke(callPath as string, callArgs as unknown[]),
      [path, args] as const,
    )
    if (!result.ok) throw new Error(`${path} failed: ${result.error.code} ${result.error.message}`)
    return result.value
  }

  type State = {
    attached: boolean
    url: string | null
    title: string | null
    isLoading: boolean
    canGoBack: boolean
    canGoForward: boolean
    siteId: string | null
    lastError: string | null
  }

  const state = async (): Promise<State> => (await invoke('browse.state')) as State

  /** Attaches at `url` and waits for the document to arrive. */
  async function attachAt(url: string): Promise<void> {
    await invoke('browse.attach', [{ x: 0, y: 0, width: 1200, height: 700 }, url])
    await expect
      .poll(async () => (await state()).title, { timeout: 15_000 })
      .toBe(`spm test ${new URL(url).pathname}`)
  }

  /**
   * The id of the view's own `webContents`, so every main-process read below can name it directly
   * instead of walking the window again.
   *
   * `contentView.children` is where the view lives and the *renderer's* own contents is not in it
   * — measured: a `BrowserWindow` with a loaded page reports `children.length === 0` until a
   * `WebContentsView` is added, and 0 again after it is removed. So a child here is the browse view
   * and there is nothing to disambiguate.
   */
  async function browseContentsId(): Promise<number> {
    return await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as
        { webContents?: { id: number } } | undefined
      if (!child?.webContents) throw new Error('there is no browse view on the window')
      return child.webContents.id
    })
  }

  /** How many views are on the window. One while attached, none after `detach`. */
  async function viewCount(): Promise<number> {
    return await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? 0,
    )
  }

  /**
   * Runs a script **inside the embedded document**, through the view's own `webContents`.
   *
   * This is the instrument the whole file turns on. It is reached from the main process because
   * there is no other way in: a `WebContentsView` is a native sibling of the renderer, not a DOM
   * element, so Playwright has no page object for it.
   */
  async function inBrowseView<T>(script: string): Promise<T> {
    const id = await browseContentsId()
    return (await app.evaluate(
      async ({ webContents }, [contentsId, source]) => {
        const contents = webContents.fromId(contentsId as number)
        if (!contents) throw new Error('the browse view has gone')
        return await contents.executeJavaScript(source as string, true)
      },
      [id, script] as const,
    )) as T
  }

  /* -----------------------------------------------------------------------------------------
   * The bridge
   * -------------------------------------------------------------------------------------- */

  test('the embedded document cannot see the bridge', async () => {
    // **The assertion this whole subsystem is written around** (E constraints 8 and 9).
    //
    // It is read inside the embedded document, at a third-party origin, because that is the only
    // instrument that answers. Measured: a `WebContentsView` given `webPreferences.preload` —
    // otherwise sandboxed and context-isolated, and reporting a `getLastWebPreferences()` object
    // byte-identical to this one's — reported `typeof window.spm === 'object'` with all three keys
    // and returned a real `ipcMain` answer from `invoke('projects.list', [])`, at a remote origin.
    //
    // Mutation, run: adding `preload: preloadPath()` to the one `webPreferences` in
    // `browse/host.ts` turns this test red and leaves every other test in this file green.
    await attachAt(`${base}/first`)

    const bridge = await inBrowseView<{ typeofBridge: string; keys: string[]; node: string[] }>(`
      ({
        typeofBridge: typeof window.spm,
        keys: Object.keys(window.spm ?? {}),
        node: [typeof require, typeof process, typeof module].map(String),
      })
    `)
    expect(bridge.typeofBridge).toBe('undefined')
    expect(bridge.keys).toEqual([])
    // Node's globals too, which is `sandbox`/`nodeIntegration` seen from where it matters. Not a
    // substitute for the flags test below: with `contextIsolation: true` these stay `undefined`
    // even with `nodeIntegration` back on, which is exactly why that test reads the main process.
    expect(bridge.node).toEqual(['undefined', 'undefined', 'undefined'])

    // The control, in the same test: the *renderer's* document has the bridge, so an `undefined`
    // above cannot be a broken instrument reading a page that never loaded.
    expect(
      await page.evaluate(() => ({
        typeofBridge: typeof globalThis.spm,
        keys: Object.keys(globalThis.spm ?? {}).sort(),
      })),
    ).toEqual({ typeofBridge: 'object', keys: ['canStreamFromDisk', 'invoke', 'mode'] })
  })

  test('the view keeps its four trust flags', async () => {
    // `getLastWebPreferences()` cannot answer the preload question — see the file docblock — and
    // that is not a reason to stop asking it the questions it can answer. Without this,
    // `webSecurity: false` on that one constructor turns nothing red: it would switch off the
    // same-origin policy for third-party content inside a process that serves the user's files,
    // and no assertion in this file reads a cross-origin fetch.
    await attachAt(`${base}/first`)
    const id = await browseContentsId()
    const prefs = await app.evaluate(({ webContents }, contentsId) => {
      // Present and documented at runtime, but absent from electron.d.ts in 44.0.0, so the cast is
      // unavoidable — the same one `shell.spec.ts` makes for the window.
      const readable = webContents.fromId(contentsId) as unknown as {
        getLastWebPreferences?: () => Record<string, unknown> | null
      } | null
      return readable?.getLastWebPreferences?.() ?? null
    }, id)
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    // And the shape of the instrument itself, recorded rather than remembered: `preload` is not a
    // key of this object. If a future Electron adds one, this line fails and the file docblock
    // above — and constraint 9 with it — is due a re-reading.
    expect(Object.keys(prefs as Record<string, unknown>)).not.toContain('preload')
  })

  /* -----------------------------------------------------------------------------------------
   * The partition
   * -------------------------------------------------------------------------------------- */

  test('the view is on its own persistent partition, not the default session', async () => {
    await attachAt(`${base}/first`)
    const id = await browseContentsId()
    const session = await app.evaluate(({ session: electronSession, webContents }, contentsId) => {
      const contents = webContents.fromId(contentsId)
      return {
        isDefault: contents?.session === electronSession.defaultSession,
        storagePath: contents?.session.getStoragePath() ?? null,
        defaultStoragePath: electronSession.defaultSession.getStoragePath(),
      }
    }, id)
    expect(session.isDefault).toBe(false)
    // The runtime guard for the session-scoped-preload defect as well as for the partition: a
    // preload registered on `defaultSession` reaches every webContents on it, and a view that is
    // not on it cannot inherit one.
    expect(session.storagePath?.endsWith('spm-browse')).toBe(true)
    expect(session.storagePath).not.toBe(session.defaultStoragePath)
  })

  test('spm:// is served on the default session and not on the browse partition', async () => {
    // **Both halves in one assertion, so a null instrument is visible.** `isProtocolHandled`
    // answering `false` for everything — a wrong session object, a scheme spelled wrong — would
    // pass a test that only asked about the browse partition.
    const handled = await app.evaluate(
      ({ session }, partition) => ({
        onDefault: session.defaultSession.protocol.isProtocolHandled('spm'),
        onBrowse: session.fromPartition(partition).protocol.isProtocolHandled('spm'),
      }),
      BROWSE_PARTITION,
    )
    expect(handled).toEqual({ onDefault: true, onBrowse: false })

    // The positive form. `loadURL` from the main process is a browser-initiated navigation and
    // reaches **neither** `will-navigate` nor `will-frame-navigate` — measured: with all three
    // hooks attached, a main-process `loadURL` of an ordinary page produced an empty hook log — so
    // what refuses this is the partition, not this app's policy.
    await attachAt(`${base}/first`)
    const id = await browseContentsId()
    const attempt = await app.evaluate(async ({ webContents }, contentsId) => {
      const contents = webContents.fromId(contentsId)
      if (!contents) throw new Error('the browse view has gone')
      try {
        await contents.loadURL('spm://app/')
        return { rejected: false, message: '', url: contents.getURL() }
      } catch (error) {
        return { rejected: true, message: String(error), url: contents.getURL() }
      }
    }, id)
    expect(attempt.rejected).toBe(true)
    expect(attempt.message).toContain('ERR_FAILED')
    expect(attempt.url).toBe(`${base}/first`)
  })

  /* -----------------------------------------------------------------------------------------
   * The four navigation hooks
   * -------------------------------------------------------------------------------------- */

  test('the navigation policy is on the view’s own webContents', async () => {
    // **The measurement this test exists for**: with `applyNavigationPolicy` attached to the
    // *window* exactly as `app.ts` does it, a `loadURL` and an in-page `location.href` inside an
    // embedded view both completed with an **empty hook log**. Asserting
    // `browseNavigationPolicy(url) === 'block'` as a unit test is necessary and says nothing about
    // that.
    //
    // **Which half of this discriminates.** Chromium refuses a renderer-initiated navigation to an
    // unregistered custom scheme on its own — measured, with no policy attached at all, the view
    // stayed put — so `getURL()` below is true either way. The discriminator is `lastError`: it is
    // a sentence *this app* writes, and with the hooks gone it is `null` or Chromium's own text.
    await attachAt(`${base}/first`)
    await inBrowseView(`location.href = 'bambustudio://open?model=2'; 'go'`)
    await expect
      .poll(async () => (await state()).lastError, { timeout: 10_000 })
      .toBe('the model browser does not open bambustudio: URLs')
    expect((await state()).url).toBe(`${base}/first`)
    // The URL is *not* in the message. It is rendered inside the document that holds the bridge,
    // and a site chooses it (spec 3.10).
    expect((await state()).lastError).not.toContain('model=2')
  })

  test('all three navigation listeners are on the view’s own webContents', async () => {
    /*
     * **This exists because the behavioural tests around it overlap, and a mutation proved it.**
     *
     * Deleting the `will-frame-navigate` arm left every other test in this file green: an in-page
     * `location.href` in the *main frame* reaches `will-navigate` too, and it writes the same
     * `lastError`. Deleting `will-navigate` is symmetrical. Constraint 11's named failure — three
     * of the four attached — therefore has no behavioural discriminator here, and there is a
     * reason it cannot easily have one:
     *
     * - What only `will-frame-navigate` covers is a **subframe**. Every scheme this policy blocks
     *   is also one Chromium refuses from a subframe of an `http` page, so "the iframe stayed put"
     *   is true with the arm deleted; and a subframe refusal is deliberately kept out of
     *   `lastError`, because an ad frame failing to reach a custom scheme is not the page the user
     *   asked for having failed.
     * - What only `will-navigate` covers is `window.open(url, '_self')`, which reaches it alone —
     *   and that is again a main-frame navigation Chromium refuses on its own.
     *
     * So the discriminator is the registration itself, read off the **real** `webContents` rather
     * than off a double. It is a weaker assertion than a behavioural one and it is the assertion
     * that is available; the arms' *behaviour* is covered by the two tests either side of this one
     * and by `browse-host.test.ts`, which drives each listener directly.
     */
    await attachAt(`${base}/first`)
    const id = await browseContentsId()
    const counts = await app.evaluate(({ webContents }, contentsId) => {
      const contents = webContents.fromId(contentsId)
      return {
        frame: contents?.listenerCount('will-frame-navigate') ?? 0,
        navigate: contents?.listenerCount('will-navigate') ?? 0,
        redirect: contents?.listenerCount('will-redirect') ?? 0,
        // The control: an event nothing in this app hooks on the browse view. Without it a
        // `listenerCount` that answered 1 for everything would pass the three above.
        unhooked: contents?.listenerCount('console-message') ?? 0,
      }
    }, id)
    expect(counts).toEqual({ frame: 1, navigate: 1, redirect: 1, unhooked: 0 })
  })

  test('a 302 into a custom scheme is refused by will-redirect', async () => {
    // Measured: this redirect reaches `will-redirect` and **not** `will-navigate`, so a suite that
    // only drives `will-navigate` is green with this arm missing. As above, "the view stayed put"
    // is true either way — Chromium fails the unregistered scheme itself, and `loadURL` then
    // rejects with a bare `ERR_FAILED (-2)`. What goes red with the arm deleted is `lastError`,
    // which becomes that error string instead of this sentence.
    await attachAt(`${base}/first`)
    await invoke('browse.navigate', [`${base}/redirect-to-custom-scheme`])
    await expect
      .poll(async () => (await state()).lastError, { timeout: 10_000 })
      .toBe('the model browser does not open bambustudio: URLs')
    expect((await state()).url).toBe(`${base}/first`)

    // The allow arm of the same hook, so the assertion above is not satisfied by a `will-redirect`
    // that refuses everything — which would break every site that redirects, i.e. all of them.
    await invoke('browse.navigate', [`${base}/redirect-to-page`])
    await expect.poll(async () => (await state()).url, { timeout: 10_000 }).toBe(`${base}/second`)
    expect((await state()).lastError).toBeNull()
  })

  test('a plain _blank link navigates the view itself and opens no window', async () => {
    await attachAt(`${base}/first`)
    const before = await windowUrls(app)

    await inBrowseView(`document.getElementById('lnk').click(), 'clicked'`)
    await expect.poll(async () => (await state()).url, { timeout: 10_000 }).toBe(`${base}/second`)

    // No second top-level window. With no handler installed at all, `window.open` from embedded
    // content produces a real `BrowserWindow` on the opener's session, outside every piece of
    // chrome `/browse` draws.
    expect(await windowUrls(app)).toEqual(before)
  })

  test('a deferred window.open is not denied at the about:blank step', async () => {
    // E decision 12's second arm: `const w = window.open(); w.location = url` reaches the handler
    // with the target `about:blank`, **before** the site has named its destination — so a
    // deny-everything handler kills the open rather than the destination, and with it the popup
    // half of every sign-in flow (spec 5.7 makes logging in the user's own job).
    await attachAt(`${base}/first`)
    const before = await windowUrls(app)

    const opened = await inBrowseView<string>(
      `(() => { const w = window.open(); if (!w) return 'null'; w.location = '${base}/deferred'; return 'window' })()`,
    )
    // `window.open` returned a window rather than `null`, which is what `{ action: 'deny' }` gives
    // the caller — measured.
    expect(opened).toBe('window')

    const popup = await expectPopup(app, `${base}/deferred`)
    // It landed on the browse partition and it has no bridge of its own, which is what makes
    // allowing it safe. Measured across 21 variants: a popup never inherits the opener's preload,
    // and a supplied one through this handler gives it a full live bridge at any origin — which is
    // why the flags are named in the handler rather than left to inheritance.
    expect(popup.storagePath?.endsWith('spm-browse')).toBe(true)
    expect(popup.bridge).toBe('undefined')
    expect(popup.prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })

    // Closed by hand, so the tests after this one see the window count they started with.
    await app.evaluate(({ BrowserWindow }, target) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL() === target) window.destroy()
      }
    }, `${base}/deferred`)
    await expect.poll(() => windowUrls(app)).toEqual(before)
  })

  /* -----------------------------------------------------------------------------------------
   * Permissions
   * -------------------------------------------------------------------------------------- */

  test('the browse session’s permission handlers deny, and the default session’s never fires', async () => {
    // Each session needs its own — the default session's handler fired only for the default
    // session's view — so an assertion that does not check *which* handler fired can pass on the
    // wrong one. The recorder below is installed on `defaultSession` and **grants**: if the browse
    // view were on that session, this test would fail twice, once on the recorder and once on the
    // answer.
    await app.evaluate(({ session }) => {
      const recorder = globalThis as unknown as { __spmDefaultPermissions?: string[] }
      recorder.__spmDefaultPermissions = []
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
        recorder.__spmDefaultPermissions?.push(permission)
        callback(true)
      })
    })
    await attachAt(`${base}/first`)

    const answer = await inBrowseView<{ geolocation: string; query: string }>(`
      (async () => ({
        geolocation: await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve('denied:' + e.code))),
        query: await navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state, (e) => 'err:' + e.message),
      }))()
    `)
    expect(answer.geolocation).toBe('denied:1')
    // **`setPermissionCheckHandler` is what answers this, and it is measured rather than assumed.**
    // Spec 9.5 records it as unmeasured. Three partitions on Electron 44.0.0: with only the
    // request handler set this answered `"granted"`; with both, `"denied"`; with neither, the
    // query answered `"granted"` and the geolocation request was granted outright. So deleting the
    // check-handler line turns this line red and nothing else.
    expect(answer.query).toBe('denied')

    const fired = await app.evaluate(
      () =>
        (globalThis as unknown as { __spmDefaultPermissions?: string[] }).__spmDefaultPermissions ??
        [],
    )
    expect(fired).toEqual([])
  })

  /* -----------------------------------------------------------------------------------------
   * Bounds and lifecycle, on a real window
   * -------------------------------------------------------------------------------------- */

  test('the view never covers the chrome inset, and a sub-minimum request hides it', async () => {
    // Spec 9.6's open question is whether the inset achieves the property it is written for, and
    // it says the only way to answer it is to build the route and use it. This is the part that
    // can be answered before the route exists: the rectangle the main process actually applied.
    await attachAt(`${base}/first`)
    const zoom = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0,
    )
    expect(zoom).toBe(1)

    await invoke('browse.setBounds', [{ x: 0, y: 0, width: 4000, height: 4000 }])
    const placed = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const child = window?.contentView.children[0]
      return {
        bounds: child?.getBounds() ?? null,
        content: window?.getContentBounds() ?? null,
        visible: child?.getVisible() ?? null,
      }
    })
    // The whole window was asked for; the band at the top is not given away.
    expect(placed.bounds?.y).toBe(120)
    expect(placed.visible).toBe(true)
    expect((placed.bounds?.y ?? 0) + (placed.bounds?.height ?? 0)).toBe(placed.content?.height)

    await invoke('browse.setBounds', [{ x: 10, y: 200, width: 1, height: 1 }])
    const shrunk = await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows()[0]?.contentView.children[0]
      return { bounds: child?.getBounds() ?? null, visible: child?.getVisible() ?? null }
    })
    // Hidden, and **not** given the rectangle: a `1x1` view is a live third-party page running
    // where nobody can see it.
    expect(shrunk.visible).toBe(false)
    expect(shrunk.bounds).toEqual(placed.bounds)
  })

  test('detach destroys the view rather than hiding it', async () => {
    await attachAt(`${base}/first`)
    expect(await viewCount()).toBe(1)
    const id = await browseContentsId()

    await invoke('browse.detach')

    // Off the window **and** destroyed, which are two different things: a view merely removed from
    // the content view is still a live third-party page running script, holding sockets and able
    // to start a download nobody is watching. Spec 4.3 rejects hiding for exactly that, and the
    // `webContents` lookup below is what tells the two apart — `close()` is asynchronous, so it is
    // polled rather than read once.
    expect(await viewCount()).toBe(0)
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, contentsId) => webContents.fromId(contentsId)?.isDestroyed() ?? true,
          id,
        ),
      )
      .toBe(true)
    expect(await state()).toMatchObject({ attached: false, url: null, title: null })
  })

  test('a second attach destroys the first view rather than stacking another', async () => {
    await attachAt(`${base}/first`)
    const first = await browseContentsId()
    await attachAt(`${base}/second`)
    const second = await browseContentsId()

    expect(second).not.toBe(first)
    expect(await viewCount()).toBe(1)
    // The destruction of the *first* one, not merely that one view is left: a host that dropped
    // its reference without closing would leave a live page with no owner, and a count check
    // cannot see it.
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, contentsId) => webContents.fromId(contentsId)?.isDestroyed() ?? true,
          first,
        ),
      )
      .toBe(true)
    expect((await state()).url).toBe(`${base}/second`)
    await invoke('browse.detach')
  })

  /* -----------------------------------------------------------------------------------------
   * The remembered page
   * -------------------------------------------------------------------------------------- */

  test('the last page is remembered, and clearLastPage forgets it', async () => {
    await attachAt(`${base}/remembered`)
    await invoke('browse.detach')

    // No URL this time: the default is the remembered page, which is why that entry exists and is
    // also why it is named in the contract for what it is — one line of persisted third-party
    // browsing history the user did not ask for.
    await invoke('browse.attach', [{ x: 0, y: 0, width: 1200, height: 700 }])
    await expect
      .poll(async () => (await state()).url, { timeout: 15_000 })
      .toBe(`${base}/remembered`)

    await invoke('browse.detach')
    await invoke('browse.clearLastPage')
    // With nothing remembered the default is the registry's first start URL — asserted as a
    // *refusal to reach the network* rather than by loading it: `attach` with no URL now names
    // Thingiverse, and this suite must never depend on a site being up. Reading the state right
    // after the attach is enough to see which URL it went for.
    await invoke('browse.attach', [{ x: 0, y: 0, width: 1200, height: 700 }])
    const id = await browseContentsId()
    const started = await app.evaluate(
      ({ webContents }, contentsId) => webContents.fromId(contentsId)?.getURL() ?? '',
      id,
    )
    expect(started === '' || started.startsWith('https://www.thingiverse.com/')).toBe(true)
    await invoke('browse.detach')
  })
})

/**
 * The popup a deferred `window.open` produced, once it has arrived at its real destination.
 *
 * Found **by URL** rather than by index into `getAllWindows()`. An index is what the first version
 * of this did, and it reported the app's own window as though it were the popup — the ordering of
 * that list is not something to build an assertion on.
 */
async function expectPopup(
  app: ElectronApplication,
  url: string,
): Promise<{ storagePath: string | null; bridge: string; prefs: Record<string, unknown> | null }> {
  // Polled on the list rather than on a boolean, so a failure says what the windows actually are
  // instead of only that none of them is this.
  await expect.poll(() => windowUrls(app), { timeout: 15_000 }).toContain(url)

  return await app.evaluate(async ({ BrowserWindow }, target) => {
    const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === target)
    if (!popup) throw new Error('the popup went away')
    const readable = popup.webContents as unknown as {
      getLastWebPreferences?: () => Record<string, unknown> | null
    }
    return {
      storagePath: popup.webContents.session.getStoragePath(),
      bridge: (await popup.webContents.executeJavaScript('typeof window.spm')) as string,
      prefs: readable.getLastWebPreferences?.() ?? null,
    }
  }, url)
}

/** Every top-level window's URL. The instrument for "a site put a window on screen". */
function windowUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()),
  )
}
