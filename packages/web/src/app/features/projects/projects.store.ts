import { Injectable, computed, inject, resource, signal } from '@angular/core'
import type { ProjectDto, ProjectQuery, RescanResultDto, SettingsDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { SettingsStore } from '../../core/settings.store'

@Injectable()
export class ProjectsStore {
  private readonly api = inject(API_CLIENT)
  private readonly settings = inject(SettingsStore)
  /**
   * Seeded from the persisted settings rather than hard-coded. `SettingsDto.sort`/`.dir` are
   * stored by the server, validated by the schema and defaulted in `DEFAULT_SETTINGS`
   * (spec 3.3 lists `sort` among the `user_settings` keys), but nothing used to read or
   * write them from the UI, so the project list's sort silently reset on every visit.
   * app.config.ts's initializer awaits `SettingsStore.load()` before any route renders, so
   * this signal's initial value is the user's own choice, not the defaults.
   */
  private readonly queryState = signal<ProjectQuery>({
    sort: this.settings.settings().sort,
    dir: this.settings.settings().dir,
  })

  readonly query = this.queryState.asReadonly()

  /** resource() takes any promise, so the transport abstraction survives (spec 6.1). */
  readonly projects = resource<ProjectDto[], ProjectQuery>({
    params: () => this.queryState(),
    loader: ({ params }) => this.api.projects.list(params),
    defaultValue: [],
  })

  /**
   * `Resource.value()` only substitutes `defaultValue` before any load has ever completed
   * (or while a same-params reload is in flight). Once a load settles to the public 'error'
   * status, `value()` throws a `ResourceValueError` instead — `defaultValue` does not shield
   * reads after that point. `status()` is the public, typed way to check for that state
   * (`Resource<T>` exposes `status`/`error`/`isLoading`, but no `isError`).
   */
  readonly loadFailed = computed(() => this.projects.status() === 'error')

  /**
   * Ruling 59: the tag filter bar must always offer a way to un-toggle an active filter. With
   * AND filtering, two tags that no single loaded project shares in common yield an empty
   * result set — and knownTags used to be derived only from the loaded projects, so it would
   * go empty right along with the list, hiding every filter button (including the ones that
   * caused the empty result) with no way back except reloading the page. Folding the tags
   * currently in `query()` into the union guarantees a selected tag always has a button.
   *
   * Fix round 1: guard on `loadFailed` before ever touching `this.projects.value()` — reading
   * it after a failed load throws (see `loadFailed` above), and this computed is read by the
   * filter bar independently of the grid, so it must survive a failed load on its own.
   */
  readonly knownTags = computed(() => {
    const selected = this.query().tags ?? []
    if (this.loadFailed()) {
      return [...new Set(selected)].sort((a, b) => a.localeCompare(b))
    }
    const loaded = this.projects.value().flatMap((project) => project.tags)
    return [...new Set([...loaded, ...selected])].sort((a, b) => a.localeCompare(b))
  })

  setSearch(term: string): void {
    const trimmed = term.trim()
    this.queryState.update(({ search: _dropped, ...rest }) =>
      trimmed ? { ...rest, search: trimmed } : rest,
    )
  }

  toggleTag(name: string): void {
    // Destructuring `tags` out of the parameter (rather than a local `const { tags: _dropped,
    // ...rest } = query`) keeps every binding used, since eslint's `no-unused-vars` only
    // exempts `_`-prefixed *function arguments*, not local destructured variables.
    this.queryState.update(({ tags, ...rest }) => {
      const current = tags ?? []
      const next = current.includes(name)
        ? current.filter((tag) => tag !== name)
        : [...current, name]
      return next.length > 0 ? { ...rest, tags: next } : rest
    })
  }

  setIncludeArchived(flag: boolean): void {
    this.queryState.update(({ includeArchived: _dropped, ...rest }) =>
      flag ? { ...rest, includeArchived: true } : rest,
    )
  }

  /**
   * Applies the sort locally first, then persists it, so the list re-sorts even if the
   * preference cannot be saved. `SettingsStore.patch` rethrows after rolling its own keys
   * back; the rejection is deliberately propagated for the page to surface.
   */
  setSort(sort: SettingsDto['sort'], dir: SettingsDto['dir']): Promise<void> {
    this.queryState.update((query) => ({ ...query, sort, dir }))
    return this.settings.patch({ sort, dir })
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    const created = await this.api.projects.create(input)
    this.projects.reload()
    return created
  }

  async rescan(): Promise<RescanResultDto> {
    const result = await this.api.projects.rescan()
    this.projects.reload()
    return result
  }
}
