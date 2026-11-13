import type { ProjectViewDto, SettingsDto } from '../api/generated'

/**
 * Saved views of the project list.
 *
 * A view is a name over four things: the sort order, the layout, whether archived projects are
 * shown, and which tags the list is narrowed to. **Not the search box** — a keyword is something
 * you type to find one thing, and a view you cannot leave without clearing a search is a trap.
 *
 * They live on the account, beside the other settings, so they follow the user to whichever
 * machine opens the library and work the same against a folder or a server. The whole list is
 * one value: renaming, reordering and deleting are all "here is the list now", which is one rule
 * instead of four.
 */

/** What a view decides. The rest of the query — the search — is never part of one. */
export type ViewShape = Pick<
  ProjectViewDto,
  'viewMode' | 'sort' | 'dir' | 'includeArchived' | 'tags'
>

/** The icons a view may carry, by the name stored for it. The web app owns this list. */
export const VIEW_ICONS = ['layers', 'archive', 'tag', 'printer', 'box', 'clock', 'search'] as const

export type ViewIcon = (typeof VIEW_ICONS)[number]

export const DEFAULT_VIEW_ICON: ViewIcon = 'layers'

/** Whether a stored icon name is one this build draws. An older or newer name simply is not. */
export function isViewIcon(name: string): name is ViewIcon {
  return (VIEW_ICONS as readonly string[]).includes(name)
}

/** What the settings record calls the four things a view decides. */
type ShapeSettings = Pick<
  SettingsDto,
  'viewMode' | 'sort' | 'dir' | 'includeArchived' | 'filterTags'
>

/** The settings that make up a view, taken from the whole settings record. */
export function shapeOf(settings: ShapeSettings): ViewShape {
  return {
    viewMode: settings.viewMode,
    sort: settings.sort,
    dir: settings.dir,
    includeArchived: settings.includeArchived,
    tags: [...settings.filterTags].sort(),
  }
}

/** Two tag selections are the same selection whatever order they are in. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((tag, index) => tag === right[index])
}

/** Whether the list is showing exactly what this view asks for. */
export function matchesView(shape: ViewShape, view: ProjectViewDto): boolean {
  return (
    shape.viewMode === view.viewMode &&
    shape.sort === view.sort &&
    shape.dir === view.dir &&
    shape.includeArchived === view.includeArchived &&
    sameTags(shape.tags, view.tags)
  )
}

/**
 * The view the list is currently showing, or `null` for a list that matches none of them.
 *
 * Derived rather than remembered: a stored "current view" and a query the user has since changed
 * are two answers to the same question, and the stale one always wins somewhere.
 */
export function activeView(
  views: readonly ProjectViewDto[],
  shape: ViewShape,
): ProjectViewDto | null {
  return views.find((view) => matchesView(shape, view)) ?? null
}

/** A new view over what the list is showing now. `id` comes from the caller so it can be seeded. */
export function viewFrom(id: string, name: string, icon: string, shape: ViewShape): ProjectViewDto {
  return {
    id,
    name: name.trim(),
    icon: isViewIcon(icon) ? icon : DEFAULT_VIEW_ICON,
    viewMode: shape.viewMode,
    sort: shape.sort,
    dir: shape.dir,
    includeArchived: shape.includeArchived,
    tags: [...shape.tags],
  }
}

/** An id for a new view: unique among the ones there are, and short enough to store. */
export function newViewId(existing: readonly ProjectViewDto[]): string {
  const taken = new Set(existing.map((view) => view.id))
  for (let n = 1; ; n++) {
    const id = `view-${n}`
    if (!taken.has(id)) return id
  }
}

/** The list with one view moved one place up or down. Out of range, it is unchanged. */
export function moveView(
  views: readonly ProjectViewDto[],
  id: string,
  direction: 'up' | 'down',
): ProjectViewDto[] {
  const from = views.findIndex((view) => view.id === id)
  if (from < 0) return [...views]
  const to = direction === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= views.length) return [...views]
  const next = [...views]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** The list with one view renamed, or re-iconed. Unknown ids change nothing. */
export function editView(
  views: readonly ProjectViewDto[],
  id: string,
  patch: Partial<Pick<ProjectViewDto, 'name' | 'icon'>>,
): ProjectViewDto[] {
  return views.map((view) =>
    view.id === id
      ? { ...view, ...patch, ...(patch.name === undefined ? {} : { name: patch.name.trim() }) }
      : view,
  )
}

/** The list without one view. */
export function removeView(views: readonly ProjectViewDto[], id: string): ProjectViewDto[] {
  return views.filter((view) => view.id !== id)
}

/** The list with one view's shape replaced by what the project list is showing now. */
export function reshapeView(
  views: readonly ProjectViewDto[],
  id: string,
  shape: ViewShape,
): ProjectViewDto[] {
  return views.map((view) => (view.id === id ? { ...view, ...shape, tags: [...shape.tags] } : view))
}

/** The list with a copy of one view right after it. The caller supplies the copy's name. */
export function duplicateView(
  views: readonly ProjectViewDto[],
  id: string,
  name: string,
): ProjectViewDto[] {
  const index = views.findIndex((view) => view.id === id)
  if (index < 0) return [...views]
  const copy: ProjectViewDto = { ...views[index]!, id: newViewId(views), name: name.trim() }
  const next = [...views]
  next.splice(index + 1, 0, copy)
  return next
}
