import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import { AppError } from '@spm/contract/errors.ts'
import {
  BROWSE_CHROME_INSET,
  BROWSE_MIN_AREA,
  BROWSE_PARTITION,
  BrowseHost,
  browseOpenDecision,
  browseViewBounds,
  MAX_REFUSAL_SCHEME,
} from '../src/browse/host.ts'
import { BROWSE_FILE_NAME, readLastPage, writeLastPage } from '../src/browse/last-page.ts'
import { MODEL_SITES } from '../src/browse/registry.ts'

/**
 * The bounds arithmetic, the window-open decision and the view's lifecycle, under plain
 * `node --test`.
 *
 * **What the double below is, and what it deliberately is not.** It records the calls this module
 * makes and models **none** of Electron's behaviour: nothing here navigates, nothing here decides
 * whether a preload is inherited, nothing here knows what a partition does. A fake that answered
 * those questions would be testing what its author believed Electron does — which is the one shape
 * of useless test this subsystem is most exposed to, because the whole of it is claims about
 * Electron. Every property that is Electron's own — the absent bridge, the partition, the four
 * hooks firing at all, the permission refusal, `spm://` being unserved — is asserted against a real
 * window in `browse.spec.ts` and is asserted **nowhere else**.
 *
 * What is left for this file is the part that is ours: an intersection, a minimum, a decision
 * table, and who destroys what.
 */

/* -------------------------------------------------------------------------------------------
 * The recording double
 * ---------------------------------------------------------------------------------------- */

type Listener = (...args: never[]) => void

class FakeWebContents {
  readonly listeners = new Map<string, Listener[]>()
  windowOpenHandler: ((details: OpenDetails) => unknown) | null = null
  readonly loaded: string[] = []
  closed = 0
  destroyed = false
  loadRejection: Error | null = null

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  setWindowOpenHandler(handler: (details: OpenDetails) => unknown): void {
    this.windowOpenHandler = handler
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    return this.loadRejection ? Promise.reject(this.loadRejection) : Promise.resolve()
  }

  close(): void {
    this.closed += 1
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.loaded[this.loaded.length - 1] ?? ''
  }

  getTitle(): string {
    return 'a title'
  }

  isLoading(): boolean {
    return false
  }

  readonly navigationHistory = {
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => {},
    goForward: (): void => {},
  }

  reload(): void {}

  /** Drives one of the listeners this module registered, and reports whether it refused. */
  fire(event: string, details: Record<string, unknown>): { prevented: boolean } {
    let prevented = false
    const payload = { ...details, preventDefault: () => (prevented = true) }
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (arg: unknown, ...rest: unknown[]) => void)(payload, details['url'])
    }
    return { prevented }
  }
}

type OpenDetails = { url: string; frameName: string; features: string }

type ViewOptions = { webPreferences?: Record<string, unknown> }

const madeViews: FakeView[] = []

class FakeView {
  readonly webContents = new FakeWebContents()
  readonly options: ViewOptions | undefined
  readonly boundsApplied: { x: number; y: number; width: number; height: number }[] = []
  readonly visibility: boolean[] = []

  constructor(options?: ViewOptions) {
    this.options = options
    madeViews.push(this)
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.boundsApplied.push(bounds)
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible)
  }
}

class FakeWindow {
  destroyed = false
  zoomFactor = 1
  content = { x: 0, y: 0, width: 1280, height: 860 }
  readonly children: FakeView[] = []
  readonly listeners: { event: string; listener: Listener }[] = []

