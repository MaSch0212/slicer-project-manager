import { InjectionToken } from '@angular/core'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { HttpApiClient } from './http-api-client'

/**
 * The only place the transport is chosen. Electron (spec C) provides IpcApiClient against
 * this same token, and no component changes.
 */
export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT', {
  factory: () => new HttpApiClient(),
})

/**
 * The shell's own client, which is the IPC one in the desktop build and a refusal in the browser.
 *
 * **Separate from `API_CLIENT`, because they answer different questions.** `API_CLIENT` is
 * whatever transport the *library* is on, and in remote mode that is `HttpApiClient`, which
 * refuses `library.pick`, `library.connect` and every `slicers` method. A page that is talking to
 * the shell about this *machine* — which library there should be, which slicers are installed on
 * it, which one to hand a file to — is not talking to the library, so it needs the one transport
 * that always reaches the main process whatever mode the window is in.
 *
 * It lives here, beside `API_CLIENT`, and not under `features/desktop/`, and the move is what
 * makes it usable at all from a page the web build also has. `features/desktop/*` is physically
 * absent from the web bundle by construction — CI greps for it — so a token defined there could
 * only be injected by desktop-only pages, and the launch controls belong on the ordinary project
 * page. The bundle separation is kept by the same `fileReplacements` swap that chooses
 * `API_CLIENT`: this file's factory builds an `HttpApiClient`, which pulls no IPC code into the
 * web bundle and refuses every shell method exactly as spec 2.4's capability flags say it should.
 */
export const SHELL_CLIENT = new InjectionToken<ApiClient>('SHELL_CLIENT', {
  factory: () => new HttpApiClient(),
})
