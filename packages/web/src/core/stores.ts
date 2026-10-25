import { createMemo, createRoot, createSignal } from 'solid-js'
import {
  DEFAULT_SETTINGS,
  type Capabilities,
  type SettingsDto,
  type SettingsPatch,
  type UserDto,
} from '../api/generated'
import { api, type ApiClient } from './api/client'
import { cachedTheme, isTheme } from './theme'

/**
 * The most restrictive shell: what the app assumes when the server will not say. Resolved at
 * runtime, never compiled in, because the effective set is shell x backend (parent spec 2.4).
 */
export const OFFLINE_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

export function createCapabilitiesStore(client: Pick<ApiClient, 'capabilities'>) {
  const [capabilities, setCapabilities] = createSignal<Capabilities>(OFFLINE_CAPABILITIES)
  const [loaded, setLoaded] = createSignal(false)

  async function load(): Promise<void> {
    try {
      setCapabilities(await client.capabilities())
    } catch (error) {
      // Logged, not swallowed: this catch is the only place the reason the server did not answer
      // (a proxy refusing a redirect, say) ever surfaces.
      console.error('failed to load capabilities; falling back to the offline defaults', error)
      setCapabilities(OFFLINE_CAPABILITIES)
    }
    setLoaded(true)
  }

  return { capabilities, loaded, load }
}

export function createAuthStore(client: Pick<ApiClient, 'account' | 'auth'>) {
  const [user, setUser] = createSignal<UserDto | null>(null)
  // Store-level memos live for the life of the app: a root of their own, never disposed.
  const { isAuthenticated, isAdmin } = createRoot(() => ({
    isAuthenticated: createMemo(() => user() !== null),
    isAdmin: createMemo(() => user()?.isAdmin === true),
  }))

  async function refresh(): Promise<void> {
    try {
      setUser(await client.account.me())
    } catch {
      // A 401 at bootstrap is the normal "not signed in yet" case.
      setUser(null)
    }
  }

  async function logout(): Promise<void> {
    try {
      await client.auth.logout()
    } finally {
      // Local state is cleared even when the server call failed: the user asked to be signed out
      // and the UI must not keep claiming a session. The rejection still reaches the caller.
      setUser(null)
    }
  }

  return { user, isAuthenticated, isAdmin, setUser, refresh, logout }
}

/** Copies only `keys` from `source`: snapshots and merges are per key, never the whole object. */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>
  for (const key of keys) result[key] = source[key]
  return result
}

/** The defaults, with the theme this browser last showed, so a reload does not flash. */
function initialSettings(): SettingsDto {
  const theme = cachedTheme()
  return isTheme(theme) ? { ...DEFAULT_SETTINGS, theme } : DEFAULT_SETTINGS
}

export function createSettingsStore(client: Pick<ApiClient, 'settings'>) {
  const [settings, setSettings] = createSignal<SettingsDto>(initialSettings())
  const [loaded, setLoaded] = createSignal(false)

  async function load(): Promise<void> {
    try {
      setSettings(await client.settings.get())
    } catch {
      // A server that will not answer falls back to the shared defaults, like the other stores.
      setSettings(DEFAULT_SETTINGS)
    }
    setLoaded(true)
  }

  /**
   * Optimistic, and per key rather than by serialising whole calls: two overlapping patches to
   * different keys (theme, then viewMode, before the first PUT resolves) must not clobber each
   * other whatever order they resolve in or whether one fails. Each call snapshots only the keys
   * it touches (for its own rollback) and merges back only the keys it sent. Two overlapping
   * calls to the *same* key still resolve last-writer-wins for that key.
   */
  async function patch(partial: SettingsPatch): Promise<void> {
    const keys = Object.keys(partial) as (keyof SettingsDto)[]
    const snapshot = pick(settings(), keys)
    setSettings((current) => ({ ...current, ...partial }))
    try {
      const response = await client.settings.put(partial)
      setSettings((current) => ({ ...current, ...pick(response, keys) }))
    } catch (error) {
      setSettings((current) => ({ ...current, ...snapshot }))
      throw error
    }
  }

  /** Forgets the signed-out user's settings. `loaded` goes false so the theme is left alone. */
  function reset(): void {
    setSettings(initialSettings())
    setLoaded(false)
  }

  return { settings, loaded, load, patch, reset }
}

export const capabilities = createCapabilitiesStore(api)
export const auth = createAuthStore(api)
export const settings = createSettingsStore(api)
