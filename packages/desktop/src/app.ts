import { app, BrowserWindow, protocol, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeLibrary, ensureLocalUser, openLibrary, type Ctx, type Library } from '@spm/core'
import { parseFileRequest, serveLibraryFile } from './files.ts'
import { registerInvokeHandler } from './ipc.ts'
import { navigationPolicy, RENDERER_HOST, RENDERER_ORIGIN, RESERVED_PATH_SEGMENT } from './urls.ts'

/**
 * The Electron main process, minus its entry point.
 *
 * `src/main.ts` does nothing but call `main()` from here, and that separation is deliberate: task 2
 * adds an `ipc.ts` that needs the library session and that `main()` in turn wires up, so a
 * module holding both the shared pieces and the start-the-app side effect would put `main()` at
 * the bottom of an import cycle. Everything is exported for the same reason — task 2 takes
 * `openDesktopLibrary` for the dispatch table's `lib`/`ctx`, and neither has to duplicate or
 * re-open anything. Task 3's file bytes went into `files.ts` rather than in here, for the same
 * reason: it must be importable, and testable, without `electron`.
 */

/**
 * `app.getName()`, and what the Angular build's index.html happens to put in `<title>` too.
 *
 * Not passed to `BrowserWindow` as its `title` option: a loaded document's `<title>` overrides
 * that option, so the option is only ever visible before the first paint — and the window is
 * created hidden and shown on `ready-to-show`, which is after it. It was set here at first, and
 * a test asserting the window's title then passed with the option deliberately set wrong.
 */
export const APP_NAME = 'Slicer Project Manager'

/**
 * The renderer is served from `spm://app/`, not loaded from `file://`.
 *
 * What actually breaks under `file://` is one thing, measured: the Angular build emits
 * `<base href="/">`, so every asset resolves to `file:///main.js`, nothing loads and `<app-root>`
 * stays empty. A first version of this comment also blamed `history.pushState` throwing on an
 * opaque origin. That is false on this Electron: a `file://` document reports its origin as
 * `file://`, `pushState` succeeds, and with the base href rewritten to `./` the whole app boots
 * and routes off `file://` perfectly well.
 *
 * So `baseHref: "./"` in the electron configuration of angular.json was a real alternative, and
 * it is rejected on merit rather than on impossibility:
 *
 * - A deep link cannot be reloaded. After the router pushes `file:///…/browser/projects` there
 *   is no such file, so any reload — or anything else that re-enters the URL — is a dead end.
 * - `file://` is where per-origin browser state stops being dependable, and the renderer is a
 *   real app that will want some.
 * - Decisive for task 3: `spm://file/<id>/raw` is cross-origin to a `file://` document with no
 *   way to make it otherwise, whereas both hosts living under one scheme leaves task 3 free to
 *   move the file host under `spm://app/` and be same-origin if CORS proves a nuisance.
 *
 * That last paragraph is now settled rather than speculative: ruling C-7 moved file bytes under
 * the renderer's own host at a reserved path. The two constants moved to `urls.ts` with it, so
 * `dispatch.ts` — which must be importable without Electron — can read them; they are re-exported
 * here because that is where task 1 put them and where task 3 will look.
 */
export { RENDERER_HOST, RENDERER_ORIGIN } from './urls.ts'

/** Names the library folder to open. Same variable the Deno server reads, on purpose. */
export const LIBRARY_DIR_ENV = 'SPM_LIBRARY_DIR'

/**
 * `spm://` has to be declared privileged *before* `app.whenReady()`, which is why it is declared
 * here and handled in `createSpmHandler` below.
 *
 * The four privileges are what Electron's documentation says they are, and none of them has been
 * removed one at a time to see what breaks — so read this as intent, not as measurement.
 * `standard` gives the scheme an origin, which is what makes `spm://app/_spm/...` same-origin
 * with the document; `secure` puts the renderer in a secure context; `supportFetchAPI` is what
 * the viewer's `fetch(rawUrl)` goes through; `stream` is there for the `ReadableStream` body
 * `serveLibraryFile` answers with, which does work — that part is measured, by the raw-bytes
 * test reading a body larger than one chunk.
 *
 * There is no `spm://file` host, which is what the plan originally specified — ruling C-7 moved
 * file bytes under the renderer's own host at a reserved path, because `spm://file` is a
 * different origin from `spm://app` and a `fetch()` from the renderer for a cross-origin
 * `spm://` URL fails with a bare `TypeError: Failed to fetch` — measured — until the response
 * carries CORS headers, and B2's viewer fetches `rawUrl` directly.
 */
