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
 * `AppError` from `desktopBridge()` at that point rather than at module evaluation — which in
 * this app means `CapabilitiesStore.load()` catching it and falling back to the offline defaults,
 * instead of a blank window.
 */
export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT', {
  factory: () =>
    desktopMode() === 'remote' ? new HttpApiClient('', proxiedFetch) : new IpcApiClient(),
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
 */
function proxiedFetch(input: string, init: RequestInit = {}): Promise<Response> {
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
