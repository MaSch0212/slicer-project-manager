import { describe, expect, it } from 'vitest'
import { SLICER_PRODUCTS, slicerDisplayName } from './slicer-names'

describe('slicer names', () => {
  it('lists the five products in the order the shell lists them', () => {
    expect(SLICER_PRODUCTS.map((product) => product.id)).toEqual([
      'cura',
      'prusaslicer',
      'anycubic',
      'bambu',
      'orca',
    ])
  })

  it('names each product the way every surface says it', () => {
    expect(SLICER_PRODUCTS.map((product) => slicerDisplayName(product.id))).toEqual([
      'UltiMaker Cura',
      'PrusaSlicer',
      'Anycubic Slicer Next',
      'Bambu Studio',
      'OrcaSlicer',
    ])
  })

  it('falls back to the id for anything that is not one of the five', () => {
    expect(slicerDisplayName('superslicer' as never)).toBe('superslicer')
  })
})
