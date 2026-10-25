import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SEARCH_MAX_LENGTH,
  type ProjectDto,
  type SettingsDto,
  type SettingsPatch,
} from '../api/generated'
import {
  createProjectsStore,
  initialQuery,
  isFiltered,
  parseSortValue,
  PROJECTS_PAGE_SIZE,
  sortValueOf,
} from './projects-store'

// Ported from legacy features/projects/projects.store.spec.ts. The Angular specs drove `resource()`
// and settled the application; this store is plain signals and promises, so the same cases run by
// awaiting the store's own calls.

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

/** A full page of distinct projects, which is what makes the store believe more rows exist. */
const fullPage = (prefix: string): ProjectDto[] =>
  Array.from({ length: PROJECTS_PAGE_SIZE }, (_, index) => project({ id: `${prefix}${index}` }))

const ids = (projects: readonly ProjectDto[]) => projects.map((p) => p.id)

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(
  persisted: Partial<SettingsDto> = {},
  list = vi.fn().mockResolvedValue([]),
  tags = vi.fn().mockResolvedValue([]),
) {
  let current: SettingsDto = { ...DEFAULT_SETTINGS, ...persisted }
  const patch = vi.fn((partial: SettingsPatch) => {
    current = { ...current, ...partial }
    return Promise.resolve()
  })
  const client = {
    projects: { list, tags, create: vi.fn().mockResolvedValue(project({})), rescan: vi.fn() },
  }
  const onRememberFailed = vi.fn()
  const store = createProjectsStore({
    client: client as never,
    settings: { settings: () => current, patch },
    onRememberFailed,
  })
  return { store, client, patch, onRememberFailed }
}

