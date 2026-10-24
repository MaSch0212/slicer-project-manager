import { InjectionToken } from '@angular/core'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { HttpApiClient } from './http-api-client'
import { IpcApiClient, UPLOAD_LENGTH_HEADER, type BridgeMode } from './ipc-api-client'

/**
 * The electron build's `API_CLIENT`, swapped in for `api-client.token.ts` by `fileReplacements`
 * in angular.json — the same mechanism `routes.electron.ts` uses, and the reason no component
 * ever learns which shell it is running in (constraint 1).
 *
 * It does not import `./api-client.token` for the same reason `routes.electron.ts` does not
 * import `./routes`: that specifier is what gets replaced with this very file.
 *
 * **Two transports, chosen here and nowhere else** (spec 2.6). In local-folder mode the client is
 * `IpcApiClient` and every call goes to the main process. In remote-server mode it is the *same*
 * `HttpApiClient` the browser build uses, with the same empty base URL — the shell reverse-proxies
 * `spm://app/api/...` to the configured origin, so the renderer is never navigated to that origin,
 * never learns what it is, and needs no CORS, no widened CSP and no cookie of its own. The
 * reasoning, and the four measurements behind it, are in `packages/desktop/src/remote.ts`.
 *
 * The factory runs lazily, on the first `inject(API_CLIENT)`, so a missing preload surfaces as an
 * `AppError` from `desktopBridge()` at that point rather than at module evaluation.
 *
 * **Where that lands is a blank window, and the comment this replaces said the opposite.** It
 * claimed `CapabilitiesStore.load()` would catch it and fall back to the offline defaults. It
 * cannot: the store takes its client in a *field initializer* (`inject(API_CLIENT)`), so the
 * throw happens while the store is being constructed — which `app.config.ts` does in its app
 * initializer, outside `load()`'s `try` — and bootstrap fails. Pinned in
 * `api-client.token.electron.spec.ts`, which asserts the `AppError` rather than a recovery that
 * does not happen. Nothing here fixes it: a desktop build whose own preload did not load is
 * broken, and the honest failure is better than a UI that pretends to be offline.
 */
export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT', {
  factory: () =>
    desktopMode() === 'remote' ? new HttpApiClient('', proxiedFetch) : new IpcApiClient(),
})

/**
 * The shell's own client, which in this build is the IPC one in **both** modes.
 *
 * **Separate from `API_CLIENT` above, because they answer different questions — and unlike it, this
 * one does not branch.** `API_CLIENT` is whatever transport the *library* is on, and in remote mode
 * that is `HttpApiClient`, which refuses `library.pick`, `library.connect` and every `slicers`
 * method. A page talking to the shell about this *machine* — which library there should be, which
 * slicers are installed on it, which one to hand a file to — is not talking to the library, so it
 * needs the transport that always reaches the main process. The machine the slicers are installed
 * on is this one whichever library is open, which is the whole reason the second token exists.
 *
 * It lives here, beside `API_CLIENT`, and not under `features/desktop/`, and the move is what makes
 * it usable from a page the web build also has. `features/desktop/*` is physically absent from the
 * web bundle by construction — CI greps for it — so a token defined there could only be injected by
 * desktop-only pages, and the launch controls belong on the ordinary project page. The bundle
 * separation is kept by the same `fileReplacements` swap that chooses `API_CLIENT`: the twin of this
 * file builds an `HttpApiClient`, which pulls no IPC code into the web bundle and refuses every
 * shell method exactly as spec 2.4's capability flags say it should.
 */
export const SHELL_CLIENT = new InjectionToken<ApiClient>('SHELL_CLIENT', {
  factory: () => new IpcApiClient(),
})

/**
 * Which transport this window was built with.
 *
 * Read off the bridge rather than asked for over IPC, because an injection factory is
 * synchronous. It is `'local'` when there is no bridge at all: a preload that failed to load
 * leaves `IpcApiClient` to report the missing bridge as an `AppError`, which the app already
 * degrades from, where `HttpApiClient` would instead fetch `/api/...` off an origin that has no
 * server behind it and report a parade of 404s.
 */
export function desktopMode(): BridgeMode {
  return (globalThis as { spm?: { mode?: unknown } }).spm?.mode === 'remote' ? 'remote' : 'local'
}

/**
 * `fetch`, with the one thing a request through the shell's proxy cannot carry for itself.
 *
 * `content-length` is a forbidden header name, so the `content-length` `HttpApiClient` sets on an
 * upload is stripped by Chromium, and — measured on Electron 44.0.0 — the body's own length does
 * not reach the shell's protocol handler either. The server refuses a body with no length (411,
 * spec 5.6), so without this every upload in remote mode fails. Restating it in a header of the
 * shell's own is the smallest fix that leaves `HttpApiClient` untouched: the shell turns it back
 * into a real `content-length` on the way out (`declaredUploadLength` in
 * `packages/desktop/src/remote.ts`).
 *
 * Both of `UploadBody`'s arms are covered, and this is the only place in the app where they can
 * be: the client's own `content-length` is still in `init.headers` when this runs — nothing has
 * stripped it yet — and a `Blob` body knows its own size. A request with neither is left alone,
 * which is every request that is not an upload.
 *
 * Exported for `api-client.token.electron.spec.ts`: it is the renderer's half of a two-package
 * mechanism whose other half (`declaredUploadLength`, in the desktop package) has its own test,
 * and neither test alone would notice the two disagreeing.
 */
export function proxiedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const declared = declaredLength(init)
  if (declared === null) return fetch(input, init)
  const headers = new Headers(init.headers)
  headers.set(UPLOAD_LENGTH_HEADER, String(declared))
  return fetch(input, { ...init, headers })
}

function declaredLength(init: RequestInit): number | null {
  const stated = new Headers(init.headers).get('content-length')
  if (stated !== null && /^\d+$/.test(stated)) return Number(stated)
  return init.body instanceof Blob ? init.body.size : null
}