export const SPM_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
} as const

export function registerSpmScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'spm', privileges: SPM_SCHEME_PRIVILEGES }])
}

/**
 * Explicit, not inferred. A module script served with the wrong Content-Type is refused by
 * Chromium outright, so guessing here would break the whole renderer rather than one asset.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/**
 * The renderer's content security policy, sent with the document.
 *
 * `default-src 'none'` is the part that earns its keep: nothing in this app should ever reach
 * the network, and with no policy at all Chromium would happily let a compromised renderer fetch
 * from anywhere. `spm:` is listed for images and connections because that is where file bytes
 * come from — and it is what `media-src` does *not* say, which is why a `<video>` pointed at a
 * `rawUrl` never issues a request at all. See the range table on `createSpmHandler`.
 *
 * `'unsafe-inline'` twice, and neither is an oversight. The Angular build inlines critical CSS
 * into `<head>`, and it defers the stylesheet with `<link media="print" onload="this.media=
 * 'all'">` — an inline event handler, which `script-src 'self'` blocks, leaving the app running
 * with no stylesheet at all. Hashes cannot cover an attribute handler, so the choices are this
 * or changing how the Angular build emits its head, which is not this task's to change.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: spm:",
  "connect-src 'self' spm:",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Where the Angular electron build lives, relative to this module once it is bundled. */
export function defaultRendererDir(): string {
  // The bundle is written to packages/desktop/dist/main.js.
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist/electron/browser')
}

/**
 * Maps a `spm://app/...` path onto a file in the renderer directory, or to `index.html` for
 * anything that is a client-side route rather than an asset. Returns null when the request
 * escapes the renderer directory, when it falls under the reserved prefix, or when its path
 * cannot be decoded at all.
 *
 * The containment check is not belt-and-braces. Chromium canonicalises `..` segments in a
 * standard-scheme URL and decodes `%2e` before the handler ever sees the path, so those escapes
 * are already dead — but an *encoded separator* is not canonicalised. Measured: with the check
 * removed, `spm://app/..%2f..%2f..%2fpackage.json` returns a file from outside the renderer
 * directory with status 200.
 *
 * The reserved-prefix check is what makes ruling C-7's path prefix actually reserved, and it is
 * here rather than in task 3 because task 2 is what started emitting those URLs. Without it the
 * SPA fallback below swallows them: `spm://app/_spm/files/<id>/raw` has no known extension, so
 * it came back **200 `text/html`** with index.html in the body — measured — and B2's viewer then
 * reported a perfectly intact model as damaged. Failing closed costs one line; failing open with
 * a success status and the wrong content type is the worst of the three states.
 *
 * It still refuses every one of them. `parseFileRequest` now takes the one canonical spelling
 * out of the stream *before* this function is reached, so what arrives here under the reserved
 * prefix is only ever an alias of it — and an alias must still be a 404, or the aliases would be
 * a second way to name a file. That is why the reserved list in `shell.spec.ts` did not change
 * when the bytes arrived: `_spm/files/abc/raw` 404s because there is no file `abc`, and
 * `_SPM/files/abc/raw` 404s because it never became a file request in the first place.
 *
 * It runs **after** `resolve`, and that ordering is what makes it proof against the *separator*
 * encodings — the class the containment check above exists for. Written first against the
 * decoded-but-unresolved path it had three live bypasses, all answering 200 with the SPA:
 * `x/..%2f_spm/…` presented `x` as its first segment and `resolve` then collapsed it back onto
 * `_spm`, and `_spm.` and `_spm%20` are NTFS aliases for the same directory, which the
 * case-folding reasoning had missed.
 *
 * Not proof of completeness, which is what an earlier version of this sentence claimed: `_spm%00`
 * and `_spm%00x` went straight past it and answered 200, because Win32 path APIs truncate at a
 * NUL and the trim did not. Any path containing a NUL is now refused outright, one line below —
 * a smaller and more defensible rule than modelling that truncation, and one `fs` would have
 * enforced anyway by throwing. What remains is a list of normalisations, each with a measurement
 * behind it, not a proof; `shell.spec.ts` carries every alias tried, including the seven that
 * correctly do *not* name the reserved directory.
 */
