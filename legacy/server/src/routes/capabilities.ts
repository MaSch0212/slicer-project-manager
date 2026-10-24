import type { Capabilities } from '@spm/contract/dtos.ts'
import { json } from '../json.ts'
import type { Route } from '../router.ts'

export const SERVER_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

export const capabilityRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/capabilities',
    auth: 'public',
    handler: () => json(SERVER_CAPABILITIES),
  },
]
