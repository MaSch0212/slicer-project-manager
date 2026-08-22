import { contentTypeFor } from '@spm/core'

const WEB_ROOT = Deno.env.get('SPM_WEB_ROOT') ?? '../web/dist/web/browser'

/** Serves the Angular bundle, falling back to index.html so client routes deep-link. */
export async function serveStatic(url: URL): Promise<Response> {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  for (const candidate of [relative, 'index.html']) {
    try {
      const bytes = await Deno.readFile(`${WEB_ROOT}/${candidate}`)
      const type = candidate.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : candidate.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : candidate.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : contentTypeFor(candidate)
      return new Response(bytes, { headers: { 'content-type': type } })
    } catch {
      continue
    }
  }
  return new Response('not found', { status: 404 })
}
