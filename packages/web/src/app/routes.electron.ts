import type { Routes } from '@angular/router'
import { sharedRoutes } from './routes.shared'

/**
 * Desktop-only routes live here and are referenced from nowhere else, so the web build cannot
 * pull them in. Spec D adds /settings/slicers, spec E adds /browse, both under
 * ./features/desktop/*, replacing the placeholder below.
 *
 * `fileReplacements` swaps this file in for routes.ts, so it must import the shared list from
 * routes.shared.ts: './routes' would be replaced with this very file.
 */
export const routes: Routes = [
  ...sharedRoutes,
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
