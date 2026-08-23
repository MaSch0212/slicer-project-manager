import { ApplicationRef } from '@angular/core'
import { Router, provideRouter } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AppError } from '@spm/contract/errors.ts'
import type { FileDto, ProjectDetailDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import en from '../../core/i18n/locales/en.json'
import { ProjectDetailPage } from './project-detail.page'
import { provideJigForTests } from '../../../testing/jig'

const file: FileDto = {
  id: 'f1',
  name: 'benchy.stl',
  kind: 'model',
  sizeBytes: 2048,
  previewState: 'pending',
  rawUrl: '/api/files/f1/raw',
}

const detail: ProjectDetailDto = {
  id: 'p1',
  name: 'Benchy',
  website: 'https://example.com/benchy',
  notes: 'printed at 0.2mm',
  isArchived: false,
  state: 'ok',
  tags: ['boat'],
  fileCounts: { model: 1, slicerProject: 0, other: 0 },
  createdAt: 0,
  updatedAt: 0,
  files: [file],
}

/**
 * A *fresh* DTO per fetch, which is what the HTTP transport actually hands back (every
 * response is a new JSON parse). Handing the same object out twice would hide any bug that
 * depends on object identity across a reload — the edit-form clobbering one below in
 * particular.
 */
const fetched = (over: Partial<ProjectDetailDto> = {}): ProjectDetailDto => ({
  ...detail,
  files: detail.files.map((entry) => ({ ...entry })),
  ...over,
})

type Mock = ReturnType<typeof vi.fn>

function setup(
  overrides: {
    get?: Mock
    update?: Mock
    addTag?: Mock
    removeTag?: Mock
    deleteProject?: Mock
    upload?: Mock
    rename?: Mock
    deleteFile?: Mock
  } = {},
) {
  const api = {
    projects: {
      get: overrides.get ?? vi.fn(() => Promise.resolve(fetched())),
      update: overrides.update ?? vi.fn(() => Promise.resolve(fetched())),
      addTag: overrides.addTag ?? vi.fn().mockResolvedValue(undefined),
      removeTag: overrides.removeTag ?? vi.fn().mockResolvedValue(undefined),
      delete: overrides.deleteProject ?? vi.fn().mockResolvedValue(undefined),
    },
    files: {
      upload: overrides.upload ?? vi.fn().mockResolvedValue(file),
      rename: overrides.rename ?? vi.fn().mockResolvedValue(file),
      delete: overrides.deleteFile ?? vi.fn().mockResolvedValue(undefined),
    },
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      // A real Router (not a `{ navigate }` stub as in login.page.spec): this template has
      // routerLinks back to the project list, and RouterLink needs a Router that can build
      // a UrlTree plus the root ActivatedRoute that provideRouter supplies.
      provideRouter([]),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true)
  const fixture = TestBed.createComponent(ProjectDetailPage)
  fixture.componentRef.setInput('id', 'p1')
  return { fixture, api, navigate, page: fixture.componentInstance }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()
const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent ?? ''

describe('ProjectDetailPage', () => {
  it('loads the project named by the route input', async () => {
    const { fixture, api } = setup()
    await settle()
    expect(api.projects.get).toHaveBeenCalledWith('p1')
    expect(fixture.componentInstance.project.value()?.name).toBe('Benchy')
    expect(text(fixture)).toContain('Benchy')
  })

  // Ruling 62: the brief's template was a single `@if (project.value(); as detail)` with no
  // `@else`. Reading `.value()` after a settled failure throws a ResourceValueError, and even
  // if it did not, a failed load rendered a blank page. Every state must render something.
  it('renders an error branch instead of throwing when the load fails', async () => {
    const { fixture, page } = setup({ get: vi.fn().mockRejectedValue(new Error('boom')) })

    await settle()

    expect(page.project.status()).toBe('error')
    expect(page.loadFailed()).toBe(true)
    expect(text(fixture)).toContain(en.errors.generic)
    // A dead end is the other half of the defect: there must be a way back to the list.
    expect(fixture.nativeElement.querySelector('a[href="/projects"]')).not.toBeNull()
  })

  // Ruling 62: a deleted project, a stale bookmark or someone else's id is not the same
  // thing as a transient failure, and should not read as one.
  it('distinguishes a missing project from a transient failure', async () => {
    const { fixture } = setup({ get: vi.fn().mockRejectedValue(new AppError('NotFound', 'gone')) })

    await settle()

    expect(text(fixture)).toContain(en.errors.notFound)
    expect(text(fixture)).not.toContain(en.errors.generic)
  })

  // Ruling 61: `Content-Length` is a forbidden header name, so a script-set one is stripped
  // and a ReadableStream body has no length the browser can compute — the server then answers
  // 411. Handing fetch the `File` (which *is* a Blob) is the only arm that works in a browser.
  it('uploads the File itself as a Blob, never as a stream', async () => {
    const { api, page } = setup()
    await settle()
    const upload = new File(['solid benchy'], 'benchy.stl')

    await page.onUpload(upload)

    const [projectId, name, body] = api.files.upload.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(projectId).toBe('p1')
    expect(name).toBe('benchy.stl')
    expect(body).toEqual({ blob: upload })
    expect(body['blob']).toBeInstanceOf(Blob)
    expect('stream' in body).toBe(false)
    // A successful upload reloads the project, so the new file shows up in the list.
    await settle()
    expect(api.projects.get.mock.calls.length).toBeGreaterThan(1)
  })

  it('renders a quota failure with the actual numbers', async () => {
    const upload = vi.fn().mockRejectedValue(
      new AppError('QuotaExceeded', 'nope', {
        usageBytes: 1024,
        quotaBytes: 2048,
        incomingBytes: 4096,
      }),
    )
    const { fixture, page } = setup({ upload })
    await settle()

    await page.onUpload(new File(['x'], 'a.stl'))

    expect(page.errorMessage()).toContain('1.0 kB')
    expect(page.errorMessage()).toContain('2.0 kB')
    await settle()
    expect(text(fixture)).toContain('1.0 kB')
  })

  it('adds and removes a tag, then reloads', async () => {
    const { api, page } = setup()
    await settle()

    await page.onAddTag('petg')
    await settle()
    await page.onRemoveTag('boat')
    await settle()

    expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
    expect(api.projects.removeTag).toHaveBeenCalledWith('p1', 'boat')
    expect(api.projects.get.mock.calls.length).toBeGreaterThan(2)
    expect(page.errorMessage()).toBeNull()
  })

  // Ruling 65: tagNameSchema is `z.string().trim().min(1).max(60)` — the same validator the
  // server runs. A 61-character tag used to round-trip to a 400 that nothing displayed.
  it('refuses an over-length tag client-side, without calling the API', async () => {
    const { api, page } = setup()
    await settle()

    await page.onAddTag('x'.repeat(61))

    expect(api.projects.addTag).not.toHaveBeenCalled()
    expect(page.errorMessage()).toBe(en.errors.invalidTag)
  })

  it('refuses a blank tag and trims the one it does send', async () => {
    const { api, page } = setup()
    await settle()

    await page.onAddTag('   ')
    expect(api.projects.addTag).not.toHaveBeenCalled()

    await page.onAddTag('  petg  ')
    expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
  })

  // Fix round 1, item 5: the template used to wipe the field unconditionally, so a rejected
  // 61-character tag left the user staring at an error and an empty box.
  it('keeps a rejected tag in the input, and clears it once accepted', async () => {
    const { fixture, api, page } = setup()
    await settle()
    const input = fixture.nativeElement.querySelector(
      `input[aria-label="${en.projects.addTag}"]`,
    ) as HTMLInputElement
    const tooLong = 'x'.repeat(61)

    input.value = tooLong
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()

    expect(api.projects.addTag).not.toHaveBeenCalled()
    expect(page.errorMessage()).toBe(en.errors.invalidTag)
    expect(input.value).toBe(tooLong)

    input.value = 'petg'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()

    expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
    expect(input.value).toBe('')
  })

  it('keeps a tag the server rejects in the input too', async () => {
    const { fixture, api } = setup({
      addTag: vi.fn().mockRejectedValue(new AppError('Conflict', 'dup')),
    })
    await settle()
    const input = fixture.nativeElement.querySelector(
      `input[aria-label="${en.projects.addTag}"]`,
    ) as HTMLInputElement

    input.value = 'boat'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()

    expect(api.projects.addTag).toHaveBeenCalled()
    expect(input.value).toBe('boat')
  })

  // Ruling 64: only onUpload had a try/catch. Every other mutation awaited a network call
  // bare, so a 409 on a duplicate tag, a 404 on an already-deleted file or a network blip
  // escaped as an unhandled rejection and the page silently did nothing.
  it('surfaces a rejected addTag instead of throwing', async () => {
    const { page } = setup({ addTag: vi.fn().mockRejectedValue(new AppError('Conflict', 'dup')) })
    await settle()

    await expect(page.onAddTag('boat')).resolves.toBe(false)

    expect(page.errorMessage()).toBe(en.errors.generic)
  })

  it('surfaces a rejected removeTag instead of throwing', async () => {
    const { page } = setup({ removeTag: vi.fn().mockRejectedValue(new Error('boom')) })
    await settle()

    await expect(page.onRemoveTag('boat')).resolves.toBeUndefined()

    expect(page.errorMessage()).toBe(en.errors.generic)
  })

  it('surfaces a rejected file delete instead of throwing', async () => {
    const { page } = setup({
      deleteFile: vi.fn().mockRejectedValue(new AppError('NotFound', 'gone')),
    })
    await settle()

    await expect(page.onDeleteFile(file)).resolves.toBeUndefined()

    expect(page.errorMessage()).toBe(en.errors.notFound)
  })

  it('deletes a file and reloads', async () => {
    const { api, page } = setup()
    await settle()
    const before = api.projects.get.mock.calls.length

    await page.onDeleteFile(file)
    await settle()

    expect(api.files.delete).toHaveBeenCalledWith('f1')
    expect(api.projects.get.mock.calls.length).toBeGreaterThan(before)
  })

  // Ruling 66: the brief declared onRenameFile and then never called it from anywhere, so
  // files.rename was unreachable from the whole web package.
  it('renames a file through the per-file rename affordance', async () => {
    const { fixture, api, page } = setup()
    await settle()

    // The control that makes the next assertion falsifiable: the editor is not there yet.
    expect(text(fixture)).not.toContain(en.projects.newName)

    page.startRename(file)
    await settle()
    expect(text(fixture)).toContain(en.projects.newName)

    page.renameDraft.set('benchy-v2.stl')
    await page.onRenameFile(file, page.renameDraft())
    await settle()

    expect(api.files.rename).toHaveBeenCalledWith('f1', 'benchy-v2.stl')
    expect(page.renamingId()).toBeNull()
  })

  it('refuses an invalid file name client-side, without calling the API', async () => {
    const { api, page } = setup()
    await settle()

    await page.onRenameFile(file, 'bad/name.stl')

    expect(api.files.rename).not.toHaveBeenCalled()
    expect(page.errorMessage()).toBe(en.errors.invalidFileName)
  })

  // Ruling 66: projectPatchSchema and projects.update were referenced nowhere in the web
  // package, so a project could not be renamed, re-noted, re-linked or archived — while the
  // project list already ships an "include archived" filter and an "Archived" badge.
  it('saves an edit through projects.update and reloads', async () => {
    const { api, page } = setup()
    await settle()
    const before = api.projects.get.mock.calls.length

    page.editModel.set({
      name: 'Benchy v2',
      website: 'https://example.com/v2',
      notes: 'petg, 0.2mm',
      isArchived: true,
    })
    await page.onSaveEdit()
    await settle()

    expect(api.projects.update).toHaveBeenCalledWith('p1', {
      name: 'Benchy v2',
      website: 'https://example.com/v2',
      notes: 'petg, 0.2mm',
      isArchived: true,
    })
    expect(api.projects.get.mock.calls.length).toBeGreaterThan(before)
  })

  it('prefills the edit form from the loaded project', async () => {
    const { page } = setup()
    await settle()

    expect(page.editModel()).toEqual({
      name: 'Benchy',
      website: 'https://example.com/benchy',
      notes: 'printed at 0.2mm',
      isArchived: false,
    })
  })

  // Fix round 1, Important: the edit form sits directly above the tags and files sections, so
  // typing a name and then adding a tag or deleting a file is ordinary. Every mutation ends in
  // project.reload(), which resolves to a fresh DTO — re-seeding the form on that wiped the
  // typed text with no message and no way to get it back.
  it('keeps in-progress edits through an unrelated mutation', async () => {
    const { api, page } = setup()
    await settle()
    const typed = {
      name: 'Benchy v3',
      website: '',
      notes: 'a paragraph of notes',
      isArchived: true,
    }

    page.editModel.set(typed)
    await page.onAddTag('petg')
    await settle()

    expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
    expect(page.editModel()).toEqual(typed)
  })

  // The other half of that guarantee: "do not clobber" must not decay into "never re-seed".
  it('re-seeds the form when the stored values really did change', async () => {
    const get = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(fetched()))
      .mockImplementation(() => Promise.resolve(fetched({ name: 'Renamed elsewhere' })))
    const { page } = setup({ get })
    await settle()
    expect(page.editModel().name).toBe('Benchy')

    page.editModel.set({ name: 'typed', website: '', notes: '', isArchived: false })
    await page.onAddTag('petg')
    await settle()

    expect(page.editModel().name).toBe('Renamed elsewhere')
  })

  it('does not call update when the patch is invalid', async () => {
    const { api, page } = setup()
    await settle()

    // A website that is not a URL: validated against projectPatchSchema itself.
    page.editModel.set({ name: 'Benchy', website: 'not a url', notes: '', isArchived: false })
    await page.onSaveEdit()
    expect(api.projects.update).not.toHaveBeenCalled()

    // A blank name with the website emptied: the "website cleared" arm must still enforce
    // every other rule of the shared schema, not skip validation wholesale.
    page.editModel.set({ name: '   ', website: '', notes: '', isArchived: false })
    await page.onSaveEdit()
    expect(api.projects.update).not.toHaveBeenCalled()

    // Over-long notes, from the same shared max(10_000).
    page.editModel.set({
      name: 'Benchy',
      website: '',
      notes: 'x'.repeat(10_001),
      isArchived: false,
    })
    await page.onSaveEdit()
    expect(api.projects.update).not.toHaveBeenCalled()
  })

  // projectPatchSchema spells "no website" / "no notes" as null, but a text input can only
  // ever produce ''. Clearing a field must therefore reach the API as null, not as ''.
  it('clears an emptied website and notes as null rather than as an empty string', async () => {
    const { api, page } = setup()
    await settle()

    page.editModel.set({ name: 'Benchy', website: '', notes: '', isArchived: false })
    await page.onSaveEdit()

    expect(api.projects.update).toHaveBeenCalledWith('p1', {
      name: 'Benchy',
      website: null,
      notes: null,
      isArchived: false,
    })
  })

  it('surfaces a rejected update instead of throwing', async () => {
    const { page } = setup({ update: vi.fn().mockRejectedValue(new Error('boom')) })
    await settle()

    await expect(page.onSaveEdit()).resolves.toBeUndefined()

    expect(page.errorMessage()).toBe(en.errors.generic)
  })

  // Ruling 67: deleting a project with "also delete the files" ticked erases every file of
  // that project from disk. One stray click must not be enough.
  it('arms the delete on the first press and only destroys on the second', async () => {
    const { fixture, api, page, navigate } = setup()
    await settle()
    // Unarmed, neither warning is on the page — so the assertion below can fail.
    expect(text(fixture)).not.toContain(en.projects.confirmDeleteWithFiles)
    expect(text(fixture)).not.toContain(en.projects.confirmDelete)

    await page.onDeleteProject(true)
    await settle()

    expect(api.projects.delete).not.toHaveBeenCalled()
    expect(page.deleteArmed()).toBe(true)
    // The on-disk consequence has to be stated before it happens.
    expect(text(fixture)).toContain(en.projects.confirmDeleteWithFiles)

    await page.onDeleteProject(true)

    expect(api.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: true })
    expect(navigate).toHaveBeenCalledWith(['/projects'])
  })

  it('warns without the on-disk clause when the files are being kept', async () => {
    const { fixture, page } = setup()
    await settle()

    await page.onDeleteProject(false)
    await settle()

    expect(text(fixture)).toContain(en.projects.confirmDelete)
    expect(text(fixture)).not.toContain(en.projects.confirmDeleteWithFiles)
  })

  it('disarms the delete when the confirmation is cancelled', async () => {
    const { api, page } = setup()
    await settle()

    await page.onDeleteProject(true)
    page.cancelDelete()
    expect(page.deleteArmed()).toBe(false)

    // Cancelling means the next press arms again rather than deleting.
    await page.onDeleteProject(true)
    expect(api.projects.delete).not.toHaveBeenCalled()
  })

  // The router reuses this component instance across a `:id` change, so an armed delete
  // must not survive into a different project — one press would destroy the wrong one.
  // Every piece of per-project state is keyed on the route id, and each one leaks something
  // different if it is ever downgraded to a plain signal: the previous project's error text,
  // an open rename editor, or (worst) a live armed delete pointed at the wrong project.
  it('resets the per-project state when the route moves to another project', async () => {
    const { fixture, api, page } = setup()
    await settle()

    // Arm first: starting any action clears the previous error, by design.
    await page.onDeleteProject(true)
    page.startRename(file)
    await page.onAddTag('x'.repeat(61))
    expect(page.errorMessage()).toBe(en.errors.invalidTag)
    expect(page.renamingId()).toBe('f1')
    expect(page.deleteArmed()).toBe(true)

    fixture.componentRef.setInput('id', 'p2')
    await settle()

    expect(page.errorMessage()).toBeNull()
    expect(page.renamingId()).toBeNull()
    expect(page.deleteArmed()).toBe(false)
    await page.onDeleteProject(true)
    expect(api.projects.delete).not.toHaveBeenCalled()
  })

  it('surfaces a rejected project delete instead of throwing, and stays on the page', async () => {
    const { page, navigate } = setup({
      deleteProject: vi.fn().mockRejectedValue(new AppError('Forbidden', 'no')),
    })
    await settle()

    await page.onDeleteProject(false)
    await expect(page.onDeleteProject(false)).resolves.toBeUndefined()

    expect(page.errorMessage()).toBe(en.errors.generic)
    expect(navigate).not.toHaveBeenCalled()
    // A failed delete must not leave the confirmation armed either.
    expect(page.deleteArmed()).toBe(false)
  })

  // Fix round 1, item 4: a guard-blocked or failed navigation used to leave a live
  // "yes, delete" button on an already-deleted project, with nothing said.
  it('disarms and reports when the delete lands but the navigation does not', async () => {
    const { api, page, navigate } = setup()
    navigate.mockResolvedValue(false)
    await settle()

    await page.onDeleteProject(false)
    await page.onDeleteProject(false)

    expect(api.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: false })
    expect(page.deleteArmed()).toBe(false)
    expect(page.errorMessage()).toBe(en.errors.generic)
  })

  // Fix round 1, item 1: asserting `projects.archived` against the whole document could not
  // fail — the edit form rendered the same string as its checkbox label unconditionally. The
  // label now has its own key (`projects.archive`), and the badge is asserted inside the
  // header, with the non-archived case as the control that makes the assertion falsifiable.
  it('renders the missing-folder warning and the archived badge', async () => {
    const { fixture } = setup({
      get: vi.fn(() => Promise.resolve(fetched({ state: 'missing', isArchived: true }))),
    })
    await settle()
    const header = fixture.nativeElement.querySelector('header')?.textContent ?? ''

    expect(text(fixture)).toContain(en.projects.missing)
    expect(header).toContain(en.projects.archived)
  })

  it('does not badge a project that is not archived', async () => {
    const { fixture } = setup()
    await settle()
    const header = fixture.nativeElement.querySelector('header')?.textContent ?? ''

    expect(header).not.toContain(en.projects.archived)
    expect(text(fixture)).not.toContain(en.projects.missing)
    // The archive checkbox is still offered — under its own, action-shaped label.
    expect(text(fixture)).toContain(en.projects.archive)
  })

  // formatBytes itself moved to core/format-bytes.spec.ts (ruling 72.4) — it is now shared
  // with admin/users.page.ts, so its tests live with the implementation, not one of its callers.
})
