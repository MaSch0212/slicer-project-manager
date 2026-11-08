import { createSignal, onCleanup, type Accessor } from 'solid-js'

/** Where a section starts, relative to the top of the visible scroll area, in pixels. */
export type SectionBox = { id: string; top: number }

/**
 * The section to mark in a section menu: the one crossing the middle of the visible area, and in
 * a gap between two, the one above. Scrolled to the end it is the last, which may be too short
 * to ever reach the middle. `null` when there are no sections.
 *
 * Pure, and exported, because jsdom has no layout engine: this is the rule, and it is tested
 * directly. The watcher below only measures.
 */
export function activeSection(
  sections: readonly SectionBox[],
  viewHeight: number,
  atEnd: boolean,
): string | null {
  if (sections.length === 0) return null
  if (atEnd) return sections.at(-1)?.id ?? null
  const middle = viewHeight / 2
  let active = sections[0]?.id ?? null
  for (const section of sections) {
    if (section.top > middle) break
    active = section.id
  }
  return active
}

export type SectionSpy = {
  /** The section the reader is in, or `null` before anything has been measured. */
  active: Accessor<string | null>
  /** `ref` for the element that scrolls. */
  attach: (element: HTMLElement) => void
  /** `ref` for a section element: `<section ref={spy.observe('slicers')}>`. */
  observe: (id: string) => (element: HTMLElement) => void
  /** Call from the scroller's `scroll`. */
  onScroll: () => void
  /** Call from the scroller's `scrollend`, where the browser has one. */
  onScrollEnd: () => void
  /** Scrolls a section to the top and marks it at once. */
  scrollTo: (id: string) => void
}

/**
 * Watches a scrolling page and says which of its sections the reader is in.
 *
 * It measures on scroll rather than through an `IntersectionObserver`: the sections live in a
 * scroller of their own now, the rule is about where a section sits in *that* box, and a
 * measurement answers that directly instead of being inferred from a band of root margins.
 *
 * **A jump is not a scroll.** Choosing a section scrolls smoothly past the ones between, and a
 * watcher left running would mark each in turn and land on the right one only at the end. So a
 * jump marks its target and silences the watcher until the scrolling stops.
 */
export function createSectionSpy(order: () => readonly string[]): SectionSpy {
  const [active, setActive] = createSignal<string | null>(null)
  const elements = new Map<string, HTMLElement>()
  let scroller: HTMLElement | undefined
  let jumping: ReturnType<typeof setTimeout> | undefined

  const endJump = () => {
    clearTimeout(jumping)
    jumping = undefined
  }
  onCleanup(endJump)

  const measure = () => {
    if (!scroller || jumping !== undefined) return
    const view = scroller.getBoundingClientRect()
    const boxes = order().flatMap((id) => {
      const element = elements.get(id)
      return element ? [{ id, top: element.getBoundingClientRect().top - view.top }] : []
    })
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
    const found = activeSection(boxes, scroller.clientHeight, atEnd)
    if (found !== null) setActive(found)
  }

  return {
    active,
    attach: (element) => {
      scroller = element
    },
    observe: (id) => (element) => {
      elements.set(id, element)
      setActive((previous) => previous ?? id)
    },
    onScroll: measure,
    onScrollEnd: endJump,
    scrollTo: (id) => {
      const element = elements.get(id)
      if (!element) return
      setActive(id)
      clearTimeout(jumping)
      // `scrollend` ends it where the browser has one; the timer covers the rest, and a jump
      // that does not scroll at all because the section is already in view.
      jumping = setTimeout(endJump, 1000)
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      // Optional call: jsdom has no `scrollIntoView`, and a test that only checks what gets
      // marked should not need a stub for it.
      element.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    },
  }
}
