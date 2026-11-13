import { createSignal } from 'solid-js'

/**
 * Which saved view the user last picked, on this device.
 *
 * Kept here rather than on the account: it is "where was I", not a preference, and two machines
 * open on the same library should not pull each other's sidebar about. Local storage only so a
 * restart lands in the same view; when it is empty or unreadable the list simply falls back to
 * the first view its filters match (see `currentView`).
 */
const STORAGE_KEY = 'spm.selectedView'

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const [picked, setPicked] = createSignal<string | null>(read())

export const pickedViewId = picked

export function pickView(id: string | null): void {
  setPicked(id)
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // A private window or blocked storage: the choice lasts until the app closes, which is fine.
  }
}
