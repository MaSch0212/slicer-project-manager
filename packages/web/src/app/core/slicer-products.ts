import type { SlicerId } from '@spm/contract/dtos.ts'

/**
 * Every product the app knows about, in the order `packages/desktop/src/slicers/registry.ts`
 * lists them, with the name to show for it.
 *
 * **Duplicated from that registry in one direction only, and deliberately.** The renderer must not
 * import from `packages/desktop` (spec 2.5), and these are brand names rather than translated
 * copy, so they are not in the locale files either. What can genuinely drift is the *list*, and
 * the assertion below is what stops it — a sixth `SlicerId` fails to compile here until it has a
 * row.
 *
 * **Duplicated once, and that part is new.** It existed twice inside `packages/web` — task 3 added
 * a copy to `/settings/slicers` and task 4 another to the project page, each with its own
 * `AssertNever` guard and near-identical docblock. The duplication *from* the desktop registry is
 * argued; a second copy of it inside one package was argued nowhere, and a third surface — the
 * session card — had skipped the table altogether and was rendering raw ids, so a user read
 * "OrcaSlicer" on two pages and "orca" on the third.
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
