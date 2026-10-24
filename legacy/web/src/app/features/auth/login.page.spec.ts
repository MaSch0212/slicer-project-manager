import { Router } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AppError } from '@spm/contract/errors.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { LoginPage } from './login.page'
import { provideJigForTests } from '../../../testing/jig'

function setup(login: ReturnType<typeof vi.fn>) {
  const navigate = vi.fn()
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      { provide: API_CLIENT, useValue: { auth: { login }, account: { me: vi.fn() } } },
      { provide: Router, useValue: { navigate } },
    ],
  })
  return { fixture: TestBed.createComponent(LoginPage), navigate }
}

describe('LoginPage', () => {
  it('stores the user and navigates on success', async () => {
    const user = { id: '1', username: 'marc', isAdmin: false }
    const { fixture, navigate } = setup(vi.fn().mockResolvedValue(user))
    fixture.componentInstance.model.set({ username: 'marc', password: 'a good long password' })

    await fixture.componentInstance.onSubmit()

    expect(TestBed.inject(AuthStore).user()).toEqual(user)
    expect(navigate).toHaveBeenCalledWith(['/projects'])
    expect(fixture.componentInstance.errorKey()).toBeNull()
  })

  it('shows one generic message for any credential failure', async () => {
    const { fixture, navigate } = setup(
      vi.fn().mockRejectedValue(new AppError('Unauthorized', 'nope')),
    )
    fixture.componentInstance.model.set({ username: 'marc', password: 'wrong password' })

    await fixture.componentInstance.onSubmit()

    expect(fixture.componentInstance.errorKey()).toBe('signInFailed')
    expect(navigate).not.toHaveBeenCalled()
  })

  // Ruling 53: an invalid model (per the shared loginSchema) must never reach the network —
  // it would only be rejected by the server, and it would burn the auth rate-limit budget on
  // a request the client already knew was bad.
  it('does not call the API when the model is invalid', async () => {
    const login = vi.fn()
    const { fixture, navigate } = setup(login)
    fixture.componentInstance.model.set({ username: '', password: '' })

    await fixture.componentInstance.onSubmit()

    expect(login).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
