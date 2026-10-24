import {
  changePasswordSchema,
  profilePatchSchema,
  settingsPatchSchema,
} from '@spm/contract/schemas.ts'
import { changePassword, getSettings, me, putSettings, updateProfile } from '@spm/core'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

export const accountRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/account',
    auth: 'session',
    handler: ({ env, ctx }) => json(me(env.lib, ctx)),
  },
  {
    method: 'PATCH',
    path: '/api/account',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const patch = await parseJson(req, profilePatchSchema)
      return json(updateProfile(env.lib, ctx, patch))
    },
  },
  {
    method: 'POST',
    path: '/api/account/password',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const input = await parseJson(req, changePasswordSchema)
      await changePassword(env.lib, ctx, input.current, input.next)
      return noContent()
    },
  },
  {
    method: 'GET',
    path: '/api/account/settings',
    auth: 'session',
    handler: ({ env, ctx }) => json(getSettings(env.lib, ctx)),
  },
  {
    method: 'PUT',
    path: '/api/account/settings',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const patch = await parseJson(req, settingsPatchSchema)
      return json(putSettings(env.lib, ctx, patch))
    },
  },
]
