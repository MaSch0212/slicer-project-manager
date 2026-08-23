import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ProjectsPage } from './projects.page'
import { provideJigForTests } from '../../../testing/jig'

function setup(
  overrides: {
    create?: ReturnType<typeof vi.fn>
    rescan?: ReturnType<typeof vi.fn>
    putSettings?: ReturnType<typeof vi.fn>
  } = {},
) {
  const api = {
    projects: {
      list: vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn(),
      rescan: overrides.rescan ?? vi.fn(),
    },
    settings: {
      get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
      put:
        overrides.putSettings ??
        vi.fn((patch: Partial<SettingsDto>) => Promise.resolve({ ...DEFAULT_SETTINGS, ...patch })),
    },
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  return { fixture: TestBed.createComponent(ProjectsPage), api }
}

describe('ProjectsPage', () => {
  // Ruling 58: the brief's original onCreate trimmed createModel().name by hand and skipped
  // createForm entirely — the same defect ruling 53 fixed in LoginPage. Gating on the shared
  // createProjectSchema via submit() means an invalid model never reaches the network.
  it('does not call create when the model is invalid', async () => {
    const create = vi.fn()
    const { fixture } = setup({ create })
    fixture.componentInstance.createModel.set({ name: '   ' })

    await fixture.componentInstance.onCreate()

    expect(create).not.toHaveBeenCalled()
  })

  it('creates the project and clears the form on a valid submit', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', name: 'New' })
    const { fixture } = setup({ create })
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
    const { fixture } = setup({ create })
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
    const { fixture } = setup({ rescan })

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
    const { fixture } = setup({ rescan })

    await fixture.componentInstance.onRescan()
    expect(fixture.componentInstance.rescanned()).not.toBeNull()

    await expect(fixture.componentInstance.onRescan()).resolves.toBeUndefined()

    expect(fixture.componentInstance.rescanError()).toBe(true)
    expect(fixture.componentInstance.rescanned()).toBeNull()
  })

  it('persists the chosen sort', async () => {
    const { fixture, api } = setup()

    await fixture.componentInstance.onSort('name:asc')

    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    expect(fixture.componentInstance.sortError()).toBe(false)
  })

  // onSort is bound to a template (change) handler, so a rejection from persisting the
  // preference has nowhere to go; the sort itself is already applied locally either way.
  it('surfaces a failure to persist the sort instead of rejecting', async () => {
    const { fixture } = setup({ putSettings: vi.fn().mockRejectedValue(new Error('boom')) })

    await expect(fixture.componentInstance.onSort('name:asc')).resolves.toBeUndefined()

    expect(fixture.componentInstance.sortError()).toBe(true)
  })
})
