import { onCleanup } from 'solid-js'

/**
 * The event the desktop shell dispatches into the page when files changed under the library and
 * have been indexed: a project folder made in Explorer, a file a slicer saved, a change the sync
 * brought down from the server. The page refreshes what it lists; it is never rebuilt for it, so a
 * dialog the user has open survives.
 */
export const LIBRARY_CHANGED_EVENT = 'spm:library-changed'

/**
 * Calls `refresh` whenever the library changed, for as long as the calling component lives. A
 * burst of events (a sync pulling down twenty files) is one refresh per animation frame at most.
 */
export function onLibraryChanged(refresh: () => void): void {
  let queued = false
  const listener = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      refresh()
    })
  }
  window.addEventListener(LIBRARY_CHANGED_EVENT, listener)
  onCleanup(() => window.removeEventListener(LIBRARY_CHANGED_EVENT, listener))
}
