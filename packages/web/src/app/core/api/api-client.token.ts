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
