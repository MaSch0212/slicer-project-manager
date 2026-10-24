import type { Routes } from '@angular/router'
import { sharedRoutes } from './routes.shared'

/** The web shell: the shared routes and nothing else. */
export const routes: Routes = [...sharedRoutes, { path: '**', redirectTo: 'projects' }]
