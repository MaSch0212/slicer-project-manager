import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type Capabilities,
  type SettingsDto,
  type UserDto,
} from '../api/generated'
import { ApiError } from './api/error'
import {
  createAuthStore,
  createCapabilitiesStore,
  createSettingsStore,
  OFFLINE_CAPABILITIES,
} from './stores'

const USER: UserDto = {
  id: 'u1',
  username: 'anna',
  displayName: 'Anna',
  isAdmin: true,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}

describe('capabilities store', () => {
  it('starts as the most restrictive shell and loads what the server says', async () => {
    const served: Capabilities = {
      ...OFFLINE_CAPABILITIES,
      requiresAuth: false,
      canManageUsers: true,
    }
    const store = createCapabilitiesStore({ capabilities: vi.fn().mockResolvedValue(served) })
    expect(store.capabilities()).toEqual(OFFLINE_CAPABILITIES)
    expect(store.loaded()).toBe(false)
    await store.load()
    expect(store.capabilities()).toEqual(served)
    expect(store.loaded()).toBe(true)
  })

  it('falls back to the offline defaults when the server will not answer, and says why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createCapabilitiesStore({
      capabilities: vi.fn().mockRejectedValue(new ApiError('Internal', 'down')),
    })
    await store.load()
    expect(store.capabilities()).toEqual(OFFLINE_CAPABILITIES)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('auth store', () => {
  const client = (me: () => Promise<UserDto>, logout = vi.fn().mockResolvedValue(undefined)) =>
    ({ account: { me }, auth: { logout } }) as never

  it('knows the signed-in user and whether they administer', async () => {
    const store = createAuthStore(client(() => Promise.resolve(USER)))
    expect(store.isAuthenticated()).toBe(false)
    await store.refresh()
    expect(store.user()).toEqual(USER)
    expect(store.isAuthenticated()).toBe(true)
    expect(store.isAdmin()).toBe(true)
  })

  it('treats a 401 at bootstrap as simply not signed in', async () => {
    const store = createAuthStore(client(() => Promise.reject(new ApiError('Unauthorized', 'no'))))
    await store.refresh()
    expect(store.user()).toBeNull()
  })

  // Ported: signs the user out locally even when the server call fails.
  it('signs the user out locally even when the server call fails', async () => {
    const logout = vi.fn().mockRejectedValue(new ApiError('Internal', 'down'))
    const store = createAuthStore(client(() => Promise.resolve(USER), logout))
    store.setUser(USER)
    await expect(store.logout()).rejects.toThrow('down')
    expect(store.isAuthenticated()).toBe(false)
  })
})

describe('settings store', () => {
  function make(
    overrides: Partial<SettingsDto> = {},
    put?: (patch: Partial<SettingsDto>) => Promise<SettingsDto>,
  ) {
    const api = {
      settings: {
        get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...overrides }),
        // The default merges the patch the way the server does.
        put: vi.fn(
          put ?? ((patch) => Promise.resolve({ ...DEFAULT_SETTINGS, ...overrides, ...patch })),
        ),
      },
    }
    return { store: createSettingsStore(api as never), api }
  }

  it('starts from the shared defaults before anything is loaded', () => {
    const { store } = make()
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    expect(store.loaded()).toBe(false)
  })

  it('loads the persisted settings', async () => {
    const { store } = make({ theme: 'dark', language: 'de' })
    await store.load()
    expect(store.settings().theme).toBe('dark')
    expect(store.settings().language).toBe('de')
    expect(store.loaded()).toBe(true)
  })

  it('patches optimistically and keeps the server answer', async () => {
    const { store, api } = make()
    await store.load()
    const done = store.patch({ viewMode: 'list' })
    expect(store.settings().viewMode).toBe('list')
    await done
    expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' })
    expect(store.settings().viewMode).toBe('list')
  })

  it('rolls back when the server rejects the patch', async () => {
    const { store } = make({}, () => Promise.reject(new ApiError('Validation', 'no')))
    await store.load()
    await expect(store.patch({ theme: 'dark' })).rejects.toThrow('no')
    expect(store.settings().theme).toBe('system')
  })

  // Ported: overlapping patches to different keys do not clobber each other.
  it('keeps both values when two overlapping patches to different keys resolve out of order', async () => {
    const resolvers: Array<() => void> = []
    const { store } = make(
      {},
      (patch) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ ...DEFAULT_SETTINGS, ...patch }))
        }),
    )
    await store.load()
    const first = store.patch({ theme: 'dark' })
    const second = store.patch({ viewMode: 'list' })
    resolvers[1]!()
    await second
    resolvers[0]!()
    await first
    expect(store.settings().theme).toBe('dark')
    expect(store.settings().viewMode).toBe('list')
  })

  // Ported: only the failing key reverts.
  it('only reverts the failing key when a failing patch overlaps a succeeding one', async () => {
    const settles: Array<(ok: boolean) => void> = []
    const { store } = make(
      {},
      (patch) =>
        new Promise((resolve, reject) => {
          settles.push((ok) =>
            ok ? resolve({ ...DEFAULT_SETTINGS, ...patch }) : reject(new Error('no')),
          )
        }),
    )
    await store.load()
    const failing = store.patch({ theme: 'dark' })
    const succeeding = store.patch({ viewMode: 'list' })
    settles[1]!(true)
    await succeeding
    settles[0]!(false)
    await expect(failing).rejects.toThrow('no')
    expect(store.settings().theme).toBe('system')
    expect(store.settings().viewMode).toBe('list')
  })

  it('forgets the signed-out user and marks itself unloaded, so the theme is left alone', async () => {
    const { store } = make({ language: 'de' })
    await store.load()
    store.reset()
    expect(store.settings().language).toBe('en')
    expect(store.loaded()).toBe(false)
  })
})
