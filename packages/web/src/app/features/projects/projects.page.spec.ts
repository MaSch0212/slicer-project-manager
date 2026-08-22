import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ProjectsPage } from './projects.page'

function setup(
  overrides: { create?: ReturnType<typeof vi.fn>; rescan?: ReturnType<typeof vi.fn> } = {},
) {
  const api = {
    projects: {
      list: vi.fn().mockResolvedValue([]),
      create: overrides.create ?? vi.fn(),
      rescan: overrides.rescan ?? vi.fn(),
    },
  }
  TestBed.configureTestingModule({
    providers: [
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

  // A rescan is one-shot (spec: no form/model to preserve), so its failure only needs to
  // surface visibly rather than escape as an unhandled rejection.
  it('sets an error instead of throwing when rescan rejects', async () => {
    const rescan = vi.fn().mockRejectedValue(new Error('boom'))
    const { fixture } = setup({ rescan })

    await expect(fixture.componentInstance.onRescan()).resolves.toBeUndefined()

    expect(fixture.componentInstance.rescanError()).toBe(true)
    expect(fixture.componentInstance.rescanned()).toBeNull()
  })
})
