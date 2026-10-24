import type { BrowserWindow, Session, WebContentsView } from 'electron'
import type { BrowseBounds, BrowseStateDto, ModelSiteDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { browseNavigationPolicy } from '../urls.ts'
import { clearLastPage, readLastPage, writeLastPage } from './last-page.ts'
import { MODEL_SITES, siteForUrl } from './registry.ts'

/**
 * The model browser's native view, and the wall around it.
 *
 * This module loads **arbitrary third-party web content into a process whose other renderer holds
 * an IPC bridge to the user's filesystem**. Everything else in subsystem E is a feature; this is
 * the containment, and spec §3 is written about the twenty lines in `attach` rather than about the
 * hundreds around them.
 *
 * Three properties hold it up, each measured both ways
 * (`.superpowers/spikes/2026-08-28-model-browser-facts.md`):
 *
 * 1. **No preload, ever** (spec 3.2, E constraint 8). A `WebContentsView` made with no `preload`
 *    reported `typeof window.spm === "undefined"` at a third-party origin. The *same* view given
 *    `webPreferences.preload` — otherwise sandboxed and context-isolated — reported
 *    `typeof window.spm === 'object'` with all three keys, and `invoke('projects.list', [])`
 *    returned a real `ipcMain` answer, **at a third-party origin**. One line apart.
 * 2. **Its own `persist:` partition** (spec 3.4). Separate cookies, separate `localStorage`,
 *    separate storage directory, a separate `will-download` stream, a separate permission handler
 *    — and `spm://` unreachable, because `protocol.handle` registers on `defaultSession` only. On
 *    the default session an embedded view's `loadURL('spm://app/')` **succeeds**; on the partition
 *    it comes back `ERR_FAILED (-2)`.
 * 3. **Its own navigation policy on its own `webContents`** (spec 3.5). `applyNavigationPolicy` in
 *    `app.ts` hooks `window.webContents`, and with it attached exactly as `app.ts` does it a
 *    `loadURL` and an in-page `location.href` inside an embedded view **both completed with an
 *    empty hook log**. So this file attaches its own, four hooks, to the view's own contents — and
 *    it consults `browseNavigationPolicy`, never `navigationPolicy`, which answers `external` for
 *    `http(s)` and would fire the user's system browser for every link in the model browser.
 *
 * **The instrument warning, because it is the one that would let a regression through.**
 * `getLastWebPreferences()` — which `shell.spec.ts` uses correctly for the trust flags — returns
 * 15 keys and **`preload` is not one of them**, and the object is byte-identical for the
 * bridge-holding window and a bridge-less view. Re-measured while writing this file: the view
 * below produced exactly those 15 keys. A test that reads it to assert "no preload" therefore
 * passes in the exact configuration measured to hand `ipcMain` to a model site. The only
 * instrument that answers is `typeof window.spm` read **inside the embedded document**, which is
 * what `test/browse.spec.ts` does.
 *
 * **Electron is injected** — the `WebContentsView` constructor, `session.fromPartition` and the
 * host window — so the bounds arithmetic and the lifecycle run under plain `node --test`. That
 * seam is deliberately narrow: the fake in `test/browse-host.test.ts` records *this module's*
 * calls and models none of Electron's behaviour, because a double that modelled it would be
 * testing what its author believed Electron does. Every property that is Electron's — the absent
 * bridge, the partition, the four hooks, the permission refusal — is asserted against a real
 * window in `test/browse.spec.ts` and nowhere else.
 */

/**
 * The browse profile. One string, exported, because task 3's download interception attaches to
 * this same session and the two must not spell it separately.
 *
 * `persist:` and not a transient partition: cookies and `localStorage` survive, which is what makes
 * `detach` destroying the view cost a scroll position rather than a login (spec 4.3).
 */
export const BROWSE_PARTITION = 'persist:spm-browse'

/**
 * The band at the top of the window the browse view may never cover, in **CSS pixels**.
 *
 * **A judgement, not a measurement.** Spec 9.6 is explicit that nothing in the spike touched
 * layout, resize or focus, and that it is *not established* that an inset achieves the property it
 * is written for — only that it is a better-shaped rule than the clamp it replaced. 120 px is a
 * guess at the height of the app's own chrome above the browse pane, and it is the number to change
 * when the `/browse` page exists and disagrees.
 *
 * What it is *for* is not a guess: a rectangle equal to the content bounds **is** the whole window,
 * so clamping a renderer's request to the content area stops `NaN`, negatives and off-screen values
 * and does exactly nothing about a site painted over the app's own chrome. The main process
 * reserves this band for itself and intersects the renderer's request with what is left, and the
 * renderer never names either constant — which is the whole of why they live here (E decision 11).
 */
export const BROWSE_CHROME_INSET = { top: 120, right: 0, bottom: 0, left: 0 } as const

/**
 * The smallest rectangle worth painting, in **CSS pixels**. Also a judgement.
 *
 * It exists for the reverse attack: a renderer that reports `1×1` keeps a live third-party page
 * running invisibly, which is precisely what spec 4.3 refuses to hide a view for, arrived at
 * through the API that spec leaves open. A request that intersects to less than this is treated as
 * a call to `hide()` — the page stops painting — and is **not** honoured as a rectangle.
 *
 * **Checked per dimension and not as a product**, which is stricter than the word "area" suggests
 * and is the reason the check is written out rather than left as `width * height`: a `20 × 5000`
 * sliver has 100 000 square pixels and is no more visible than the `1 × 1`.
 */
export const BROWSE_MIN_AREA = { width: 200, height: 200 } as const

/** A rectangle in the window's own coordinate space, in device-independent pixels. */
export type BrowseRect = { x: number; y: number; width: number; height: number }

/**
 * What the window-open handler does about one `window.open`, decided without touching Electron.
 *
 * Separated from the handler so the table of cases can be driven exhaustively under `node --test`
 * (`test/browse-host.test.ts`) rather than one real window per case.
 */
export type BrowseOpenDecision = 'deny' | 'navigate' | 'popup'

/**
 * Which of the three a `window.open` gets.
 *
 * **`deny`** — the policy refuses the URL. Nothing else needs saying: `{ action: 'deny' }` creates
 * no window at all and `window.open` returns `null` to the caller, measured.
 *
 * **`navigate`** — an `http(s)` target the page did **not** ask to be a window of its own. The
 * browse view goes there itself and the handler denies, so the user ends up where they expected,
 * inside the app's chrome, with a back button, instead of in an unchromed top-level window outside
 * everything `/browse` draws.
 *
 * **`popup`** — everything else the policy allows, and the two arms of it are why this is not a
 * deny-everything handler:
 *
 * - **A named or featured window.** `window.open(idp, 'name', 'width=500,height=400')` is the
 *   dominant sign-in idiom, and spec 5.7 makes logging in the user's own job. Measured here:
 *   `frameName` is `'popupname'` and `features` is `'width=500,height=400'` for that call, against
 *   `''` and `''` for both an `<a target="_blank">` click and a bare `window.open(url)`. So the
 *   discriminator is that the page *named* the window or *dimensioned* it. `disposition` is
 *   deliberately not consulted: it reads `foreground-tab` for the named-but-unfeatured call and
 *   `new-window` only once features appear, so it splits the login idiom in half.
 * - **`about:blank`, `blob:` and `data:`.** The deferred idiom is `const w = window.open()`, then
 *   `w.location = url` — the handler is reached with the target `about:blank`, *before* the site
 *   has named its destination, so denying there kills the open rather than the destination.
 *   Measured: allowed at the `about:blank` step, the popup then went to the real URL, on the
 *   browse partition, with `typeof window.spm === "undefined"`.
 *
 * A popup is allowed with its trust flags **named** rather than inherited — see the handler in
 * `#attachNavigationPolicy`, which spells them a second time and says why. `noopener` is
 * deliberately not forced: it severs `window.opener`, which is the half of the login idiom that
 * carries the result back, to remove a reach that does not exist on this partition anyway (a
 * browse popup is cross-origin from `spm://app`, and `spm://` is not served here at all).
 */
export function browseOpenDecision(details: {
  url: string
  frameName: string
  features: string
}): BrowseOpenDecision {
  if (browseNavigationPolicy(details.url) === 'block') return 'deny'
  const protocol = URL.parse(details.url)?.protocol
  const asksForItsOwnWindow = details.frameName !== '' || details.features !== ''
  if (!asksForItsOwnWindow && (protocol === 'http:' || protocol === 'https:')) return 'navigate'
  return 'popup'
}

/**
 * The rectangle to give the view, or `null` for "there is nothing worth painting — hide it".
 *
 * `request` is the renderer's intent in **CSS pixels**; `contentSize` is the window's content area
 * in device-independent pixels, as `getContentBounds()` reports it; `zoomFactor` converts between
 * the two. All of the arithmetic happens in CSS pixels, because that is the unit both constants
 * above were written in — the chrome band is 120 CSS px tall *in the renderer*, so scaling the
 * inset along with everything else is the only spelling that stays right when a user zooms.
 *
 * **Intersection, not a clamp** (spec 4.2, E decision 11): `allowed` is the content area minus the
 * chrome inset, and the answer is the overlap of the request with it. The renderer cannot widen
 * `allowed`, because it never names it.
 *
 * A rectangle whose numbers are not finite, or a zoom factor that is not positive, is `null` rather
 * than an exception: the caller is a bounds report from an untrusted renderer, and the honest
 * response to "I cannot place this" is to stop painting a third-party page, not to throw.
 */
export function browseViewBounds(
  request: BrowseBounds,
  contentSize: { width: number; height: number },
  zoomFactor: number,
): BrowseRect | null {
  const numbers = [request.x, request.y, request.width, request.height, zoomFactor]
  if (!numbers.every((value) => Number.isFinite(value)) || zoomFactor <= 0) return null

  const contentWidth = contentSize.width / zoomFactor
  const contentHeight = contentSize.height / zoomFactor
  const allowedLeft = BROWSE_CHROME_INSET.left
  const allowedTop = BROWSE_CHROME_INSET.top
  const allowedRight = contentWidth - BROWSE_CHROME_INSET.right
  const allowedBottom = contentHeight - BROWSE_CHROME_INSET.bottom

  const left = Math.max(request.x, allowedLeft)
  const top = Math.max(request.y, allowedTop)
  const right = Math.min(request.x + request.width, allowedRight)
  const bottom = Math.min(request.y + request.height, allowedBottom)
  const width = right - left
  const height = bottom - top
  if (width < BROWSE_MIN_AREA.width || height < BROWSE_MIN_AREA.height) return null

  return {
    x: Math.round(left * zoomFactor),
    y: Math.round(top * zoomFactor),
    width: Math.round(width * zoomFactor),
    height: Math.round(height * zoomFactor),
  }
}

export type BrowseHostOptions = {
  /**
   * `WebContentsView` itself, passed as a class.
   *
   * The **class** and not a factory, and that is constraint 8 wearing a type: a factory in `app.ts`
   * would be a second place a `webPreferences` object could be built, and the one this file builds
   * would be one spread away from being the main window's. `new` is written once, in `attach`,
   * against this.
   */
  WebContentsView: new (options?: {
    webPreferences?: {
      partition?: string
      sandbox?: boolean
      contextIsolation?: boolean
      nodeIntegration?: boolean
      webSecurity?: boolean
    }
  }) => WebContentsView
  /** `session.fromPartition`. Called once, lazily — it needs `app.whenReady()` and this does not. */
  fromPartition: (partition: string) => Session
  /**
   * The window the view is parented to, resolved **per call** for the reason everything else in
   * this shell is: `replaceWindows` swaps the window on a transport change, and a captured one
   * would be a handle on a destroyed window.
   */
  window: () => BrowserWindow | null
  /** `<userData>/browse.json`. See `last-page.ts` for what it is and why it is named that way. */
  lastPageFile: string
  /**
   * Called **once, with the browse session, at the moment it is created** — before any view exists
   * on it and therefore before anything on it can load a page.
   *
   * It exists for exactly one caller: `BrowseDownloads.attachTo`, whose `will-download` listener
   * lives on the *session* and outlives every view (E decision 4). Registering it per `attach`
   * would remove it on `detach`, and a download that started before the detach and finished after
   * it would lose its `done` handler — measured, because destroying the owning view mid-download
   * does not cancel an `http` download.
   *
   * A callback rather than a `BrowseDownloads` parameter, because this class knows nothing about
   * downloads and should not start: it owns the session's *creation*, and this is the seam that
   * says so.
   */
  onSession?: (session: Session) => void
}

export class BrowseHost {
  readonly #WebContentsView: BrowseHostOptions['WebContentsView']
  readonly #fromPartition: (partition: string) => Session
  readonly #hostWindow: () => BrowserWindow | null
  readonly #lastPageFile: string
  readonly #onSession: (session: Session) => void

  #session: Session | null = null
  #view: WebContentsView | null = null
  /** The window `#view` is parented to, so the listeners come off the same object they went on. */
  #window: BrowserWindow | null = null
  /** The renderer's most recent intent, in CSS pixels. Null until the first report. */
  #bounds: BrowseBounds | null = null
  /**
   * Hidden because somebody **asked**, which is not the same as hidden because the rectangle was
   * too small — and keeping the two apart is the whole reason this field exists. `hide()` is a
   * modal's tool (spec 4.1), and the renderer goes on reporting bounds while a modal is open: on
   * one flag the next scroll report would put a third-party page back on top of the dialog.
   */
  #hiddenOnRequest = false
  #lastError: string | null = null
  /** So a `did-navigate` that did not move the URL does not cost an fsync. */
  #rememberedUrl: string | null = null

  readonly #onWindowResize = (): void => {
    // The renderer's report is the intent and the window's event is the correction (spec 4.2): a
    // resize between two reports would otherwise leave the view stranded at the old rectangle.
    this.#applyBounds()
  }

  readonly #onWindowClosed = (): void => {
    // One of spec 4.3's three backstops. A native resource whose only owner is a renderer
    // lifecycle hook is a leak waiting for a crash.
    this.#destroyView()
  }

  constructor(options: BrowseHostOptions) {
    this.#WebContentsView = options.WebContentsView
    this.#fromPartition = options.fromPartition
    this.#hostWindow = options.window
    this.#lastPageFile = options.lastPageFile
    this.#onSession = options.onSession ?? ((): void => {})
  }

  /**
   * The browse session, created on first use and never handed a `protocol.handle`.
   *
   * **`browseSession.protocol.handle('spm', …)` succeeds** — measured — so "`spm://` is not served
   * in the browse partition" is a property kept on purpose and not one the platform enforces.
   * Whoever comes here next wanting the browse view to reach an app URL: that is the sentence you
   * are about to delete. On the default session an embedded view's `loadURL('spm://app/')`
   * *succeeds*, and `files.ts` serves file bytes under that origin with no CSP of their own; the
   * partition is what removes the question. `test/browse.spec.ts` asserts `isProtocolHandled('spm')`
   * is false here **and** true on `defaultSession` in the same assertion, so the check cannot pass
   * by being a null instrument.
   *
   * The `will-download` listener goes on this object once, for the life of the process — the item
   * lives on the session and outlives the view. `onSession` is where, and `BrowseDownloads` is what.
   */
  session(): Session {
    if (this.#session) return this.#session
    const session = this.#fromPartition(BROWSE_PARTITION)
    // Each session needs its own: the default session's handler fired only for the default
    // session's view (spec 3.7). A browse partition with none runs on Electron's defaults, and
    // this task measured what those are rather than repeating the spec's "not a decision anyone
    // made": in a fresh partition with no handler at all, a page was **granted** geolocation and
    // **granted** notifications with no prompt of any kind.
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    // **Spec 9.5 recorded this handler as unmeasured. It is measured now — 3.7, 9.5 and the plan
    // all carry the withdrawal — and it is not merely "the same refusal for consistency": it does
    // work the request handler does not.** Three partitions, one each, on Electron 44.0.0: with
    // the request handler alone,
    // `navigator.permissions.query({ name: 'geolocation' })` answered **`"granted"`** while the
    // actual geolocation request was denied; with both handlers it answered `"denied"`, and the
    // check handler fired for `media`, `web-app-installation`, `geolocation` and `notifications`;
    // with neither, the query answered `"granted"` and the request was granted too. So without
    // this line a site reads a granted permission out of an API that never raises a request, and
    // whatever it draws from that answer is a decision nobody refused. Windows 11 only.
    session.setPermissionCheckHandler(() => false)
    this.#session = session
    // Last, and once: the handlers above are on before anything can be asked for, and the download
    // interceptor is on before any view exists to start one. Assigned to `#session` first so that a
    // callback which reaches back for `session()` finds this one rather than making a second.
    this.#onSession(session)
    return session
  }

  /** The registry, as the renderer sees it. It names sites; it does not gate them (spec 4.4). */
  sites(): ModelSiteDto[] {
    return MODEL_SITES.map((site) => ({
      id: site.id,
      displayName: site.displayName,
      homeUrl: site.homeUrl,
    }))
  }

  /**
   * Creates the browse view, parents it to the current window and starts a load.
   *
   * **It destroys any existing view first** (spec 4.3): the shell holds at most one, and an
   * `attach` that found one already there and returned it would leave a second `/browse` mount
   * driving the first mount's page.
   *
   * `url` defaults to the remembered last page and then to the registry's first `homeUrl`. A `url`
   * the policy refuses is an `AppError` and not a silent fallback — the renderer asked for
   * something specific, and getting Thingiverse instead would be a lie.
   *
   * The load is **not awaited**. Two of the four sites answer 403 with Cloudflare's non-interactive
   * challenge and clear themselves after 5.6 s and 6.4 s, so an `attach` that waited for a document
   * would look like a hang; spec 4.5's rule is that the UI shows progress and waits on a
   * navigation rather than counting seconds, and `state()` is what it polls.
   */
  attach(bounds: BrowseBounds, url?: string): BrowseStateDto {
    const window = this.#requireWindow()
    const target = this.#startUrl(url)
    // Before the view, so the permission handlers are on the partition before anything on it can
    // load a page and ask for something.
    this.session()
    this.#destroyView()

    /*
     * **The one place a browse view is constructed, and these five keys are the whole of its
     * `webPreferences`** (E constraint 8, spec 3.2 and 3.9).
     *
     * No `preload`. No `additionalArguments`. And no spread of the main window's options — a
     * helper that did that is the defect this constraint is written against, because
     * `createMainWindow`'s object carries `preload: preloadPath()` and the spread would be one
     * word long. Measured: a `WebContentsView` given this app's own preload, otherwise sandboxed
     * and context-isolated, reported `typeof window.spm === 'object'` at a third-party origin and
     * `invoke('projects.list', [])` returned a real `ipcMain` answer.
     *
     * `webSecurity: true` is stated rather than left to the default because it is the one flag
     * whose absence turns nothing red: it switches off the same-origin policy for third-party
     * content inside a process that serves the user's files, and `getLastWebPreferences()` — which
     * *does* report it, unlike `preload` — is the instrument `test/browse.spec.ts` uses to pin it.
     * The other three are stated for the same reason `createMainWindow` states them.
     *
     * The flags are written out a second time in the window-open handler below. That duplication
     * is deliberate: a shared constant spread into both would be exactly the shape of thing
     * somebody widens once, and a supplied `webPreferences.preload` through *that* handler was
     * measured to give a popup a full live bridge at any origin — which makes these the two places
     * in this app where the bridge can be handed to a website.
     */
    const view = new this.#WebContentsView({
      webPreferences: {
        partition: BROWSE_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })

    this.#attachNavigationPolicy(view)
    window.contentView.addChildView(view)
    this.#view = view
    this.#window = window
    this.#bounds = bounds
    this.#hiddenOnRequest = false
    this.#applyBounds()
    window.on('resize', this.#onWindowResize)
    window.once('closed', this.#onWindowClosed)

    this.#load(view, target)
    return this.state()
  }

  /**
   * Destroys the view. Safe with none.
   *
   * **Destroys and does not hide.** A hidden view is a live third-party page still running script,
   * still holding sockets, still able to start a download nobody is watching, and one bounds bug
   * from being visible on a page it has nothing to do with. The cost is a scroll position and not
   * a login: the partition is persistent, so cookies and `localStorage` survive it (spec 4.3).
   *
   * `app.ts` also calls this on a transport change, which is `ShellHost`'s existing "switching
   * modes must not leak the previous mode's client" property with E's view joining the things it
   * covers: `replaceWindows` builds a new window and destroys the old, in that order, so a browse
   * view the shell still held would be a handle on a destroyed window.
   */
  detach(): void {
    this.#destroyView()
  }

  /**
   * Stops the view painting, without destroying it. **For a modal, and never for a route change.**
   *
   * A `WebContentsView` is a native sibling of the renderer's own view, not a DOM element: it
   * paints over the renderer unconditionally, with no z-index relationship to negotiate. So any
   * dialog, toast or dropdown the app raises under the view's rectangle is invisible, and this is
   * the only answer to that which does not cost the user the page they were on. Route teardown
   * calls `detach`, which destroys, and that does not change.
   */
  hide(): void {
    this.#hiddenOnRequest = true
    // The same liveness test `state()` and `#requireView()` make, for the same reason: `#view` is
    // nulled by `detach`, by the window closing and by a re-attach, but not by the contents dying
    // on its own — a renderer crash leaves this reference pointing at a destroyed view. One class,
    // one rule.
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.setVisible(false)
  }

  /** Puts a `hide()`n view back, at whatever rectangle the renderer last reported. */
  show(): BrowseStateDto {
    this.#hiddenOnRequest = false
    this.#applyBounds()
    return this.state()
  }

  /** The renderer's intent, in CSS pixels. See `browseViewBounds` for what becomes of it. */
  setBounds(bounds: BrowseBounds): void {
    this.#bounds = bounds
    this.#applyBounds()
  }

  /**
   * Goes somewhere, if `browseNavigationPolicy` allows it — **decided here, in the main process**.
   *
   * Constraint 13: the renderer never hands a URL to Chromium in the privileged document. A `url`
   * shown in the browse chrome is site-authored text, and the way to act on it is this call.
   *
   * **The refusal is recorded before it is thrown, and that is not belt-and-braces.** The four
   * hooks below all set `#lastError` from `describeRefusal` and the renderer renders it, so a
   * refusal reached through a *page* has a sentence. A refusal reached through the address control
   * had none: this method throws **before** `#load`, which is the only other thing that touches
   * `#lastError`, so typing `file:///C:/x` or `bambustudio://x` and pressing Go produced no visible
   * change of any kind — the `Validation` was caught into a `console.error` in the renderer and the
   * `lastError` line stayed empty. That is the silence `notices.ts` argues is unacceptable ("silence
   * trains a user to believe the feature is broken"), reached through the one path the notices do
   * not cover.
   *
   * Recording it here rather than translating the `Validation` in the renderer, because
   * `describeRefusal` already writes this sentence for the four hooks and a second one in the
   * renderer would be a second copy of the same explanation — with a scheme the renderer would have
   * to re-parse out of a URL to say anything specific. The throw stays: `navigate` still fails, and
   * a caller that awaits it still learns so.
   */
  navigate(url: string): BrowseStateDto {
    const view = this.#requireView()
    if (browseNavigationPolicy(url) === 'block') {
      this.#lastError = describeRefusal(url)
      throw new AppError('Validation', 'that URL cannot be opened in the model browser')
    }
    this.#load(view, url)
    return this.state()
  }

  back(): BrowseStateDto {
    const view = this.#requireView()
    this.#lastError = null
    view.webContents.navigationHistory.goBack()
    return this.state()
  }

  forward(): BrowseStateDto {
    const view = this.#requireView()
    this.#lastError = null
    view.webContents.navigationHistory.goForward()
    return this.state()
  }

  reload(): BrowseStateDto {
    const view = this.#requireView()
    this.#lastError = null
    view.webContents.reload()
    return this.state()
  }

  /**
   * What the browse chrome polls.
   *
   * **Every string in it is untrusted data in the renderer** (spec 3.10, constraint 13): `url` and
   * `title` are chosen by the site, and `lastError` is a message this file writes *about* a URL a
   * site chose. They are rendered as text only — never into `innerHTML`, `bypassSecurityTrust*`, a
   * `[href]`, a `[src]`, a CSS `url()` or a `window.open`. The DTO says so where it is declared,
   * and this is the place the values are minted.
   */
  state(): BrowseStateDto {
    const view = this.#view
    if (!view || view.webContents.isDestroyed()) {
      return {
        attached: false,
        url: null,
        title: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        siteId: null,
        lastError: this.#lastError,
      }
    }
    const contents = view.webContents
    // The empty string is what `getURL()` answers for a webContents that has not committed a
    // document yet, which is not a URL and must not be reported as one.
    const url = contents.getURL()
    const title = contents.getTitle()
    return {
      attached: true,
      url: url === '' ? null : url,
      title: title === '' ? null : title,
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      siteId: siteForUrl(url)?.id ?? null,
      lastError: this.#lastError,
    }
  }

  /** Forgets the remembered last page. The only thing that does — see `last-page.ts`. */
  clearLastPage(): void {
    this.#rememberedUrl = null
    clearLastPage(this.#lastPageFile)
  }

  /* ---------------------------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------------------------ */

  #requireWindow(): BrowserWindow {
    const window = this.#hostWindow()
    if (!window || window.isDestroyed()) {
      throw new AppError('Conflict', 'there is no window to put a model browser in')
    }
    return window
  }

  #requireView(): WebContentsView {
    const view = this.#view
    if (!view || view.webContents.isDestroyed()) {
      throw new AppError('Conflict', 'the model browser is not open')
    }
    return view
  }

  #startUrl(url: string | undefined): string {
    if (url !== undefined) {
      if (browseNavigationPolicy(url) === 'block') {
        throw new AppError('Validation', 'that URL cannot be opened in the model browser')
      }
      return url
    }
    // `noUncheckedIndexedAccess` cannot see that the registry has rows, and `about:blank` is the
    // honest answer for one with none: the policy allows it, it is a blank page, and it is not
    // somewhere this file invented to send a user. `test/browse-registry.test.ts` pins the four.
    return readLastPage(this.#lastPageFile) ?? MODEL_SITES[0]?.homeUrl ?? 'about:blank'
  }

  #load(view: WebContentsView, url: string): void {
    this.#lastError = null
    void view.webContents.loadURL(url).catch((error: unknown) => {
      // Only when nothing more specific is already recorded. A navigation refused by one of the
      // four hooks below rejects this promise with `ERR_FAILED (-2)` as well, and "the model
      // browser does not open bambustudio: URLs" is a better thing to put in front of a user than
      // the Chromium error code that followed it.
      if (this.#lastError === null) this.#lastError = describeLoadFailure(error)
    })
  }

  /**
   * **All four hooks, on the view's own `webContents`** (E constraint 11, spec 3.5 and 3.9).
   *
   * Attaching three of them is the kind of gap that passes every test written against the fourth,
   * so each one is named here with what only it covers, measured on Electron 44.0.0:
   *
   * - `will-frame-navigate` fires **first** for the same URL and is the only one that covers
   *   subframes. An in-page `location.href = 'bambustudio://x'` arrived here.
   * - `will-navigate` is main-frame only, and is what a `window.open(url, '_self')` reaches when
   *   the window-open handler does not.
   *
   *   **The first two overlap in the main frame, measured by deleting each in turn**: a main-frame
   *   in-page navigation reaches both, so with either one gone the other still refuses it and the
   *   whole Playwright suite stayed green. What only `will-frame-navigate` covers is a *subframe*,
   *   and every scheme this policy blocks is one Chromium refuses from a subframe anyway — so
   *   there is no behavioural test that separates them, and `browse.spec.ts` asserts the
   *   registration on the real `webContents` instead. Neither is therefore load-bearing on its own
   *   today; both stay because "three of the four attached" is the failure constraint 11 names,
   *   and because the overlap is Chromium's to change and not ours.
   * - `will-redirect` is **the only hook a server-side 302 into a custom scheme reaches**. A local
   *   server answering `302 → bambustudio://open?model=1` produced one `will-redirect` entry and an
   *   empty `will-navigate` log.
   * - `setWindowOpenHandler` is the one that stops a site putting an unchromed top-level window on
   *   screen — with none installed, `window.open` from embedded content makes a real
   *   `BrowserWindow` on the opener's session.
   *
   *   **The window it does allow gets none of these hooks.** A popup approved by the `popup` arm is
   *   a fresh `webContents` with no navigation policy and no window-open handler of its own: it may
   *   navigate wherever it likes and open further windows without this file seeing either. That is
   *   stated rather than hedged. Containment does not rest on it — the popup is on
   *   `BROWSE_PARTITION`, which serves no `spm://` and has no preload (`browse.spec.ts` reads
   *   `typeof window.spm` *inside* the popup and gets `'undefined'`), and Chromium refuses a
   *   renderer-initiated navigation to an unregistered custom scheme on its own. What is missing is
   *   the refusal *record*: a blocked scheme in a popup produces no `lastError`. Attaching these
   *   listeners through `did-create-window` would not be a copy of this function — the `navigate`
   *   arm loads into the *browse view*, which for a popup would yank the page out from under a
   *   half-finished login — so it needs its own decision table and its own measurement, and is not
   *   a passenger on someone else's change.
   *
   * All four consult `browseNavigationPolicy`. **Never `navigationPolicy`**, which answers
   * `external` for `http(s)` and would hand every link in the model browser to
   * `shell.openExternal` — the browser would never move. The two policies invert on exactly that
   * arm, which is why `urls.ts` exports two functions rather than one with a flag.
   */
  #attachNavigationPolicy(view: WebContentsView): void {
    const contents = view.webContents
    const refuse = (details: {
      url: string
      isMainFrame: boolean
      preventDefault(): void
    }): void => {
      if (browseNavigationPolicy(details.url) === 'allow') return
      details.preventDefault()
      // Only the main frame reaches the user's error line. A subframe — an ad, a consent vendor —
      // navigating somewhere refused is still blocked; it is just not something to put in the
      // browse chrome as though the page the user asked for had failed.
      if (details.isMainFrame) this.#lastError = describeRefusal(details.url)
    }
    contents.on('will-frame-navigate', refuse)
    contents.on('will-navigate', refuse)
    contents.on('will-redirect', refuse)

    contents.setWindowOpenHandler((details) => {
      switch (browseOpenDecision(details)) {
        case 'deny':
          this.#lastError = describeRefusal(details.url)
          return { action: 'deny' }
        case 'navigate':
          this.#load(view, details.url)
          return { action: 'deny' }
        case 'popup':
          return {
            action: 'allow',
            // **The trust flags named, not inherited** — the second of the two places in this app
            // where a `webPreferences.preload` would hand a website the bridge. Measured: supplied
            // through this very handler, it gave a popup `typeof window.spm === 'object'` and a
            // live `invoke` at a remote origin. Electron does inherit the security-related flags
            // into a popup on its own (a `features` string asking for `nodeIntegration=yes,
            // contextIsolation=no,sandbox=no` was measured to change none of them), so this object
            // is not what makes the popup safe — it is what makes the popup's configuration
            // *stated*, in the one place a future edit would otherwise pass something else.
            overrideBrowserWindowOptions: {
              webPreferences: {
                partition: BROWSE_PARTITION,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
              },
            },
          }
      }
    })

    contents.on('did-start-navigation', (details) => {
      // A navigation the user started is a new attempt, and the previous failure stops being the
      // answer to "what is on screen". Main frame only: a subframe starting a load says nothing
      // about it, and a same-document navigation is not an attempt at anything.
      if (details.isMainFrame && !details.isSameDocument) this.#lastError = null
    })

    contents.on('did-navigate', (_event, url) => {
      this.#remember(url)
    })
  }

  #remember(url: string): void {
    if (url === this.#rememberedUrl) return
    this.#rememberedUrl = url
    writeLastPage(this.#lastPageFile, url)
  }

  #applyBounds(): void {
    const view = this.#view
    const window = this.#window
    const bounds = this.#bounds
    // `view.webContents.isDestroyed()` for the same reason `hide()` makes the test: the window
    // being alive does not make the view's contents alive, and a destroyed one is what `state()`
    // and `#requireView()` both refuse to touch.
    if (!view || !window || !bounds) return
    if (window.isDestroyed() || view.webContents.isDestroyed()) return
    if (this.#hiddenOnRequest) {
      view.setVisible(false)
      return
    }
    const content = window.getContentBounds()
    const rect = browseViewBounds(bounds, content, window.webContents.getZoomFactor())
    if (rect === null) {
      // Spec 4.2's reverse attack: a renderer reporting `1×1` would otherwise keep a live
      // third-party page running invisibly. It is hidden, and **not** given the rectangle.
      view.setVisible(false)
      return
    }
    view.setBounds(rect)
    view.setVisible(true)
  }

  #destroyView(): void {
    const view = this.#view
    const window = this.#window
    this.#view = null
    this.#window = null
    this.#bounds = null
    this.#hiddenOnRequest = false
    this.#lastError = null
    if (window && !window.isDestroyed()) {
      window.removeListener('resize', this.#onWindowResize)
      window.removeListener('closed', this.#onWindowClosed)
      if (view) window.contentView.removeChildView(view)
    }
    // `webContents.close()` is what destroys a `WebContentsView`; removing it from the parent only
    // stops it being drawn. Measured: `isDestroyed()` is true afterwards.
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
  }
}

