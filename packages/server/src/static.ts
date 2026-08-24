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

/** Serves the Angular bundle, falling back to index.html so client routes deep-link. The root
 *  is required rather than defaulted, so there is nowhere for a second copy of the default to
 *  hide: `makeHandler` resolves it once from `Env`. */
export async function serveStatic(url: URL, root: string): Promise<Response> {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  for (const candidate of [relative, 'index.html']) {
    try {
      const bytes = await Deno.readFile(staticFilePath(root, candidate))
      const type = candidate.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : candidate.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : candidate.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : contentTypeFor(candidate)
      return new Response(bytes, { headers: { 'content-type': type } })
    } catch {
      // A miss, or a candidate refused by staticFilePath: either way, try the SPA fallback.
      // Both genuinely collapse to the same answer, which is why one bare catch covers them.
      continue
    }
  }
  return new Response('not found', { status: 404 })
}
