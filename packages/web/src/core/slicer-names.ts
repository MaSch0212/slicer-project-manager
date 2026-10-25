import type { SlicerId } from '../api/generated'

/**
 * The name to show for each slicer product. Brand names, not translated copy, so they live here
 * and not in the locale files. The `Record` type makes a sixth `SlicerId` a compile error until it
 * has a name.
 */
const NAMES: Record<SlicerId, string> = {
  cura: 'UltiMaker Cura',
  prusaslicer: 'PrusaSlicer',
  anycubic: 'Anycubic Slicer Next',
  bambu: 'Bambu Studio',
  orca: 'OrcaSlicer',
}

/** The product's name, or the id itself for anything that is somehow not one of the five. */
export function slicerDisplayName(id: SlicerId): string {
  return NAMES[id] ?? id
}
