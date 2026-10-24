import type { Capabilities } from '@spm/contract/dtos.ts'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { isCapabilities, REMOTE_SHELL_CAPABILITIES, unionCapabilities } from './capabilities.ts'
import { API_PATH_PREFIX, UPLOAD_LENGTH_HEADER } from './protocol.ts'
import { RENDERER_ORIGIN } from './urls.ts'

/**
 * Remote-server mode (spec 2.6): the shell pointed at a Deno server instead of at a folder.
 *
 * **The renderer is never navigated to the remote origin, and never learns what it is.** It stays
 * on `spm://app`, uses the same `HttpApiClient` the browser build uses with an empty base URL,
 * and every `/api/...` request it makes is answered by the main process, which forwards it to the
 * configured origin. The shell is a reverse proxy for one server.
 *
 * That is not indirection for its own sake. Four things made it the only workable shape, and each
 * one was measured before this file existed:
 *
 * - **The bridge.** A preload is attached to the *webContents*, so a window navigated to a remote
 *   origin hands that origin `window.spm` — task 3 measured exactly that and added
 *   `navigationPolicy` to stop it. Remote mode must not be the hole that policy closed.
 * - **File URLs.** The server decorates its DTOs with `/api/files/<id>/thumb`, a *relative* URL.
 *   In a document at `spm://app` that resolves to `spm://app/api/files/<id>/thumb` — so those
 *   bytes have to be served from this origin whatever else happens. Measured through the proxy:
 *   `<img src="/api/files/…/thumb">` loads and decodes, 2×2 px of real PNG.
 * - **CORS and the CSP.** Fetching the remote origin directly from `spm://app` is cross-origin.
 *   The server sends no CORS headers and constraint 2 forbids teaching it any, and the renderer's
 *   `connect-src 'self' spm:` would have to be widened to whatever the user typed. Through the
 *   proxy every request is same-origin and the CSP is untouched.
 * - **The cookie.** `SameSite=Lax` drops the session cookie on a cross-site subresource request,
 *   and `Secure` (which the server sets for anything that is not plain-http localhost) is refused
 *   outright from a page Chromium does not consider secure. A browser tab gets this for free
 *   because the page and the API share an origin; the desktop app is not a browser tab.
 *
 * Nothing here imports `electron` — `fetch` is injected — so `test/remote.test.ts` drives the
 * whole of it against a real HTTP server under plain `node --test`, and `test/remote.spec.ts`
 * drives it against a real Deno server through a real window.
 */

/** Names a remote server for one launch, overriding whatever is remembered. */
export const REMOTE_URL_ENV = 'SPM_REMOTE_URL'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Turns what the user typed into the origin the shell will talk to, or throws `Validation`.
 *
 * **This is untrusted input** (constraint 4): it arrives from the renderer, through
 * `library.connect`. What it can do is bounded by being an *origin* and nothing else — the
 * pathname, query and fragment are refused rather than dropped, so `https://example.com/api/../..`
 * cannot become a base for path arithmetic later, and a user who pasted a deep link is told their
 * URL was not what this wanted rather than being silently connected somewhere else.
 *
 * `http:` and `https:` only. Every other scheme is refused, including the ones that would be
 * actively dangerous to hand to `fetch` — `file:` reads the user's disk, `data:` would make the
 * shell serve renderer-supplied bytes from its own origin.
 *
 * Credentials in the URL (`https://user:pass@host`) are refused rather than stripped: they would
 * otherwise be a password the shell holds and never uses, and silently dropping half of what
 * somebody typed is worse than saying no.
 */
export function parseRemoteOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('Validation', 'a server URL is required')
  }
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new AppError('Validation', `not a URL: ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('Validation', `a server URL must be http or https, not ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError('Validation', 'a server URL must not carry a username or a password')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new AppError('Validation', 'a server URL must not carry a query string or a fragment')
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new AppError(
      'Validation',
      `a server URL must name an origin, not a path: ${url.pathname}`,
    )
  }
  return url.origin
}

