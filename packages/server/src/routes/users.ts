import { createUserSchema, updateUserSchema } from '@spm/contract/schemas.ts'
import { createUser, deleteUser, listUsers, reissueInvite, updateUser } from '@spm/core'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

/**
 * Turns a configured `SPM_PUBLIC_ORIGIN` into a bare origin, or throws.
 *
 * Normalising means a trailing slash or a stray path in the env var cannot produce
 * `https://host//activate#tok`. Throwing on anything that is not an http(s) URL is
 * deliberate: this runs at module load, so a typo stops the server rather than quietly
 * reverting to the `http://` links this setting exists to avoid.
 */
export function normalizePublicOrigin(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`SPM_PUBLIC_ORIGIN is not a valid absolute URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SPM_PUBLIC_ORIGIN must be an http(s) URL: ${raw}`)
  }
  return parsed.origin
}

const configured = Deno.env.get('SPM_PUBLIC_ORIGIN')?.trim()
const PUBLIC_ORIGIN = configured ? normalizePublicOrigin(configured) : undefined

/**
 * The token rides in the fragment, so it never reaches a server log (spec 5.3).
 *
 * The origin comes from `SPM_PUBLIC_ORIGIN` when set, otherwise from the request. Deno
 * derives `url.origin`'s scheme from its own listener, so behind a TLS-terminating proxy the
 * request origin is `http://` — and an `http://` activation link drops the `Secure` session
 * cookie the activation response sets, leaving the user activated but not signed in.
 * `X-Forwarded-Proto` is deliberately not consulted: it is client-settable, the same reason
 * the rate limiter keys only on the TCP peer address Deno itself observed.
 */
export function activationUrl(url: URL, token: string, publicOrigin = PUBLIC_ORIGIN): string {
  return `${publicOrigin ?? url.origin}/activate#${token}`
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
