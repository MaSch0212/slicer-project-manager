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

  it('keeps both values when two overlapping patches to different keys resolve out of order', async () => {
    let resolveA!: (value: SettingsDto) => void
    let resolveB!: (value: SettingsDto) => void
    const put = vi
      .fn<(patch: Partial<SettingsDto>) => Promise<SettingsDto>>()
      .mockImplementationOnce(
        () =>
          new Promise<SettingsDto>((resolve) => {
            resolveA = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SettingsDto>((resolve) => {
            resolveB = resolve
          }),
      )
    const { store } = provide({}, put)
    await store.load()

    const patchA = store.patch({ theme: 'dark' })
    const patchB = store.patch({ viewMode: 'list' })

    // B is called second but its PUT settles first. Its response predates A's write, so it
    // still carries the default theme — that must not leak back into A's key.
    resolveB({ ...DEFAULT_SETTINGS, viewMode: 'list' })
    await patchB
    // A resolves last with a response that predates B's write (still the default viewMode).
    // Under a whole-state overwrite this would stomp B's already-applied change.
    resolveA({ ...DEFAULT_SETTINGS, theme: 'dark' })
    await patchA

    expect(store.settings().theme).toBe('dark')
    expect(store.settings().viewMode).toBe('list')
  })

  it('only reverts the failing key when a failing patch overlaps a succeeding one on different keys', async () => {
    let resolveB!: (value: SettingsDto) => void
    const put = vi
      .fn<(patch: Partial<SettingsDto>) => Promise<SettingsDto>>()
      .mockImplementationOnce(() => Promise.reject(new Error('nope')))
      .mockImplementationOnce(
        () =>
          new Promise<SettingsDto>((resolve) => {
            resolveB = resolve
          }),
      )
    const { store } = provide({ theme: 'light' }, put)
    await store.load()

    // Chained immediately so the rejection always has a handler attached (avoids an
    // unhandled-rejection warning while we hold the assertion for later).
    const failing = expect(store.patch({ theme: 'dark' })).rejects.toThrow()
    const succeeding = store.patch({ viewMode: 'list' })
    // Deliberately mismatched theme: a PUT that never mentioned theme still returns the
    // full settings row, and that must not leak into the theme field either.
    resolveB({ ...DEFAULT_SETTINGS, theme: 'system', viewMode: 'list' })

    await failing
    await succeeding

    expect(store.settings().theme).toBe('light')
    expect(store.settings().viewMode).toBe('list')
  })
})
