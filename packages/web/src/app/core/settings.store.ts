import { Injectable, inject, signal } from '@angular/core'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<SettingsDto>(DEFAULT_SETTINGS)
  readonly settings = this.state.asReadonly()

  async load(): Promise<void> {
    try {
      this.state.set(await this.api.settings.get())
    } catch {
      // A server that will not answer falls back to the shared defaults, same shape as
      // AuthStore.refresh() and CapabilitiesStore.load().
      this.state.set(DEFAULT_SETTINGS)
    }
  }

  /** Optimistic: the UI switches immediately, and rolls back if the write fails. */
  async patch(partial: Partial<SettingsDto>): Promise<void> {
    const previous = this.state()
    this.state.set({ ...previous, ...partial })
    try {
      this.state.set(await this.api.settings.put(partial))
    } catch (error) {
      this.state.set(previous)
      throw error
    }
  }
}
