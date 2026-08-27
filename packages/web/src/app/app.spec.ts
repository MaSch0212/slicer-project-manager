import { TestBed } from '@angular/core/testing'
import { Router, provideRouter } from '@angular/router'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { withDefaultIcons } from '@awdlab/jig/default-icons'
import { nova } from '@awdlab/jig-themes/nova'
import { describe, expect, it, vi } from 'vitest'
import { API_CLIENT } from './core/api/api-client.token'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { TranslateService } from './core/i18n/translate.service'
import { App } from './app'

const USER = {
  id: 'u1',
  username: 'marc',
  displayName: 'Marc',
  isAdmin: true,
  status: 'active' as const,
  quotaBytes: null,
  diskUsageBytes: 0,
  createdAt: 0,
}

const WEB_CAPABILITIES = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

async function setup(
  logout = vi.fn().mockResolvedValue(undefined),
  capabilities = WEB_CAPABILITIES,
  pick = vi.fn().mockResolvedValue({ dir: '/libraries/models' }),
) {
  const api = {
    auth: { logout },
    account: { me: vi.fn().mockResolvedValue(USER) },
    settings: { get: vi.fn(), put: vi.fn() },
    library: { pick },
    // A function, because that is what `ApiClient.capabilities` is and what
    // `CapabilitiesStore.load()` calls. It used to be `{ get: … }` here, which nothing ever
    // called, so the store sat on its offline defaults and the shell was only ever rendered
    // for one capability set.
    capabilities: vi.fn().mockResolvedValue(capabilities),
  }
  await TestBed.configureTestingModule({
    imports: [App],
    // Mirrors app.config.ts: App injects ColorSchemeService directly, which needs
    // COLOR_SCHEME_STORAGE provided (only withAutoColorScheme() supplies it).
    providers: [
      provideRouter([
        { path: 'login', children: [] },
        { path: 'projects', children: [] },
      ]),
      { provide: API_CLIENT, useValue: api },
      // withDefaultIcons(): the shell renders jig-icon in its nav, and an icon slot with no
      // registry throws at render rather than degrading.
      ...provideJigControls({ theme: { preset: nova } }, withDefaultIcons(), withAutoColorScheme()),
    ],
  }).compileComponents()

  // Before createComponent: TestBed auto-detects changes and the template reads
  // t.translations() unguarded (app.config.ts awaits this same promise before bootstrap).
  await TestBed.inject(TranslateService).ready
  const auth = TestBed.inject(AuthStore)
  auth.setUser(USER)
  const capabilityStore = TestBed.inject(CapabilitiesStore)
  await capabilityStore.load()
  const router = TestBed.inject(Router)
  await router.navigateByUrl('/projects')

  const fixture = TestBed.createComponent(App)
  return { fixture, api, auth, router, app: fixture.componentInstance }
}

/** The sign-out control, found the way a screen reader finds it. */
function signOutButtons(fixture: { nativeElement: unknown }): NodeListOf<Element> {
  return (fixture.nativeElement as HTMLElement).querySelectorAll('[aria-label="Sign out"]')
}

function changeFolderButtons(fixture: { nativeElement: unknown }): NodeListOf<Element> {
  return (fixture.nativeElement as HTMLElement).querySelectorAll(
    '[aria-label="Change library folder"]',
  )
}

describe('App', () => {
  it('should create the app', async () => {
    const { fixture } = await setup()
    expect(fixture.componentInstance).toBeTruthy()
  })

  /**
   * The sign-out control is gated on a capability so the Electron shell — which has no sessions —
   * does not offer to end one. That gate is in shared renderer code, and the desktop suite only
   * asserts the *absence*: changing the expression to any other always-false capability removed
   * sign-out from the browser build with 247 vitest and 12 e2e tests still green. Both directions,
   * so the pair actually pins the expression.
   */
  it('shows sign-out where there is a session to end', async () => {
    const { fixture } = await setup()
    fixture.detectChanges()
    expect(signOutButtons(fixture)).toHaveLength(1)
  })

  it('offers no sign-out where the shell requires no authentication', async () => {
    const { fixture } = await setup(undefined, { ...WEB_CAPABILITIES, requiresAuth: false })
    fixture.detectChanges()
    expect(signOutButtons(fixture)).toHaveLength(0)
    // The rest of the navigation is still there — otherwise gating the whole block off would
    // pass the line above for the wrong reason.
    const links = [...(fixture.nativeElement as HTMLElement).querySelectorAll('a')].map((a) =>
      a.textContent?.trim(),
    )
    expect(links).toEqual(expect.arrayContaining(['Projects', 'Import', 'Settings']))
  })

  // The shell used to bind (click)="auth.logout()" directly. AuthStore.logout clears local
  // state in a `finally` and rethrows, so nothing navigated: a *successful* sign-out left
  // the user sitting on /projects with the grid still rendered.
  it('leaves the authenticated area after a successful sign-out', async () => {
    const { app, auth, router } = await setup()

    await app.onSignOut()

    expect(auth.isAuthenticated()).toBe(false)
    expect(router.url).toBe('/login')
    expect(app.signOutFailed()).toBe(false)
  })

  /**
   * The desktop shell's folder picker reaches the UI as a capability and an `ApiClient` call, and
   * nothing else: spec 2.4's whole point is that no component knows which shell it is in. Both
   * directions, so the pair pins the expression rather than the flag's current value.
   */
  it('offers no folder picker where the shell cannot open a local folder', async () => {
    const { fixture } = await setup()
    fixture.detectChanges()
    expect(changeFolderButtons(fixture)).toHaveLength(0)
  })

  it('offers the folder picker where the shell can open one, and asks the shell for it', async () => {
    const pick = vi.fn().mockResolvedValue({ dir: '/libraries/models' })
    const { fixture, app } = await setup(
      undefined,
      { ...WEB_CAPABILITIES, requiresAuth: false, canPickLocalFolder: true },
      pick,
    )
    fixture.detectChanges()
    expect(changeFolderButtons(fixture)).toHaveLength(1)

    ;(changeFolderButtons(fixture)[0] as HTMLButtonElement).click()
    await fixture.whenStable()

    expect(pick).toHaveBeenCalledTimes(1)
    // Nothing else: the shell owns the reload, because it is the only side that knows the stores
    // in this renderer are now holding a closed library's data.
    expect(app.changeFolderFailed()).toBe(false)
  })

  it('reports a folder that would not open instead of rejecting', async () => {
    const pick = vi.fn().mockRejectedValue(new Error('no such folder'))
    const { fixture, app } = await setup(
      undefined,
      { ...WEB_CAPABILITIES, requiresAuth: false, canPickLocalFolder: true },
      pick,
    )

    await expect(app.onChangeFolder()).resolves.toBeUndefined()

    expect(app.changeFolderFailed()).toBe(true)
    fixture.detectChanges()
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull()
  })

  it('surfaces a failed sign-out in a role="alert" instead of rejecting', async () => {
    const { fixture, app, auth, router } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(app.onSignOut()).resolves.toBeUndefined()

    expect(app.signOutFailed()).toBe(true)
    fixture.detectChanges()
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull()
    // logout() clears local state in a finally, so the user really is signed out here and
    // the shell must not keep showing the authenticated area either way.
    expect(auth.isAuthenticated()).toBe(false)
    expect(router.url).toBe('/login')
  })
})
