import { describe, expect, it, vi } from 'vitest'
import type { ZipImportResultDto } from '../api/generated'
import { ApiError } from './api/error'
import en from './i18n/en.json'
import {
  createArchiveImport,
  importErrorMessage,
  isZipName,
  summarizeImport,
} from './import-archive'

// Ported from the former Angular features/import/import.panel.spec.ts. The panel's upload-control handle
// (markDone/markFailed) has no counterpart: the drop zone reports files and the state is ours.

const RESULT: ZipImportResultDto = {
  projectsExtracted: 2,
  filesExtracted: 7,
  bytesExtracted: 2048,
  strippedRoot: 'MyLibrary',
  skipped: 3,
  projectsUpdated: 2,
  tagsApplied: 4,
  rescan: { adopted: 2, markedMissing: 0, filesAdded: 7, filesRemoved: 0, previewsQueued: 7 },
}

const zipFile = (name: string) => new File(['zip bytes'], name)

function setup(curaManagerZip = vi.fn().mockResolvedValue(RESULT)) {
  const importer = createArchiveImport({ importer: { curaManagerZip } } as never)
  return { importer, curaManagerZip }
}

describe('archive import', () => {
  it('uploads the archive and keeps what the import did', async () => {
    const { importer, curaManagerZip } = setup()
    const archive = zipFile('library.zip')
    await importer.run([archive])
    expect(curaManagerZip).toHaveBeenCalledWith(archive)
    expect(importer.result()).toEqual(RESULT)
    expect(importer.error()).toBeNull()
  })

  it('refuses anything that is not a .zip without calling the server', async () => {
    const { importer, curaManagerZip } = setup()
    await importer.run([zipFile('notes.txt')])
    expect(curaManagerZip).not.toHaveBeenCalled()
    expect(importer.error()).toBe(en.import.notZip)
  })

  it('accepts an uppercase extension', async () => {
    const { importer, curaManagerZip } = setup()
    await importer.run([zipFile('LIBRARY.ZIP')])
    expect(curaManagerZip).toHaveBeenCalledOnce()
    expect(isZipName('a.Zip')).toBe(true)
    expect(isZipName('a.zip.txt')).toBe(false)
  })

  // The endpoint takes one archive, and two in flight would race on the collision check.
  it('imports only the first archive', async () => {
    const { importer, curaManagerZip } = setup()
    const first = zipFile('a.zip')
    await importer.run([first, zipFile('b.zip'), zipFile('c.zip')])
    expect(curaManagerZip).toHaveBeenCalledOnce()
    expect(curaManagerZip).toHaveBeenCalledWith(first)
  })

  it('does nothing for an empty drop', async () => {
    const { importer, curaManagerZip } = setup()
    await importer.run([])
    expect(curaManagerZip).not.toHaveBeenCalled()
  })

  it('refuses a second archive while one is being imported', async () => {
    let finish!: (value: ZipImportResultDto) => void
    const pending = new Promise<ZipImportResultDto>((resolve) => (finish = resolve))
    const { importer, curaManagerZip } = setup(vi.fn().mockReturnValue(pending))
    const first = importer.run([zipFile('a.zip')])
    expect(importer.busy()).toBe(true)
    await importer.run([zipFile('b.zip')])
    expect(curaManagerZip).toHaveBeenCalledOnce()
    finish(RESULT)
    await first
  })

  it('shows a collision message verbatim, because it says what to do about it', async () => {
    const { importer } = setup(
      vi.fn().mockRejectedValue(new ApiError('Conflict', 'already in your library: Widget A')),
    )
    await importer.run([zipFile('library.zip')])
    expect(importer.error()).toBe('already in your library: Widget A')
  })

  it('hides an internal failure behind the generic message', async () => {
    const { importer } = setup(vi.fn().mockRejectedValue(new ApiError('Internal', 'stack trace')))
    await importer.run([zipFile('library.zip')])
    expect(importer.error()).toBe(en.import.failed)
    expect(importer.error()).not.toContain('stack trace')
  })

  it('says a quota failure with the numbers', () => {
    const error = new ApiError('QuotaExceeded', 'over', {
      details: { usageBytes: 1024, quotaBytes: 2048 },
    })
    expect(importErrorMessage(error)).toBe(
      'This upload would exceed your quota (1.0 kB of 2.0 kB used)',
    )
    expect(importErrorMessage(new Error('boom'))).toBe(en.import.failed)
  })

  it('clears the busy flag whether the import succeeds or fails', async () => {
    const ok = setup()
    await ok.importer.run([zipFile('a.zip')])
    expect(ok.importer.busy()).toBe(false)
    // Otherwise the drop zone stays replaced by a spinner and there is no way to retry.
    const bad = setup(vi.fn().mockRejectedValue(new Error('boom')))
    await bad.importer.run([zipFile('b.zip')])
    expect(bad.importer.busy()).toBe(false)
  })

  // A success banner beside a fresh failure would read as though both had happened.
  it('drops a stale result when a new import starts', async () => {
    const { importer } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(RESULT)
        .mockRejectedValueOnce(new ApiError('Conflict', 'already in your library: Widget A')),
    )
    await importer.run([zipFile('a.zip')])
    expect(importer.result()).toEqual(RESULT)
    await importer.run([zipFile('b.zip')])
    expect(importer.result()).toBeNull()
    expect(importer.error()).toContain('Widget A')
  })

  it('can be reset', async () => {
    const { importer } = setup()
    await importer.run([zipFile('a.zip')])
    importer.reset()
    expect(importer.result()).toBeNull()
  })
})

describe('import summary', () => {
  it('lists what was created, added and applied, and notes what was left alone', () => {
    const summary = summarizeImport(RESULT)
    expect(summary.stats).toEqual([
      { label: 'Projects created', value: '2' },
      { label: 'Files added', value: '7' },
      { label: 'Total size', value: '2.0 kB' },
      { label: 'Tags applied', value: '4' },
      { label: 'Projects with tags or source URL applied', value: '2' },
      { label: 'Previews queued', value: '7' },
    ])
    expect(summary.notes).toEqual([
      'Everything was inside one folder (MyLibrary), so its contents became the library.',
      '3 items were skipped because they were hidden or not inside a project folder.',
    ])
  })

  it('leaves out what did not happen, and uses the singular for one skipped item', () => {
    const summary = summarizeImport({
      ...RESULT,
      strippedRoot: null,
      skipped: 1,
      projectsUpdated: 0,
      rescan: { ...RESULT.rescan, previewsQueued: 0 },
    })
    expect(summary.stats.map((stat) => stat.label)).toEqual([
      'Projects created',
      'Files added',
      'Total size',
      'Tags applied',
    ])
    expect(summary.notes).toEqual([
      '1 item was skipped because it was hidden or not inside a project folder.',
    ])
    expect(summarizeImport({ ...RESULT, strippedRoot: null, skipped: 0 }).notes).toEqual([])
  })
})
