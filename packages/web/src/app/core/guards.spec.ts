import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import {
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  type RouterStateSnapshot,
} from '@angular/router'
import type { Capabilities } from '@spm/contract/dtos.ts'
import { AuthStore } from './auth.store'
import { CapabilitiesStore } from './capabilities.store'
import { adminGuard, authGuard } from './guards'

const SERVED: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

/** Electron local mode: no session exists at all, so nothing may depend on one (spec 2.6). */
const LOCAL: Capabilities = { ...SERVED, requiresAuth: false, canManageUsers: false }

function run(
  guard: CanActivateFn,
  capabilities: Capabilities,
  session: { isAuthenticated: boolean; isAdmin: boolean },
): boolean | UrlTree {
  TestBed.resetTestingModule()
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: CapabilitiesStore, useValue: { capabilities: signal(capabilities) } },
      {
        provide: AuthStore,
        useValue: {
          isAuthenticated: signal(session.isAuthenticated),
          isAdmin: signal(session.isAdmin),
        },
      },
    ],
  })
  return TestBed.runInInjectionContext(
    () => guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot) as boolean | UrlTree,
  )
}

describe('authGuard', () => {
  it('sends an anonymous visitor of a served app to the login page', () => {
    const result = run(authGuard, SERVED, { isAuthenticated: false, isAdmin: false })
    expect(result).toBeInstanceOf(UrlTree)
    expect(String(result)).toBe('/login')
  })

  it('lets a signed-in user through', () => {
    expect(run(authGuard, SERVED, { isAuthenticated: true, isAdmin: false })).toBe(true)
  })

  it('lets everyone through when the shell does not require auth', () => {
    // The one branch that grants access with no session: a regression here is an auth bypass
    // in the served build, not a cosmetic bug.
    expect(run(authGuard, LOCAL, { isAuthenticated: false, isAdmin: false })).toBe(true)
  })
})

describe('adminGuard', () => {
  it('lets an admin into user administration', () => {
    expect(run(adminGuard, SERVED, { isAuthenticated: true, isAdmin: true })).toBe(true)
  })

  it('bounces a non-admin back to the projects list', () => {
    const result = run(adminGuard, SERVED, { isAuthenticated: true, isAdmin: false })
    expect(result).toBeInstanceOf(UrlTree)
    expect(String(result)).toBe('/projects')
  })

  it('bounces even an admin when the shell cannot manage users', () => {
    const result = run(adminGuard, LOCAL, { isAuthenticated: true, isAdmin: true })
    expect(result).toBeInstanceOf(UrlTree)
    expect(String(result)).toBe('/projects')
  })
})
