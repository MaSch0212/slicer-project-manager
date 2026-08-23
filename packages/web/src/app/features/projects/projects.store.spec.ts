import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ProjectDto, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { SettingsStore } from '../../core/settings.store'
import { ProjectsStore } from './projects.store'

function project(over: Partial<ProjectDto>): ProjectDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function setup(list = vi.fn().mockResolvedValue([])) {
  const api = {
    projects: { list, create: vi.fn().mockResolvedValue(project({})), rescan: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
      put: vi.fn((patch: Partial<SettingsDto>) =>
        Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
      ),
    },
  }
  TestBed.configureTestingModule({
    providers: [ProjectsStore, { provide: API_CLIENT, useValue: api }],
  })
  return { store: TestBed.inject(ProjectsStore), api }
}

/**
 * Loads the persisted settings before ProjectsStore is constructed, the way app.config.ts's
 * initializer does (it awaits SettingsStore.load() before any route can render).
 */
async function setupWithSettings(
  persisted: Partial<SettingsDto>,
  list = vi.fn().mockResolvedValue([]),
) {
  const api = {
    projects: { list, create: vi.fn().mockResolvedValue(project({})), rescan: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...persisted }),
      put: vi.fn((patch: Partial<SettingsDto>) =>
        Promise.resolve({ ...DEFAULT_SETTINGS, ...persisted, ...patch }),
      ),
    },
  }
  TestBed.configureTestingModule({
    providers: [ProjectsStore, { provide: API_CLIENT, useValue: api }],
  })
  await TestBed.inject(SettingsStore).load()
  return { store: TestBed.inject(ProjectsStore), api }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

describe('ProjectsStore', () => {
  it('starts sorted by most recently updated when nothing else is persisted', async () => {
    const { store, api } = setup()
    await settle()
    expect(store.query()).toEqual({ sort: 'updatedAt', dir: 'desc' })
    expect(api.projects.list).toHaveBeenCalledWith({ sort: 'updatedAt', dir: 'desc' })
  })

  // Final review, minor 1: SettingsDto.sort/.dir are persisted by the server, validated by
  // the schema and defaulted in DEFAULT_SETTINGS, but the store used to hard-code
  // { sort: 'updatedAt', dir: 'desc' } — so the user's saved sort was written by no UI and
  // read by no UI, and the list reset on every visit. Spec 3.3 lists `sort` among the
  // user_settings keys.
  it('seeds the initial query from the persisted settings', async () => {
    const { store, api } = await setupWithSettings({ sort: 'name', dir: 'asc' })
    await settle()
    expect(store.query()).toEqual({ sort: 'name', dir: 'asc' })
    expect(api.projects.list).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
  })

  it('persists a sort change so the next visit keeps it', async () => {
    const { store, api } = await setupWithSettings({})
    await settle()

    await store.setSort('name', 'asc')
    await settle()

    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(api.projects.list).toHaveBeenLastCalledWith({ sort: 'name', dir: 'asc' })
  })

  // The list must still re-sort even if the preference cannot be saved: the local query is
  // what drives the request, and the rejection is the page's to report.
  it('applies a sort change locally and rethrows when persisting it fails', async () => {
    const { store, api } = await setupWithSettings({})
    api.settings.put.mockRejectedValueOnce(new Error('boom'))
    await settle()

    await expect(store.setSort('createdAt', 'desc')).rejects.toThrow()

    expect(store.query()).toEqual({ sort: 'createdAt', dir: 'desc' })
  })

  it('reloads when the search term changes', async () => {
    const { store, api } = setup()
    await settle()
    store.setSearch('bench')
    await settle()
    expect(api.projects.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'bench' }))
  })

  it('drops an empty search term rather than sending it', async () => {
    const { store } = setup()
    store.setSearch('bench')
    store.setSearch('   ')
    expect(store.query().search).toBeUndefined()
  })

  it('toggles a tag on and off', () => {
    const { store } = setup()
    store.toggleTag('petg')
    expect(store.query().tags).toEqual(['petg'])
    store.toggleTag('boat')
    expect(store.query().tags).toEqual(['petg', 'boat'])
    store.toggleTag('petg')
    expect(store.query().tags).toEqual(['boat'])
    store.toggleTag('boat')
    expect(store.query().tags).toBeUndefined()
  })

  it('collects the tag union of the loaded projects for the filter bar', async () => {
    const { store } = setup(
      vi
        .fn()
        .mockResolvedValue([
          project({ id: 'a', tags: ['petg', 'boat'] }),
          project({ id: 'b', tags: ['boat', 'functional'] }),
        ]),
    )
    await settle()
    expect(store.knownTags()).toEqual(['boat', 'functional', 'petg'])
  })

  it('reloads after creating a project and after a rescan', async () => {
    const { store, api } = setup()
    await settle()
    const before = api.projects.list.mock.calls.length

    await store.create({ name: 'New' })
    await settle()
    await store.rescan()
    await settle()

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'New' })
    expect(api.projects.rescan).toHaveBeenCalled()
    expect(api.projects.list.mock.calls.length).toBeGreaterThan(before + 1)
  })

  // Ruling 59: with AND-filtering, two tags that no single loaded project shares yields an
  // empty result set — and knownTags was previously derived only from the loaded projects,
  // so it would go empty too, hiding every filter button including the ones that caused the
  // empty result. That is a dead end: nothing left on screen to un-toggle the filter with.
  // knownTags must also include whatever tags are currently selected in the query, so a
  // selected tag always has a button to switch it back off.
  it('keeps an active tag filter selectable even when it empties the result set', async () => {
    const { store } = setup(vi.fn().mockResolvedValue([]))
    store.toggleTag('petg')
    store.toggleTag('boat')
    await settle()
    expect(store.knownTags()).toEqual(['boat', 'petg'])
  })

  // Fix round 1, finding 1: Angular's resource() only substitutes `defaultValue` before a
  // load has ever completed. Once a load settles to the public 'error' status, `.value()`
  // throws a ResourceValueError instead. knownTags used to read `.value()` unconditionally,
  // so the first failed `list()` (server error, network blip, expired session) would crash
  // it — and the template, which also reads `.value()` in its @else-if/@for. This proves the
  // store stays readable, and that the error state is observable, so the page can render a
  // real fallback instead of throwing.
  it('stays readable when list rejects, and exposes an observable error state', async () => {
    const { store } = setup(vi.fn().mockRejectedValue(new Error('boom')))
    await settle()

    expect(store.projects.status()).toBe('error')
    expect(() => store.knownTags()).not.toThrow()
    expect(store.knownTags()).toEqual([])
  })
})
