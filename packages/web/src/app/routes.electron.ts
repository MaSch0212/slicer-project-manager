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
    path: 'desktop',
    loadComponent: () =>
      import('./features/desktop/placeholder.page').then((m) => m.DesktopPlaceholderPage),
  },
  { path: '**', redirectTo: 'projects' },
]
