import type { Route } from '@angular/router'
import { describe, expect, it } from 'vitest'
import { authGuard } from './core/guards'
import { routes as electronRoutes } from './routes.electron'
import { routes as webRoutes } from './routes'

/**
 * The one thing about the settings route that no component spec can see.
 *
 * `/settings` is declared once, in routes.shared.ts, as a parent with a General child;
 * routes.electron.ts appends the Slicers child to that same parent. Nothing about that
 * arrangement fails loudly if it comes apart — a `settings` route the derivation no longer
 * recognises, or a guard that moves off the parent, leaves a desktop build whose
 * `/settings/slicers` quietly falls through to the `**` redirect.
 *
 * No component is loaded here: every entry is a `loadComponent` thunk, and this file never calls
 * one, so asserting on the desktop route list does not pull `DesktopSlicersPage` into anything.
 */
function settingsRoute(routes: Route[]): Route {
  const route = routes.find((entry) => entry.path === 'settings')
  if (!route) throw new Error('no settings route')
  return route
}

describe('the settings route', () => {
  it('is a guarded parent in both builds, and the guard is on the parent', () => {
    for (const routes of [webRoutes, electronRoutes]) {
      expect(settingsRoute(routes).canActivate).toEqual([authGuard])
    }
  })

  it('has the General child in both builds', () => {
    for (const routes of [webRoutes, electronRoutes]) {
      expect(settingsRoute(routes).children?.map((child) => child.path)).toContain('')
    }
  })

  it('has the Slicers child in the desktop build and only there', () => {
    expect(settingsRoute(electronRoutes).children?.map((child) => child.path)).toEqual([
      '',
      'slicers',
    ])
    expect(settingsRoute(webRoutes).children?.map((child) => child.path)).toEqual([''])
  })

  it('carries no second guard on the Slicers child, so the two cannot drift', () => {
    const slicers = settingsRoute(electronRoutes).children?.find(
      (child) => child.path === 'slicers',
    )
    expect(slicers).toBeDefined()
    expect(slicers?.canActivate).toBeUndefined()
  })

  it('is not also a top-level settings/slicers entry', () => {
    expect(electronRoutes.map((route) => route.path)).not.toContain('settings/slicers')
  })
})
