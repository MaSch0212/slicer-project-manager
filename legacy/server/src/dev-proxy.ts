import { AppError } from '@spm/contract/errors.ts'
import type { Logger } from '@spm/core'

/**
 * Forwards non-API requests to a running Angular dev server.
 *
 * Without this the two halves of the app cannot be served at once: `ng serve` owns the UI on
 * :4200 but knows nothing about `/api`, and the Deno server owns `/api` but can only serve a
 * bundle that has already been built. Developing meant rebuilding the whole Angular app after
 * every edit. With `SPM_DEV_UI_ORIGIN` set, one origin serves both -- the API locally, and
 * everything else from `ng serve`, live reload included.
 *
 * This is a development affordance and is off unless the variable is set. It is never a
 * production path: a proxy in front of `ng serve` has no place in a deployment, and the
 * unbuilt dev bundle is not what should be served to users.
 */

/** Validated at startup so a typo fails immediately rather than on the first page load. */
export function resolveDevUiOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new AppError('Validation', `SPM_DEV_UI_ORIGIN is not a URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('Validation', `SPM_DEV_UI_ORIGIN must be http(s): ${raw}`)
  }
  return parsed.origin
}

/**
 * Hop-by-hop headers, which belong to a single connection and must not be forwarded
 * (RFC 9110 §7.6.1). Passing `connection` or `upgrade` through to `fetch` makes Deno reject
 * the request outright, and forwarding `content-length` alongside a streamed body double-counts
 * it. `host` is dropped so fetch derives the right one for the upstream origin.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

function forwardableHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of source) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

/** Pipes a client websocket and an upstream one together until either end closes. */
export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  // Anything the client sends before the upstream handshake finishes would throw on send,
  // so it is queued and flushed on open. Vite's HMR client talks immediately.
  const pending: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = []
  let upstreamOpen = false

  client.onmessage = (event) => {
    if (upstreamOpen) upstream.send(event.data)
    else pending.push(event.data)
  }
  upstream.onopen = () => {
    upstreamOpen = true
    for (const message of pending) upstream.send(message)
    pending.length = 0
  }
  upstream.onmessage = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(event.data)
  }

  // A close on either side tears down the other, so a dev-server restart does not leave the
  // browser holding a socket that will never speak again.
  const close = (socket: WebSocket) => () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  }
  client.onclose = close(upstream)
  client.onerror = close(upstream)
  upstream.onclose = close(client)
  upstream.onerror = close(client)
}

export type DevProxyDeps = {
  fetch: typeof globalThis.fetch
  upgrade: (req: Request, protocol: string | undefined) => { socket: WebSocket; response: Response }
  openUpstream: (url: string, protocols: string[]) => WebSocket
  log: Logger
}

export function makeDevProxy(origin: string, deps: DevProxyDeps) {
  return async function proxy(req: Request, url: URL): Promise<Response> {
    const target = new URL(url.pathname + url.search, origin)

    // Vite's live reload runs over a websocket; without this every edit would need a manual
    // refresh, which defeats most of the point of proxying to the dev server at all.
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      // The 101 must echo a subprotocol the client offered, or the browser fails the
      // connection even though the handshake looked fine from the server side -- which is
      // exactly what a silent "WebSocket connection failed" in the console means here.
      // Vite offers exactly one ("vite-hmr"), and its own server echoes the first, so
      // picking the first matches what the client would have got talking to it directly.
      const { socket, response } = deps.upgrade(req, protocols[0])
      // The same protocol has to go upstream: vite ignores a handshake that omits it, and
      // the connection then hangs open until it times out rather than failing fast.
      const upstream = deps.openUpstream(target.href.replace(/^http/, 'ws'), protocols)
      bridgeSockets(socket, upstream)
      deps.log.debug('dev proxy websocket', { path: url.pathname })
      return response
    }

    try {
      const upstream = await deps.fetch(target, {
        method: req.method,
        headers: forwardableHeaders(req.headers),
        body: req.body,
        // The browser must see the dev server's redirect, not its resolution.
        redirect: 'manual',
        // Required by fetch whenever a request carries a streamed body.
        ...(req.body ? { duplex: 'half' } : {}),
      } as RequestInit)
      deps.log.debug('dev proxy', {
        method: req.method,
        path: url.pathname,
        status: upstream.status,
      })
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: forwardableHeaders(upstream.headers),
      })
    } catch (error) {
      // Almost always "the dev server is not running yet". Saying so beats a bare 500,
      // because the fix is a second terminal rather than anything in this codebase.
      deps.log.warn('dev proxy could not reach the UI dev server', { origin, err: error })
      return new Response(
        `Cannot reach the Angular dev server at ${origin}.\n` +
          `Start it with: deno task dev:ui\n` +
          `Or unset SPM_DEV_UI_ORIGIN to serve the built bundle instead.\n`,
        { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
  }
}

/** The real wiring: Deno's own fetch, websocket upgrade and client. */
export function denoDevProxy(origin: string, log: Logger) {
  return makeDevProxy(origin, {
    fetch: (input, init) => fetch(input, init),
    upgrade: (req, protocol) => Deno.upgradeWebSocket(req, protocol ? { protocol } : undefined),
    openUpstream: (url, protocols) =>
      protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url),
    log,
  })
}
