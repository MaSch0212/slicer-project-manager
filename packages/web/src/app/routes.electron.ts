import type { Routes } from '@angular/router'
import { authGuard } from './core/guards'
import { sharedRoutes } from './routes.shared'

/**
 * Desktop-only routes live here and are referenced from nowhere else, so the web build cannot
 * pull them in. Spec D added /settings/slicers; spec E adds /browse, under ./features/desktop/*,
 * replacing the placeholder below.
 *
 * `fileReplacements` swaps this file in for routes.ts, so it must import the shared list from
 * routes.shared.ts: './routes' would be replaced with this very file.
 */
export const routes: Routes = [
  ...sharedRoutes,
  {
    /*
     * Spec D 8.4. Guarded exactly as `/settings` is in routes.shared.ts, and for the reason the
     * guard is written the way it is (`!capabilities.requiresAuth || auth.isAuthenticated()`): in
     * local mode `requiresAuth` is false and it passes on the first arm, while in remote mode an
     * unauthenticated window has no business anywhere but /login.
     *
     * A child of `settings` in path only. It is a sibling here because `/settings` is a shared
     * route with no children, and giving it some from this file would mean the two builds
     * disagreed about the shape of a route they both have.
     */
    path: 'settings/slicers',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/desktop/slicers/slicers.page').then((m) => m.DesktopSlicersPage),
  },
  {
    /*
     * Where the shell sends the window when the user answers its mode question with "a server".
     * No guard: it is the page that decides which library there is, so it has to work with no
     * library, no session and `requiresAuth` unknown — the state every guard in the app exists
     * to keep users out of.
     *
     * Listed before the bare `desktop` route: a leaf route only matches when it consumes the
     * whole URL, so the order is not load-bearing today — but it would become so the moment
     * `desktop` grew children, and the more specific path reading first costs nothing.
     */
    path: 'desktop/connect',
    loadComponent: () =>
      import('./features/desktop/connect.page').then((m) => m.DesktopConnectPage),
  },
  {
    path: 'desktop',
    loadComponent: () =>
      import('./features/desktop/placeholder.page').then((m) => m.DesktopPlaceholderPage),
  },
  { path: '**', redirectTo: 'projects' },
]