/**
 * Whether the session on this origin travels in the clear.
 *
 * Not a refusal: a library server on a home LAN over plain http is the normal case for this app,
 * and the alternative to allowing it is that the desktop shell cannot reach the server the
 * README tells people to run. It is a warning because the *whole* exchange is readable on that
 * network — the login, the token and every model — and the cookie's own `Secure` attribute is
 * the smallest part of that.
 */
export function isPlaintextToAnotherMachine(origin: string): boolean {
  const url = new URL(origin)
  if (url.protocol !== 'http:') return false
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
}

/**
 * What the shell forwards from the renderer's request to the server, and nothing else.
 *
 * An allow-list because the renderer is the untrusted side (constraint 4) and this is the one
 * place its bytes reach another machine. Three entries earn their place: `content-type` (the
 * server's `parseJson` reads it), `accept`, and `x-spm-file-name`, which is how an upload names
 * its file (`packages/server/src/routes/files.ts`).
 *
 * `cookie` is **not** on it, and cannot be smuggled either: measured in Electron 44.0.0, a
 * renderer `fetch` that sets `cookie` (or `content-length`) has it stripped by Chromium before
 * the protocol handler is reached — they are forbidden header names — so the request arrived with
 * `x-ok: 1` and neither of them. The allow-list is what makes that a rule rather than a
 * coincidence of Chromium's list.
 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-spm-file-name']

/**
 * Response headers the shell does **not** pass on.
 *
 * `set-cookie` because the session is the shell's to hold — see `RemoteHost`. Measured: an
 * `spm://` response carrying one is ignored by Chromium anyway (`document.cookie` stayed empty
 * and the next request carried nothing), so this is belt to that brace, and the brace is not
 * something to depend on.
 *
 * `content-encoding` and `content-length` because `fetch` upstream has already decoded the body:
 * forwarding a `gzip` label over decompressed bytes, or a length that counts the compressed ones,
 * describes a body that no longer exists.
 */
const DROPPED_RESPONSE_HEADERS = ['set-cookie', 'content-encoding', 'content-length']

/**
 * Headers the shell puts on every proxied response, overriding whatever the server sent.
 *
 * See `#forward` for the measurement. In short: these bytes land on the origin that holds the IPC
 * bridge, and their content type is chosen by another machine.
 */
const FORCED_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
}

/** What `HttpApiClient` reaches for. Anything else is refused before a request leaves the app. */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/**
 * One remote server, its session, and the proxy that reaches it.
 *
 * **Where the session lives: in this object, in the main process's memory, and nowhere else.**
 * Every `Set-Cookie` the server sends is kept in `#cookies` and replayed on later requests; the
 * renderer never sees a token and cannot read one, exactly as `HttpOnly` gives a browser tab. The
 * object is dropped when the mode changes and dies with the process, so **a restart deliberately
 * logs the user out**.
 *
 * That is a decision, not the default, and the default is the other way. Measured on Electron
 * 44.0.0: `net.fetch` from the main process uses the default `session`'s cookie jar, and after a
 * login the jar held `spm_session` with `session: false` — a *persistent* cookie, written under
 * `userData` and reloaded on the next launch. Using it would have kept the user logged in with no
 * code at all, and would have put a bearer credential for a remote server on the user's disk for
 * as long as its `Max-Age`, protected by nothing this app controls. `globalThis.fetch` was used
 * instead precisely because it has no jar — measured in the same run: a second request through it
 * carried no cookie — which leaves the storage decision here, in the open, rather than inherited.
 *
 * The cost is stated rather than hidden: every launch of the desktop app in remote mode starts at
 * the login screen. If that is later judged the wrong trade, the change is to persist `#cookies`
 * through `safeStorage` (OS-backed encryption) and not to reach for `net.fetch`'s jar, because
 * the jar's contents are as durable as the disk and nothing in the app would say so.
 */