describe('projects store: the first query', () => {
  it('starts sorted by most recently updated when nothing else is persisted', async () => {
    const { store, client } = setup()
    await store.start()
    expect(store.query()).toEqual({ sort: 'updatedAt', dir: 'desc' })
    expect(client.projects.list).toHaveBeenCalledWith({
      sort: 'updatedAt',
      dir: 'desc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  it('seeds the sort from the persisted settings', async () => {
    const { store, client } = setup({ sort: 'name', dir: 'asc' })
    await store.start()
    expect(store.query()).toEqual({ sort: 'name', dir: 'asc' })
    expect(client.projects.list).toHaveBeenCalledWith({
      sort: 'name',
      dir: 'asc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  // The request itself is what proves the filter is remembered: a seed that only reached the
  // controls would show a filter the rows do not obey.
  it('seeds the archived flag and the tag filter from the persisted settings', async () => {
    const { store, client } = setup({ includeArchived: true, filterTags: ['petg', 'boat'] })
    await store.start()
    expect(store.query()).toEqual({
      sort: 'updatedAt',
      dir: 'desc',
      includeArchived: true,
      tags: ['petg', 'boat'],
    })
    expect(client.projects.list).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true, tags: ['petg', 'boat'] }),
    )
  })

  it('writes the filter keys only when they are not the defaults', () => {
    expect(initialQuery(DEFAULT_SETTINGS)).toEqual({ sort: 'updatedAt', dir: 'desc' })
  })

  it('asks for one page of 48 rather than the whole library', async () => {
    const { store, client } = setup()
    await store.start()
    expect(PROJECTS_PAGE_SIZE).toBe(48)
    expect(client.projects.list.mock.calls[0]![0].limit).toBe(48)
    expect(client.projects.list.mock.calls[0]![0].offset).toBeUndefined()
    expect(store.loadingFirst()).toBe(false)
  })
})

describe('projects store: filters', () => {
  it('persists a sort change and re-queries', async () => {
    const { store, client, patch } = setup()
    await store.start()
    await store.setSort('name', 'asc')
    expect(patch).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(client.projects.list).toHaveBeenLastCalledWith({
      sort: 'name',
      dir: 'asc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  // The list must still re-sort even if the preference cannot be saved; the rejection is the
  // page's to report.
  it('applies a sort change locally and rethrows when persisting it fails', async () => {
    const { store, patch } = setup()
    patch.mockRejectedValueOnce(new Error('boom'))
    await expect(store.setSort('createdAt', 'desc')).rejects.toThrow()
    expect(store.query()).toEqual({ sort: 'createdAt', dir: 'desc' })
  })

  it('re-queries when the search term changes, and drops an empty term', async () => {
    const { store, client } = setup()
    await store.start()
    store.setSearch('bench')
    expect(client.projects.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'bench' }),
    )
    store.setSearch('   ')
    expect(store.query().search).toBeUndefined()
  })

  // A pasted 201st character must become a narrower result set, not a 400.
  it('truncates an over-long search term rather than dropping or sending it whole', () => {
    const { store } = setup()
    store.setSearch('x'.repeat(SEARCH_MAX_LENGTH + 1))
    expect(store.query().search).toHaveLength(SEARCH_MAX_LENGTH)
  })

  it('replaces the whole tag selection and remembers it', async () => {
    const { store, patch } = setup()
    await store.setTags(['petg', 'boat'])
    expect(store.query().tags).toEqual(['petg', 'boat'])
    await store.setTags(['boat'])
    expect(store.query().tags).toEqual(['boat'])
    expect(patch).toHaveBeenLastCalledWith({ filterTags: ['boat'] })
    await store.setTags([])
    expect(store.query().tags).toBeUndefined()
    expect(patch).toHaveBeenLastCalledWith({ filterTags: [] })
  })

  it('does nothing when the tag selection reported is the one already applied', async () => {
    const { store, client, patch } = setup({ filterTags: ['petg'] })
    await store.start()
    const calls = client.projects.list.mock.calls.length
    await store.setTags(['petg'])
    await store.setTags([])
    await store.setTags(['petg'])
    // [] differs from ['petg'] once, so exactly one reload and one write happened.
    expect(client.projects.list.mock.calls.length).toBe(calls + 2)
    expect(patch).toHaveBeenCalledTimes(2)
  })

  it('persists the archived flag and applies it', async () => {
    const { store, patch } = setup()
    await store.setIncludeArchived(true)
    expect(store.query().includeArchived).toBe(true)
    expect(patch).toHaveBeenCalledWith({ includeArchived: true })
    await store.setIncludeArchived(false)
    expect(store.query().includeArchived).toBeUndefined()
    expect(patch).toHaveBeenLastCalledWith({ includeArchived: false })
  })

  // Spec H 5: a failed persist is not a failed filter. The list is what the user asked for.
  it('applies a tag filter locally and reports when it cannot be remembered', async () => {
    const { store, patch, onRememberFailed } = setup()
    patch.mockRejectedValueOnce(new Error('nope'))
    await store.setTags(['petg'])
    expect(store.query().tags).toEqual(['petg'])
    expect(onRememberFailed).toHaveBeenCalledOnce()
  })

  it('applies the archived flag locally and reports when it cannot be remembered', async () => {
    const { store, patch, onRememberFailed } = setup()
    patch.mockRejectedValueOnce(new Error('nope'))
    await store.setIncludeArchived(true)
    expect(store.query().includeArchived).toBe(true)
    expect(onRememberFailed).toHaveBeenCalledOnce()
  })

  it('knows whether anything narrows the list', () => {
    expect(isFiltered({ sort: 'name' })).toBe(false)
    expect(isFiltered({ search: 'x' })).toBe(true)
    expect(isFiltered({ tags: ['a'] })).toBe(true)
    expect(isFiltered({ includeArchived: true })).toBe(true)
  })

  it('maps the sort choices both ways and refuses anything else', () => {
    expect(sortValueOf({ sort: 'name', dir: 'asc' })).toBe('name:asc')
    expect(parseSortValue('createdAt:desc')).toEqual({ sort: 'createdAt', dir: 'desc' })
    expect(parseSortValue('name:desc')).toBeUndefined()
    expect(parseSortValue('bogus')).toBeUndefined()
  })
})

describe('projects store: paging', () => {
  it('appends the next page at the right offset', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce(fullPage('b'))
      .mockResolvedValueOnce([project({ id: 'last' })])
    const { store } = setup({}, list)
    await store.start()
    expect(store.items()).toHaveLength(48)
    expect(store.hasMore()).toBe(true)

    await store.loadMore()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 48, offset: 48 }))
    expect(store.items()).toHaveLength(96)

    await store.loadMore()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 48, offset: 96 }))
    expect(store.items()).toHaveLength(97)
    expect(store.hasMore()).toBe(false)
  })

  it('replaces rather than appends when a filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce(fullPage('b'))
      .mockResolvedValueOnce([project({ id: 'filtered' })])
    const { store } = setup({}, list)
    await store.start()
    await store.loadMore()
    expect(store.items()).toHaveLength(96)

    store.setSearch('x')
    await vi.waitFor(() => expect(store.loadingFirst()).toBe(false))
    expect(ids(store.items())).toEqual(['filtered'])
  })

  it('does not repeat a project that arrives in two consecutive pages', async () => {
    const first = fullPage('a')
    const second = [first[47]!, project({ id: 'new' })]
    const list = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const { store } = setup({}, list)
    await store.start()
    await store.loadMore()
    expect(ids(store.items()).filter((id) => id === 'a47')).toHaveLength(1)
    expect(store.items()).toHaveLength(49)
  })

  it('refuses a second load while one is in flight', async () => {
    const slow = deferred<ProjectDto[]>()
    const list = vi.fn().mockResolvedValueOnce(fullPage('a')).mockReturnValueOnce(slow.promise)
    const { store } = setup({}, list)
    await store.start()

    const one = store.loadMore()
    const two = store.loadMore()
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.loadingMore()).toBe(true)
    slow.resolve(fullPage('b'))
    await Promise.all([one, two])
    expect(list).toHaveBeenCalledTimes(2)
    expect(store.items()).toHaveLength(96)
    expect(store.loadingMore()).toBe(false)
  })

  it('discards a page that lands after the filter it was fetched for changed', async () => {
    const slow = deferred<ProjectDto[]>()
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce([project({ id: 'fresh' })])
    const { store } = setup({}, list)
    await store.start()

    const pending = store.loadMore()
    store.setSearch('boat')
    await vi.waitFor(() => expect(store.loadingFirst()).toBe(false))
    slow.resolve(fullPage('stale'))
    await pending

    expect(ids(store.items())).toEqual(['fresh'])
    expect(store.loadingMore()).toBe(false)
  })

  it('discards a first page that lands after a newer query was made', async () => {
    const slow = deferred<ProjectDto[]>()
    const list = vi
      .fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce([project({ id: 'newer' })])
    const { store } = setup({}, list)
    const started = store.start()
    store.setSearch('x')
    await vi.waitFor(() => expect(ids(store.items())).toEqual(['newer']))
    slow.resolve([project({ id: 'older' })])
    await started
    expect(ids(store.items())).toEqual(['newer'])
  })

  it('reports no more rows once a page comes back short, or when the first one is', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce(fullPage('b').slice(0, 5))
    const { store } = setup({}, list)
    await store.start()
    expect(store.hasMore()).toBe(true)
    await store.loadMore()
    expect(store.hasMore()).toBe(false)

    const short = setup({}, vi.fn().mockResolvedValue([project({ id: 'only' })]))
    await short.store.start()
    expect(short.store.hasMore()).toBe(false)
  })

  it('keeps offering more and records the failure when a page fails to load', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(fullPage('b'))
    const { store } = setup({}, list)
    await store.start()

    await store.loadMore()
    expect(store.loadMoreFailed()).toBe(true)
    expect(store.hasMore()).toBe(true)
    expect(store.items()).toHaveLength(48)

    // Retrying asks for the same offset, and a page that lands clears the record.
    await store.loadMore()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 48 }))
    expect(store.loadMoreFailed()).toBe(false)
    expect(store.items()).toHaveLength(96)
  })

  it('clears a recorded failure when the filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([])
    const { store } = setup({}, list)
    await store.start()
    await store.loadMore()
    expect(store.loadMoreFailed()).toBe(true)
    store.setSearch('x')
    expect(store.loadMoreFailed()).toBe(false)
  })

  it('stays readable when the first page rejects, and says so', async () => {
    const { store } = setup({}, vi.fn().mockRejectedValue(new Error('down')))
    await store.start()
    expect(store.loadFailed()).toBe(true)
    expect(store.items()).toEqual([])
    expect(store.hasMore()).toBe(false)
    expect(store.loadingFirst()).toBe(false)
  })
})

