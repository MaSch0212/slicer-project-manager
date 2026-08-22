import { Injectable, computed, inject, resource, signal } from '@angular/core'
import type { ProjectDto, ProjectQuery, RescanResultDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'

@Injectable()
export class ProjectsStore {
  private readonly api = inject(API_CLIENT)
  private readonly queryState = signal<ProjectQuery>({ sort: 'updatedAt', dir: 'desc' })

  readonly query = this.queryState.asReadonly()

  /** resource() takes any promise, so the transport abstraction survives (spec 6.1). */
  readonly projects = resource<ProjectDto[], ProjectQuery>({
    params: () => this.queryState(),
    loader: ({ params }) => this.api.projects.list(params),
    defaultValue: [],
  })

  /**
   * Ruling 59: the tag filter bar must always offer a way to un-toggle an active filter. With
   * AND filtering, two tags that no single loaded project shares in common yield an empty
   * result set — and knownTags used to be derived only from the loaded projects, so it would
   * go empty right along with the list, hiding every filter button (including the ones that
   * caused the empty result) with no way back except reloading the page. Folding the tags
   * currently in `query()` into the union guarantees a selected tag always has a button.
   */
  readonly knownTags = computed(() => {
    const loaded = this.projects.value().flatMap((project) => project.tags)
    const selected = this.query().tags ?? []
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

  setSort(sort: ProjectQuery['sort'], dir: ProjectQuery['dir']): void {
    this.queryState.update((query) => ({ ...query, sort, dir }))
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
