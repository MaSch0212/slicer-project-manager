import type { BrowseBounds } from '../api/generated'

/**
 * Tells `report` where an element is, in CSS pixels of the window, every time that can change:
 * on the first frame, when the element or the page around it resizes (a sidebar collapsing, a
 * banner appearing above it), when the window resizes, and when anything scrolls (a scroll
 * container above the element moves it without resizing it).
 *
 * Reports are coalesced to one per frame, and `report` is told only when the rectangle differs from
 * the last one it was given. The shell is the one that decides what to do with it: it intersects
 * the rectangle with an area it computes itself, so a wrong report can place the view badly but
 * can never place it over the app's own chrome.
 *
 * Returns the function that stops everything it started.
 */
export function observeBounds(
  element: HTMLElement,
  report: (bounds: BrowseBounds) => void,
): () => void {
  let last: BrowseBounds | null = null
  let frame: number | null = null
  let stopped = false

  const measure = () => {
    frame = null
    if (stopped) return
    const rect = element.getBoundingClientRect()
    const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    if (
      last &&
      last.x === next.x &&
      last.y === next.y &&
      last.width === next.width &&
      last.height === next.height
    ) {
      return
    }
    last = next
    report(next)
  }
  const schedule = () => {
    if (stopped || frame !== null) return
    frame = requestAnimationFrame(measure)
  }

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())
  observer?.observe(element)
  observer?.observe(document.documentElement)
  window.addEventListener('resize', schedule)
  // Capture: a scroll event does not bubble, and the container that moved is not this element.
  window.addEventListener('scroll', schedule, { capture: true, passive: true })
  document.addEventListener('transitionend', schedule, true)
  schedule()

  return () => {
    stopped = true
    if (frame !== null) cancelAnimationFrame(frame)
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, { capture: true })
    document.removeEventListener('transitionend', schedule, true)
  }
}