  readonly contentView = {
    addChildView: (view: FakeView): void => {
      this.children.push(view)
    },
    removeChildView: (view: FakeView): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    },
  }

  readonly webContents = { getZoomFactor: (): number => this.zoomFactor }

  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return this.content
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  on(event: string, listener: Listener): this {
    this.listeners.push({ event, listener })
    return this
  }

  once(event: string, listener: Listener): this {
    this.listeners.push({ event, listener })
    return this
  }

  removeListener(event: string, listener: Listener): this {
    const index = this.listeners.findIndex((l) => l.event === event && l.listener === listener)
    if (index >= 0) this.listeners.splice(index, 1)
    return this
  }

  /** Closing a window really does destroy it, which is the one Electron fact the double keeps. */
  close(): void {
    this.destroyed = true
    for (const { event, listener } of [...this.listeners]) {
      if (event === 'closed') (listener as () => void)()
    }
  }

  emit(event: string): void {
    for (const { event: name, listener } of [...this.listeners]) {
      if (name === event) (listener as () => void)()
    }
  }
}

class FakeSession {
  requestHandlers = 0
  checkHandlers = 0
  setPermissionRequestHandler(): void {
    this.requestHandlers += 1
  }
  setPermissionCheckHandler(): void {
    this.checkHandlers += 1
  }
}

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-browse-host-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type Rig = {
  host: BrowseHost
  window: FakeWindow
  sessions: Map<string, FakeSession>
  partitions: string[]
  lastPageFile: string
}

function rig(options: { window?: FakeWindow | null } = {}): Rig {
  madeViews.length = 0
  seq += 1
  const window = options.window === undefined ? new FakeWindow() : options.window
  const sessions = new Map<string, FakeSession>()
  const partitions: string[] = []
  const lastPageFile = join(root, `case-${seq}`, BROWSE_FILE_NAME)
  const host = new BrowseHost({
    WebContentsView: FakeView as unknown as BrowseHostCtor,
    fromPartition: (partition) => {
      partitions.push(partition)
      const existing = sessions.get(partition) ?? new FakeSession()
      sessions.set(partition, existing)
      return existing as unknown as Session
    },
    window: () => window as unknown as BrowserWindow,
    lastPageFile,
  })
  return { host, window: window as FakeWindow, sessions, partitions, lastPageFile }
}

/** The constructor shape `BrowseHost` takes, so the double is cast once and named here. */
type BrowseHostCtor = new (options?: ViewOptions) => WebContentsView

const FULL: { x: number; y: number; width: number; height: number } = {
  x: 0,
  y: 0,
  width: 1280,
  height: 860,
}

function rejects(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, and it returned' })
}

/* -------------------------------------------------------------------------------------------
 * browseViewBounds
 * ---------------------------------------------------------------------------------------- */

test('a request taller than the content area is intersected down, never over the chrome inset', () => {
  // The whole window, asked for. `allowed` is the content area minus the inset, and the answer is
  // the overlap — so `y` is the inset and `height` is what is left below it.
  //
  // **This is the assertion that separates an intersection from a clamp**, which is the mutation
  // decision 11 exists for: clamping this request to the content bounds returns it unchanged, and
  // every other assertion in this file stays green while a site paints over the app's own chrome.
  assert.deepEqual(browseViewBounds(FULL, { width: 1280, height: 860 }, 1), {
    x: 0,
    y: BROWSE_CHROME_INSET.top,
    width: 1280,
    height: 860 - BROWSE_CHROME_INSET.top,
  })
})

test('a request already inside the allowed rectangle is honoured as it stands', () => {
  // Otherwise the test above passes for an implementation that ignores the request entirely and
  // always answers `allowed` — an assertion satisfied by refusing everything, wearing geometry.
  assert.deepEqual(
    browseViewBounds({ x: 40, y: 200, width: 600, height: 400 }, { width: 1280, height: 860 }, 1),
    {
      x: 40,
      y: 200,
      width: 600,
      height: 400,
    },
  )
})