/**
 * The longest scheme `describeRefusal` will repeat back.
 *
 * **A scheme is not short on its own.** `'a'.repeat(20000) + '://x'` parses, and `URL.parse` hands
 * back a 20 001-character protocol — so the length of this part *is* a site's to choose, and the
 * bound is here rather than assumed. 32 is far above every scheme the policy names
 * (`bambustudio:`, the longest, is 12) and far below anything worth putting in the chrome.
 */
export const MAX_REFUSAL_SCHEME = 32

/**
 * What a refused navigation says, in one place.
 *
 * **The scheme and not the URL.** The string ends up in `BrowseStateDto.lastError`, which is
 * rendered in the privileged document, and a site chooses the URL: a message built from one is a
 * site-authored string of any length in the app's own chrome. The scheme is the part that explains
 * the refusal — `URL.parse` has already parsed it, so it holds nothing but `[a-z0-9+.-]`, and an
 * unparseable string has no scheme to name.
 *
 * Its *length* is still the site's, which is what `MAX_REFUSAL_SCHEME` is for. Nothing in a parsed
 * scheme is injectable and the DTO mandates truncation at render, so this is not the boundary — it
 * is the message carrying its own bound instead of leaving one renderer's CSS the only thing
 * between a site and 20 000 characters of the app's own chrome.
 */
function describeRefusal(url: string): string {
  const protocol = URL.parse(url)?.protocol
  return protocol === undefined
    ? 'the model browser refused a navigation to a URL it could not parse'
    : `the model browser does not open ${protocol.slice(0, MAX_REFUSAL_SCHEME)} URLs`
}

/** Chromium's own failure text, or a bounded stand-in for a rejection that is not an `Error`. */
function describeLoadFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'the page could not be loaded'
}
