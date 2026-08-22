import { describe, expect, it } from 'vitest'
import { interpolate } from '@ngneers/signal-translate'
import en from './locales/en.json'
import de from './locales/de.json'

/**
 * Ruling 57: the installed `interpolate()` matches placeholders with
 * `/{{\s*([\w.]+)\s*}}/g` — double-braced. Our locale strings used to be single-braced
 * (`{adopted}`), which this regex never matches, so the parameterised keys rendered
 * literally — braces and all — with no compile-time or runtime signal that anything was
 * wrong. This asserts real substitution so that class of bug cannot silently return.
 */
describe('locale interpolation', () => {
  it('substitutes the English rescan placeholders instead of rendering them literally', () => {
    const result = interpolate(en.projects.rescanned, { adopted: 3, filesAdded: 12 })
    expect(result).toContain('3')
    expect(result).toContain('12')
    expect(result).not.toMatch(/[{}]/)
  })

  it('substitutes the German rescan placeholders instead of rendering them literally', () => {
    const result = interpolate(de.projects.rescanned, { adopted: 3, filesAdded: 12 })
    expect(result).toContain('3')
    expect(result).toContain('12')
    expect(result).not.toMatch(/[{}]/)
  })

  it('substitutes the quota-exceeded placeholders in both locales', () => {
    for (const translations of [en, de]) {
      const result = interpolate(translations.errors.quotaExceeded, {
        usage: '1.2 GB',
        quota: '5 GB',
      })
      expect(result).toContain('1.2 GB')
      expect(result).toContain('5 GB')
      expect(result).not.toMatch(/[{}]/)
    }
  })
})