export class RemoteHost {
  readonly origin: string
  readonly #fetch: FetchLike
  /** Cookie name to value, as the server last set them. See the note above on where this lives. */
  readonly #cookies = new Map<string, string>()
  /**
   * Aborts every request this host still has in flight when the shell lets go of it.
   *
   * `#closed` stops a *new* call reaching a server the shell has left; it did nothing about one
   * already on the wire, so a request issued a moment before a mode switch could still land, and
   * its response could still be handed to a renderer that is about to be replaced.
   *
   * It is also the only bound this proxy places on an upstream that accepts a request and never
   * answers. What remains beyond it is undici's own headers and body timeouts, which this code
   * does not set and this branch has not measured — so the honest statement is that a silent
   * server hangs that request until the shell changes mode or the app quits, not that it hangs
   * for ever.
   */
  readonly #inFlight = new AbortController()
  #closed = false

  constructor(origin: string, fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.origin = origin
    this.#fetch = fetchFn
  }

  /** For tests and for the leak hunt: whether a session is being carried right now. */
  hasSession(): boolean {
    return this.#cookies.size > 0
  }

  /**
   * Lets go of the server, and of the session with it.
   *
   * Called when the shell changes mode. Clearing the cookies is the point: without it a host that
   * something still held a reference to would go on being able to act as the logged-in user, and
   * the "switching modes does not leak the previous mode's client" property would be true of the
   * renderer and false of the main process. `#closed` makes a late call fail loudly rather than
   * reach the server out of a mode the shell has left.
   */
  close(): void {
    this.#closed = true
    this.#cookies.clear()
    this.#inFlight.abort()
  }

  /**
   * Answers one `spm://app/api/...` request out of the remote server.
   *
   * The path is taken from the request and appended to the configured origin, and **every
   * response the renderer sees comes from that origin on a path under `/api`**. Two separate
   * things hold that up, and an earlier version of this comment claimed the property while only
   * one of them was true:
   *
   * - A request for `/api/../admin` never gets here, because Chromium canonicalises `..` in a
   *   standard-scheme URL before the protocol handler sees it (the same fact
   *   `resolveRendererFile` rests on), and the prefix check below refuses what is left.
   * - **Redirects are not followed** — see `#send`. Without that, the confinement was true of the
   *   first hop only.
   */
  async proxy(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (this.#closed) return this.#failure(503, 'Internal', 'the server connection has been closed')
    if (!url.pathname.startsWith(`${API_PATH_PREFIX}/`)) {
      return this.#failure(404, 'NotFound', `no such path: ${url.pathname}`)
    }
    if (!ALLOWED_METHODS.includes(request.method)) {
      return this.#failure(405, 'Validation', `${request.method} is not allowed`)
    }
    const response = await this.#send(request, url)
    if (response.status === 200 && this.#isCapabilitiesRequest(request, url)) {
      return await this.#unioned(response)
    }
    return response
  }

  /**
   * The union, for the IPC route — `capabilities` over the bridge, in a window that is talking to
   * a server. The renderer in remote mode does not take this path (it runs `HttpApiClient`, and
   * `proxy` unions the response on its way past), but the same request through the same code is
   * what makes the two answers impossible to tell apart.
   *
   * It throws rather than degrading when the server will not answer: `CapabilitiesStore` already
   * falls back to the most restrictive set, and inventing `requiresAuth: false` for a server that
   * is merely unreachable would walk the user into an app where every call fails.
   */
  async capabilities(): Promise<Capabilities> {
    const response = await this.proxy(
      new Request(`${RENDERER_ORIGIN}${API_PATH_PREFIX}/capabilities`),
    )
    const body: unknown = await response.json().catch(() => null)
    if (response.status !== 200 || !isCapabilities(body)) {
      throw new AppError('Internal', `${this.origin} did not answer with its capabilities`)
    }
    return body
  }

  #isCapabilitiesRequest(request: Request, url: URL): boolean {
    return request.method === 'GET' && url.pathname === `${API_PATH_PREFIX}/capabilities`
  }

