import { TestBed } from '@angular/core/testing'
import { Router, provideRouter } from '@angular/router'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { nova } from '@awdlab/jig-themes/nova'
import { describe, expect, it, vi } from 'vitest'
import { API_CLIENT } from './core/api/api-client.token'
import { AuthStore } from './core/auth.store'
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

async function setup(logout = vi.fn().mockResolvedValue(undefined)) {
  const api = {
    auth: { logout },
    account: { me: vi.fn().mockResolvedValue(USER) },
    settings: { get: vi.fn(), put: vi.fn() },
    capabilities: { get: vi.fn().mockResolvedValue({ requiresAuth: true, canManageUsers: true }) },
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
      ...provideJigControls({ theme: { preset: nova } }, withAutoColorScheme()),
    ],
  }).compileComponents()

  // Before createComponent: TestBed auto-detects changes and the template reads
  // t.translations() unguarded (app.config.ts awaits this same promise before bootstrap).
  await TestBed.inject(TranslateService).ready
  const auth = TestBed.inject(AuthStore)
  auth.setUser(USER)
  const router = TestBed.inject(Router)
  await router.navigateByUrl('/projects')

  const fixture = TestBed.createComponent(App)
  return { fixture, api, auth, router, app: fixture.componentInstance }
}

describe('App', () => {
  it('should create the app', async () => {
    const { fixture } = await setup()
    expect(fixture.componentInstance).toBeTruthy()
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