export function resolveRendererFile(rendererDir: string, pathname: string): string | null {
  const root = resolve(rendererDir)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // `%zz` is not a valid escape and decodeURIComponent throws URIError on it. Unhandled, that
    // rejects the handler's promise: the renderer sees a bare `TypeError: Failed to fetch` and
    // the main process logs an unhandled rejection. A malformed path is a 404 like any other.
    return null
  }
  // A NUL is never part of a path we serve. Node refuses one before the filesystem sees it, and
  // Win32 truncates at it — which is how `_spm%00` named the reserved directory while looking
  // like a different segment to a trailing-character trim.
  if (decoded.includes('\0')) return null
  const candidate = resolve(join(root, decoded))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  if (isReservedPath(root, candidate)) return null
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  // No such file: either a deep link the Angular router owns, or a genuinely missing asset.
  // An asset request has an extension we know about, and answering it with index.html would
  // hand Chromium HTML where it asked for JavaScript, which fails in a far less obvious way.
  if (extname(candidate) in CONTENT_TYPES) return null
  return join(root, 'index.html')
}

/**
 * Whether a path that has already been resolved and contained falls under the reserved prefix.
 *
 * Three normalisations, each for a measured bypass rather than for symmetry:
 *
 * - it works from `relative(root, candidate)`, so `..` and `.` segments — however they were
 *   encoded — have already been collapsed by `resolve` before the first segment is read;
 * - lowercased, because NTFS matches `_SPM` to a real `_spm` directory;
 * - trailing dots and spaces trimmed, because NTFS strips them too, so `_spm.` and `_spm%20`
 *   name that same directory. `path.resolve` does not strip either — it is a string operation —
 *   which is why this has to.
 *
 * The last two are Windows facts applied on every platform on purpose. On Linux `_spm.` really is
 * a different directory from `_spm`, so refusing it there is stricter than it needs to be — but
 * no such directory exists in a renderer build, and one guard that behaves the same everywhere is
 * worth more than a platform switch inside a security check. Where the platforms genuinely differ
 * is `\`, which `resolve` treats as a separator only on Windows; `shell.spec.ts` states that case
 * explicitly rather than asserting a single answer for both.
 */
