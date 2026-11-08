import { describe, expect, it } from 'vitest'
import { pickActive } from './section-spy'

/**
 * The rule the settings menu follows. It is tested apart from the observer because jsdom has no
 * layout engine: what crosses the band is the browser's answer, and this is what we do with it.
 */
describe('pickActive', () => {
  const order = ['appearance', 'library', 'account', 'slicers', 'import']

  it('takes the first in document order, not the first the observer reported', () => {
    // A short section scrolling past a tall one must not steal the mark from it.
    expect(pickActive(order, new Set(['slicers', 'account']), null)).toBe('account')
  })

  it('keeps the last answer while nothing is crossing the band', () => {
    // A section taller than the band, or a scroll between two: blanking here makes the menu
    // flicker on every long section.
    expect(pickActive(order, new Set(), 'slicers')).toBe('slicers')
  })

  it('falls back to the first section when there is no last answer', () => {
    expect(pickActive(order, new Set(), null)).toBe('appearance')
  })

  it('drops a remembered section that is no longer on the page', () => {
    // Slicers disappears when the shell cannot configure them; a menu still pointing at it would
    // mark an entry that is not there.
    expect(pickActive(['appearance', 'import'], new Set(), 'slicers')).toBe('appearance')
  })

  it('answers null for a page with no sections at all', () => {
    expect(pickActive([], new Set(), null)).toBeNull()
    expect(pickActive([], new Set(), 'slicers')).toBeNull()
  })
})