test('a request that intersects to less than the minimum is no rectangle at all', () => {
  const content = { width: 1280, height: 860 }
  // The renderer that reports `1x1` — spec 4.2's reverse attack. A live third-party page running
  // where nobody can see it is exactly what 4.3 refuses to hide a view for.
  assert.equal(browseViewBounds({ x: 100, y: 200, width: 1, height: 1 }, content, 1), null)
  // A sliver with a large *area*: 20 x 5000 is 100 000 square pixels and is no more visible than
  // the 1 x 1. This is why the minimum is checked per dimension rather than as a product.
  assert.equal(browseViewBounds({ x: 100, y: 200, width: 20, height: 5000 }, content, 1), null)
  // Entirely above the inset, so the overlap is empty rather than merely small.
  assert.equal(browseViewBounds({ x: 0, y: 0, width: 1280, height: 100 }, content, 1), null)
  // Entirely off to the right of the content area.
  assert.equal(browseViewBounds({ x: 4000, y: 200, width: 600, height: 400 }, content, 1), null)
  // And the boundary, both sides of it, so the comparison cannot be off by one in silence.
  const atMinimum = { x: 0, y: 200, width: BROWSE_MIN_AREA.width, height: BROWSE_MIN_AREA.height }
  assert.deepEqual(browseViewBounds(atMinimum, content, 1), { ...atMinimum, y: 200 })
  assert.equal(
    browseViewBounds({ ...atMinimum, width: BROWSE_MIN_AREA.width - 1 }, content, 1),
    null,
  )
  assert.equal(
    browseViewBounds({ ...atMinimum, height: BROWSE_MIN_AREA.height - 1 }, content, 1),
    null,
  )
})

test('the zoom factor converts the request, the inset and the minimum together', () => {
  // The renderer reports CSS pixels; the view takes device-independent ones. At 2x a 1280x860
  // window is 640x430 CSS pixels, so the whole-window request below is itself out of date — what
  // matters is that the inset is 120 *CSS* pixels, which is 240 in the answer.
  assert.deepEqual(
    browseViewBounds({ x: 0, y: 0, width: 640, height: 430 }, { width: 1280, height: 860 }, 2),
    {
      x: 0,
      y: 240,
      width: 1280,
      height: 860 - 240,
    },
  )
  // And the minimum is a CSS-pixel minimum: 200x200 CSS is 100x100 CSS at 0.5 zoom, which is under
  // it, even though the resulting device rectangle would have been 200 device pixels wide.
  assert.equal(
    browseViewBounds({ x: 0, y: 200, width: 199, height: 400 }, { width: 1280, height: 860 }, 0.5),
    null,
  )
})

test('a rectangle that is not a rectangle is no rectangle rather than an exception', () => {
  const content = { width: 1280, height: 860 }
  // The caller is a bounds report from an untrusted renderer. `NaN` and `Infinity` are what
  // `z.number()` alone lets past — the dispatch schema refuses them, and this is the second half
  // of that, because `BrowseHost` is also called from `attach` and from the window's own resize.
  assert.equal(browseViewBounds({ x: Number.NaN, y: 0, width: 800, height: 600 }, content, 1), null)
  assert.equal(
    browseViewBounds({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 600 }, content, 1),
    null,
  )
  assert.equal(browseViewBounds(FULL, content, Number.NaN), null)
  assert.equal(browseViewBounds(FULL, content, 0), null)
  assert.equal(browseViewBounds(FULL, content, -1), null)
})

/* -------------------------------------------------------------------------------------------
 * browseOpenDecision
 * ---------------------------------------------------------------------------------------- */

/**
 * One table, all three answers, for the reason `browse-policy.test.ts` gives about its own: a
 * suite that only enumerates denials passes for a handler that denies everything — and a
 * deny-everything handler is precisely what E decision 12 rejected, because it kills both the
 * sign-in idiom and the deferred `window.open()` form.
 *
 * Every `frameName`/`features` pair below was read out of a real `HandlerDetails` on Electron
 * 44.0.0 rather than guessed.
 */
