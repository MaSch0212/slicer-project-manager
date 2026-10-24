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
    } catch (error) {
      // A server that will not answer is treated as the most restrictive shell.
      //
      // Logged rather than swallowed, and that is not housekeeping. This catch is where the only
      // diagnosis of *why* the server did not answer ends up: the desktop shell's proxy refuses a
      // redirect with a message naming the address it was sent to, and three comments used to
      // claim that message was the user's route out of a misconfigured reverse proxy. It was
      // unreachable short of a packet capture. It is now one line in the console, which is where
      // the rest of this app's diagnostics live.
      console.error('failed to load capabilities; falling back to the offline defaults', error)
      this.state.set(OFFLINE_DEFAULTS)
    }
  }
}
