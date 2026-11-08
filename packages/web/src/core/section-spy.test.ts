import { describe, expect, it } from 'vitest'
import { activeSection, type SectionBox } from './section-spy'

/**
 * The rule the settings menu follows. It is tested apart from the measuring because jsdom has no
 * layout engine: where each section sits is the browser's answer, and this is what we do with it.
 */
describe('activeSection', () => {
  const at = (...tops: number[]): SectionBox[] =>
    tops.map((top, index) => ({ id: `s${index}`, top }))

  it('takes the section crossing the middle of the view', () => {
    // The view is 600 tall, so the middle is 300: s1 starts above it and s2 below.
    expect(activeSection(at(-200, 100, 500), 600, false)).toBe('s1')
  })

  it('takes the one above when the middle falls in the gap between two', () => {
    expect(activeSection(at(-400, -50, 420), 600, false)).toBe('s1')
  })

  it('takes the first while the page is still at the top', () => {
    expect(activeSection(at(0, 700, 1400), 600, false)).toBe('s0')
  })

  it('takes the last at the end of the scroll, however short it is', () => {
    // A last section too short to ever reach the middle would otherwise be unreachable in the
    // menu: scrolled to the floor, it is what the reader is looking at.
    expect(activeSection(at(-900, -400, 560), 600, true)).toBe('s2')
  })

  it('answers null for a page with no sections', () => {
    expect(activeSection([], 600, false)).toBeNull()
    expect(activeSection([], 600, true)).toBeNull()
  })
})
