import { app, BrowserWindow, protocol } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeLibrary, ensureLocalUser, openLibrary, type Ctx, type Library } from '@spm/core'

/**
 * The Electron main process.
 *
 * Everything here is exported rather than run inline so task 2 can import the pieces it needs —
 * `openDesktopLibrary` for the dispatch table's `lib`/`ctx`, `createMainWindow` for the window —
 * instead of duplicating them. `main()` at the bottom is the only thing with side effects, and
 * it is called immediately below: this module is always the entry point Electron is given.
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
 * The renderer is served from `spm://app/`, not from `file://`.
 *
 * Measured, not assumed: `loadFile()` on the Angular electron build produces a window whose
 * `<app-root>` stays empty. The build emits `<base href="/">`, so under `file://` every asset
 * resolves to `file:///main.js` and nothing loads; and even with a relative base href, a
 * `file://` document has an opaque origin, where `history.pushState` throws and the Angular
 * router cannot navigate. A standard scheme with a real origin fixes both at once.
 */
export const RENDERER_HOST = 'app'
export const RENDERER_ORIGIN = `spm://${RENDERER_HOST}`

/** Names the library folder to open. Same variable the Deno server reads, on purpose. */
export const LIBRARY_DIR_ENV = 'SPM_LIBRARY_DIR'
/** Overrides where the Angular electron build is read from. Set by the tests. */
export const RENDERER_DIR_ENV = 'SPM_DESKTOP_RENDERER_DIR'

/**
 * `spm://` has to be declared privileged *before* `app.whenReady()`, which is why it is here
 * and not in task 3 with the rest of the scheme. Task 3 adds the `spm://file/<id>/{thumb,raw}`
 * handler; until then `serve()` below answers 404 for every host but the renderer's.
 *
 * Note for task 3: the renderer's origin is `spm://app`, so `spm://file/...` is cross-origin to
 * it. `<img src>` does not care, but a `fetch()` from the renderer for `spm://file/...` fails
 * with a bare `TypeError: Failed to fetch` — measured — until the response carries CORS headers.
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

/** Where the Angular electron build lives, relative to this module once it is bundled. */
export function defaultRendererDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[RENDERER_DIR_ENV]
  if (override) return resolve(override)
  // The bundle is written to packages/desktop/dist/main.js.
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist/electron/browser')
}

/**
 * Maps a `spm://app/...` path onto a file in the renderer directory, or to `index.html` for
 * anything that is a client-side route rather than an asset. Returns null when the request
 * escapes the renderer directory.
 *
 * That containment check is not belt-and-braces. Chromium canonicalises `..` segments in a
 * standard-scheme URL and decodes `%2e` before the handler ever sees the path, so those escapes
 * are already dead — but an *encoded slash* is not canonicalised. Measured: with the check
 * removed, `spm://app/..%2f..%2f..%2fpackage.json` returns a file from outside the renderer
 * directory with status 200.
 */
export function resolveRendererFile(rendererDir: string, pathname: string): string | null {
  const root = resolve(rendererDir)
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(join(root, decoded))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  // No such file: either a deep link the Angular router owns, or a genuinely missing asset.
  // An asset request has an extension we know about, and answering it with index.html would
  // hand Chromium HTML where it asked for JavaScript, which fails in a far less obvious way.
  if (extname(candidate) in CONTENT_TYPES) return null
  return join(root, 'index.html')
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** The single `spm://` handler. Task 3 adds the `file` host beside the renderer's. */
export function createSpmHandler(rendererDir: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname !== RENDERER_HOST) {
      // spm://file/<id>/thumb and spm://file/<id>/raw arrive here in task 3.
      return new Response('not found', { status: 404 })
    }
    const file = resolveRendererFile(rendererDir, url.pathname)
    if (file === null) return new Response('not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': contentTypeFor(file) },
      })
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
 * The window. `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true` are
 * constraint 3 of the plan, and the preload path is real from the start so task 2 adds a
 * bridge to it without touching any of these options.
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
  void window.loadURL(`${RENDERER_ORIGIN}/`)
  return window
}

export function main(): void {
  app.setName(APP_NAME)
  registerSpmScheme()

  let session: DesktopSession | null = null

  app.whenReady().then(() => {
    try {
      protocol.handle('spm', createSpmHandler(defaultRendererDir()))

      const libraryDir = resolveLibraryDir()
      // Task 4 replaces this branch with a folder picker. Until then a shell with no library
      // still opens: the renderer has no way to reach one before task 2's bridge anyway.
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

main()
