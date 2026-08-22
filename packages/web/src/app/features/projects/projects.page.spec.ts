import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ProjectsPage } from './projects.page'

function setup(create = vi.fn()) {
  const api = {
    projects: { list: vi.fn().mockResolvedValue([]), create, rescan: vi.fn() },
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
    const { fixture } = setup(create)
    fixture.componentInstance.createModel.set({ name: '   ' })

    await fixture.componentInstance.onCreate()

    expect(create).not.toHaveBeenCalled()
  })

  it('creates the project and clears the form on a valid submit', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', name: 'New' })
    const { fixture } = setup(create)
    fixture.componentInstance.createModel.set({ name: 'New' })

    await fixture.componentInstance.onCreate()

    expect(create).toHaveBeenCalledWith({ name: 'New' })
    expect(fixture.componentInstance.createModel()).toEqual({ name: '' })
  })
})
