import { InjectionToken } from '@angular/core'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { IpcApiClient } from '../../core/api/ipc-api-client'

/**
 * The shell's own client, which is always the IPC one.
 *
 * Separate from `API_CLIENT` for one reason: `API_CLIENT` is whatever transport the *library*
 * is on, and in remote mode that is `HttpApiClient`, which refuses `library.pick` and
 * `library.connect` because a browser cannot re-point itself. The connect page is not talking to
 * the library — it is talking to the shell about which library there should be — so it needs the
 * one transport that always reaches the main process, whatever mode the window is in.
 *
 * It lives under `features/desktop/` and is imported only from files in that folder, so the web
 * build cannot pull it (or `IpcApiClient` with it) in — the same rule spec 2.5 gives the rest of
 * this directory, and the one CI's bundle greps enforce.
 *
 * A token rather than a `new IpcApiClient()` at the point of use so a component spec can supply a
 * fake bridge without a preload.
 */
export const SHELL_CLIENT = new InjectionToken<ApiClient>('SHELL_CLIENT', {
  factory: () => new IpcApiClient(),
})
