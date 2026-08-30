import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import type { JigUpload, JigUploadFile } from '@awdlab/jig/upload'
import type { ZipImportResultDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import en from '../../core/i18n/locales/en.json'
import { ImportPanel } from './import.panel'
import { provideJigForTests } from '../../../testing/jig'

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

const settle = () => TestBed.inject(ApplicationRef).whenStable()

/** A stand-in for the control's handle: only the three lifecycle calls are used. */
function fakeUpload(): JigUpload & {
  done: string[]
  failed: string[]
} {
  const done: string[] = []
  const failed: string[] = []
  return {
    done,
    failed,
    markDone: (id: string) => done.push(id),
    markFailed: (id: string) => failed.push(id),
    setProgress: () => {},
  } as unknown as JigUpload & { done: string[]; failed: string[] }
}

function uploadFile(name: string, id = name): JigUploadFile {
  return { id, file: new File(['zip bytes'], name), state: 'pending' } as JigUploadFile
}

async function setup(curaManagerZip = vi.fn().mockResolvedValue(RESULT)): Promise<{
  panel: ImportPanel
  api: { importer: { curaManagerZip: ReturnType<typeof vi.fn> } }
  fixture: ReturnType<typeof TestBed.createComponent<ImportPanel>>
}> {
  const api = { importer: { curaManagerZip } }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      provideRouter([{ path: 'projects', children: [] }]),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  await TestBed.inject(TranslateService).ready
  const fixture = TestBed.createComponent(ImportPanel)
  return { panel: fixture.componentInstance, api, fixture }
}

function text(fixture: Awaited<ReturnType<typeof setup>>['fixture']): string {
  fixture.detectChanges()
  return ((fixture.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ')
}

describe('ImportPanel', () => {
  it('uploads the archive and reports what the import did', async () => {
    const { panel, api, fixture } = await setup()
    const upload = fakeUpload()
    const file = uploadFile('library.zip')

    await panel.onUpload([file], upload)
    await settle()

    expect(api.importer.curaManagerZip).toHaveBeenCalledWith({ blob: file.file })
    expect(upload.done).toEqual(['library.zip'])
    expect(panel.result()).toEqual(RESULT)
    // The counts are rendered, not merely held in a signal.
    const rendered = text(fixture)
    expect(rendered).toContain('2 projects and 7 files imported, 4 tags applied.')
    expect(rendered).toContain('MyLibrary')
    expect(rendered).toContain('3 items were skipped')
  })

  it('refuses anything that is not a .zip without calling the server', async () => {
    const { panel, api } = await setup()
    const upload = fakeUpload()

    await panel.onUpload([uploadFile('library.rar')], upload)

    expect(api.importer.curaManagerZip).not.toHaveBeenCalled()
    expect(upload.failed).toEqual(['library.rar'])
    expect(panel.errorMessage()).toBe(en.import.notZip)
  })

  it('accepts an uppercase extension', async () => {
    const { panel, api } = await setup()
    await panel.onUpload([uploadFile('LIBRARY.ZIP')], fakeUpload())
    expect(api.importer.curaManagerZip).toHaveBeenCalledOnce()
  })

  it('imports only the first archive and releases the rest', async () => {
    // The endpoint takes one archive, and two in flight would race on the collision check.
    const { panel, api } = await setup()
    const upload = fakeUpload()

    await panel.onUpload([uploadFile('a.zip'), uploadFile('b.zip'), uploadFile('c.zip')], upload)

    expect(api.importer.curaManagerZip).toHaveBeenCalledOnce()
    expect(upload.done).toEqual(['a.zip'])
    // Released, not left spinning as `pending` forever.
    expect(upload.failed).toEqual(['b.zip', 'c.zip'])
  })

  it('shows a collision message verbatim, because it says what to do about it', async () => {
    const { panel, fixture } = await setup(
      vi.fn().mockRejectedValue(new AppError('Conflict', 'already in your library: Widget A')),
    )
    const upload = fakeUpload()

    await panel.onUpload([uploadFile('library.zip')], upload)

    expect(panel.errorMessage()).toBe('already in your library: Widget A')
    expect(text(fixture)).toContain('Widget A')
    expect(upload.failed).toEqual(['library.zip'])
  })

  it('hides an internal failure behind the generic message', async () => {
    const { panel } = await setup(
      vi.fn().mockRejectedValue(new AppError('Internal', 'stack trace')),
    )

    await panel.onUpload([uploadFile('library.zip')], fakeUpload())

    expect(panel.errorMessage()).toBe(en.import.failed)
    expect(panel.errorMessage()).not.toContain('stack trace')
  })

  // One TestBed per test: configureTestingModule throws once the module is instantiated,
  // so the success and failure paths cannot share a case.
  it('clears the busy flag when the import succeeds', async () => {
    const { panel } = await setup()
    await panel.onUpload([uploadFile('a.zip')], fakeUpload())
    expect(panel.busy()).toBe(false)
  })

  it('clears the busy flag when the import fails', async () => {
    const { panel } = await setup(vi.fn().mockRejectedValue(new Error('boom')))
    await panel.onUpload([uploadFile('b.zip')], fakeUpload())
    // Otherwise the drop zone stays replaced by a spinner and there is no way to retry.
    expect(panel.busy()).toBe(false)
  })

  it('drops a stale result when a new import starts', async () => {
    const { panel } = await setup(
      vi
        .fn()
        .mockResolvedValueOnce(RESULT)
        .mockRejectedValueOnce(new AppError('Conflict', 'already in your library: Widget A')),
    )
    await panel.onUpload([uploadFile('a.zip')], fakeUpload())
    expect(panel.result()).toEqual(RESULT)

    await panel.onUpload([uploadFile('b.zip')], fakeUpload())
    // A success banner beside a fresh failure would read as though both had happened.
    expect(panel.result()).toBeNull()
    expect(panel.errorMessage()).toContain('Widget A')
  })
})
