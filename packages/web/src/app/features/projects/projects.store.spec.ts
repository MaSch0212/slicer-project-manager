import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ProjectDto, type SettingsDto } from '@spm/contract/dtos.ts'
import { SEARCH_MAX_LENGTH, projectQuerySchema } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import { SettingsStore } from '../../core/settings.store'
import { PROJECTS_PAGE_SIZE, ProjectsStore } from './projects.store'

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
function fullPage(prefix: string): ProjectDto[] {
  return Array.from({ length: PROJECTS_PAGE_SIZE }, (_, index) =>
    project({ id: `${prefix}${index}` }),
  )
}

/**
 * `NotifyService` is a double in every spec here: jig's snackbar host attaches itself to
 * `ApplicationRef.components[0]`, which `TestBed` never populates, so the real one throws out of
 * a `queueMicrotask` where it lands as an unhandled error rather than a test failure. The
 * rendered path is covered by `app/app.config.spec.ts`, which bootstraps a real application.
 */
type Notify = { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }

/**
 * Loads the persisted settings before ProjectsStore is constructed, the way app.config.ts's
 * initializer does (it awaits SettingsStore.load() before any route can render), and waits for
 * the translations, which the store reads when it reports a failure.
 */
async function setup(
  persisted: Partial<SettingsDto> = {},
  list = vi.fn().mockResolvedValue([]),
  tags = vi.fn().mockResolvedValue([]),
) {
  const api = {
    projects: { list, create: vi.fn().mockResolvedValue(project({})), rescan: vi.fn(), tags },
    settings: {
      get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...persisted }),
      put: vi.fn((patch: Partial<SettingsDto>) =>
        Promise.resolve({ ...DEFAULT_SETTINGS, ...persisted, ...patch }),
      ),
    },
  }
  const notify: Notify = { success: vi.fn(), error: vi.fn() }
  TestBed.configureTestingModule({
    providers: [
      ProjectsStore,
      { provide: API_CLIENT, useValue: api },
      { provide: NotifyService, useValue: notify },
    ],
  })
  await TestBed.inject(TranslateService).ready
  await TestBed.inject(SettingsStore).load()
  return { store: TestBed.inject(ProjectsStore), api, notify }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

const ids = (projects: readonly ProjectDto[]) => projects.map((project) => project.id)

