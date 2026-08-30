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
/** The words of a string, lower-cased and stripped of punctuation, as a set. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ''),
  )
}

describe('locale files', () => {
  it('have identical key sets', () => {
    expect(keyPaths(de)).toEqual(keyPaths(en))
  })

  /**
   * Two error strings tell the user to press the rescan button. They have to name it the way the
   * button names itself, in both languages.
   *
   * They agreed once and stopped agreeing: a copy sweep rewrote `errorConflict` and
   * `errorNotFound` from "look for installed slicers again" to "**search** for installed slicers
   * again" and left `slicers.rescan` reading "**Look** for installed slicers", so the English
   * copy sent the user to a control the screen did not have. Nothing caught it, because each
   * string on its own was fine — only the pair was wrong, and no test looked at a pair.
   *
   * A word *set* rather than a substring, because German puts the verb last: "Nach installierten
   * Slicern suchen" is the button and "Suchen Sie erneut nach installierten Slicern" is the
   * error, and those share every word without sharing a substring. Vocabulary is what the user
   * matches on; word order is not something this can police across two languages.
   */
  it('name the rescan button with the words the errors that point at it use', () => {
    for (const [language, locale] of [
      ['en', en],
      ['de', de],
    ] as const) {
      const button = words(locale.slicers.rescan)
      for (const error of [locale.slicers.errorConflict, locale.slicers.errorNotFound]) {
        const missing = [...button].filter((word) => !words(error).has(word))
        expect(missing, `${language}: ${error}`).toEqual([])
      }
    }
  })
})
