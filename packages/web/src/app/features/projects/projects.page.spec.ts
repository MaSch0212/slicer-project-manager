import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { DEFAULT_SETTINGS, type ProjectDto, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import { ProjectsPage } from './projects.page'
import { PROJECTS_PAGE_SIZE } from './projects.store'
import { provideJigForTests } from '../../../testing/jig'
import en from '../../core/i18n/locales/en.json'

/** A full page of rows, which is what makes the store believe more of them exist. */
function fullPage(): ProjectDto[] {
  return Array.from({ length: PROJECTS_PAGE_SIZE }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    isArchived: false,
    state: 'ok' as const,
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
  }))
}

async function setup(
  overrides: {
    create?: ReturnType<typeof vi.fn>
    rescan?: ReturnType<typeof vi.fn>
    putSettings?: ReturnType<typeof vi.fn>
    list?: ReturnType<typeof vi.fn>
  } = {},
) {
  const api = {
    projects: {
      list: overrides.list ?? vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn(),
      rescan: overrides.rescan ?? vi.fn(),
      tags: vi.fn().mockResolvedValue([]),
    },
    settings: {
      get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
      put:
        overrides.putSettings ??
        vi.fn((patch: Partial<SettingsDto>) => Promise.resolve({ ...DEFAULT_SETTINGS, ...patch })),
    },
  }
  // `NotifyService` is a double because jig's snackbar host attaches to
  // `ApplicationRef.components[0]`, which `TestBed` never populates; `ProjectsStore` injects it
  // to report a filter that could not be remembered and a page that could not be loaded.
  const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      // Each rendered card is a routerLink, so a spec whose fixture actually has rows needs a
      // router. The list used to be empty in every one of them, which is why this was not here.
      provideRouter([{ path: 'projects/:id', children: [] }]),
      { provide: API_CLIENT, useValue: api },
      { provide: NotifyService, useValue: notify },
    ],
  })
  // Awaited *before* the component exists: TestBed auto-detects changes, so creating it first
  // renders the template immediately, and the template reads t.translations() unguarded
  // (legitimately — app.config.ts awaits this same promise before bootstrap).
  await TestBed.inject(TranslateService).ready
  return { fixture: TestBed.createComponent(ProjectsPage), api, notify }
}

