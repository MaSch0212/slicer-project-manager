import { createSignal } from 'solid-js'
import {
  SEARCH_MAX_LENGTH,
  type ProjectDto,
  type ProjectQuery,
  type RescanResultDto,
  type SettingsDto,
  type SettingsPatch,
} from '../api/generated'
import { api, type ApiClient } from './api/client'
import { settings as settingsStore } from './stores'

/**
 * How many projects one page holds (subsystem H 3.3). 48 is divisible by 2, 3, 4 and 6, so the
 * grid's last row is full at every column count the layout produces: a trailing row with one card
 * in it reads as a loading glitch rather than as the end of the library.
 */
export const PROJECTS_PAGE_SIZE = 48

/** What the projects store needs of the settings store, so a test can hand in a fake. */
export type SettingsPort = {
  settings: () => SettingsDto
  patch: (partial: SettingsPatch) => Promise<void>
}

export type ProjectsStoreDeps = {
  client: Pick<ApiClient, 'projects'>
  settings: SettingsPort
  /** Told when a filter was applied but could not be remembered (spec H 5). */
  onRememberFailed?: (error: unknown) => void
}

/**
 * The query the page starts with, from the settings the user left behind (spec H 5).
 *
 * `includeArchived` and `tags` are written only when non-default: the setters treat an absent key
 * and a default value as the same thing, and seeding defaults would make the first query a shape no
 * setter can ever produce again.
 */
export function initialQuery(settings: SettingsDto): ProjectQuery {
  const query: ProjectQuery = { sort: settings.sort, dir: settings.dir }
  if (settings.includeArchived) query.includeArchived = true
  if (settings.filterTags.length > 0) query.tags = [...settings.filterTags]
  return query
}

/** True when anything narrows the list: the page words "no projects" differently then. */
export function isFiltered(query: ProjectQuery): boolean {
  return Boolean(query.search) || (query.tags?.length ?? 0) > 0 || query.includeArchived === true
}

/**
 * The projects list as paged state (subsystem H 3, 4, 5, 7.5): one page at a time, accumulated,
 * reset by any filter change, de-duplicated by id, guarded against overlapping loads and against a
 * page that lands after the filter it was fetched for has changed.
 *
 * Plain signals and functions, no memos, so it works inside or outside a reactive owner and a test
 * needs no root. Create one per page visit and call `start()`.
 */
