import { createUserSchema, updateUserSchema } from '@spm/contract/schemas.ts'
import { createUser, deleteUser, listUsers, reissueInvite, updateUser } from '@spm/core'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

/** The token rides in the fragment, so it never reaches a server log (spec 5.3). */
export function activationUrl(url: URL, token: string): string {
  return `${url.origin}/activate#${token}`
}

export const userRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/users',
    auth: 'session',
    handler: ({ env, ctx }) => json(listUsers(env.lib, ctx)),
  },
  {
    method: 'POST',
    path: '/api/users',
    auth: 'session',
    handler: async ({ req, url, env, ctx }) => {
      const input = await parseJson(req, createUserSchema)
      const { user, token } = await createUser(env.lib, ctx, input)
      // Returned once, for the admin to copy out of band. No SMTP (spec 5.7).
      return json({ user, activationUrl: activationUrl(url, token) })
    },
  },
  {
    method: 'POST',
    path: '/api/users/:id/invite',
    auth: 'session',
    handler: async ({ url, params, env, ctx }) => {
      const { token } = await reissueInvite(env.lib, ctx, params.id!)
      return json({ activationUrl: activationUrl(url, token) })
    },
  },
  {
    method: 'PATCH',
    path: '/api/users/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const patch = await parseJson(req, updateUserSchema)
      return json(updateUser(env.lib, ctx, params.id!, patch))
    },
  },
  {
    method: 'DELETE',
    path: '/api/users/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      deleteUser(env.lib, ctx, params.id!)
      return noContent()
    },
  },
]