describe('ProjectsPage', () => {
  // Ruling 58: the brief's original onCreate trimmed createModel().name by hand and skipped
  // createForm entirely — the same defect ruling 53 fixed in LoginPage. Gating on the shared
  // createProjectSchema via submit() means an invalid model never reaches the network.
  it('does not call create when the model is invalid', async () => {
    const create = vi.fn()
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: '   ' })

    await fixture.componentInstance.onCreate()

    expect(create).not.toHaveBeenCalled()
  })

  it('creates the project and clears the form on a valid submit', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', name: 'New' })
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: 'New' })

    await fixture.componentInstance.onCreate()

    expect(create).toHaveBeenCalledWith({ name: 'New' })
    expect(fixture.componentInstance.createModel()).toEqual({ name: '' })
  })

  // Fix round 1, finding 2: submit() is `try { … } finally { … }` with no catch, so a
  // rejection from `action` used to propagate as an unhandled rejection with zero visual
  // feedback. A failed create should leave the typed name in place (unlike a failed rescan,
  // a create retry re-uses what the user already typed), so this also proves the model is
  // NOT cleared on failure.
  it('sets an error instead of throwing when create rejects, and keeps the typed name', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'))
    const { fixture } = await setup({ create })
    fixture.componentInstance.createModel.set({ name: 'New' })

    await expect(fixture.componentInstance.onCreate()).resolves.toBeUndefined()

    expect(fixture.componentInstance.createError()).toBe(true)
    expect(fixture.componentInstance.createModel()).toEqual({ name: 'New' })
  })

  it('publishes the summary of a successful rescan', async () => {
    const summary = {
      adopted: 2,
      markedMissing: 0,
      filesAdded: 7,
      filesRemoved: 0,
      previewsQueued: 7,
    }
    const rescan = vi.fn().mockResolvedValue(summary)
    const { fixture } = await setup({ rescan })

    await fixture.componentInstance.onRescan()

    expect(fixture.componentInstance.rescanned()).toEqual(summary)
    expect(fixture.componentInstance.rescanError()).toBe(false)
  })

  // A rescan is one-shot (spec: no form/model to preserve), so its failure only needs to
  // surface visibly rather than escape as an unhandled rejection.
  //
  // Final review: the `rescanned()` assertion here used to be unfalsifiable. `rescanned`
  // starts as signal(null) and the test never populated it, so `toBeNull()` held whether or
  // not onRescan cleared it — and clearing it was itself added with no test at all. Driving
  // a *resolving* rescan first is what makes the second half of this test mean something:
  // the banner and the alert are independent @if blocks, so a stale success would otherwise
  // render beside a fresh failure.
  it('clears the previous summary and sets an error when a later rescan rejects', async () => {
    const rescan = vi
      .fn()
      .mockResolvedValueOnce({
        adopted: 2,
        markedMissing: 0,
        filesAdded: 7,
        filesRemoved: 0,
        previewsQueued: 7,
      })
      .mockRejectedValueOnce(new Error('boom'))
    const { fixture } = await setup({ rescan })

    await fixture.componentInstance.onRescan()
    expect(fixture.componentInstance.rescanned()).not.toBeNull()

    await expect(fixture.componentInstance.onRescan()).resolves.toBeUndefined()

    expect(fixture.componentInstance.rescanError()).toBe(true)
    expect(fixture.componentInstance.rescanned()).toBeNull()
  })

  it('persists the chosen sort', async () => {
    const { fixture, api } = await setup()

    await fixture.componentInstance.onSort('name:asc')

    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(fixture.componentInstance.sortError()).toBe(false)
  })

  // onSort is bound to a template (change) handler, so a rejection from persisting the
  // preference has nowhere to go; the sort itself is already applied locally either way.
  it('surfaces a failure to persist the sort instead of rejecting', async () => {
    const { fixture } = await setup({ putSettings: vi.fn().mockRejectedValue(new Error('boom')) })

    await expect(fixture.componentInstance.onSort('name:asc')).resolves.toBeUndefined()

    expect(fixture.componentInstance.sortError()).toBe(true)
  })

  /**
   * Spec H 7.5 and constraint C6: a keyboard-reachable control for the next page is required,
   * not a nicety. A list that only grows on a scroll event is unreachable for anyone moving by
   * keyboard or screen reader — focus moves without ever scrolling a container — and until the
   * scroll trigger lands this button is also the only path to rows 49 and beyond.
   *
   * The assertion is on the rendered DOM rather than on a component field because what is being
   * proved is exactly that the control EXISTS on the page: a store that knows more rows are
   * there, with nothing rendered to ask for them, is the defect.
   */
  it('renders a keyboard-reachable control for the next page when more rows exist', async () => {
    const list = vi.fn().mockResolvedValue(fullPage())
    const { fixture, api } = await setup({ list })
    await fixture.whenStable()
    fixture.detectChanges()

    const footer = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.spm-list-footer button',
      ),
    ]
    expect(footer).toHaveLength(1)
    const loadMore = footer[0]
    expect(loadMore?.textContent?.trim()).toBe(en.projects.loadMore)

    loadMore?.click()
    await fixture.whenStable()

    expect(api.projects.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: PROJECTS_PAGE_SIZE, offset: PROJECTS_PAGE_SIZE }),
    )
  })

  // The other edge of the same control: a library that fits on one page must not offer a next
  // one, or the user is handed a button that does nothing. The fixture is deliberately a
  // NON-empty short page — an empty one renders the empty state instead of the list, so the
  // footer would be absent for a reason that has nothing to do with paging.
  it('renders no next-page control when the first page is already the whole library', async () => {
    const { fixture } = await setup({ list: vi.fn().mockResolvedValue(fullPage().slice(0, 3)) })
    await fixture.whenStable()
    fixture.detectChanges()

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.spm-list-footer'),
    ).toHaveLength(1)

    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.spm-list-footer button'),
    ).toHaveLength(0)
  })
})
