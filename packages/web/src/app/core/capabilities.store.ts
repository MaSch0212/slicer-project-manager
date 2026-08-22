import { Injectable, inject, signal } from '@angular/core'
import type { Capabilities } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

/** Resolved at runtime, never compiled in: the effective set is shell x backend (spec 2.4). */
const OFFLINE_DEFAULTS: Capabilities = {
  requiresAuth: true,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

@Injectable({ providedIn: 'root' })
export class CapabilitiesStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<Capabilities>(OFFLINE_DEFAULTS)
  readonly capabilities = this.state.asReadonly()

  async load(): Promise<void> {
    try {
      this.state.set(await this.api.capabilities())
    } catch {
      // A server that will not answer is treated as the most restrictive shell.
      this.state.set(OFFLINE_DEFAULTS)
    }
  }
}