describe('projects store: tags', () => {
  // Spec H 4: the tag list comes from the library, not from the rows on screen. With paging, "the
  // tags of the loaded projects" is no longer "every tag".
  it('lists the library tags, including ones no loaded project carries', async () => {
    const { store } = setup(
      {},
      vi.fn().mockResolvedValue([project({ tags: ['loaded'] })]),
      vi.fn().mockResolvedValue(['zebra', 'alpha', 'loaded']),
    )
    await store.start()
    await vi.waitFor(() => expect(store.tags()).toHaveLength(3))
    expect(store.knownTags()).toEqual(['alpha', 'loaded', 'zebra'])
  })

  // Ruling 59: with AND-filtering, two tags no project shares empty the result set. The filter must
  // still list them or there is no way back.
  it('keeps an active tag filter selectable even when it empties the result set', async () => {
    const { store } = setup(
      { filterTags: ['petg', 'boat'] },
      vi.fn().mockResolvedValue([]),
      vi.fn().mockResolvedValue([]),
    )
    await store.start()
    expect(store.items()).toEqual([])
    expect(store.knownTags()).toEqual(['boat', 'petg'])
  })

  it('stays readable when the tag list rejects', async () => {
    const { store } = setup(
      { filterTags: ['x'] },
      undefined,
      vi.fn().mockRejectedValue(new Error('down')),
    )
    await store.start()
    await vi.waitFor(() => expect(store.knownTags()).toEqual(['x']))
  })

  it('reloads the list and the tags after creating a project and after a rescan', async () => {
    const { store, client } = setup()
    await store.start()
    const lists = client.projects.list.mock.calls.length
    const tags = client.projects.tags.mock.calls.length

    await store.create({ name: 'New', tags: ['fresh'] })
    expect(client.projects.create).toHaveBeenCalledWith({ name: 'New', tags: ['fresh'] })
    await vi.waitFor(() => expect(client.projects.list.mock.calls.length).toBe(lists + 1))
    expect(client.projects.tags.mock.calls.length).toBe(tags + 1)

    client.projects.rescan.mockResolvedValue({ adopted: 1, filesAdded: 2 })
    await expect(store.rescan()).resolves.toEqual({ adopted: 1, filesAdded: 2 })
    await vi.waitFor(() => expect(client.projects.list.mock.calls.length).toBe(lists + 2))
    expect(client.projects.tags.mock.calls.length).toBe(tags + 2)
  })
})
