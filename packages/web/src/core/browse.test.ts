import { describe, expect, it } from 'vitest'
import type { BrowseDownloadDto } from '../api/generated'
import {
  BROWSE_TEXT_MAX,
  isArchiveName,
  isPersistableWebsite,
  isStillDownloading,
  truncateForDisplay,
} from './browse'

const row = (over: Partial<BrowseDownloadDto>): BrowseDownloadDto => ({
  downloadId: 'd',
  fileName: 'a.zip',
  sourceUrl: '',
  pageUrl: null,
  siteId: null,
  mimeType: '',
  state: 'completed',
  receivedBytes: 0,
  totalBytes: 0,
  hadUserGesture: false,
  startedAt: 0,
  isOrphan: false,
  isVerifiable: true,
  ...over,
})

describe('truncateForDisplay', () => {
  it('leaves a short string alone and bounds a long one', () => {
    expect(truncateForDisplay('short')).toBe('short')
    expect(truncateForDisplay('x'.repeat(BROWSE_TEXT_MAX))).toHaveLength(BROWSE_TEXT_MAX)
    const cut = truncateForDisplay('y'.repeat(BROWSE_TEXT_MAX + 1))
    expect(cut).toBe(`${'y'.repeat(BROWSE_TEXT_MAX)}…`)
    // Never in the middle of a character.
    expect(truncateForDisplay('😀'.repeat(10), 4)).toBe('😀😀😀😀…')
  })
})

describe('isArchiveName', () => {
  it('goes by the name, which is all there is', () => {
    for (const name of ['a.zip', 'A.ZIP', 'x.7z', 'x.tar.gz', 'x.rar'])
      expect(isArchiveName(name)).toBe(true)
    for (const name of ['cube.stl', 'zip', 'settings.ini', 'notes.zip.txt'])
      expect(isArchiveName(name)).toBe(false)
  })
})

describe('isStillDownloading', () => {
  it('is both halves of the shell rule: an orphan that says progressing is not running', () => {
    expect(isStillDownloading(row({ state: 'progressing' }))).toBe(true)
    expect(isStillDownloading(row({ state: 'progressing', isOrphan: true }))).toBe(false)
    expect(isStillDownloading(row({ state: 'completed' }))).toBe(false)
    expect(isStillDownloading(row({ state: 'interrupted' }))).toBe(false)
  })
})

describe('isPersistableWebsite', () => {
  it('is http(s) only', () => {
    expect(isPersistableWebsite('https://www.thingiverse.com/thing:1')).toBe(true)
    expect(isPersistableWebsite('http://example.com/')).toBe(true)
    for (const bad of [
      null,
      '',
      'data:text/html,x',
      'blob:https://x/1',
      'javascript:1',
      'file:///x',
      'nope',
    ]) {
      expect(isPersistableWebsite(bad)).toBe(false)
    }
  })
})
