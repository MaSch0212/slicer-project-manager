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
 * `TranslateService` types its translations off `en.json` alone, so a key added to English and
 * forgotten in German still compiles: at runtime `translations()` returns the German object and
 * the binding reads `undefined`, which Angular renders as an empty string. A whole sentence
 * silently disappears for German users and nothing in the build says so.
 *
 * The reverse — a key only German has — is the shape a *half-swept* rewrite leaves behind when
 * an English key is renamed and its German twin is not, so both directions are asserted rather
 * than only "German has everything English does".
 */
describe('locale files', () => {
  it('have identical key sets', () => {
    expect(keyPaths(de)).toEqual(keyPaths(en))
  })
})
