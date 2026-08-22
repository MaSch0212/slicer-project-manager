import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'
import { SettingsStore } from './settings.store'

// `put`'s default implementation is built into the default parameter itself (not applied
// via a later `.mockImplementation()` call) so that a caller-supplied mock — e.g. the
// rejecting one in the rollback test below — keeps its own behavior instead of being
// silently overwritten (mockRejectedValue is itself sugar for mockImplementation, so a
// second `.mockImplementation()` call after it would erase the rejection).
function provide(
  overrides: Partial<SettingsDto>,
  put = vi.fn((patch: Partial<SettingsDto>) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...overrides, ...patch }),
  ),
) {
  const api = {
    settings: {
      get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...overrides }),
      put,
    },
  }
  TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] })
  return { store: TestBed.inject(SettingsStore), api }
}

describe('SettingsStore', () => {
  it('starts from the shared defaults before anything is loaded', () => {
    const { store } = provide({})
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
  })

  it('loads the persisted settings', async () => {
    const { store } = provide({ language: 'de', viewMode: 'list' })
    await store.load()
    expect(store.settings().language).toBe('de')
    expect(store.settings().viewMode).toBe('list')
  })

  it('patches optimistically and keeps the server answer', async () => {
    const { store, api } = provide({})
    await store.load()
    await store.patch({ theme: 'dark' })
    expect(api.settings.put).toHaveBeenCalledWith({ theme: 'dark' })
    expect(store.settings().theme).toBe('dark')
  })

  it('rolls back when the server rejects the patch', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('nope'))
    const { store } = provide({ theme: 'light' }, failing)
    await store.load()
    await expect(store.patch({ theme: 'dark' })).rejects.toThrow()
    expect(store.settings().theme).toBe('light')
  })
})
