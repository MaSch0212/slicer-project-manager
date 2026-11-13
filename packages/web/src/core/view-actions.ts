import { createSignal } from 'solid-js'
import type { ProjectViewDto } from '../api/generated'
import { errorMessage } from './i18n/errors'
import { notify } from './notify'
import { settings } from './stores'
import { pickedViewId, pickView } from './view-selection'
import { ALL_PROJECTS, currentView, reshapeView, shapeOf, type CurrentView } from './views'

/**
 * What the sidebar, the app menu and the projects toolbar all do with saved views, in one place,
 * so the three cannot disagree about what "pick", "reset" or "save" means.
 */

/** The dialog that keeps what the list shows as a new view. One dialog, opened from anywhere. */
export const [saveViewOpen, setSaveViewOpen] = createSignal(false)

/** The editor: null while shut, else which view's name to select on opening. */
export const [editingViews, setEditingViews] = createSignal<{ focus: string | null } | null>(null)

export const savedViews = (): ProjectViewDto[] => settings.settings().views

/** The view the list is in, and whether its filters have been changed since. */
export function current(): CurrentView | null {
  return currentView(savedViews(), shapeOf(settings.settings()), pickedViewId())
}

/**
 * Writes the whole list of views. Every change — a new one, a rename, a reorder, a deletion — is
 * "here is the list now": one rule, one call, and no way for two of them to disagree about what
 * the list holds.
 */
export async function saveViews(next: readonly ProjectViewDto[]): Promise<boolean> {
  try {
    await settings.patch({ views: [...next] })
    return true
  } catch (error) {
    notify.error(errorMessage(error))
    return false
  }
}

/** Puts a view's own sort, layout, archive switch and tags on the list. */
function applyShapeOf(view: ProjectViewDto): void {
  void settings
    .patch({
      viewMode: view.viewMode,
      sort: view.sort,
      dir: view.dir,
      includeArchived: view.includeArchived,
      filterTags: [...view.tags],
    })
    .catch((error: unknown) => notify.error(errorMessage(error)))
}

/**
 * Opens a view. Picking the one the list is already in changes nothing — a change made to it
 * stays, as a draft, until it is kept or reset from the toolbar — which is how the app this
 * follows treats it. Any other view is put on the list exactly as it was saved.
 */
export function openView(view: ProjectViewDto): void {
  if (pickedViewId() === view.id) return
  pickView(view.id)
  applyShapeOf(view)
}

/**
 * Whether the list holds filters "All projects" does not have: a tag, or the archived ones. Sort
 * and layout are how the list is drawn, not what is in it, so they do not count.
 */
export function allProjectsFiltered(): boolean {
  const now = settings.settings()
  return now.filterTags.length > 0 || now.includeArchived
}

/**
 * Opens "All projects": every project, the archived ones aside, in the sort and layout the list
 * already has. Like a saved view, picking it while the list is already in it keeps what was
 * changed since; the filter pills clear that.
 */
export function openAllProjects(): void {
  if (pickedViewId() === ALL_PROJECTS && current() === null) return
  pickView(ALL_PROJECTS)
  if (!allProjectsFiltered()) return
  void settings
    .patch({ filterTags: [], includeArchived: false })
    .catch((error: unknown) => notify.error(errorMessage(error)))
}

/** Throws away the change to the current view and puts it back as it was saved. */
export function resetCurrentView(): void {
  const now = current()
  if (now) applyShapeOf(now.view)
}

/** Keeps the change: the current view becomes what the list is showing. */
export function updateCurrentView(): Promise<boolean> {
  const now = current()
  if (!now) return Promise.resolve(false)
  return saveViews(reshapeView(savedViews(), now.view.id, shapeOf(settings.settings())))
}

/** A deleted view cannot stay the picked one: the list is back in "All projects". */
export function forgetPicked(id: string): void {
  if (pickedViewId() === id) pickView(ALL_PROJECTS)
}