export function createProjectsStore(deps: Partial<ProjectsStoreDeps> = {}) {
  const client = deps.client ?? api
  const settings = deps.settings ?? settingsStore

  const [query, setQuery] = createSignal<ProjectQuery>(initialQuery(settings.settings()))
  const [firstPage, setFirstPage] = createSignal<ProjectDto[]>([])
  const [loadingFirst, setLoadingFirst] = createSignal(true)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [appended, setAppended] = createSignal<ProjectDto[]>([])
  // How many rows the latest appended page held; null until one has been appended since a reset.
  const [lastPageLength, setLastPageLength] = createSignal<number | null>(null)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [loadMoreFailed, setLoadMoreFailed] = createSignal(false)
  const [tags, setTags] = createSignal<string[]>([])

  // The offset the next page asks for. Counts rows requested, not rows kept after de-duplication.
  let nextOffset = PROJECTS_PAGE_SIZE
  // A token, not state: which filter the accumulated pages belong to. Bumped by every reset and
  // captured before an await, so an answer for a filter the user has left is discarded whole.
  let generation = 0

  /** Page zero for the current query. A superseded answer (older generation) is dropped. */
  async function loadFirstPage(): Promise<void> {
    const mine = ++generation
    nextOffset = PROJECTS_PAGE_SIZE
    setAppended([])
    setLastPageLength(null)
    setLoadMoreFailed(false)
    // A page still in flight belongs to the previous generation and will be discarded.
    setLoadingMore(false)
    setLoadingFirst(true)
    setLoadFailed(false)
    try {
      const page = await client.projects.list({ ...query(), limit: PROJECTS_PAGE_SIZE })
      if (mine !== generation) return
      setFirstPage(page)
    } catch {
      if (mine !== generation) return
      setFirstPage([])
      setLoadFailed(true)
    } finally {
      if (mine === generation) setLoadingFirst(false)
    }
  }

  async function loadTags(): Promise<void> {
    try {
      setTags(await client.projects.tags())
    } catch {
      // The filter just offers the selected tags alone; the list itself is unaffected.
      setTags([])
    }
  }

  function hasMore(): boolean {
    if (loadFailed() || loadingFirst()) return false
    return (lastPageLength() ?? firstPage().length) === PROJECTS_PAGE_SIZE
  }

  /** Every filter change goes through here, so resetting to page zero cannot be forgotten. */
  function applyQuery(next: (query: ProjectQuery) => ProjectQuery): void {
    setQuery(next)
    void loadFirstPage()
  }

  /** Persists a filter choice without letting a failure reach the list (spec H 5). */
  async function remember(partial: SettingsPatch): Promise<void> {
    try {
      await settings.patch(partial)
    } catch (error) {
      deps.onRememberFailed?.(error)
    }
  }

  return {
    query,
    tags,
    loadingFirst,
    loadFailed,
    loadingMore,
    loadMoreFailed,

    /** Page zero followed by every appended page, de-duplicated by id (spec H 3.3). */
    items(): ProjectDto[] {
      const seen = new Set<string>()
      const rows: ProjectDto[] = []
      for (const project of [...firstPage(), ...appended()]) {
        if (seen.has(project.id)) continue
        seen.add(project.id)
        rows.push(project)
      }
      return rows
    },

    /**
     * Whether another page could return anything: a page as long as the one asked for. Costs one
     * extra, empty request when the total is an exact multiple, the cheapest correct answer without
     * a count query.
     */
    hasMore,

    /** The tags the filter offers: the library's, plus whatever is selected so it can be undone. */
    knownTags(): string[] {
      const selected = query().tags ?? []
      return [...new Set([...tags(), ...selected])].sort((a, b) => a.localeCompare(b))
    },

    /** Loads page zero and the tag list. Call once when the page mounts. */
    start(): Promise<void> {
      void loadTags()
      return loadFirstPage()
    },

    reload: loadFirstPage,

    /** Narrows to a search term, cut to what the server accepts (a paste must not become a 400). */
    setSearch(term: string): void {
      const trimmed = term.trim().slice(0, SEARCH_MAX_LENGTH)
      applyQuery(({ search: _dropped, ...rest }) => (trimmed ? { ...rest, search: trimmed } : rest))
    },

    /** Replaces the whole tag selection, which is what a multi-select reports. Never rejects. */
    async setTags(names: readonly string[]): Promise<void> {
      const next = [...names]
      const current = query().tags ?? []
      // Nothing changed: no reload and no write (a control can echo its own value back).
      if (next.length === current.length && next.every((name) => current.includes(name))) return
      applyQuery(({ tags: _dropped, ...rest }) =>
        next.length > 0 ? { ...rest, tags: next } : rest,
      )
      await remember({ filterTags: next })
    },

    /** Shows or hides archived projects and remembers the choice. Never rejects. */
    async setIncludeArchived(flag: boolean): Promise<void> {
      applyQuery(({ includeArchived: _dropped, ...rest }) =>
        flag ? { ...rest, includeArchived: true } : rest,
      )
      await remember({ includeArchived: flag })
    },

    /**
     * Applies the sort locally first, then persists it, so the list re-sorts even if the preference
     * cannot be saved. The settings store rolls its keys back and rethrows; the caller reports it.
     */
    setSort(sort: SettingsDto['sort'], dir: SettingsDto['dir']): Promise<void> {
      applyQuery((current) => ({ ...current, sort, dir }))
      return settings.patch({ sort, dir })
    },

    /**
     * Appends the next page. A request already in flight refuses a second one: the guard is the
     * first statement and the flag is written before the first await, because a scroll observer and
     * a button both fire repeatedly by nature. Never rejects; a failure sets `loadMoreFailed` and
     * leaves `hasMore` true so the same control can retry.
     */
    async loadMore(): Promise<void> {
      if (loadingMore() || !hasMore()) return
      setLoadingMore(true)
      const offset = nextOffset
      const mine = generation
      try {
        const page = await client.projects.list({
          ...query(),
          limit: PROJECTS_PAGE_SIZE,
          offset,
        })
        // The filter moved while this was in flight: these rows answer a question nobody asks.
        if (mine !== generation) return
        setLoadMoreFailed(false)
        nextOffset = offset + PROJECTS_PAGE_SIZE
        setAppended((rows) => [...rows, ...page])
        setLastPageLength(page.length)
      } catch {
        if (mine === generation) setLoadMoreFailed(true)
      } finally {
        if (mine === generation) setLoadingMore(false)
      }
    },

    /** Creates a project and re-queries around it; the tag list reloads too, a create can carry tags. */
    async create(input: Parameters<ApiClient['projects']['create']>[0]): Promise<ProjectDto> {
      const created = await client.projects.create(input)
      void loadFirstPage()
      void loadTags()
      return created
    },

    /** Rescans the library, then reloads the list and the tags (a folder can bring new ones). */
    async rescan(): Promise<RescanResultDto> {
      const result = await client.projects.rescan()
      void loadFirstPage()
      void loadTags()
      return result
    },
  }
}

export type ProjectsStore = ReturnType<typeof createProjectsStore>

/** The sort choices the projects page offers, as `<sort>:<dir>` values. */
export const SORT_VALUES = ['updatedAt:desc', 'name:asc', 'createdAt:desc'] as const
export type SortValue = (typeof SORT_VALUES)[number]

export const sortValueOf = (query: Pick<ProjectQuery, 'sort' | 'dir'>): string =>
  `${query.sort ?? 'updatedAt'}:${query.dir ?? 'desc'}`

/** Splits a `<sort>:<dir>` value; undefined for anything that is not one of the offered choices. */
export function parseSortValue(
  value: string,
): { sort: SettingsDto['sort']; dir: SettingsDto['dir'] } | undefined {
  if (!(SORT_VALUES as readonly string[]).includes(value)) return undefined
  const [sort, dir] = value.split(':') as [SettingsDto['sort'], SettingsDto['dir']]
  return { sort, dir }
}
