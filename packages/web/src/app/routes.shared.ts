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
    // keeping the import inside the loaded component keeps the whole 549 kB viewer-page
    // chunk (measured) out of the shell's 655 kB initial bundle.
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
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: 'admin/users',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./features/admin/users.page').then((m) => m.UsersPage),
  },
]
