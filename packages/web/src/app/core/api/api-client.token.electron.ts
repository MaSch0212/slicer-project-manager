import { InjectionToken } from '@angular/core'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { IpcApiClient } from './ipc-api-client'

/**
 * The electron build's `API_CLIENT`, swapped in for `api-client.token.ts` by `fileReplacements`
 * in angular.json — the same mechanism `routes.electron.ts` uses, and the reason no component
 * ever learns which shell it is running in (constraint 1).
 *
 * It does not import `./api-client.token` for the same reason `routes.electron.ts` does not
 * import `./routes`: that specifier is what gets replaced with this very file.
 *
 * The factory runs lazily, on the first `inject(API_CLIENT)`, so a missing preload surfaces as an
 * `AppError` from `desktopBridge()` at that point rather than at module evaluation — which in
 * this app means `CapabilitiesStore.load()` catching it and falling back to the offline defaults,
 * instead of a blank window.
 */
export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT', {
  factory: () => new IpcApiClient(),
})
