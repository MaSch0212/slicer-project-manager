import { AppError } from '@spm/contract/errors.ts'
import { resolveSession, type Ctx, type Library } from '@spm/core'
import { errorResponse } from './errors.ts'
import { readSessionToken } from './session.ts'
import { serveStatic } from './static.ts'

export type Env = { lib: Library }

export type Handler = (input: {
  req: Request
  url: URL
  params: Record<string, string>
  env: Env
  ctx: Ctx
}) => Promise<Response> | Response

export type Route = {
  method: string
  path: string
  auth: 'public' | 'session'
  handler: Handler
}

const ANONYMOUS: Ctx = { userId: '', isAdmin: false }

export function makeHandler(routes: Route[], env: Env): (req: Request) => Promise<Response> {
  const compiled = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }))

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (!url.pathname.startsWith('/api/')) return serveStatic(url)

    let pathMatched = false
    for (const route of compiled) {
      const match = route.pattern.exec({ pathname: url.pathname })
      if (!match) continue
      pathMatched = true
      if (route.method !== req.method) continue

      try {
        let ctx = ANONYMOUS
        if (route.auth === 'session') {
          const token = readSessionToken(req)
          const resolved = token ? await resolveSession(env.lib.db, token) : null
          if (!resolved) throw new AppError('Unauthorized', 'a valid session is required')
          ctx = resolved
        }
        const params = Object.fromEntries(
          Object.entries(match.pathname.groups).map(([key, value]) => [key, value ?? '']),
        )
        return await route.handler({ req, url, params, env, ctx })
      } catch (error) {
        return errorResponse(error)
      }
    }

    // The path exists but no route claimed this method.
    if (pathMatched) {
      return new Response(
        JSON.stringify({
          error: { code: 'MethodNotAllowed', message: 'method not allowed', details: {} },
        }),
        { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )
    }
    return errorResponse(new AppError('NotFound', 'no such endpoint'))
  }
}
