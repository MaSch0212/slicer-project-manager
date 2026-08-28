import { ApplicationRef } from '@angular/core'
import { Router, provideRouter, type Routes } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AppError } from '@spm/contract/errors.ts'
import type {
  Capabilities,
  FileDto,
  ProjectDetailDto,
  SlicerConfigDto,
  SlicerLaunchDto,
} from '@spm/contract/dtos.ts'
import { API_CLIENT, SHELL_CLIENT } from '../../core/api/api-client.token'
import { CapabilitiesStore } from '../../core/capabilities.store'
import en from '../../core/i18n/locales/en.json'
import { ProjectDetailPage, resolveLaunchSlicer } from './project-detail.page'
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

/** A `.3mf` Cura wrote, which is the only kind of file the as-is control is offered for. */
const project3mf: FileDto = {
  id: 'f2',
  name: 'bracket.3mf',
  kind: 'slicer_project',
  slicer: 'cura',
  sizeBytes: 4096,
  previewState: 'ready',
  rawUrl: '/api/files/f2/raw',
}

const slicerConfig: SlicerConfigDto = {
  installs: [
    {
      id: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
      slicerId: 'orca',
      label: 'OrcaSlicer',
      version: '2.4.3.0',
      path: 'C:\\OrcaSlicer\\orca-slicer.exe',
      origin: 'msix',
      state: 'ok',
    },
    {
      id: 'registry:HKLM:Cura',
      slicerId: 'cura',
      label: 'UltiMaker Cura 5.13.0',
      version: '5.13.0',
      path: 'C:\\Cura\\UltiMaker-Cura.exe',
      origin: 'registry',
      state: 'ok',
    },
  ],
  bindings: { orca: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g', cura: 'registry:HKLM:Cura' },
  defaultSlicerId: 'orca',
  detectionSupported: true,
}

const launchDto: SlicerLaunchDto = {
  launchId: 'launch-1',
  slicerId: 'orca',
  installLabel: 'OrcaSlicer',
  stripped: true,
  notices: ['It will show one informational notice, "loading geometry data only".'],
  pid: 4242,
}

/** Every other test on this page: the launch controls must not render at all. */
const NO_SLICERS: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

const CAPABILITIES: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: false,
}

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
    /** Set to enable the launch controls; the capability alone is not enough. */
    slicers?: { get?: Mock; open?: Mock }
  } = {},
  /**
   * Routes the page's own links can actually reach. Empty by default — RouterLink only needs
   * a Router to build an href — and supplied only by the test that follows one.
   */
  routes: Routes = [],
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
  const shell = {
    slicers: {
      get: overrides.slicers?.get ?? vi.fn(() => Promise.resolve(slicerConfig)),
      open: overrides.slicers?.open ?? vi.fn(() => Promise.resolve(launchDto)),
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
      provideRouter(routes),
      { provide: API_CLIENT, useValue: api },
      { provide: SHELL_CLIENT, useValue: shell },
      // A stub rather than the real store loading over `API_CLIENT`: the flag has to be settled
      // *before* the component's resource reads it, and a store that resolves it asynchronously
      // would make every launch assertion depend on when that landed.
      {
        provide: CapabilitiesStore,
        useValue: {
          capabilities: () => (overrides.slicers ? CAPABILITIES : NO_SLICERS),
        } as unknown as CapabilitiesStore,
      },
    ],
  })
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true)
  const fixture = TestBed.createComponent(ProjectDetailPage)
  fixture.componentRef.setInput('id', 'p1')
  return { fixture, api, shell, navigate, page: fixture.componentInstance }
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

  /**
   * Before this, nothing anywhere in the app named the viewer route: the file name beside the
   * thumbnail links to `rawUrl`, which downloads the file, so a whole subsystem was reachable
   * only by typing a URL.
   */
  describe('the way into the 3D viewer', () => {
    it('navigates to the viewer for a model file', async () => {
      const { fixture } = setup({}, [{ path: 'projects/:id/view/:fileId', children: [] }])
      await settle()
      const router = TestBed.inject(Router)

      const link = fixture.nativeElement.querySelector(
        'a[href="/projects/p1/view/f1"]',
      ) as HTMLAnchorElement | null
      expect(link).not.toBeNull()
      // Following it, not merely rendering it: an href that no route matches would leave the
      // reader on a blank page, and this is the only way to tell the two apart.
      expect(router.url).not.toBe('/projects/p1/view/f1')

      link?.click()
      await settle()

      expect(router.url).toBe('/projects/p1/view/f1')
      // The download link is a separate affordance and stays: the viewer replaces neither
      // saving the file nor opening it in a slicer.
      expect(fixture.nativeElement.querySelector(`a[href="${file.rawUrl}"]`)).not.toBeNull()
    })

    it('does not offer it for a file that is not a model', async () => {
      const other: FileDto = { ...file, id: 'f9', name: 'notes.txt', kind: 'other' }
      const { fixture } = setup({
        get: vi.fn(() => Promise.resolve(fetched({ files: [other] }))),
      })
      await settle()

      // The control that makes the test above falsifiable in the other direction: a .gcode or
      // a slicer project has nothing the viewer's three loaders can open, and an entry point
      // that led to "this viewer cannot show that" would be worse than none.
      expect(fixture.nativeElement.querySelector('a[href^="/projects/p1/view/"]')).toBeNull()
      // And the row is on the page, so the assertion above is about the link and not about an
      // empty file list.
      expect(text(fixture)).toContain('notes.txt')
    })

    /**
     * The thumbnail is the picture of the model, sitting two columns to the left of the icon
     * button that opens it, and it was inert — so the thing a user reaches for did nothing
     * while the thing that worked looked like a toolbar affordance.
     */
    it('opens the viewer from the thumbnail itself', async () => {
      const { fixture } = setup({}, [{ path: 'projects/:id/view/:fileId', children: [] }])
      await settle()
      const router = TestBed.inject(Router)

      const hit = fixture.nativeElement.querySelector(
        '.spm-file-thumb .spm-file-thumb-hit',
      ) as HTMLAnchorElement | null
      expect(hit).not.toBeNull()
      expect(hit?.getAttribute('href')).toBe('/projects/p1/view/f1')

      expect(router.url).not.toBe('/projects/p1/view/f1')
      hit?.click()
      await settle()
      expect(router.url).toBe('/projects/p1/view/f1')
    })

    it('keeps the thumbnail out of the tab order and out of the accessibility tree', async () => {
      const { fixture } = setup({}, [{ path: 'projects/:id/view/:fileId', children: [] }])
      await settle()

      const hit = fixture.nativeElement.querySelector('.spm-file-thumb-hit') as HTMLElement
      // It is a duplicate of the labelled "View <name>" control in the same row. A second,
      // unnamed link to the same place is noise in the tab order and in a screen reader's
      // list of links, so mouse and touch get the large target and nothing else changes.
      expect(hit.getAttribute('tabindex')).toBe('-1')
      expect(hit.getAttribute('aria-hidden')).toBe('true')
      expect(hit.textContent?.trim()).toBe('')

      // The control: the named button it defers to really is there, so this is a duplicate
      // being suppressed rather than the only entry point being hidden from assistive tech.
      const named = [...fixture.nativeElement.querySelectorAll('a[href^="/projects/p1/view/"]')]
      expect(named.length).toBe(2)
      // `.some(...)` with no matcher after it asserts nothing at all — the exact shape this
      // subsystem has caught seven times — so the count is asserted instead.
      const hidden = named.filter((link) => (link as HTMLElement).ariaHidden === 'true')
      expect(hidden.length).toBe(1)
    })

    it('does not put a hit target on a file the viewer cannot open', async () => {
      const other: FileDto = { ...file, id: 'f9', name: 'notes.txt', kind: 'other' }
      const { fixture } = setup({
        get: vi.fn(() => Promise.resolve(fetched({ files: [other] }))),
      })
      await settle()

      expect(fixture.nativeElement.querySelector('.spm-file-thumb-hit')).toBeNull()
      // The control: the tile itself is still rendered, so the query above is looking at a row
      // that exists.
      expect(fixture.nativeElement.querySelector('.spm-file-thumb')).not.toBeNull()
    })
  })

  describe('handing a file to a slicer', () => {
    const withSlicers = (over: { open?: Mock; get?: Mock } = {}) =>
      setup({
        slicers: over,
        get: vi.fn(() => Promise.resolve(fetched({ files: [file, { ...project3mf }] }))),
      })

    it('offers "open as it is" for a slicer project only, and the other path for every file', async () => {
      const { fixture } = withSlicers()
      await settle()

      const labels = [...fixture.nativeElement.querySelectorAll('button')].map(
        (button: HTMLButtonElement) => button.getAttribute('aria-label') ?? '',
      )
      expect(labels).toContain(`${en.projects.openInSlicer} bracket.3mf`)
      expect(labels).not.toContain(`${en.projects.openInSlicer} benchy.stl`)
      expect(labels).toContain(`${en.projects.newSlicerProject} bracket.3mf`)
      expect(labels).toContain(`${en.projects.newSlicerProject} benchy.stl`)
    })

    it('renders no launch control at all where the shell cannot launch one', async () => {
      const { fixture } = setup({
        get: vi.fn(() => Promise.resolve(fetched({ files: [file, { ...project3mf }] }))),
      })
      await settle()

      const labels = [...fixture.nativeElement.querySelectorAll('button')].map(
        (button: HTMLButtonElement) => button.getAttribute('aria-label') ?? '',
      )
      expect(labels).not.toContain(`${en.projects.newSlicerProject} benchy.stl`)
      expect(text(fixture)).not.toContain(en.projects.slicerChoice)
    })

    it('sends ids and a mode, and never a path or a slicer it was not given', async () => {
      const { page, shell } = withSlicers()
      await settle()

      await page.onLaunch(file, 'new-project')

      expect(shell.slicers.open).toHaveBeenCalledWith('f1', 'p1', { mode: 'new-project' })
      // `slicerId` absent rather than null: "not stated" is what makes the main process apply its
      // own rule, and a null would be a `Validation` failure at the channel.
      const [, , opts] = shell.slicers.open.mock.calls[0] as [string, string, object]
      expect('slicerId' in opts).toBe(false)
    })

    it('sends the chosen slicer when the user picks one', async () => {
      const { page, shell } = withSlicers()
      await settle()
      page.chosenSlicer.set('bambu')

      await page.onLaunch({ ...project3mf }, 'as-is')

      expect(shell.slicers.open).toHaveBeenCalledWith('f2', 'p1', {
        mode: 'as-is',
        slicerId: 'bambu',
      })
    })

    it('says what it handed over and to what, and never that anything opened', async () => {
      const { fixture, page } = withSlicers()
      await settle()

      await page.onLaunch(file, 'new-project')
      await settle()

      const shown = text(fixture)
      expect(shown).toContain('Handed benchy.stl to OrcaSlicer (OrcaSlicer)')
      expect(shown).toContain('loading geometry data only')
      // Constraint 11, asserted as an absence because that is what the constraint is.
      expect(shown.toLowerCase()).not.toContain('opened in')
    })

    it("shows the shell's own refusal rather than a generic apology", async () => {
      const { fixture, page } = withSlicers({
        open: vi
          .fn()
          .mockRejectedValue(
            new AppError(
              'Validation',
              'mixed.3mf could not be prepared for a new project because stripping it left slicer configuration behind. Opening it as it is, without stripping, is still available.',
              { reason: 'configuration-left-behind' },
            ),
          ),
      })
      await settle()

      await page.onLaunch(file, 'new-project')
      await settle()

      expect(text(fixture)).toContain('stripping it left slicer configuration behind')
      expect(text(fixture)).not.toContain(en.errors.generic)
    })

    it('warns about Cura before handing it anything, and does not launch until answered', async () => {
      const { fixture, page, shell } = withSlicers()
      await settle()
      // Cura is what the file itself names, so an as-is launch with no explicit choice is a Cura
      // launch — which the page has to work out for itself, before the call.
      await page.onLaunch({ ...project3mf }, 'as-is')
      await settle()

      expect(shell.slicers.open).not.toHaveBeenCalled()
      expect(text(fixture)).toContain(en.projects.curaHazardTitle)

      await page.onCuraContinue()
      await settle()

      expect(shell.slicers.open).toHaveBeenCalledWith('f2', 'p1', { mode: 'as-is' })
      expect(text(fixture)).not.toContain(en.projects.curaHazardTitle)
    })

    it('warns every time until the user says not to, and then never again', async () => {
      const { page, shell } = withSlicers()
      await settle()

      await page.onLaunch({ ...project3mf }, 'as-is')
      await page.onCuraContinue()
      // Not ticked, so the next Cura launch is held back again.
      await page.onLaunch({ ...project3mf }, 'as-is')
      expect(shell.slicers.open).toHaveBeenCalledTimes(1)

      page.curaDontShowAgain.set(true)
      await page.onCuraContinue()
      await page.onLaunch({ ...project3mf }, 'as-is')

      expect(shell.slicers.open).toHaveBeenCalledTimes(3)
    })

    it('does not warn about Cura for a launch that would not use it', async () => {
      const { page, shell } = withSlicers()
      await settle()

      // The same Cura-authored file down the other path: that one defaults to the configured
      // default, which is Orca, so there is nothing to warn about.
      await page.onLaunch({ ...project3mf }, 'new-project')

      expect(shell.slicers.open).toHaveBeenCalledWith('f2', 'p1', { mode: 'new-project' })
      expect(page.curaPending()).toBeNull()
    })

    it('offers only the products with an install bound to them', async () => {
      const { page } = withSlicers()
      await settle()

      expect(page['slicerOptions']()).toEqual([
        { label: 'UltiMaker Cura', value: 'cura' },
        { label: 'OrcaSlicer', value: 'orca' },
      ])
    })
  })

  describe('resolveLaunchSlicer', () => {
    it('prefers what the user chose over everything else', () => {
      expect(resolveLaunchSlicer('as-is', 'cura', 'bambu', 'orca')).toBe('bambu')
      expect(resolveLaunchSlicer('new-project', undefined, 'bambu', 'orca')).toBe('bambu')
    })

    it('uses the slicer the file names for as-is, and the default for a new project', () => {
      expect(resolveLaunchSlicer('as-is', 'cura', null, 'orca')).toBe('cura')
      // The new-project path deliberately does not: its target is usually *not* the product that
      // wrote the file, so defaulting to it would make the common case need an override.
      expect(resolveLaunchSlicer('new-project', 'cura', null, 'orca')).toBe('orca')
    })

    it('falls through to the default, and to nothing when there is not one', () => {
      expect(resolveLaunchSlicer('as-is', undefined, null, 'orca')).toBe('orca')
      expect(resolveLaunchSlicer('as-is', undefined, null, null)).toBeNull()
    })
  })
})
