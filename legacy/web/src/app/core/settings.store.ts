import { Injectable, inject, signal } from '@angular/core'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

/** Copies only `keys` from `source`. Used to snapshot/merge per-key, never the whole object. */
function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>
  for (const key of keys) {
    result[key] = source[key]
  }
  return result
}

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

  /**
   * Optimistic, per key rather than by serialising the whole call: two overlapping patches
   * to different keys (e.g. the user changes theme, then viewMode, before the first PUT
   * resolves) must not clobber each other regardless of resolution order or whether one of
   * them fails. Each call therefore only snapshots the keys it touches (for its own
   * rollback) and only merges back the keys it sent (from its own server response) — never
   * the whole state object in either direction. This does not by itself resolve two
   * overlapping calls that both touch the *same* key (whichever response lands last still
   * wins for that key); see task-18-report.md for why that is out of scope here.
   */
  async patch(partial: Partial<SettingsDto>): Promise<void> {
    const keys = Object.keys(partial) as (keyof SettingsDto)[]
    const snapshot = pick(this.state(), keys)
    this.state.update((current) => ({ ...current, ...partial }))
    try {
      const response = await this.api.settings.put(partial)
      this.state.update((current) => ({ ...current, ...pick(response, keys) }))
    } catch (error) {
      this.state.update((current) => ({ ...current, ...snapshot }))
      throw error
    }
  }
}
