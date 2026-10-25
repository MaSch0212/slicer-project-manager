import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/error'
import de from './de.json'
import en from './en.json'
import { errorMessage } from './errors'
import { interpolate, language, loadTranslations, lookup, setLanguage, t } from './index'

function keyPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix]
  return Object.entries(node).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

afterEach(() => setLanguage('en'))

describe('locale files', () => {
  // Ported: have identical key sets.
  it('have identical key sets', () => {
    expect(keyPaths(de).sort()).toEqual(keyPaths(en).sort())
  })

  // Ported from the interpolation spec: every parameterised string substitutes, in both locales.
  it('substitute every placeholder in both locales, leaving no braces and no "undefined"', () => {
    for (const locale of [en, de]) {
      for (const path of keyPaths(locale)) {
        const text = lookup(locale, path)!
        if (!text.includes('{{')) continue
        const names = [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]!)
        const filled = interpolate(text, Object.fromEntries(names.map((name) => [name, '42'])))
        expect(filled, path).not.toMatch(/[{}]/)
        expect(filled, path).not.toMatch(/\bundefined\b/)
      }
    }
    expect(interpolate(en.projects.rescanned, { adopted: 3, filesAdded: 12 })).toBe(
      'Adopted 3, 12 files added',
    )
  })
})

describe('interpolate', () => {
  it('leaves a placeholder with no value as written', () => {
    expect(interpolate('{{ a }} and {{b}}', { a: 1 })).toBe('1 and {{b}}')
  })
})

describe('t', () => {
  it('translates a key in English by default', () => {
    expect(t('auth.signIn')).toBe('Sign in')
  })

  it('switches language and sets <html lang>', async () => {
    await setLanguage('de')
    expect(language()).toBe('de')
    expect(t('auth.signIn')).toBe('Anmelden')
    expect(document.documentElement.lang).toBe('de')
  })

  it('renders an unknown key as itself rather than blank', () => {
    expect(t('nope.nothing' as never)).toBe('nope.nothing')
  })

  it('formats parameters', () => {
    expect(t('common.tooShort', { min: 10 })).toBe('Use at least 10 characters')
  })
})

describe('loadTranslations', () => {
  // Ported: German when the chunk loads; English rather than hanging when it fails.
  it('returns the German translations when the chunk loads', async () => {
    expect(await loadTranslations('de', () => Promise.resolve({ default: de }))).toBe(de)
  })

  it('falls back to English when the chunk fails to load, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadTranslations('de', () => Promise.reject(new Error('offline')))).toBe(en)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never asks for a chunk for English', async () => {
    const importDe = vi.fn()
    expect(await loadTranslations('en', importDe)).toBe(en)
    expect(importDe).not.toHaveBeenCalled()
  })
})

describe('errorMessage', () => {
  it('maps codes to the errors.* family and formats the quota', () => {
    expect(errorMessage(new ApiError('NotFound', 'x'))).toBe(en.errors.notFound)
    expect(
      errorMessage(
        new ApiError('QuotaExceeded', 'x', { details: { usageBytes: 2048, quotaBytes: 1048576 } }),
      ),
    ).toBe('This upload would exceed your quota (2.0 kB of 1.0 MB used)')
    expect(errorMessage(new ApiError('Internal', 'x'))).toBe(en.errors.generic)
    expect(errorMessage(new Error('boom'))).toBe(en.errors.generic)
  })
})
