import type { Route } from '../router.ts'
import { authRoutes } from './auth.ts'
import { capabilityRoutes } from './capabilities.ts'

export const routes: Route[] = [...capabilityRoutes, ...authRoutes]
