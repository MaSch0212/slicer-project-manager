import { createSignal } from 'solid-js'

/**
 * Grid or list for a project's files, on this device.
 *
 * Its own choice, not the project list's: the two used to share the account's `viewMode`, so
 * switching the files in the panel also re-laid the list behind it — and, now that the layout is
 * part of a saved view, marked the view as changed. Local because it is a matter of taste on the
 * screen in front of you, like the panel's width.
 */
const STORAGE_KEY = 'spm.filesViewMode'

export type FilesViewMode = 'grid' | 'list'

function read(): FilesViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

const [mode, setMode] = createSignal<FilesViewMode>(read())

export const filesViewMode = mode

export function setFilesViewMode(next: FilesViewMode): void {
  setMode(next)
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Blocked storage: the choice lasts until the app closes.
  }
}