export function isReservedPath(root: string, candidate: string): boolean {
  const [firstSegment] = relative(root, candidate)
    .split(/[\\/]+/)
    .filter(Boolean)
  return firstSegment?.toLowerCase().replace(/[. ]+$/, '') === RESERVED_PATH_SEGMENT
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * The single `spm://` handler. There is one host, `spm://app`, and two things under it: the
 * renderer's own assets, and file bytes at `spm://app/${RESERVED_PATH_SEGMENT}/files/<id>/{raw,
 * thumb}`. `parseFileRequest` decides which, and everything it does not claim falls through to
 * `resolveRendererFile` — including every alias of the reserved prefix, which that function goes
 * on refusing exactly as it did before this branch existed.
 *
 * **Ranges are not served, and nothing this app can do asks for one.** That is a measurement,
 * not a position. A recording handler was swapped in on Electron 44.0.0 (Chromium 152) with the
 * `spm` privileges below, and every consumer was driven at it with its request headers logged:
 *
 * | driven                        | method | `range`      |
 * | ----------------------------- | ------ | ------------ |
 * | `fetch(rawUrl)` — the viewer  | GET    | absent       |
 * | `<img src=thumbUrl>`          | GET    | absent       |
 * | `<a href=rawUrl>` clicked     | GET    | absent       |
 * | `webContents.downloadURL`     | GET    | absent (no headers at all) |
 * | `<video src=rawUrl>`          | GET    | **`bytes=0-`** |
 *
 * The last row is why this is written down rather than assumed, and it does not change the
 * answer — but the first version of this paragraph got the *scope* of the reason wrong, and the
 * review caught it. It said "the CSP has no `media-src`, so a `<video>` can never issue a
 * request". That is true of documents that **carry** the CSP, and this handler attaches one only
 * on the renderer-asset branch, for `text/html`. A document produced by the *file* branch would
 * have no policy at all.
 *
 * The answer survives the correction, on two legs rather than one:
 *
 * - In the renderer's own document — the only place an element can be written that points at a
 *   `rawUrl` — the CSP does hold: `default-src 'none'` with no `media-src`, so a `<video>` never
 *   issues a request. Measured: `securitypolicyviolation` fires with `media-src <- spm` and the
 *   element fails with `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`.
 *   `files.spec.ts` asserts the served header still has no `media-src`, so adding one breaks
 *   there rather than here.
 * - The file branch cannot produce a document that could hold a `<video>` in the first place.
 *   A first version of this leg cited only `.html`, `.svg` and `.xhtml` — which are precisely the
 *   extensions that *don't* commit, so it proved the narrower half of what it claimed. The whole
 *   of core's map was then driven, one navigation per type, and this is what came back:
 *
 *   | content type                  | extensions        | navigation | script ran |
 *   | ----------------------------- | ----------------- | ---------- | ---------- |
 *   | `text/plain; charset=utf-8`   | `txt`, `gcode`    | commits    | no         |
 *   | `application/json`            | `json`            | commits    | no         |
 *   | `image/png`                   | `png`             | commits    | no         |
 *   | `image/jpeg`                  | `jpg`, `jpeg`     | commits    | no         |
 *   | `application/pdf`             | `pdf`             | commits    | no         |
 *   | `model/stl`, `model/obj`, `model/3mf` | `stl`, `obj`, `3mf` | downloads | no |
 *   | `application/octet-stream`    | everything else   | downloads  | no         |
 *
 *   So six of the ten extensions really do commit as documents, and the payload's
 *   `<script>window.__p=1</script>` executed in **none** of them — a plain-text, JSON, image or
 *   PDF document cannot run script or hold a `<video>` element. The types that could are the
 *   ones that download, and `nosniff` on that branch is what stops Chromium reconsidering. See
 *   the header comment in `files.ts`.
 *
 * The `bytes=0-` above was measured from a CSP-free probe document, which remains the only place
 * it can happen. If a later task adds `media-src spm:`, or teaches core to serve a renderable
 * type, it inherits range support as a requirement — and this table is the evidence for that.
 *
 * The headers are genuinely visible here, which is the thing that would make the table vacuous
 * if it were not true: a `fetch` with a hand-written `x-probe: yes` arrived with it intact. So
 * did a hand-written `Range: bytes=4-9` — Chromium forwards it, this handler ignores it, and the
 * renderer gets **200 with the whole body**; `fetch` does not synthesise a 206 and does not slice
 * anything. `accept-ranges: none` on every response says so on the wire.
 *
 * The viewer's size gate, which the brief flagged as having assumed HTTP semantics, turns out to
 * need none: it compares `file.sizeBytes` from the DTO against a constant and returns *before*
 * any fetch (`viewer.page.ts`, the `oversized` branch), so it never depended on a header.
 */
export function createSpmHandler(
  rendererDir: string,
  resolveSession: () => DesktopSession | null,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname !== RENDERER_HOST) {
      // Nothing legitimate reaches here: every URL this app emits is under spm://app.
      return new Response('not found', { status: 404 })
    }
    const fileRequest = parseFileRequest(url.pathname)
    if (fileRequest) {
      const session = resolveSession()
      // No library open. A 404 and not a 503: with no library there is no id that names
      // anything, which is the same thing a stale URL from a library that has since been closed
      // means. It is also what the viewer renders best — 404 gives "this file is not part of
      // this project any more", where a 5xx gives "check your connection", and the connection is
      // not the problem. Task 4 makes this reachable by switching folders under a loaded page.
      //
      // Load-bearing, not defensive. Measured with the line deleted: `session.lib` throws a
      // TypeError, the handler's promise rejects, and the renderer gets a bare
      // `TypeError: Failed to fetch` — the failure with no status for the UI to branch on.
      if (!session) return new Response('not found', { status: 404 })
      return await serveLibraryFile(session.lib, session.ctx, fileRequest)
    }
    const file = resolveRendererFile(rendererDir, url.pathname)
    if (file === null) return new Response('not found', { status: 404 })
    try {
      const body = await readFile(file)
      const contentType = contentTypeFor(file)
      const headers: Record<string, string> = { 'content-type': contentType }
      // Only on the document: a CSP header on a stylesheet or a script is inert, and putting it
      // everywhere would suggest it does something there.
      //
      // No `x-content-type-options` here either, and that asymmetry with the file branch is
      // deliberate rather than an oversight. This branch serves the Angular build's own output
      // out of `rendererDir` through the fixed nine-entry `CONTENT_TYPES` map above — every type
      // explicit, no user bytes reachable, nothing falling through to a guess. The file branch
      // serves whatever a user dropped in a folder, under a name they chose, and that is what
      // makes sniffing worth forbidding there. Adding it here is defensible and untested; it is
      // left out rather than added unmeasured.
      if (contentType.startsWith('text/html')) {
        headers['content-security-policy'] = CONTENT_SECURITY_POLICY
      }
      return new Response(new Uint8Array(body), { status: 200, headers })
    } catch {
      return new Response('not found', { status: 404 })
    }
  }
}

/** A library that is open, migrated, and has its single local user. */
export type DesktopSession = { lib: Library; ctx: Ctx }

/**
 * Task 4 owns *choosing* the folder; this owns opening it. `openLibrary` already runs the
 * migrations (see db/open.ts), so there is no separate `runMigrations` call here — adding one
 * would be a no-op that reads as if it were doing something.
 */
export function openDesktopLibrary(dir: string): DesktopSession {
  const lib = openLibrary(dir)
  return { lib, ctx: ensureLocalUser(lib) }
}

export function closeDesktopLibrary(session: DesktopSession): void {
  closeLibrary(session.lib)
}

/**
 * Where the library path comes from until task 4 puts a picker in front of it. One source, the
 * environment: a `--library=` switch was written first and then removed, because nothing
 * exercised it and an untested second path into the one thing that decides which folder the app
 * writes to is not worth the convenience.
 */
export function resolveLibraryDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env[LIBRARY_DIR_ENV]
  return fromEnv ? resolve(fromEnv) : null
}

export function preloadPath(): string {
  return fileURLToPath(new URL('./preload.js', import.meta.url))
}

/**
 * The window.
 *
 * `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true` are constraint 3 of the
 * plan — the whole reason the renderer can be treated as untrusted — and the preload path is
 * real from the start so task 2 adds a bridge without touching any of them. They are asserted in
 * shell.spec.ts through `webContents.getLastWebPreferences()`, which is the only instrument that
 * sees them: with `contextIsolation` on, a renderer-side `typeof require` check stays green even
 * with `nodeIntegration` turned back on, so the obvious test is also the wrong one.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // Hidden until the first paint, so the window never flashes an unstyled, untranslated
    // shell. It is also what keeps the window's title honest — see APP_NAME.
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
    },
  })
  window.once('ready-to-show', () => window.show())
  applyNavigationPolicy(window)
  void window.loadURL(`${RENDERER_ORIGIN}/`)
  return window
}

/**
 * Keeps the window on the renderer's own origin, and sends everything else to the user's browser.
 *
 * A preload is attached to the *webContents*, not to a document, so it follows that webContents
 * wherever it navigates. Measured before this existed, on Electron 44.0.0: setting
 * `location.href = 'https://example.com/'` from the renderer's main world navigated the app's own
 * window there, and the remote page reported `typeof window.spm === 'object'` with keys
 * `canStreamFromDisk,invoke` — the whole IPC bridge, at someone else's origin.
 * `window.open('https://example.com/')` produced a *second* `BrowserWindow` at that origin, with
 * the same bridge. `navigationPolicy` in `urls.ts` carries the reasoning and the exhaustive unit
 * coverage; this is the wiring.
 *
 * **Both hooks, because neither one covers the whole surface** — which is not the same as saying
 * they never overlap, as an earlier version of this sentence did. It claimed `will-navigate`
 * never fires for a `window.open`. Measured, and it is nearly right but not absolute:
 * `window.open(url, '_blank')` reaches `setWindowOpenHandler` alone, while
 * `window.open(url, '_self')` navigates the current frame and reaches **`will-navigate` alone**.
 * Discriminated without inference, by opening a same-origin URL the two hooks disagree about:
 * `window.open('spm://app/import', '_self')` landed on `/import` — so the deny-everything window
 * handler never saw it — and the same URL with `_blank` left the page where it was and opened no
 * window. Either way one hook covers it; the point stands, the absolute did not.
 *
 * `shell.openExternal` and not simply a refusal: the project website link
 * (`project-detail.page.ts`, `target="_blank"`) is a real feature, and it is only http(s) that is
 * ever handed to the OS — a `file:` or `javascript:` URL reaching `openExternal` is its own
 * vulnerability, which is why `navigationPolicy` answers three values rather than a boolean.
 */
export function applyNavigationPolicy(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    const policy = navigationPolicy(url)
    if (policy === 'allow') return
    // Prevented first, so an `openExternal` that throws still cannot leave the app on a page it
    // was not supposed to reach.
    event.preventDefault()
    if (policy === 'external') void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Deny for `allow` too: nothing in this app opens a second window on its own origin, and a
    // window that arrived unasked for would have the bridge and no CSP-bearing document to hold
    // it. If a later task needs one, it opens it from the main process where it can say so.
    if (navigationPolicy(url) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
}

export function main(): void {
  app.setName(APP_NAME)
  registerSpmScheme()

  let session: DesktopSession | null = null

  // Before `whenReady`, and before any window: `ipcMain.handle` is not tied to a window, and
  // registering it first means the renderer cannot possibly load and call into a channel that
  // is not there yet. The accessor is a closure over `session` rather than the value, because
  // the value is null until a folder is opened and task 4 swaps it without a restart.
  registerInvokeHandler(() => session)

  app.whenReady().then(() => {
    try {
      // The same closure the IPC handler gets, and for the same reason: task 4 swaps the open
      // library without a restart, and a captured session would pin the protocol handler to the
      // old one — a re-registration it has no reason to discover it needs.
      protocol.handle(
        'spm',
        createSpmHandler(defaultRendererDir(), () => session),
      )

      const libraryDir = resolveLibraryDir()
      // Task 4 replaces this branch with a folder picker. Until then a shell with no library
      // still opens, and the bridge answers `capabilities` out of the shell itself while every
      // library-backed call reports `Conflict: no library folder is open`.
      if (libraryDir) session = openDesktopLibrary(libraryDir)

      createMainWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    } catch (error) {
      // Without this, a library that will not open leaves an unhandled rejection and a process
      // with no window at all — and `window-all-closed` never fires for a window that was never
      // created, so it hangs until something kills it. Task 4 turns this into an explanation
      // and a return to the picker; for now it is a message and a non-zero exit.
      console.error('desktop: startup failed', error)
      app.exit(1)
    }
  })

  app.on('window-all-closed', () => {
    // macOS keeps the app alive with no windows; everywhere else closing the window is quitting.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    if (session) closeDesktopLibrary(session)
    session = null
  })
}
