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

  // Every one of these is the whole of what a failed or in-progress load says, so a literal
  // "{{ extension }}" would be the user's entire explanation of what went wrong.
  it('substitutes the viewer placeholders in both locales', () => {
    for (const translations of [en, de]) {
      const viewer = translations.viewer
      expect(interpolate(viewer.loadingPercent, { percent: 42 })).toContain('42')
      const unsupported = interpolate(viewer.unsupported, {
        extension: '.gcode',
        formats: 'STL, OBJ, 3MF',
      })
      expect(unsupported).toContain('.gcode')
      // The list of openable formats is derived from the loader table, not written out here,
      // so both locales have to carry the placeholder for it.
      expect(unsupported).toContain('STL, OBJ, 3MF')
      expect(interpolate(viewer.parseFailed, { extension: '.3mf' })).toContain('.3mf')
      // The size gate's whole job is to say how big the file is, so a message that renders the
      // placeholder instead of the number tells the user nothing they can decide on.
      const tooLarge = interpolate(viewer.tooLarge, { size: '164.8 MB', extension: '.stl' })
      expect(tooLarge).toContain('164.8 MB')
      expect(tooLarge).toContain('.stl')
      // No placeholders of its own, but it is the message 374 of the library's 402 .3mf files
      // land on, so an empty string here would be a blank alert rather than a visible bug.
      expect(viewer.slicerProject.length).toBeGreaterThan(20)
      expect(viewer.slicerProject).not.toMatch(/[{}]/)
      for (const message of [
        viewer.loadingPercent,
        viewer.unsupported,
        viewer.parseFailed,
        viewer.tooLarge,
      ]) {
        const filled = interpolate(message, {
          percent: 42,
          extension: '.stl',
          formats: 'STL',
          size: '164.8 MB',
        })
        expect(filled).not.toMatch(/[{}]/)
        // A placeholder the caller gave no value for is substituted with `String(undefined)`,
        // so the braces disappear and the brace check above goes green over the literal word
        // "undefined" sitting in the message. This is the assertion that sees it.
        expect(filled).not.toMatch(/\bundefined\b/)
      }
    }
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
