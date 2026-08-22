import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
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
  }
  TestBed.configureTestingModule({
    providers: [ProjectsStore, { provide: API_CLIENT, useValue: api }],
  })
  return { store: TestBed.inject(ProjectsStore), api }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

describe('ProjectsStore', () => {
  it('starts sorted by most recently updated', async () => {
    const { store, api } = setup()
    await settle()
    expect(store.query()).toEqual({ sort: 'updatedAt', dir: 'desc' })
    expect(api.projects.list).toHaveBeenCalledWith({ sort: 'updatedAt', dir: 'desc' })
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
})