describe('ProjectsStore', () => {
  it('starts sorted by most recently updated when nothing else is persisted', async () => {
    const { store, api } = await setup()
    await settle()
    expect(store.query()).toEqual({ sort: 'updatedAt', dir: 'desc' })
    expect(api.projects.list).toHaveBeenCalledWith({
      sort: 'updatedAt',
      dir: 'desc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  // Final review, minor 1: SettingsDto.sort/.dir are persisted by the server, validated by
  // the schema and defaulted in DEFAULT_SETTINGS, but the store used to hard-code
  // { sort: 'updatedAt', dir: 'desc' } — so the user's saved sort was written by no UI and
  // read by no UI, and the list reset on every visit. Spec 3.3 lists `sort` among the
  // user_settings keys.
  it('seeds the initial query from the persisted settings', async () => {
    const { store, api } = await setup({ sort: 'name', dir: 'asc' })
    await settle()
    expect(store.query()).toEqual({ sort: 'name', dir: 'asc' })
    expect(api.projects.list).toHaveBeenCalledWith({
      sort: 'name',
      dir: 'asc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  // Spec H 5: the filter is remembered. Both keys seed the very first query, so the list the
  // user comes back to is the list they left — the request itself is what proves it, since a
  // seed that only reached the controls would show a filter the rows do not obey.
  it('seeds the archived flag and the tag filter from the persisted settings', async () => {
    const { store, api } = await setup({ includeArchived: true, filterTags: ['petg', 'boat'] })
    await settle()
    expect(store.query()).toEqual({
      sort: 'updatedAt',
      dir: 'desc',
      includeArchived: true,
      tags: ['petg', 'boat'],
    })
    expect(api.projects.list).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true, tags: ['petg', 'boat'] }),
    )
  })

  it('persists a sort change so the next visit keeps it', async () => {
    const { store, api } = await setup()
    await settle()

    await store.setSort('name', 'asc')
    await settle()

    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(api.projects.list).toHaveBeenLastCalledWith({
      sort: 'name',
      dir: 'asc',
      limit: PROJECTS_PAGE_SIZE,
    })
  })

  // The list must still re-sort even if the preference cannot be saved: the local query is
  // what drives the request, and the rejection is the page's to report.
  it('applies a sort change locally and rethrows when persisting it fails', async () => {
    const { store, api } = await setup()
    api.settings.put.mockRejectedValueOnce(new Error('boom'))
    await settle()

    await expect(store.setSort('createdAt', 'desc')).rejects.toThrow()

    expect(store.query()).toEqual({ sort: 'createdAt', dir: 'desc' })
  })

  it('reloads when the search term changes', async () => {
    const { store, api } = await setup()
    await settle()
    store.setSearch('bench')
    await settle()
    expect(api.projects.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'bench' }))
  })

  it('drops an empty search term rather than sending it', async () => {
    const { store } = await setup()
    store.setSearch('bench')
    store.setSearch('   ')
    expect(store.query().search).toBeUndefined()
  })

  /**
   * Ruling H-6. `parseProjectQuery` refuses a query that fails validation with a 400 -- right for
   * `limit=abc`, which a caller builds from arithmetic -- but `projectQuerySchema` caps `search`
   * at `SEARCH_MAX_LENGTH`, so a pasted 201st character used to turn a search into a hard
   * failure. Truncating is the only answer that is neither a refusal nor a silent drop: the
   * assertion is that the term survives, shortened, rather than that it is gone.
   */
  it('truncates an over-long search term rather than dropping or sending it whole', async () => {
    const { store } = await setup()

    store.setSearch('x'.repeat(SEARCH_MAX_LENGTH + 1))

    expect(store.query().search).toHaveLength(SEARCH_MAX_LENGTH)
    expect(projectQuerySchema.safeParse(store.query()).success).toBe(true)
  })

  /**
   * `setTags` is what the filter bar's multi-select reports through -- it hands back the whole
   * selection it now holds, not the item that changed. The second half is the point: it
   * *replaces*, so a tag that is no longer in the array is no longer in the filter.
   */
  it('replaces the whole tag selection and remembers it', async () => {
    const { store, api } = await setup()

    await store.setTags(['petg', 'boat'])
    expect(store.query().tags).toEqual(['petg', 'boat'])

    await store.setTags(['boat'])

    expect(store.query().tags).toEqual(['boat'])
    expect(api.settings.put).toHaveBeenLastCalledWith({ filterTags: ['boat'] })
  })

  it('toggles a tag on and off', async () => {
    const { store } = await setup()
    await store.toggleTag('petg')
    expect(store.query().tags).toEqual(['petg'])
    await store.toggleTag('boat')
    expect(store.query().tags).toEqual(['petg', 'boat'])
    await store.toggleTag('petg')
    expect(store.query().tags).toEqual(['boat'])
    await store.toggleTag('boat')
    expect(store.query().tags).toBeUndefined()
  })

  // Spec H 5, the other half of the seeding test above: what the user picks has to reach the
  // server, or there is nothing for the next visit to seed from.
  it('persists the tag filter and the archived flag as they change', async () => {
    const { store, api } = await setup()
    await settle()

    await store.toggleTag('petg')
    await store.setIncludeArchived(true)

    expect(api.settings.put).toHaveBeenCalledWith({ filterTags: ['petg'] })
    expect(api.settings.put).toHaveBeenCalledWith({ includeArchived: true })
  })

  /**
   * Spec H 5: a failed persist must not prevent the filter applying locally. `SettingsStore.patch`
   * is optimistic and rolls its own key back before rethrowing, so the setting is correctly back
   * where it was — but the list is what the user actually asked for, and only remembering it
   * failed. Both halves are asserted because either one alone would pass against the wrong code:
   * a store that swallowed the rejection silently, or one that reported it and then dropped the
   * filter on the floor.
   */
  it('applies a tag filter locally and reports an error when it cannot be remembered', async () => {
    const { store, api, notify } = await setup()
    api.settings.put.mockRejectedValue(new Error('boom'))
    await settle()

    await expect(store.toggleTag('petg')).resolves.toBeUndefined()
    await settle()

    expect(store.query().tags).toEqual(['petg'])
    expect(api.projects.list).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['petg'] }))
    expect(notify.error).toHaveBeenCalled()
  })

  it('applies the archived flag locally and reports an error when it cannot be remembered', async () => {
    const { store, api, notify } = await setup()
    api.settings.put.mockRejectedValue(new Error('boom'))
    await settle()

    await expect(store.setIncludeArchived(true)).resolves.toBeUndefined()

    expect(store.query().includeArchived).toBe(true)
    expect(notify.error).toHaveBeenCalled()
  })

  // Spec H 3.3: the first request is a page, not the whole library. The number matters — 48 is
  // divisible by 2, 3, 4 and 6, so the grid's last row is full at every column count.
  it('asks for one page of 48 rather than the whole library', async () => {
    const { api } = await setup()
    await settle()
    expect(api.projects.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 48 }))
  })

  it('appends the next page at the right offset', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce([project({ id: 'b0' }), project({ id: 'b1' })])
    const { store, api } = await setup({}, list)
    await settle()

    await store.loadMore()

    expect(api.projects.list).toHaveBeenLastCalledWith({
      sort: 'updatedAt',
      dir: 'desc',
      limit: PROJECTS_PAGE_SIZE,
      offset: PROJECTS_PAGE_SIZE,
    })
    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE + 2)
    expect(ids(store.items()).slice(-2)).toEqual(['b0', 'b1'])
  })

  /**
   * Spec H 3.3: a filter change resets to page zero and REPLACES. The `loadMore` before the
   * filter change is what gives this test teeth — against a store with nothing accumulated,
   * "replaces" and "appends" are the same assertion.
   */
  it('replaces rather than appends when a filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce(fullPage('b'))
      .mockResolvedValue([project({ id: 'z' })])
    const { store } = await setup({}, list)
    await settle()
    await store.loadMore()
    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE * 2)

    store.setSearch('boat')
    await settle()

    expect(ids(store.items())).toEqual(['z'])
  })

  /**
   * Spec H 3.3: offset paging over a live table can hand the same row out twice, because a
   * project written between two requests shifts the page boundary. The overlap is deliberately
   * the LAST row of the first page arriving again as the first row of the second, which is the
   * shape a single insertion above the offset actually produces.
   */
  it('does not repeat a project that arrives in two consecutive pages', async () => {
    const first = fullPage('a')
    // The same id the last row of the first page carries, rebuilt rather than indexed out of
    // the array, so the fixture states the overlap instead of depending on an index.
    const repeated = project({ id: `a${PROJECTS_PAGE_SIZE - 1}` })
    const list = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([repeated, project({ id: 'b0' })])
    const { store } = await setup({}, list)
    await settle()

    await store.loadMore()

    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE + 1)
    expect(ids(store.items()).filter((id) => id === repeated.id)).toEqual([repeated.id])
  })

  /**
   * Spec H 3.3 and 7.5: a request already in flight refuses a second. The first page has to be a
   * FULL one and the second request has to be left pending, or the guard is never reached — a
   * store that has no more rows to fetch, or one whose fetch has already resolved, passes this
   * without the guard existing at all.
   */
  it('refuses a second load while one is in flight', async () => {
    let release: (rows: ProjectDto[]) => void = () => {}
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockImplementationOnce(
        () =>
          new Promise<ProjectDto[]>((resolve) => {
            release = resolve
          }),
      )
    const { store, api } = await setup({}, list)
    await settle()
    const before = api.projects.list.mock.calls.length

    const first = store.loadMore()
    const second = store.loadMore()

    expect(api.projects.list.mock.calls.length).toBe(before + 1)
    expect(store.isLoadingMore()).toBe(true)

    release([])
    await Promise.all([first, second])
    expect(store.isLoadingMore()).toBe(false)
  })

  /**
   * Fix round 1, finding 1. Spec H 3.3 says a filter change replaces — and the reset alone does
   * not achieve that, because a request already running knows nothing about it. When the old
   * filter's page landed it appended its rows under the new filter's page zero AND advanced
   * `nextOffset` past the new filter's second page, which then became unreachable entirely.
   *
   * The shape is the one that catches it and nothing weaker does: start the load, change the
   * filter WHILE IT IS STILL PENDING, then resolve it. A test that settles the load first (the
   * "replaces rather than appends" one above) passes against the broken code.
   *
   * Both consequences are asserted, because the rows alone would not have caught the offset.
   */
  it('discards a page that lands after the filter it was fetched for changed', async () => {
    let release: (rows: ProjectDto[]) => void = () => {}
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('stale'))
      .mockImplementationOnce(
        () =>
          new Promise<ProjectDto[]>((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValueOnce(fullPage('fresh'))
      .mockResolvedValue([project({ id: 'last' })])
    const { store, api } = await setup({}, list)
    await settle()

    const pending = store.loadMore()
    store.setSearch('boat')
    await settle()
    release(fullPage('late'))
    await pending
    await settle()

    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE)
    expect(ids(store.items()).every((id) => id.startsWith('fresh'))).toBe(true)

    await store.loadMore()

    expect(api.projects.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'boat', offset: PROJECTS_PAGE_SIZE }),
    )
  })

  // Spec H 3.3: the store has no total, so it infers the end from a short page. This is what
  // decides whether the "Load more" control renders at all.
  it('reports no more rows once a page comes back short', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce([project({ id: 'b0' })])
    const { store } = await setup({}, list)
    await settle()
    expect(store.hasMore()).toBe(true)

    await store.loadMore()

    expect(store.hasMore()).toBe(false)
  })

  it('reports no more rows when the very first page is short', async () => {
    const { store } = await setup({}, vi.fn().mockResolvedValue([project({ id: 'a0' })]))
    await settle()
    expect(store.hasMore()).toBe(false)
  })

  /**
   * The control the user just pressed has to still be there to press again, so a failed page
   * must not be mistaken for the end of the library.
   *
   * The failure is a signal and no longer a snackbar (spec H 7.5): `endReached` re-arms every
   * time the user leaves the threshold zone and comes back, so one snackbar per attempt is a
   * stream of them at a broken-network boundary. `notify.error` is asserted NOT to have fired,
   * which is the half a state-only assertion would not catch — a store that set the signal and
   * kept the snackbar would pass on the signal alone.
   */
  it('keeps offering more and records the failure when a page fails to load', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('boom'))
    const { store, notify } = await setup({}, list)
    await settle()
    expect(store.loadMoreFailed()).toBe(false)

    await expect(store.loadMore()).resolves.toBeUndefined()

    expect(store.loadMoreFailed()).toBe(true)
    expect(notify.error).not.toHaveBeenCalled()
    expect(store.hasMore()).toBe(true)
    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE)
  })

  /**
   * A page that lands is the other thing that makes a recorded failure untrue.
   *
   * It has its own test because the clear moved (fix round 1, finding 4): it used to happen at the
   * top of every attempt, where a single line covered both the retry case and — accidentally and
   * harmfully — the failure-after-failure case. It now sits in the success path, so nothing else
   * exercises it.
   */
  it('clears a recorded failure once a page finally lands', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fullPage('b'))
    const { store } = await setup({}, list)
    await settle()
    await store.loadMore()
    expect(store.loadMoreFailed()).toBe(true)

    await store.loadMore()

    expect(store.loadMoreFailed()).toBe(false)
    expect(store.items()).toHaveLength(PROJECTS_PAGE_SIZE * 2)
  })

  /**
   * The other half of the same state: it is about the attempt that failed, not a mode the store
   * stays in. A filter change replaces the whole result set, so a failure recorded against the
   * previous one has nothing left to describe, and leaving it set would put an error under a
   * list that had just loaded correctly.
   *
   * `setSearch` rather than a retry, because a retry clears it through the same line the first
   * attempt does; a reset going through `resetPaging` is the path that is easy to miss.
   */
  it('clears a recorded failure when the filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([project({ id: 'b0' })])
    const { store } = await setup({}, list)
    await settle()
    await store.loadMore()
    expect(store.loadMoreFailed()).toBe(true)

    store.setSearch('benchy')
    await settle()

    expect(store.loadMoreFailed()).toBe(false)
  })

  // Spec H 4: the filter bar's tag list comes from the library, not from the rows on screen —
  // once the list arrives one page at a time, "the tags of the loaded projects" is no longer
  // "every tag", and a tag on project 200 would be unreachable.
  it('lists the library tags, including ones no loaded project carries', async () => {
    const { store } = await setup(
      {},
      vi.fn().mockResolvedValue([project({ id: 'a' })]),
      vi.fn().mockResolvedValue(['boat', 'functional', 'petg']),
    )
    await settle()
    expect(store.knownTags()).toEqual(['boat', 'functional', 'petg'])
  })

  it('reloads after creating a project and after a rescan', async () => {
    const { store, api } = await setup()
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

  /**
   * Fix round 2. `createProjectSchema` carries `tags`, and `createProject` applies them
   * (`for (const tag of input.tags ?? []) addTag(...)`), so a create can put a tag in the library
   * that was never there before — which makes the filter bar's list stale exactly as a rescan
   * does. The input here carries a tag on purpose: it states the reason the reload exists,
   * rather than leaving it to a comment that the code could quietly stop agreeing with.
   */
  it('refreshes the library tags after creating a project, which can carry tags', async () => {
    const { store, api } = await setup()
    await settle()
    const before = api.projects.tags.mock.calls.length

    await store.create({ name: 'New', tags: ['petg'] })
    await settle()

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'New', tags: ['petg'] })
    expect(api.projects.tags.mock.calls.length).toBe(before + 1)
  })

  // A rescan adopts folders that may carry tags this library has never seen, so the filter
  // bar's list is stale the moment it finishes.
  it('refreshes the library tags after a rescan', async () => {
    const { store, api } = await setup()
    await settle()
    const before = api.projects.tags.mock.calls.length

    await store.rescan()
    await settle()

    expect(api.projects.tags.mock.calls.length).toBe(before + 1)
  })

  // Ruling 59: with AND-filtering, two tags that no single project shares yields an empty
  // result set — and if the rendered tag list were derived only from what is on screen, it
  // would go empty too, hiding every filter button including the ones that caused the empty
  // result. That is a dead end: nothing left on screen to un-toggle the filter with. Spec H 4
  // changes where the base list comes from and leaves that rule exactly where it was.
  it('keeps an active tag filter selectable even when it empties the result set', async () => {
    const { store } = await setup({}, vi.fn().mockResolvedValue([]))
    await store.toggleTag('petg')
    await store.toggleTag('boat')
    await settle()
    expect(store.knownTags()).toEqual(['boat', 'petg'])
  })

  // Fix round 1, finding 1: Angular's resource() only substitutes `defaultValue` before a
  // load has ever completed. Once a load settles to the public 'error' status, `.value()`
  // throws a ResourceValueError instead. The store's own reads therefore have to guard on the
  // status, or the first failed `list()` (server error, network blip, expired session) takes
  // the whole page down with it — including the filter bar, which renders independently of the
  // grid. This proves the store stays readable, and that the error state is observable, so the
  // page can render a real fallback instead of throwing.
  it('stays readable when list rejects, and exposes an observable error state', async () => {
    const { store } = await setup({}, vi.fn().mockRejectedValue(new Error('boom')))
    await settle()

    expect(store.projects.status()).toBe('error')
    expect(() => store.items()).not.toThrow()
    expect(store.items()).toEqual([])
    expect(store.hasMore()).toBe(false)
    expect(() => store.knownTags()).not.toThrow()
    expect(store.knownTags()).toEqual([])
  })

  // The same hazard on the other resource, which the filter bar reads on its own.
  it('stays readable when the tag list rejects', async () => {
    const { store } = await setup({}, undefined, vi.fn().mockRejectedValue(new Error('boom')))
    await settle()

    expect(store.tags.status()).toBe('error')
    expect(() => store.knownTags()).not.toThrow()
    expect(store.knownTags()).toEqual([])
  })
})
