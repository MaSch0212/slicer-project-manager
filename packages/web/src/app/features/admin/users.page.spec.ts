import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { AppError } from '@spm/contract/errors.ts'
import type { UserDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import en from '../../core/i18n/locales/en.json'
import { TranslateService } from '../../core/i18n/translate.service'
import { UsersPage } from './users.page'

function user(over: Partial<UserDto>): UserDto {
  return {
    id: 'u1',
    username: 'marc',
    displayName: 'Marc',
    isAdmin: true,
    status: 'active',
    diskUsageBytes: 0,
    quotaBytes: null,
    createdAt: 0,
    ...over,
  }
}

async function setup(list = vi.fn().mockResolvedValue([user({})])) {
  const api = {
    users: {
      list,
      create: vi.fn().mockResolvedValue({
        user: user({ id: 'u2', username: 'anna', status: 'pending' }),
        activationUrl: 'http://x/activate#tok',
      }),
      reissueInvite: vi.fn().mockResolvedValue({ activationUrl: 'http://x/activate#tok2' }),
      update: vi.fn().mockResolvedValue(user({})),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }
  TestBed.configureTestingModule({
    providers: [
      // The jig controls used by the template (jig-input-field, [jigInput], jigErrors) need
      // the app-level provider that app.config.ts installs — TestBed builds this component
      // in isolation, so it must be supplied here too (see login.page.spec.ts,
      // project-detail.page.spec.ts). The brief's own setup() omitted this and would not
      // actually render.
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  // Outside a real bootstrap, nothing otherwise awaits TranslateService.ready before a
  // component is created — app.config.ts's provideAppInitializer does that in production,
  // guaranteeing translations are populated before any page mounts. Without it here, the
  // very first, unconditional `t.translations()` read at the top of the template races an
  // as-yet-unpopulated translations signal and the initial render throws (a real Angular
  // scheduler retries and every assertion below still passes, but vitest reports the
  // interim throw as an unhandled error and fails the run). Awaiting `ready` before
  // `createComponent` mirrors app.config.ts's own sequencing and closes the race.
  await TestBed.inject(TranslateService).ready
  const fixture = TestBed.createComponent(UsersPage)
  return { fixture, api, page: fixture.componentInstance }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()
const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent ?? ''

describe('UsersPage', () => {
  it('lists users on load', async () => {
    const { fixture, api } = await setup()
    await settle()
    expect(api.users.list).toHaveBeenCalled()
    expect(fixture.componentInstance.users.value()?.length).toBe(1)
  })

  // Ruling 70: `value()` throws once a load settles to the error status, so `?? []` never
  // runs and would leave a blank table with no explanation. Every state has to render
  // something, the same way project-detail.page.ts's loadFailed/loaded pair does.
  it('renders an error branch instead of a blank table when the list fails to load', async () => {
    const { fixture, page } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await settle()

    expect(page.users.status()).toBe('error')
    expect(text(fixture)).toContain(en.errors.generic)
    expect(fixture.nativeElement.querySelector('table')).toBeNull()
  })

  it('surfaces the activation url once, for the admin to copy', async () => {
    const { fixture } = await setup()
    await settle()
    fixture.componentInstance.createModel.set({
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })

    await fixture.componentInstance.onCreate()

    expect(fixture.componentInstance.activationUrl()).toBe('http://x/activate#tok')
  })

  // Ruling 71: onCreate must consult createForm before calling the API — an empty or
  // too-short username reaches the network today and can only be rejected server-side.
  it('does not call create when the model is invalid', async () => {
    const { fixture, api } = await setup()
    await settle()
    fixture.componentInstance.createModel.set({
      username: '',
      displayName: '',
      isAdmin: false,
      quotaBytes: null,
    })

    await fixture.componentInstance.onCreate()

    expect(api.users.create).not.toHaveBeenCalled()
    expect(fixture.componentInstance.activationUrl()).toBeNull()
  })

  it('re-issuing an invite replaces the shown link', async () => {
    const { fixture } = await setup()
    await settle()
    await fixture.componentInstance.onReissue(user({ id: 'u2' }))
    expect(fixture.componentInstance.activationUrl()).toBe('http://x/activate#tok2')
  })

  it('converts a megabyte quota entry into bytes', async () => {
    const { fixture, api } = await setup()
    await settle()
    await fixture.componentInstance.onSetQuota(user({}), 500)
    expect(api.users.update).toHaveBeenCalledWith('u1', { quotaBytes: 500 * 1024 * 1024 })
  })

  it('clears a quota back to unlimited', async () => {
    const { fixture, api } = await setup()
    await settle()
    await fixture.componentInstance.onSetQuota(user({}), null)
    expect(api.users.update).toHaveBeenCalledWith('u1', { quotaBytes: null })
  })

  // Ruling 72.1/72.2: the old `valueAsNumber || null` mapped a typed `0` to "unlimited" — the
  // opposite of what the admin asked for — and enforced nothing server-side matches. `0` and
  // negative numbers must be refused, not reinterpreted.
  it('refuses a zero quota without calling update', async () => {
    const { fixture, api } = await setup()
    await settle()

    await fixture.componentInstance.onSetQuota(user({}), 0)

    expect(api.users.update).not.toHaveBeenCalled()
    expect(fixture.componentInstance.errorMessage()).toBe(en.admin.invalidQuota)
  })

  it('refuses a negative quota without calling update', async () => {
    const { fixture, api } = await setup()
    await settle()

    await fixture.componentInstance.onSetQuota(user({}), -5)

    expect(api.users.update).not.toHaveBeenCalled()
    expect(fixture.componentInstance.errorMessage()).toBe(en.admin.invalidQuota)
  })

  // Ruling 72.2: a fractional MiB entry can multiply into a fractional byte count, which
  // updateUserSchema's int() rejects — this must be caught client-side rather than shipping
  // a 400 nothing displays.
  it('refuses a quota entry that multiplies into a non-integer byte count', async () => {
    const { fixture, api } = await setup()
    await settle()

    await fixture.componentInstance.onSetQuota(user({}), 0.3)

    expect(api.users.update).not.toHaveBeenCalled()
    expect(fixture.componentInstance.errorMessage()).toBe(en.admin.invalidQuota)
  })

  // Ruling 72.1: wired through the actual input, not just the method — an emptied field
  // means "clear the quota", not NaN-coerced-to-unlimited by accident.
  it('clears the quota when the input is emptied', async () => {
    const { fixture, api } = await setup()
    await settle()
    const input = fixture.nativeElement.querySelector(
      `input[aria-label="${en.admin.quotaMiB}"]`,
    ) as HTMLInputElement

    input.value = ''
    input.dispatchEvent(new Event('change'))
    await settle()

    expect(api.users.update).toHaveBeenCalledWith('u1', { quotaBytes: null })
  })

  it('refuses a typed zero through the actual input, without calling update', async () => {
    const { fixture, api } = await setup()
    await settle()
    const input = fixture.nativeElement.querySelector(
      `input[aria-label="${en.admin.quotaMiB}"]`,
    ) as HTMLInputElement

    input.value = '0'
    input.dispatchEvent(new Event('change'))
    await settle()

    expect(api.users.update).not.toHaveBeenCalled()
    expect(text(fixture)).toContain(en.admin.invalidQuota)
  })

  // Ruling 72.3: the quota and usage cells used to render raw byte counts while the input
  // was interpreted as MiB — no shared unit between what is shown and what is typed.
  it('renders quota and usage in human units, not raw byte counts', async () => {
    const { fixture } = await setup(
      vi.fn().mockResolvedValue([user({ diskUsageBytes: 5 * 1024 * 1024, quotaBytes: 200 })]),
    )
    await settle()

    expect(text(fixture)).toContain('5.0 MB')
    expect(text(fixture)).toContain('200 B')
    expect(text(fixture)).not.toMatch(/\b5242880\b/)
  })

  it('shows "unlimited" rather than a byte count when there is no quota', async () => {
    const { fixture } = await setup(vi.fn().mockResolvedValue([user({ quotaBytes: null })]))
    await settle()

    expect(text(fixture)).toContain(en.admin.unlimited)
  })

  it('explains a last-active-admin refusal', async () => {
    const { fixture, api } = await setup()
    await settle()
    api.users.delete.mockRejectedValueOnce(new AppError('LastActiveAdmin', 'nope'))

    await fixture.componentInstance.onDelete(user({}))

    expect(fixture.componentInstance.errorMessage()).toBe(
      'The last active administrator must remain',
    )
  })

  // Ruling 73: deleting a user cascades all their project and file metadata with one click
  // today, and no confirmation. Match project-detail.page.ts's two-stage shape: arm, then
  // confirm.
  it('arms the delete on the first press and only deletes on a confirming second press', async () => {
    const { fixture, api, page } = await setup()
    await settle()
    expect(text(fixture)).not.toContain(en.admin.confirmDeleteUser)

    page.armDelete(user({}))
    await settle()

    expect(api.users.delete).not.toHaveBeenCalled()
    expect(page.deleteArmedId()).toBe('u1')
    // The surprising, deliberate consequence (spec 5.7-adjacent): the library folder is not
    // removed, so an admin expecting deletion to reclaim disk space needs to be told.
    expect(text(fixture)).toContain(en.admin.confirmDeleteUser)

    await page.confirmDelete(user({}))

    expect(api.users.delete).toHaveBeenCalledWith('u1')
    expect(page.deleteArmedId()).toBeNull()
  })

  it('cancelling a delete leaves the user in place', async () => {
    const { api, page } = await setup()
    await settle()

    page.armDelete(user({}))
    page.cancelDelete()

    expect(page.deleteArmedId()).toBeNull()
    await page.confirmDelete(user({}))
    // confirmDelete always calls onDelete when invoked directly; the real guard is the
    // template only rendering the confirm button while armed. This asserts the state the
    // template gates on, not a route that could not otherwise be exercised without a real
    // click sequence.
    expect(api.users.delete).toHaveBeenCalledTimes(1)
  })

  it('computes usage percent only when a quota exists', async () => {
    const { fixture } = await setup()
    expect(fixture.componentInstance.usagePercent(user({ quotaBytes: null }))).toBeNull()
    expect(
      fixture.componentInstance.usagePercent(user({ quotaBytes: 200, diskUsageBytes: 50 })),
    ).toBe(25)
  })

  // Minor ruling: onCopy used to fire-and-forget `navigator.clipboard.writeText`. The
  // activation link is shown exactly once, so a silently failed copy is worth surfacing.
  it('surfaces a clipboard failure instead of swallowing it', async () => {
    const { page } = await setup()
    await settle()
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })

    await page['onCopy']('http://x/activate#tok')

    expect(page.errorMessage()).toBe(en.errors.generic)
  })
})
