import { ActivatedRoute } from '@angular/router'
import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AppError } from '@spm/contract/errors.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'
import { ActivatePage } from './activate.page'
import { provideJigForTests } from '../../../testing/jig'

async function setup(fragment: string | null, checkToken = vi.fn()) {
  const api = { auth: { checkToken, activate: vi.fn() } }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      { provide: API_CLIENT, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { fragment } } },
    ],
  })
  // Mirror the app initializer's guarantee (see app.config.ts): no page renders until
  // translations() has been populated. This must happen *before* the component is created —
  // ActivatePage's constructor kicks off `check()` immediately (a separate, unawaited
  // promise chain), and the mocked `checkToken` can resolve, flip `state`, and trigger a
  // render of the 'invalid'/'ready' branch (which reads `t.translations()`) before the real
  // TranslateService has loaded 'en', regardless of what this function awaits afterward.
  await TestBed.inject(TranslateService).ready
  const fixture = TestBed.createComponent(ActivatePage)
  return { fixture, api }
}

describe('ActivatePage', () => {
  it('reports an invalid link when the fragment is missing', async () => {
    const { fixture } = await setup(null)
    await TestBed.inject(ApplicationRef).whenStable()
    expect(fixture.componentInstance.state()).toBe('invalid')
  })

  it('checks the token before asking for a password', async () => {
    const checkToken = vi.fn().mockResolvedValue({ valid: true, username: 'anna' })
    const { fixture } = await setup('sometoken', checkToken)
    await TestBed.inject(ApplicationRef).whenStable()

    expect(checkToken).toHaveBeenCalledWith('sometoken')
    expect(fixture.componentInstance.state()).toBe('ready')
    expect(fixture.componentInstance.username()).toBe('anna')
  })

  it('reports an expired link as invalid', async () => {
    const { fixture } = await setup('expired', vi.fn().mockResolvedValue({ valid: false }))
    await TestBed.inject(ApplicationRef).whenStable()
    expect(fixture.componentInstance.state()).toBe('invalid')
  })

  // Ruling 53: an invalid model (per the shared activateSchema — e.g. a too-short password)
  // must never reach the network.
  it('does not call the API when the model is invalid', async () => {
    const checkToken = vi.fn().mockResolvedValue({ valid: true, username: 'anna' })
    const { fixture, api } = await setup('sometoken', checkToken)
    await TestBed.inject(ApplicationRef).whenStable()

    fixture.componentInstance.model.set({ password: 'short', confirm: 'short' })
    await fixture.componentInstance.onSubmit()

    expect(api.auth.activate).not.toHaveBeenCalled()
    expect(fixture.componentInstance.state()).toBe('ready')
  })

  // Ruling 54: only a dead token (InvalidToken / TokenExpired / NotFound) means the link
  // itself is invalid. Anything else — a policy rejection, a rate limit, a transient
  // failure — must leave the working link's form up so the user can correct and retry.
  it('keeps state ready and shows an error when activation fails for a non-token reason', async () => {
    const checkToken = vi.fn().mockResolvedValue({ valid: true, username: 'anna' })
    const { fixture, api } = await setup('sometoken', checkToken)
    api.auth.activate = vi.fn().mockRejectedValue(new AppError('Validation', 'rejected'))
    await TestBed.inject(ApplicationRef).whenStable()

    fixture.componentInstance.model.set({
      password: 'a good long password',
      confirm: 'a good long password',
    })
    await fixture.componentInstance.onSubmit()

    expect(fixture.componentInstance.state()).toBe('ready')
    expect(fixture.componentInstance.formError()).toBe(true)
  })

  // Ruling 55: activateSchema is a `.refine()`d schema whose mismatch issue carries
  // `path: ['confirm']`. Prove validateStandardSchema actually maps that path onto the
  // `confirm` field, rather than the form root or nowhere.
  it('attaches the password-mismatch error to the confirm field specifically', async () => {
    const checkToken = vi.fn().mockResolvedValue({ valid: true, username: 'anna' })
    const { fixture } = await setup('sometoken', checkToken)
    await TestBed.inject(ApplicationRef).whenStable()

    fixture.componentInstance.model.set({
      password: 'a good long password',
      confirm: 'a different password',
    })

    expect(fixture.componentInstance.activateForm.confirm().errors().length).toBeGreaterThan(0)
    expect(fixture.componentInstance.activateForm.password().errors()).toEqual([])
  })
})
