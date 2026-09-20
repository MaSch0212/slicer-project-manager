import { Injectable, computed, inject, resource, signal } from '@angular/core'
import type { ProjectDto, ProjectQuery, RescanResultDto, SettingsDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import { SettingsStore } from '../../core/settings.store'

/**
 * How many projects one page holds (spec 3.3).
 *
 * 48 is divisible by 2, 3, 4 and 6, so the grid's last row is full at every column count this
 * layout produces — a trailing row with one card in it reads as a loading glitch rather than as
 * the end of the library.
 */
export const PROJECTS_PAGE_SIZE = 48

/**
 * The query the page starts with, from the settings the user left behind (spec 5).
 *
 * `includeArchived` and `tags` are only written when they are non-default, because the rest of
 * the store treats an absent key and a default value as the same thing — `setIncludeArchived`
 * deletes the key rather than sending `false`, and `toggleTag` deletes it rather than sending an
 * empty array. Seeding the defaults in explicitly would make the initial query a shape no setter
 * can ever produce again.
 */
function initialQuery(settings: SettingsDto): ProjectQuery {
  const query: ProjectQuery = { sort: settings.sort, dir: settings.dir }
  if (settings.includeArchived) query.includeArchived = true
  if (settings.filterTags.length > 0) query.tags = [...settings.filterTags]
  return query
}

@Injectable()
export class ProjectsStore {
  private readonly api = inject(API_CLIENT)
  private readonly settings = inject(SettingsStore)
  private readonly notify = inject(NotifyService)
  private readonly t = inject(TranslateService)

  /**
   * Seeded from the persisted settings rather than hard-coded. `SettingsDto.sort`/`.dir` are
   * stored by the server, validated by the schema and defaulted in `DEFAULT_SETTINGS`
   * (spec 3.3 lists `sort` among the `user_settings` keys), but nothing used to read or
   * write them from the UI, so the project list's sort silently reset on every visit.
   * app.config.ts's initializer awaits `SettingsStore.load()` before any route renders, so
   * this signal's initial value is the user's own choice, not the defaults.
   *
   * Spec H 5 adds `includeArchived` and `filterTags` to the same treatment, for the same
   * reason and from the same place. Search is deliberately NOT among them: a search box that
   * refills itself on every visit hides the rest of the library from a user who has forgotten
   * why they are seeing four projects.
   */
  private readonly queryState = signal<ProjectQuery>(initialQuery(this.settings.settings()))

  readonly query = this.queryState.asReadonly()

  /**
   * Page zero. `resource()` takes any promise, so the transport abstraction survives (spec 6.1).
   *
   * It asks for `PROJECTS_PAGE_SIZE` rows and no more; every later page is fetched by
   * `loadMore` and accumulated in `appended`. Keeping page zero a resource rather than folding
   * it into the same signal is what keeps `isLoading`/`status`/`reload` — and therefore the
   * page's spinner, its error banner and the reload after a create or a rescan — working
   * exactly as they did before paging existed.
   */
  readonly projects = resource<ProjectDto[], ProjectQuery>({
    params: () => this.queryState(),
    loader: ({ params }) => this.api.projects.list({ ...params, limit: PROJECTS_PAGE_SIZE }),
    defaultValue: [],
  })

  /**
   * Every page after page zero, in the order they arrived. Emptied whenever the query changes
   * (see `applyQuery`), because a filter change that appended would show the previous filter's
   * results underneath the new filter's.
   */
  private readonly appended = signal<ProjectDto[]>([])

  /**
   * How many rows the most recent appended page held, or `null` when no page has been appended
   * since the last reset. `hasMore` reads it; a failed request deliberately leaves it alone, so
   * the "Load more" control survives a failure and the user can simply press it again.
   */
  private readonly lastPageLength = signal<number | null>(null)

  /** The offset the next page asks for. Counts rows *requested*, not rows kept after de-duplication. */
  private readonly nextOffset = signal(PROJECTS_PAGE_SIZE)

  private readonly loadingMore = signal(false)

  /** Whether a further page is currently being fetched — the page renders a spinner on it. */
  readonly isLoadingMore = this.loadingMore.asReadonly()

  /**
   * `Resource.value()` only substitutes `defaultValue` before any load has ever completed
   * (or while a same-params reload is in flight). Once a load settles to the public 'error'
   * status, `value()` throws a `ResourceValueError` instead — `defaultValue` does not shield
   * reads after that point. `status()` is the public, typed way to check for that state
   * (`Resource<T>` exposes `status`/`error`/`isLoading`, but no `isError`).
   */
  readonly loadFailed = computed(() => this.projects.status() === 'error')

  /**
   * The rows to render: page zero followed by every appended page, **de-duplicated by id**.
   *
   * Offset paging over a live table is not exact, and spec 3.3 says so rather than pretending
   * otherwise. A project created or renamed between two requests shifts rows across the page
   * boundary, so the same project can arrive in two consecutive pages; the `p.id` tiebreaker in
   * the SQL makes the order total for a *static* table, not for one being written to. Removing
   * the repeat here is the honest mitigation. A row inserted *above* the current offset between
   * two pages can still be missed until the next filter change or reload — that is accepted and
   * recorded, not fixed; cursor paging would fix it and is not worth the complexity here.
   *
   * De-duplicating on read rather than on append also catches an overlap between page zero and
   * the first appended page, which an append-time check against only the previous page would not.
   */
  readonly items = computed<ProjectDto[]>(() => {
    if (this.loadFailed()) return []
    const seen = new Set<string>()
    const rows: ProjectDto[] = []
    for (const project of [...this.projects.value(), ...this.appended()]) {
      if (seen.has(project.id)) continue
      seen.add(project.id)
      rows.push(project)
    }
    return rows
  })

  /**
   * Whether asking for another page could return anything.
   *
   * The store has no total to compare against — nothing in the UI needs one and it would cost a
   * second query per page — so it infers the end from the page it just got: a page shorter than
   * the one it asked for is the last one. That costs one extra, empty request when the library
   * is an exact multiple of `PROJECTS_PAGE_SIZE`, which is the cheapest correct answer without a
   * count query.
   *
   * `loadFailed` is checked first and not merely for tidiness: reading `projects.value()` after a
   * failed load throws (see `loadFailed`), and this is read straight from the template.
   */
  readonly hasMore = computed(() => {
    if (this.loadFailed()) return false
    const last = this.lastPageLength()
    return (last ?? this.projects.value().length) === PROJECTS_PAGE_SIZE
  })

  /**
   * Ruling 59: the tag filter bar must always offer a way to un-toggle an active filter. With
   * AND filtering, two tags that no single project shares in common yield an empty result set —
   * and if the rendered list were derived only from what is on screen it would go empty right
   * along with the results, hiding every filter button (including the ones that caused the empty
   * result) with no way back except reloading the page. Folding the tags currently in `query()`
   * into the union guarantees a selected tag always has a button.
   *
   * Spec H 4 changes where the base list comes from and leaves that rule exactly as it was: the
   * union used to start from the tags of the loaded projects, which stopped being "every tag in
   * the library" the moment the list started arriving one page at a time. It now starts from the
   * `projects.tags()` resource, which asks the library directly.
   *
   * The `status() === 'error'` guard moved along with it, for the same reason it existed: a
   * resource whose load failed throws from `value()`, and this computed is read by the filter bar
   * independently of the grid, so it must survive a failed load on its own.
   */
  readonly tags = resource<string[], void>({
    loader: () => this.api.projects.tags(),
    defaultValue: [],
  })

  readonly knownTags = computed(() => {
    const selected = this.query().tags ?? []
    const library = this.tags.status() === 'error' ? [] : this.tags.value()
    return [...new Set([...library, ...selected])].sort((a, b) => a.localeCompare(b))
  })

  /**
   * The single door every filter change goes through, so that resetting to page zero cannot be
   * forgotten by one of them. Writing `queryState` re-runs the page-zero resource on its own;
   * this only has to throw away what the *previous* filter accumulated.
   */
  private applyQuery(next: (query: ProjectQuery) => ProjectQuery): void {
    this.appended.set([])
    this.lastPageLength.set(null)
    this.nextOffset.set(PROJECTS_PAGE_SIZE)
    this.queryState.update(next)
  }

  setSearch(term: string): void {
    const trimmed = term.trim()
    this.applyQuery(({ search: _dropped, ...rest }) =>
      trimmed ? { ...rest, search: trimmed } : rest,
    )
  }

  /**
   * Toggles a tag and remembers the result (spec 5).
   *
   * The returned promise never rejects. It is bound straight to a control's output, where a
   * rejection has nowhere to go but an unhandled rejection — and, more to the point, a filter
   * that could not be *remembered* is not a filter that failed: the list has already been
   * narrowed to what the user asked for, and all that is left to say is that the next visit will
   * not start there. Hence a snackbar from here rather than a rethrow, unlike `setSort`, whose
   * caller has an inline message to fill in.
   */
  async toggleTag(name: string): Promise<void> {
    const current = this.queryState().tags ?? []
    const next = current.includes(name) ? current.filter((tag) => tag !== name) : [...current, name]
    // Destructuring `tags` out of the parameter (rather than a local `const { tags: _dropped,
    // ...rest } = query`) keeps every binding used, since eslint's `no-unused-vars` only
    // exempts `_`-prefixed *function arguments*, not local destructured variables.
    this.applyQuery(({ tags: _dropped, ...rest }) =>
      next.length > 0 ? { ...rest, tags: next } : rest,
    )
    await this.remember({ filterTags: next })
  }

  /** Shows or hides archived projects and remembers the choice. Same contract as `toggleTag`. */
  async setIncludeArchived(flag: boolean): Promise<void> {
    this.applyQuery(({ includeArchived: _dropped, ...rest }) =>
      flag ? { ...rest, includeArchived: true } : rest,
    )
    await this.remember({ includeArchived: flag })
  }

  /**
   * Applies the sort locally first, then persists it, so the list re-sorts even if the
   * preference cannot be saved. `SettingsStore.patch` rethrows after rolling its own keys
   * back; the rejection is deliberately propagated for the page to surface.
   */
  setSort(sort: SettingsDto['sort'], dir: SettingsDto['dir']): Promise<void> {
    this.applyQuery((query) => ({ ...query, sort, dir }))
    return this.settings.patch({ sort, dir })
  }

  /**
   * Appends the next page.
   *
   * **A request already in flight refuses a second one.** The guard is the first statement and
   * the flag is written synchronously, before the first `await`, because both callers fire
   * repeatedly by nature: a scroll listener re-arms as the user moves back and forth, and the
   * button can be pressed twice. jig's own documentation says edge-triggering removes repeated
   * fires, not a request in flight — so this is the store's to guarantee, not the directive's.
   *
   * Like `toggleTag`, this never rejects: it is bound to both a click and a scroll output.
   * `lastPageLength` is left untouched on failure so `hasMore` stays true and the control the
   * user just pressed is still there to press again.
   */
  async loadMore(): Promise<void> {
    if (this.loadingMore() || !this.hasMore()) return
    this.loadingMore.set(true)
    const offset = this.nextOffset()
    try {
      const page = await this.api.projects.list({
        ...this.queryState(),
        limit: PROJECTS_PAGE_SIZE,
        offset,
      })
      this.nextOffset.set(offset + PROJECTS_PAGE_SIZE)
      this.appended.update((rows) => [...rows, ...page])
      this.lastPageLength.set(page.length)
    } catch {
      this.notify.error(this.t.translations().projects.loadMoreFailed)
    } finally {
      this.loadingMore.set(false)
    }
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    const created = await this.api.projects.create(input)
    this.reloadFirstPage()
    return created
  }

  async rescan(): Promise<RescanResultDto> {
    const result = await this.api.projects.rescan()
    this.reloadFirstPage()
    // A rescan adopts folders that may carry tags this library has never seen, so the filter
    // bar's list is stale the moment it finishes.
    this.tags.reload()
    return result
  }

  /**
   * Reloads page zero and drops everything paged in after it.
   *
   * Keeping the appended pages would be worse than useless: they were fetched at offsets into a
   * list that has just changed length, so they would sit under a re-queried first page as rows
   * that are now in the wrong place and possibly duplicated.
   */
  private reloadFirstPage(): void {
    this.appended.set([])
    this.lastPageLength.set(null)
    this.nextOffset.set(PROJECTS_PAGE_SIZE)
    this.projects.reload()
  }

  /**
   * Persists a filter choice without letting a failure reach the list.
   *
   * `SettingsStore.patch` is optimistic and rolls its own key back before rethrowing, so by the
   * time this catches, the *setting* is already back where it was — which is correct, since it
   * is not saved. The local query is untouched by that rollback and stays where the user put it.
   */
  private async remember(partial: Partial<SettingsDto>): Promise<void> {
    try {
      await this.settings.patch(partial)
    } catch {
      this.notify.error(this.t.translations().projects.filterNotRemembered)
    }
  }
}