  /**
   * Spec 2.4's union, applied where the renderer cannot skip it.
   *
   * The renderer runs the browser's `HttpApiClient` unchanged, so `capabilities()` is a plain
   * `GET /api/capabilities` and whatever comes back is what the whole UI keys off. Doing the
   * union in the renderer would mean a desktop-only wrapper around a client the spec says to use
   * as it is; doing it here means the shell's column is added by the only process that knows what
   * shell this is. The IPC route reaches the same code through `capabilities()` below — in local
   * mode there is no backend to union with at all, and `ShellHost.capabilities` answers the
   * shell's column directly.
   *
   * A backend that answers something that is not a `Capabilities` is passed through untouched
   * rather than unioned with a guess: `CapabilitiesStore` already has a fallback for a
   * `capabilities()` it cannot use, and inventing five flags out of a proxy's error page would
   * light up UI on the strength of a 200 from something that is not this server.
   */
  async #unioned(response: Response): Promise<Response> {
    // Read once and rebuild, rather than `clone()`: a clone tees the stream and whichever branch
    // is not read stays buffered until it is collected. A capability set is a couple of hundred
    // bytes, so reading it whole costs nothing and leaves nothing dangling.
    const text = await response.text()
    let backend: unknown = null
    try {
      backend = JSON.parse(text)
    } catch {
      // Not JSON at all. Handed on exactly as it arrived.
    }
    const headers = new Headers(response.headers)
    if (!isCapabilities(backend)) {
      console.warn('desktop: the remote server answered /api/capabilities with something else')
      return new Response(text, { status: response.status, headers })
    }
    const merged: Capabilities = unionCapabilities(REMOTE_SHELL_CAPABILITIES, backend)
    headers.set('content-type', 'application/json')
    // `headers` is a copy of what `#forward` already produced, so it carries the forced pair.
    // Building a fresh `Headers` here is what would silently drop them.
    return new Response(JSON.stringify(merged), { status: 200, headers })
  }

  async #send(request: Request, url: URL): Promise<Response> {
    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    // Only where there is a body to measure. A `x-spm-content-length` on a GET would otherwise
    // become a `content-length` describing a body that is not there, and undici would either
    // refuse the request or wait for bytes that never come.
    const declared = request.body ? declaredUploadLength(request) : null
    // Measured: Chromium strips `content-length` from a renderer `fetch` (it is a forbidden
    // header name) and does not put the body's own length on the `Request` the protocol handler
    // receives, so a proxied upload reaches the server as `Transfer-Encoding: chunked` — and the
    // server refuses a body with no length with 411 before it writes a byte (spec 5.6,
    // `requireContentLength`). The renderer therefore declares the length it already knows in a
    // header of its own (see `UPLOAD_LENGTH_HEADER`), and this is where it becomes the real one.
    // Measured end to end: with it, the server saw `content-length: 100000` and no chunking, and
    // all 100 000 bytes arrived; without it, no length and `transfer-encoding: chunked`.
    if (declared !== null) headers.set('content-length', String(declared))
    const cookie = this.#cookieHeader()
    if (cookie) headers.set('cookie', cookie)

    // **`manual`, and this is the security boundary the rest of the file rests on.** The default
    // is `follow`, and measured against a server answering `302 Location:
    // http://127.0.0.1:<other>/_cluster/health`, undici fetched that other host and handed back
    // its body with **status 200** and `response.url` pointing at it — a general read primitive
    // for whatever the renderer could get the shell pointed at, on any host and any path, wearing
    // the configured server's identity. With `manual` the same request comes back as a 302 with
    // its `Location` intact and nothing else is fetched, which is what `#refuseRedirect` then
    // turns into an error the user can act on.
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: 'manual',
      // Cancelled by `close()`, so letting go of a server also lets go of what it still owes us.
      signal: this.#inFlight.signal,
    }
    if (request.body) {
      // Streamed, never buffered: an upload may be a whole CuraManager archive, and the shell
      // holding a copy of it in memory to count its bytes would be a worse answer than the 411
      // the header above avoids.
      init.body = request.body
      init.duplex = 'half'
    }

    let response: Response
    try {
      response = await this.#fetch(`${this.origin}${url.pathname}${url.search}`, init)
    } catch (error) {
      // The server is not there, the name does not resolve, or TLS failed. It reaches the UI as
      // an `AppError` with a code, like every other failure (constraint 5): `HttpApiClient`
      // rebuilds one from this envelope, and a bare 502 with a text body would arrive as
      // `Internal: request failed with status 502` with nothing naming the server.
      const detail = error instanceof Error ? error.message : String(error)
      return this.#failure(502, 'Internal', `could not reach ${this.origin}: ${detail}`)
    }
    // The refusal comes first. Taking a `Set-Cookie` off a response whose body and destination
    // this proxy is about to reject sat oddly beside "nothing else is fetched" — and a server
    // that redirects is, by this shell's own rule, not one it is talking to.
    if (isRedirect(response.status)) return this.#refuseRedirect(response)
    this.#absorbCookies(response)
    return this.#forward(response)
  }

  /**
   * A redirect is refused, and named, rather than followed or passed on.
   *
   * Refused because following it leaves the origin the user named (see `#send`). Not passed on
   * either: the renderer's own `fetch` would follow it, and a `Location` on another origin is
   * then a request from the renderer to that origin — the same escape one layer out, stopped
   * only by a CSP that is not this module's to depend on.
   *
   * The message names the target, because the one legitimate way to meet this is a reverse proxy
   * redirecting `http://host` to `https://host`. **Where that message actually goes is worth
   * being exact about, because three comments used to overstate it.** It travels to the renderer
   * in the app's error envelope and `HttpApiClient` rebuilds it into an `AppError` — and both
   * places that catch one (`capabilities.store.ts`, `login.page.ts`) show the user a fixed
   * sentence, so what the user *sees* is "sign-in failed". The message is logged: here, in the
   * shell's own stderr, which is the log a user can paste; and in the renderer's console at both
   * of those catch sites, which is what the View menu's developer tools are for. It is a
   * diagnostic, not a dialog, and saying otherwise is how a mitigation becomes a claim nobody
   * checked.
   *
   * `Internal` rather than a new code: `AppErrorCode` is a closed union and this is not a failure
   * any UI branches on.
   */
  #refuseRedirect(response: Response): Response {
    const location = response.headers.get('location') ?? 'somewhere else'
    console.warn(`desktop: refused a redirect from ${this.origin} to ${location}`)
    return this.#failure(
      502,
      'Internal',
      `${this.origin} redirected to ${location}; this app talks to one server and does not ` +
        'follow redirects. Use that address directly if it is the right one.',
    )
  }

  /**
   * Hands the server's answer to the renderer, with two headers the server does not get a say in.
   *
   * **The `content-type` on a proxied response is chosen by another machine, and these bytes land
   * on `spm://app` — the origin that holds the IPC bridge.** `createSpmHandler` attaches its CSP
   * only on the renderer-asset branch and `nosniff` only on the file branch; this branch was
   * getting neither, and it is reachable by a plain click, because `project-detail.page.ts`
   * renders `<a [href]="file.rawUrl">` and in remote mode `rawUrl` is the server's own relative
   * `/api/files/<id>/raw`.
   *
   * Measured before these two lines existed, through the real shell against a server answering
   * that path with `text/html`: the document committed at `spm://app` and its script **ran**
   * (`window.__pwned === true`). That is script in the privileged origin with no policy on it —
   * `window.spm`, same-origin storage, a convincing page inside the real app window, and an
   * unrestricted `fetch` to anywhere, which is precisely what the renderer's own
   * `default-src 'none'` exists to stop.
   *
   * Both headers, because they stop different halves. `nosniff` keeps Chromium from *upgrading* a
   * boring type into a renderable one. It does nothing when the server simply says `text/html`,
   * which is the interesting case — that is what the `sandbox` policy is for: a document that
   * commits under it has an opaque origin, runs no script and submits no forms, so there is
   * nothing left to hold the bridge with.
   *
   * Neither harms the two things that legitimately read this branch. A CSP is inert on a
   * subresource, so `HttpApiClient`'s `fetch` and `<img src="/api/files/…/thumb">` are untouched,
   * and `remote.spec.ts` drives a real thumbnail and a real download through here to say so
   * rather than to assume it.
   *
   * `content-disposition: attachment` outside an allow-list was the other half offered in review.
   * It is not added: the sandbox already removes what a document could do, and forcing a download
   * on every response this app has not enumerated would break the next content type the server
   * learns to send before anyone noticed why.
   */
  #forward(response: Response): Response {
    const headers = new Headers(response.headers)
    for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name)
    for (const [name, value] of Object.entries(FORCED_RESPONSE_HEADERS)) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  }

  #cookieHeader(): string | null {
    if (this.#cookies.size === 0) return null
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Takes whatever the server set, by name, rather than knowing the session cookie's name.
   *
   * The alternative was to spell `spm_session` here, which would be this package's copy of a
   * constant in `packages/server/src/session.ts` with nothing tying the two together. A jar keyed
   * on whatever arrives needs no such constant and survives the server adding a second cookie.
   *
   * `Path` and `Domain` are ignored on purpose. There is exactly one origin and every request
   * this proxy makes is under `/api`, so there is no second scope for a cookie to belong to, and
   * implementing the matching rules would be code no request could distinguish from this.
   */
  #absorbCookies(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const index = pair?.indexOf('=') ?? -1
      if (!pair || index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      // `sessionClearCookie` in the server spells a logout as an empty value *and* `Max-Age=0`;
      // either on its own is the same instruction, so either deletes.
      const expired = attributes.some((a) => a.trim().toLowerCase() === 'max-age=0')
      if (value === '' || expired) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  /** The app's own error envelope, so a failure the shell invents keeps its identity too. */
  #failure(status: number, code: AppErrorCode, message: string): Response {
    return new Response(JSON.stringify({ error: { code, message } }), {
      status,
      // The same two headers `#forward` forces. These bodies are the shell's own and could not be
      // made renderable — but a reader comparing the two paths should not have to work out why
      // one is protected and the other is not.
      headers: { 'content-type': 'application/json', ...FORCED_RESPONSE_HEADERS },
    })
  }
}

/**
 * Whether a status is a redirect this proxy must refuse.
 *
 * **304 is excluded, and it is the reason this is a function rather than a range check.** `Not
 * Modified` shares the 3xx band and is not a redirect at all: it carries no `Location`, and
 * reporting it as "redirected to somewhere else" would be a confusing 502 for a perfectly ordinary
 * conditional response. Nothing in this repo sends `If-None-Match` today — that was checked, not
 * assumed — so this is a guard against a future conditional GET rather than a live bug.
 */
export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

/**
 * The length the renderer declared for an upload body, or null.
 *
 * Validated rather than forwarded: a value that is not a plain run of digits would reach undici
 * as a `content-length` it rejects, and the failure would surface as an opaque proxy error rather
 * than as the malformed header it is. A body whose real length disagrees with this is undici's to
 * refuse — it does, with `Request body length does not match content-length header` — and the
 * only party that can lie here is the renderer, about its own upload.
 */
export function declaredUploadLength(request: Request): number | null {
  const raw = request.headers.get(UPLOAD_LENGTH_HEADER)
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) return null
  return Number(raw)
}
