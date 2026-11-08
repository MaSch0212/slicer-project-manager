import { createSignal, onCleanup, type Accessor } from 'solid-js'

/**
 * Which section the reader is in, given the ones currently crossing the band at the top of the
 * viewport. The first in document order wins, so a short section scrolling past a tall one does
 * not steal the mark from it.
 *
 * Pure, and exported, because jsdom has no layout engine: this is the rule, and it is tested
 * directly. The observer below only decides what goes in the set.
 */
export function pickActive(
  order: readonly string[],
  intersecting: ReadonlySet<string>,
  previous: string | null,
): string | null {
  for (const id of order) if (intersecting.has(id)) return id
  // Nothing is crossing the band: a section taller than the band, or a scroll between two. The
  // last answer still describes where the reader is; blanking the menu here would make it flicker.
  if (previous !== null && order.includes(previous)) return previous
  return order[0] ?? null
}

/**
 * The band: everything from just under the sticky chrome to a third of the way down. A section
 * counts as "the one you are reading" while its box crosses that strip.
 */
const ROOT_MARGIN = '-76px 0px -66% 0px'

export type SectionSpy = {
  /** The section the reader is in, or `null` before anything has been measured. */
  active: Accessor<string | null>
  /** `ref` for a section element: `<section ref={spy.observe('slicers')}>`. */
  observe: (id: string) => (element: HTMLElement) => void
  /** Scrolls a section to the top of the content area and marks it at once. */
  scrollTo: (id: string) => void
}

/**
 * Watches a long page and says which of its sections is on screen.
 *
 * `order` is the ids in the order they are rendered; it is a function because sections appear and
 * disappear with capabilities. Where there is no `IntersectionObserver` (jsdom, and any
 * environment old enough to lack it) nothing is observed and `active` stays on the first section:
 * the menu still works, it just stops following the scroll.
 */
export function createSectionSpy(order: () => readonly string[]): SectionSpy {
  const [active, setActive] = createSignal<string | null>(null)
  const elements = new Map<string, HTMLElement>()
  const live = new Set<string>()
  let observer: IntersectionObserver | null = null

  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-section')
          if (id === null) continue
          if (entry.isIntersecting) live.add(id)
          else live.delete(id)
        }
        setActive((previous) => pickActive(order(), live, previous))
      },
      { rootMargin: ROOT_MARGIN },
    )
    onCleanup(() => observer?.disconnect())
  }

  const observe = (id: string) => (element: HTMLElement) => {
    element.setAttribute('data-section', id)
    elements.set(id, element)
    observer?.observe(element)
    setActive((previous) => previous ?? id)
  }

  const scrollTo = (id: string) => {
    const element = elements.get(id)
    if (!element) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    // Optional call: jsdom has no `scrollIntoView`, and a test that only checks what gets marked
    // should not need a stub for it.
    element.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    // Marked now rather than when the scroll lands: a smooth scroll takes long enough that a menu
    // which only caught up at the end would feel broken.
    setActive(id)
  }

  return { active, observe, scrollTo }
}