const OPEN_TABLE: ReadonlyArray<readonly [OpenDetails, 'deny' | 'navigate' | 'popup', string]> = [
  [
    { url: 'https://www.thingiverse.com/thing:1', frameName: '', features: '' },
    'navigate',
    'an <a target="_blank"> click, and a bare window.open(url): both report empty name and features',
  ],
  [
    { url: 'http://127.0.0.1:8080/x', frameName: '', features: '' },
    'navigate',
    'http as well as https — this is a browser, and a LAN address is an ordinary link',
  ],
  [
    { url: 'https://accounts.example.com/oauth', frameName: 'idp', features: '' },
    'popup',
    'named but unfeatured: the page asked for a window of its own',
  ],
  [
    { url: 'https://accounts.example.com/oauth', frameName: '', features: 'width=500,height=400' },
    'popup',
    'featured but unnamed',
  ],
  [
    {
      url: 'https://accounts.example.com/oauth',
      frameName: 'idp',
      features: 'width=500,height=400',
    },
    'popup',
    'the sign-in idiom in full',
  ],
  [
    { url: 'about:blank', frameName: '', features: '' },
    'popup',
    'the deferred form: window.open() then assign location. Denying here kills the open before the site has named its destination',
  ],
  [
    { url: 'blob:https://www.thingiverse.com/ae5e9664', frameName: '', features: '' },
    'popup',
    'blob: — the one download this project has ever completed came down one',
  ],
  [
    { url: 'data:text/html,x', frameName: '', features: '' },
    'popup',
    'data: rides along with blob:',
  ],
  [
    { url: 'bambustudio://open?model=1', frameName: '', features: '' },
    'deny',
    'an unmeasured custom-scheme hand-off',
  ],
  [
    { url: 'spm://app/', frameName: 'x', features: 'width=1' },
    'deny',
    "the app's own origin, asked for as a real popup — the policy refuses it before the popup arm is reached",
  ],
  [{ url: 'file:///C:/Windows/System32/cmd.exe', frameName: '', features: '' }, 'deny', 'file:'],
  [{ url: 'javascript:alert(1)', frameName: '', features: '' }, 'deny', 'javascript:'],
  [{ url: 'about:srcdoc', frameName: '', features: '' }, 'deny', 'about: is not about:blank'],
  [{ url: 'not a url', frameName: '', features: '' }, 'deny', 'unparseable'],
]

test('the window-open decision navigates a plain link, allows a real popup, denies the rest', () => {
  for (const [details, expected, why] of OPEN_TABLE) {
    assert.equal(browseOpenDecision(details), expected, `${why}: ${JSON.stringify(details)}`)
  }
})

/* -------------------------------------------------------------------------------------------
 * The view's lifecycle
 * ---------------------------------------------------------------------------------------- */

