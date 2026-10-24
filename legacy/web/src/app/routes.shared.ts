import type { Routes } from '@angular/router'
import { adminGuard, authGuard } from './core/guards'

/**
 * Every route both shells have, without the `**` fallback so each shell can append its own
 * routes after these. This lives outside routes.ts because `fileReplacements` swaps routes.ts
 * for routes.electron.ts at module-resolution level: were the electron variant to import
 * './routes', that specifier would be replaced too and the file would import itself.
 */
export const sharedRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'projects' },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'activate',
    loadComponent: () => import('./features/auth/activate.page').then((m) => m.ActivatePage),
  },
  {
    path: 'projects',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/projects.page').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/project-detail.page').then((m) => m.ProjectDetailPage),
  },
  {
    // Lazy on purpose and load-bearing: this is the only route that reaches three.js, and
    // keeping the import inside the loaded component is what keeps the whole viewer-page
    // chunk — three's core plus the STL, OBJ and 3MF loaders, comfortably larger than the
    // entire rest of the shell put together — out of the initial bundle.
    path: 'projects/:id/view/:fileId',
    canActivate: [authGuard],
    loadComponent: () => import('./features/viewer/viewer.page').then((m) => m.ViewerPage),
  },
  {
    path: 'import',
    canActivate: [authGuard],
    loadComponent: () => import('./features/import/import.page').then((m) => m.ImportPage),
  },
  {
    /*
     * A parent with children, because the settings page is a tab strip over a `<router-outlet />`
     * (spec G 6) and each tab is a real URL. Both builds have this parent and both have the
     * General child; routes.electron.ts appends the desktop-only Slicers child to the same
     * `children` array, so the two builds agree about the shape of the route they share instead
     * of one declaring a leaf and the other a sibling that only looked like a child.
     *
     * `canActivate` sits on the parent and covers every child, which is what keeps
     * `/settings/slicers` guarded from the file that does not declare it, and what makes a guard
     * that drifts between the two impossible rather than merely unlikely.
     */
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/settings/general.tab').then((m) => m.SettingsGeneralTab),
      },
    ],
  },
  {
    path: 'admin/users',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./features/admin/users.page').then((m) => m.UsersPage),
  },
]
