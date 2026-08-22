import { activateSchema, loginSchema } from '@spm/contract/schemas.ts'
import { activateAccount, checkActivationToken, deleteSession, login } from '@spm/core'
import { json, parseJson } from '../json.ts'
import type { Route } from '../router.ts'
import { readSessionToken, sessionClearCookie, sessionSetCookie } from '../session.ts'

export const authRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    handler: async ({ req, url, env }) => {
      const input = await parseJson(req, loginSchema)
      const result = await login(
        env.lib,
        input.username,
        input.password,
        req.headers.get('user-agent'),
      )
      return json(result.user, {
        headers: { 'set-cookie': sessionSetCookie(result.token, result.expiresAt, url) },
      })
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'public',
    handler: async ({ req, url, env }) => {
      const token = readSessionToken(req)
      if (token) await deleteSession(env.lib.db, token)
      return new Response(null, { status: 204, headers: { 'set-cookie': sessionClearCookie(url) } })
    },
  },
  {
    method: 'GET',
    path: '/api/auth/activation/:token',
    auth: 'public',
    handler: async ({ params, env }) => {
      // Read-only, so an expired link errors before a password is typed (spec 5.3).
      const result = await checkActivationToken(env.lib.db, params.token!)
      return json(result.valid ? { valid: true, username: result.username } : { valid: false })
    },
  },
  {
    method: 'POST',
    path: '/api/auth/activation/:token',
    auth: 'public',
    handler: async ({ req, url, params, env }) => {
      const input = await parseJson(req, activateSchema)
      const result = await activateAccount(
        env.lib,
        params.token!,
        input.password,
        req.headers.get('user-agent'),
      )
      return json(result.user, {
        headers: { 'set-cookie': sessionSetCookie(result.token, result.expiresAt, url) },
      })
    },
  },
]
