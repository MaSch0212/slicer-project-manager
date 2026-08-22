import type { Route } from '../router.ts'
import { accountRoutes } from './account.ts'
import { authRoutes } from './auth.ts'
import { capabilityRoutes } from './capabilities.ts'
import { projectRoutes } from './projects.ts'
import { userRoutes } from './users.ts'

export const routes: Route[] = [
  ...capabilityRoutes,
  ...authRoutes,
  ...accountRoutes,
  ...userRoutes,
  ...projectRoutes,
]
