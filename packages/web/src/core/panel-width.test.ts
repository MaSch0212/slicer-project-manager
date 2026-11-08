import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  readPanelWidth,
  writePanelWidth,
} from './panel-width'

describe('clampPanelWidth', () => {
  it('keeps a sensible width and rounds it', () => {
    expect(clampPanelWidth(512.4)).toBe(512)
    expect(clampPanelWidth('512')).toBe(512)
  })

  it('refuses to make the panel narrower or wider than it can usefully be', () => {
    expect(clampPanelWidth(10)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(100_000)).toBe(PANEL_MAX_WIDTH)
  })

  it('falls back to the default for anything that is not a number', () => {
    for (const bad of [null, undefined, 'wide', Number.NaN, Infinity, {}]) {
      expect(clampPanelWidth(bad)).toBe(PANEL_DEFAULT_WIDTH)
    }
  })
})

describe('the remembered width', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('is the default until something is stored, and what was stored after', () => {
    expect(readPanelWidth()).toBe(PANEL_DEFAULT_WIDTH)
    writePanelWidth(600)
    expect(readPanelWidth()).toBe(600)
  })

  it('bounds what it reads back, so a hand-edited value cannot hide the list', () => {
    window.localStorage.setItem('spm.projectPanelWidth', '99999')
    expect(readPanelWidth()).toBe(PANEL_MAX_WIDTH)
    window.localStorage.setItem('spm.projectPanelWidth', 'wide')
    expect(readPanelWidth()).toBe(PANEL_DEFAULT_WIDTH)
  })

  it('survives storage that refuses, because the panel is not worth an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(readPanelWidth()).toBe(PANEL_DEFAULT_WIDTH)
    expect(() => writePanelWidth(500)).not.toThrow()
  })
})
