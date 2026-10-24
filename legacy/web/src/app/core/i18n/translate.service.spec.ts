import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import { loadDeOrFallbackToEn } from './translate.service'

// Ruling 74: a chunk-load failure for the `de` locale (offline, a stale deploy, a 404) must
// not leave `translations` unset forever — app.config.ts awaits `TranslateService.ready`
// before bootstrap finishes, so an unresolved promise there would hang the whole app on a
// blank screen. `loadDeOrFallbackToEn` takes the dynamic import as a parameter rather than
// performing `import('./locales/de.json')` directly, because Angular's vitest integration
// refuses `vi.mock` on relative specifiers, so a rejecting stub is the only way to exercise
// the failure path.
describe('loadDeOrFallbackToEn', () => {
  it('returns the German translations when the chunk loads', async () => {
    const de = { app: { title: 'German' } }
    const result = await loadDeOrFallbackToEn(() => Promise.resolve({ default: de as never }))
    expect(result).toBe(de)
  })

  it('falls back to English rather than hanging when the chunk fails to load', async () => {
    const result = await loadDeOrFallbackToEn(() => Promise.reject(new Error('chunk 404')))
    expect(result).toBe(en)
  })
})
