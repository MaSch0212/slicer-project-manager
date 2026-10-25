import type { SlicerId } from '../api/generated'

/**
 * Every product the app knows about, in the order the shell lists them, with the name to show for
 * it. Brand names, not translated copy, so they live here and not in the locale files.
 *
 * **Duplicated from the shell's registry in one direction only, and deliberately**: the page must
 * not depend on the desktop crate, and what can genuinely drift is the *list*; the assertion
 * below is what stops it. A sixth `SlicerId` fails to compile here until it has a row.
 */
export const SLICER_PRODUCTS = [
  { id: 'cura', name: 'UltiMaker Cura' },
  { id: 'prusaslicer', name: 'PrusaSlicer' },
  { id: 'anycubic', name: 'Anycubic Slicer Next' },
  { id: 'bambu', name: 'Bambu Studio' },
  { id: 'orca', name: 'OrcaSlicer' },
] as const satisfies readonly { id: SlicerId; name: string }[]

type AssertNever<T extends never> = T
/** The `satisfies` above catches a row the union does not have; this catches the other direction. */
export type SlicerProductsAreComplete = AssertNever<
  Exclude<SlicerId, (typeof SLICER_PRODUCTS)[number]['id']>
>

/** The product's name, or the id itself for anything that is somehow not one of the five. */
export function slicerDisplayName(id: SlicerId): string {
  return SLICER_PRODUCTS.find((product) => product.id === id)?.name ?? id
}
