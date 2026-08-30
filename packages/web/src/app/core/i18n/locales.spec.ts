import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import de from './locales/de.json'

/**
 * Every key in one locale file, as a flat, sorted list of dotted paths.
 *
 * Flattened rather than compared object-by-object so a failure names the key that is missing
 * instead of dumping two nested objects and leaving the reader to diff them. Sorted so the two
 * lists compare as sets: key *order* is a formatting question Prettier does not police, and a key
 * that moved is not a key that is gone.
 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

/**
 * Spec G 8, and constraint C4 made checkable.
 *
 * The assertion is symmetric, but only one of the two directions can ever reach it, and knowing
 * which is the point of this note. **Both were measured.**
 *
 * **A key English has and German lacks never gets here: the build fails first.**
 * `translate.service.ts` declares `importDe: () => Promise<{ default: Translations }>` with
 * `Translations = typeof en`, so the German file is type-checked *against* the English one.
 * Deleting `nav.open` from `de.json` ends the Angular build with
 * `TS2322 … Property '"open"' is missing`, and `test:web` never runs. The compiler already closes
 * this direction, and nothing here improves on it.
 *
 * **A key only German has does compile, and is the direction this test exists for.** Nothing
 * types `de.json` as *exactly* `Translations` — extra properties are assignable — so a key left
 * behind by a rename that swept `en.json` and not `de.json` builds, ships, and is dead weight no
 * binding will ever read. Adding `nav.openStale` to `de.json` is what turns this red. That is the
 * half-swept pair spec G 8 says this project has found repeatedly, and it is the only failure
 * this file can ever report.
 */
describe('locale files', () => {
  it('have identical key sets', () => {
    expect(keyPaths(de)).toEqual(keyPaths(en))
  })
})
