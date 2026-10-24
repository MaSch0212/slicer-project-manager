import { resolve } from 'node:path'
import { contentTypeFor, safeJoin } from '@spm/core'

/**
 * Where the Angular bundle sits relative to *this file* (`packages/server/src`), i.e.
 * `packages/web/dist/web/browser`.
 */
const DEFAULT_WEB_ROOT_FROM_HERE = '../../web/dist/web/browser'

/**
 * The default web root is resolved against this module's own directory, never `Deno.cwd()`.
 *
 * README documents `deno run -A packages/server/main.ts` run from the repo root. A
 * cwd-relative default of `../web/dist/web/browser` resolved to
 * `<parent-of-repo>/web/dist/web/browser` from there, so every request — including the
 * `index.html` SPA fallback — missed and the entire UI answered 404. Nothing caught it,
 * because `playwright.config.ts` always passes an explicit `SPM_WEB_ROOT`.
 *
 * An explicit `SPM_WEB_ROOT` keeps its old meaning and stays relative to the process cwd
 * (that is the form playwright.config.ts uses: `dist/web/browser` with cwd `packages/web`).
 *
 * Takes the raw value rather than reading `SPM_WEB_ROOT` itself: the read belongs with every
 * other environment read, in `readServerEnv`, and a module-level one here would run at import
 * time — before `main.ts` can turn a bad value into a sentence.
 */
export function resolveWebRoot(override: string | undefined): string {
  if (override) return resolve(override)
  // import.meta.dirname is undefined only for non-file: module URLs, which this never is.
  return resolve(import.meta.dirname ?? '.', DEFAULT_WEB_ROOT_FROM_HERE)
}

/**
 * Joins a request-derived candidate under the web root, refusing anything that escapes it.
 *
 * The server runs with `-A`, so this must not rest on the incidental fact that WHATWG URL
 * normalisation resolves dot segments before `url.pathname` is ever read: the guarantee is
 * stated here, by core's own `safeJoin`, the same function every library path goes through.
 * Throws `AppError('Forbidden')` on an absolute, empty or escaping segment.
 */
export function staticFilePath(root: string, candidate: string): string {
  return safeJoin(root, ...candidate.split('/'))
}

/**
 * The types the Angular bundle needs that core's `contentTypeFor` does not know.
 *
 * **Here and not in core, on purpose.** `contentTypeFor` is the map for *library* files — bytes a
 * user dropped into a project folder, under a name they chose — and `packages/desktop/src/app.ts`
 * carries a measured table of what each of those types does when navigated to at the renderer's
 * own origin. `svg` is precisely the entry that would invalidate it: an SVG document commits *and
 * can run script*, which is why core's map does not contain it and must not gain it. This map
 * serves only the Angular build's own output, where every file is one this repo generated.
 *
 * The three entries below were all measured wrong before they were added. With the bundle carrying
 * the app icons and this function unchanged, `favicon.svg`, `favicon.ico` and
 * `manifest.webmanifest` all came back **200 `application/octet-stream`** from a real
 * `serveStatic` call. That is not cosmetic for any of them:
 *
 * - Chromium does not sniff SVG for `<img>` — it requires `image/svg+xml` — so the brand mark in
 *   the app header rendered as a broken image in the browser while working perfectly in the
 *   Electron shell, which has its own map and already had `.svg` in it.
 * - Chromium refuses a manifest that is not served as JSON, so the Android home-screen icon the
 *   manifest exists for would not have been used.
 * - The `.ico` is the one browsers are lenient about, and it is here because leaving one of three
 *   wrong to prove a point about leniency is not a decision worth writing down.
 *
 * `.woff2` is *not* here, and that is a deliberate omission rather than an oversight: the bundle's
 * Inter fonts are served as `application/octet-stream` today and load correctly, because browsers
 * do not enforce a font's media type. Adding it would be defensible and unmeasured.
 */
const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function bundleContentType(candidate: string): string {
  const dot = candidate.lastIndexOf('.')
  const extension = dot === -1 ? '' : candidate.slice(dot).toLowerCase()
  return BUNDLE_CONTENT_TYPES[extension] ?? contentTypeFor(candidate)
}

/** Serves the Angular bundle, falling back to index.html so client routes deep-link. The root
 *  is required rather than defaulted, so there is nowhere for a second copy of the default to
 *  hide: `makeHandler` resolves it once from `Env`. */
export async function serveStatic(url: URL, root: string): Promise<Response> {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  for (const candidate of [relative, 'index.html']) {
    try {
      const bytes = await Deno.readFile(staticFilePath(root, candidate))
      const type = bundleContentType(candidate)
      return new Response(bytes, { headers: { 'content-type': type } })
    } catch {
      // A miss, or a candidate refused by staticFilePath: either way, try the SPA fallback.
      // Both genuinely collapse to the same answer, which is why one bare catch covers them.
      continue
    }
  }
  return new Response('not found', { status: 404 })
}
