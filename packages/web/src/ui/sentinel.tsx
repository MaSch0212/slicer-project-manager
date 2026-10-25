import { createEffect, on, onCleanup, onMount } from 'solid-js'

/**
 * An invisible marker at the end of a list that says "the reader is about to run out". It reports
 * through an `IntersectionObserver`, which works whichever element scrolls (the window, or a
 * container an ancestor made scrollable) and needs no scroll listener or container lookup.
 *
 * `rearmKey` is whatever changes when the list grows. An observer only fires when visibility
 * *changes*, so a short page that leaves the marker on screen would never fire again: changing the
 * key re-observes it, which reports the current state afresh. `rootMargin` starts the load before
 * the reader reaches the floor.
 *
 * It is a convenience, never the only way on: a list that grows only on a scroll cannot be reached
 * by a keyboard, so the page keeps a "Load more" button beside it.
 */
export function ScrollSentinel(props: {
  onReach: () => void
  disabled?: boolean
  rearmKey?: unknown
  rootMargin?: string
}) {
  let element: HTMLDivElement | undefined
  let observer: IntersectionObserver | undefined

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined' || !element) return
    observer = new IntersectionObserver(
      (entries) => {
        if (!props.disabled && entries.some((entry) => entry.isIntersecting)) props.onReach()
      },
      { rootMargin: props.rootMargin ?? '0px 0px 400px 0px' },
    )
    observer.observe(element)
  })
  // Not on the first run: mounting has just observed it.
  createEffect(
    on(
      [() => props.rearmKey, () => props.disabled],
      () => {
        if (!observer || !element) return
        observer.unobserve(element)
        observer.observe(element)
      },
      { defer: true },
    ),
  )
  onCleanup(() => observer?.disconnect())

  return <div ref={(el) => (element = el)} aria-hidden="true" class="h-px w-full" />
}