test('attach makes exactly one view, with five webPreferences and no preload', () => {
  const { host, window, partitions, sessions } = rig()
  host.attach(FULL)

  assert.equal(madeViews.length, 1)
  const view = madeViews[0]!
  // The keys, whole, and not `toMatchObject`-style: `preload` and `additionalArguments` are absent
  // because the key set is exactly these five, and a subset assertion cannot say that.
  //
  // **It is not the assertion that catches a preload, and must never be mistaken for one.** This
  // reads the object this module passed to a constructor it was handed; the configuration measured
  // to give a model site a live `ipcMain` answer is one where that object has a sixth key, and
  // `getLastWebPreferences()` — the instrument that reads what a webContents is *running* with —
  // does not report `preload` at all. `browse.spec.ts` reads `typeof window.spm` inside the
  // embedded document, and that is the assertion.
  assert.deepEqual(view.options, {
    webPreferences: {
      partition: BROWSE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  assert.deepEqual(window.children, [view])
  assert.deepEqual(partitions, [BROWSE_PARTITION])
  // Both handlers, on the browse session, before anything could load. The check handler is not
  // decoration: measured on Electron 44, with only the request handler set,
  // `navigator.permissions.query({name:'geolocation'})` answered "granted".
  const session = sessions.get(BROWSE_PARTITION)!
  assert.equal(session.requestHandlers, 1)
  assert.equal(session.checkHandlers, 1)
})

test('a second attach destroys the first view before making the second', () => {
  const { host, window } = rig()
  host.attach(FULL)
  host.attach(FULL)

  // The destroy *call*, not "there is one view": a host that leaked the first view and simply
  // stopped pointing at it would satisfy an existence check and leave a live third-party page
  // running with no owner.
  assert.equal(madeViews.length, 2)
  assert.equal(madeViews[0]!.webContents.closed, 1)
  assert.equal(madeViews[1]!.webContents.closed, 0)
  assert.deepEqual(window.children, [madeViews[1]])
  // And the first view's window listeners came off with it, so a resize does not drive a
  // destroyed view. One `resize` and one `closed` for the live view, and nothing left over.
  assert.deepEqual(window.listeners.map((l) => l.event).sort(), ['closed', 'resize'])
})

test('detach destroys, and detaching twice is not an error', () => {
  const { host, window } = rig()
  host.attach(FULL)
  host.detach()
  assert.equal(madeViews[0]!.webContents.closed, 1)
  assert.deepEqual(window.children, [])
  assert.deepEqual(window.listeners, [])
  host.detach()
  assert.equal(madeViews[0]!.webContents.closed, 1)
  assert.equal(host.state().attached, false)
})

test('the view is destroyed when the host window closes', () => {
  const { host, window } = rig()
  host.attach(FULL)
  window.close()
  assert.equal(madeViews[0]!.webContents.closed, 1)
  assert.equal(host.state().attached, false)
})

test('attach with no window is a Conflict rather than a view with nowhere to live', () => {
  const { host } = rig({ window: null })
  assert.equal(rejects(() => host.attach(FULL)).code, 'Conflict')
  assert.equal(madeViews.length, 0)
})

test('every method that needs a view says Conflict when there is none', () => {
  const { host } = rig()
  for (const call of [
    () => host.navigate('https://www.thingiverse.com/'),
    () => host.back(),
    () => host.forward(),
    () => host.reload(),
  ]) {
    assert.equal(rejects(call).code, 'Conflict')
  }
  // The four that are safe with none, because a route teardown or a closed modal can reach them
  // after the view has gone.
  host.detach()
  host.hide()
  host.setBounds(FULL)
  assert.deepEqual(host.show(), host.state())
  assert.equal(host.state().attached, false)
})

/* -------------------------------------------------------------------------------------------
 * Bounds, applied
 * ---------------------------------------------------------------------------------------- */

test('a sub-minimum request hides the view and applies no rectangle at all', () => {
  const { host } = rig()
  host.attach(FULL)
  const view = madeViews[0]!
  assert.equal(view.boundsApplied.length, 1)

  host.setBounds({ x: 10, y: 200, width: 1, height: 1 })

  // Not a 1x1 rectangle, and not a rectangle clamped up to the minimum either: *no* setBounds.
  assert.equal(view.boundsApplied.length, 1, 'no rectangle was applied for the 1x1 request')
  assert.equal(view.visibility[view.visibility.length - 1], false)
})

test('a window resize re-applies the last reported rectangle', () => {
  const { host, window } = rig()
  host.attach({ x: 0, y: 0, width: 1280, height: 860 })
  const view = madeViews[0]!
  assert.deepEqual(view.boundsApplied, [{ x: 0, y: 120, width: 1280, height: 740 }])

  // The renderer's report is the intent; the window's event is the correction. A resize between
  // two reports would otherwise leave the view stranded at the old rectangle.
  window.content = { x: 0, y: 0, width: 900, height: 600 }
  window.emit('resize')

  assert.deepEqual(view.boundsApplied[1], { x: 0, y: 120, width: 900, height: 480 })
})

test('hide survives the bounds reports that follow it, and show puts the view back', () => {
  const { host } = rig()
  host.attach(FULL)
  const view = madeViews[0]!
  const appliedAtAttach = view.boundsApplied.length

  host.hide()
  // The renderer goes on reporting bounds while a modal is open — on scroll, on resize. A host
  // with one flag would put a third-party page straight back on top of the dialog.
  host.setBounds({ x: 0, y: 0, width: 1280, height: 860 })
  assert.equal(view.boundsApplied.length, appliedAtAttach, 'nothing was painted while hidden')
  assert.equal(view.visibility[view.visibility.length - 1], false)

  host.show()
  assert.equal(view.boundsApplied.length, appliedAtAttach + 1)
  assert.equal(view.visibility[view.visibility.length - 1], true)
})

test('a view whose contents died is not painted, hidden or moved', () => {
  const { host } = rig()
  host.attach(FULL)
  const view = madeViews[0]!
  const appliedAtAttach = view.boundsApplied.length
  const visibilityAtAttach = view.visibility.length

  // **The one route that leaves `#view` set and its contents gone.** `detach`, the window closing
  // and a re-attach all null the reference; a renderer crash does not, and `state()` and
  // `#requireView()` have always tested `isDestroyed()` for exactly that. `hide()` and the bounds
  // path did not, which made the rule inconsistent inside one class rather than absent from it.
  view.webContents.destroyed = true

  host.hide()
  host.setBounds({ x: 0, y: 0, width: 1280, height: 860 })
  host.show()
  assert.equal(view.boundsApplied.length, appliedAtAttach, 'a dead view was given a rectangle')
  assert.equal(view.visibility.length, visibilityAtAttach, 'a dead view was told to paint or not')
  // And the host still answers, because a crashed view is a state to report and not an exception
  // to raise: `show()` returns the same detached state `state()` does.
  assert.equal(host.state().attached, false)
})

/* -------------------------------------------------------------------------------------------
 * Where a view starts, and what it remembers
 * ---------------------------------------------------------------------------------------- */

test('attach opens on the registry, then on the remembered page, then on what it was asked for', () => {
  const first = rig()
  first.host.attach(FULL)
  assert.deepEqual(madeViews[0]!.webContents.loaded, [MODEL_SITES[0]!.homeUrl])

  const remembered = rig()
  writeLastPage(remembered.lastPageFile, 'https://www.printables.com/model/1807378-clip')
  remembered.host.attach(FULL)
  assert.deepEqual(madeViews[0]!.webContents.loaded, [
    'https://www.printables.com/model/1807378-clip',
  ])

  const asked = rig()
  writeLastPage(asked.lastPageFile, 'https://www.printables.com/model/1807378-clip')
  asked.host.attach(FULL, 'https://makerworld.com/en/models/2093108')
  assert.deepEqual(madeViews[0]!.webContents.loaded, ['https://makerworld.com/en/models/2093108'])
})

test('a start URL the policy refuses is an error, not a quiet fall back to the registry', () => {
  const { host } = rig()
  // Silently opening Thingiverse for a caller that asked for something else would be a lie, and
  // the caller is the one place a `spm://` URL could be smuggled in.
  assert.equal(rejects(() => host.attach(FULL, 'spm://app/')).code, 'Validation')
  assert.equal(rejects(() => host.attach(FULL, 'file:///C:/')).code, 'Validation')
  assert.equal(madeViews.length, 0)
})

test('navigate refuses a blocked URL in the main process, and loads nothing', () => {
  const { host } = rig()
  host.attach(FULL)
  const view = madeViews[0]!
  const loadedAtAttach = view.webContents.loaded.length

  for (const url of ['spm://app/_spm/files/1/raw', 'file:///C:/x', 'javascript:alert(1)', 'nope']) {
    assert.equal(rejects(() => host.navigate(url)).code, 'Validation', url)
  }
  assert.equal(view.webContents.loaded.length, loadedAtAttach)

  // And the arms it allows, which is what stops the assertion above being satisfied by a navigate
  // that refuses everything.
  host.navigate('https://cults3d.com/en/3d-model/various/hyper-hopper')
  assert.equal(
    view.webContents.loaded[loadedAtAttach],
    'https://cults3d.com/en/3d-model/various/hyper-hopper',
  )
})

test('the last page is remembered on a navigation that committed, and only for http(s)', () => {
  const { host, lastPageFile } = rig()
  host.attach(FULL)
  const contents = madeViews[0]!.webContents

  contents.fire('did-navigate', { url: 'https://www.thingiverse.com/thing:7401409' })
  assert.equal(readLastPage(lastPageFile), 'https://www.thingiverse.com/thing:7401409')

  // A `blob:` document the user opened is not somewhere anybody can be returned to, and the
  // previous page stays.
  contents.fire('did-navigate', { url: 'blob:https://www.thingiverse.com/ae5e9664' })
  assert.equal(readLastPage(lastPageFile), 'https://www.thingiverse.com/thing:7401409')

  host.clearLastPage()
  assert.equal(readLastPage(lastPageFile), null)
})

/* -------------------------------------------------------------------------------------------
 * The four hooks — the half of them that is ours
 * ---------------------------------------------------------------------------------------- */

/**
 * **This does not substitute for `browse.spec.ts`, and the distinction is the point.**
 *
 * What is asserted here is that the listeners this module registers consult
 * `browseNavigationPolicy` and call `preventDefault` — our own wiring, driven directly. What it
 * cannot say is that Electron ever calls them: the policy attached to the *window* instead of the
 * view produces exactly this file's green, an empty hook log, and a completed navigation to a
 * third-party site. That is a real window's job.
 */
test('all four hooks are on the view, and all four consult the browse policy', () => {
  const { host } = rig()
  host.attach(FULL)
  const contents = madeViews[0]!.webContents

  assert.deepEqual(
    [...contents.listeners.keys()].filter((event) => event.startsWith('will-')).sort(),
    ['will-frame-navigate', 'will-navigate', 'will-redirect'],
  )
  assert.notEqual(contents.windowOpenHandler, null)

  for (const hook of ['will-frame-navigate', 'will-navigate', 'will-redirect']) {
    // `will-redirect` is the one a server-side 302 into a custom scheme reaches, measured, and it
    // is the arm a suite that only drives `will-navigate` leaves untested.
    assert.equal(
      contents.fire(hook, { url: 'bambustudio://open?model=1', isMainFrame: true }).prevented,
      true,
      hook,
    )
    // And the allow arm, per hook, so none of the three is satisfied by refusing everything —
    // which for this policy would mean a browser that cannot open a web page.
    assert.equal(
      contents.fire(hook, { url: 'https://www.thingiverse.com/thing:1', isMainFrame: true })
        .prevented,
      false,
      hook,
    )
  }

  // A refused main-frame navigation says so, in a message built from the *scheme* rather than
  // from the site-authored URL — the string is rendered inside the document that holds the bridge.
  contents.fire('will-redirect', { url: 'bambustudio://open?model=1', isMainFrame: true })
  assert.equal(host.state().lastError, 'the model browser does not open bambustudio: URLs')
  assert.equal(host.state().lastError?.includes('open?model=1'), false)

  // A subframe refusal is still blocked and is not reported as the page having failed.
  contents.fire('did-start-navigation', {
    url: 'https://x/',
    isMainFrame: true,
    isSameDocument: false,
  })
  assert.equal(host.state().lastError, null)
  assert.equal(
    contents.fire('will-frame-navigate', { url: 'bambustudio://x', isMainFrame: false }).prevented,
    true,
  )
  assert.equal(host.state().lastError, null)
})

test('the scheme in a refusal is bounded, because a site chooses how long it is', () => {
  const { host } = rig()
  host.attach(FULL)
  const contents = madeViews[0]!.webContents

  // `URL.parse` accepts this: the character set is `[a-z0-9+.-]`, so nothing here is injectable,
  // but the *length* is the site's to pick and `lastError` is rendered in the document that holds
  // the bridge. Without the bound the message is 20 000 characters of the app's own chrome.
  const absurd = `${'a'.repeat(20_000)}://x`
  assert.notEqual(URL.parse(absurd), null, 'the premise: this really does parse')
  contents.fire('will-navigate', { url: absurd, isMainFrame: true })
  assert.equal(
    host.state().lastError,
    `the model browser does not open ${'a'.repeat(MAX_REFUSAL_SCHEME)} URLs`,
  )

  // And the schemes anyone actually meets are untouched by it.
  contents.fire('will-navigate', { url: 'bambustudio://open?model=1', isMainFrame: true })
  assert.equal(host.state().lastError, 'the model browser does not open bambustudio: URLs')
})

test('the window-open handler navigates in place, allows a popup with named flags, or denies', () => {
  const { host } = rig()
  host.attach(FULL)
  const contents = madeViews[0]!.webContents
  const handler = contents.windowOpenHandler!
  const loadedAtAttach = contents.loaded.length

  assert.deepEqual(
    handler({ url: 'https://www.thingiverse.com/thing:2', frameName: '', features: '' }),
    { action: 'deny' },
  )
  // Denied *and* navigated: the user goes where they expected, inside the app's chrome.
  assert.equal(contents.loaded[loadedAtAttach], 'https://www.thingiverse.com/thing:2')

  const popup = handler({
    url: 'https://accounts.example.com/oauth',
    frameName: 'idp',
    features: 'width=500,height=400',
  })
  assert.deepEqual(popup, {
    action: 'allow',
    // The flags **named**, not inherited: this is the second of the two places in the app where a
    // `webPreferences.preload` would hand a website the bridge, measured through this very
    // mechanism. `noopener` is deliberately absent — it severs the half of the login idiom that
    // carries the result back.
    overrideBrowserWindowOptions: {
      webPreferences: {
        partition: BROWSE_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    },
  })
  assert.equal(contents.loaded.length, loadedAtAttach + 1, 'a popup did not also move the view')

  assert.deepEqual(handler({ url: 'bambustudio://open', frameName: '', features: '' }), {
    action: 'deny',
  })
  assert.equal(host.state().lastError, 'the model browser does not open bambustudio: URLs')
})

/* -------------------------------------------------------------------------------------------
 * The state DTO
 * ---------------------------------------------------------------------------------------- */

test('state names the site a URL belongs to, and reports no URL as null rather than empty', () => {
  const { host } = rig()
  assert.deepEqual(host.state(), {
    attached: false,
    url: null,
    title: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    siteId: null,
    lastError: null,
  })

  host.attach(FULL, 'https://www.thingiverse.com/thing:7401409')
  const attached = host.state()
  assert.equal(attached.attached, true)
  assert.equal(attached.url, 'https://www.thingiverse.com/thing:7401409')
  // Attribution, never permission: the registry names sites and does not gate them.
  assert.equal(attached.siteId, 'thingiverse')

  host.navigate('https://example.com/')
  assert.equal(host.state().siteId, null, 'a URL off the registry is browsable and unattributed')
})

test('a load that fails records Chromium’s own words, and a refusal outranks them', async () => {
  const { host } = rig()
  host.attach(FULL)
  const contents = madeViews[0]!.webContents
  contents.loadRejection = new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://nope.invalid/'")

  host.navigate('https://nope.invalid/')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(
    host.state().lastError,
    "ERR_NAME_NOT_RESOLVED (-105) loading 'https://nope.invalid/'",
  )

  // The other order, which is the one that actually happens: a blocked redirect refuses first and
  // *then* rejects the `loadURL` promise with a bare `ERR_FAILED (-2)`. Measured. The refusal is
  // the useful sentence, so it must not be overwritten by the error code that followed it.
  contents.loadRejection = new Error("ERR_FAILED (-2) loading 'https://redirector.invalid/'")
  host.navigate('https://redirector.invalid/')
  contents.fire('will-redirect', { url: 'bambustudio://open?model=1', isMainFrame: true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(host.state().lastError, 'the model browser does not open bambustudio: URLs')
})
