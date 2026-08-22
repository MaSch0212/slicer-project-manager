import { AppError } from '@spm/contract/errors.ts'
import { resolveSession, type Ctx, type Library } from '@spm/core'
import { errorResponse } from './errors.ts'
import { makeRateLimiter, type RateLimitRule } from './rate-limit.ts'
import { readSessionToken } from './session.ts'
import { serveStatic } from './static.ts'

export type Env = {
  lib: Library
  /** Injectable clock for the per-`makeHandler` rate limiter; tests override it to move
   *  time forward without sleeping. Defaults to `Date.now` inside `makeRateLimiter`. */
  now?: () => number
}

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
  /** Per-client-IP budget for this exact route. Absent means unlimited. */
  rateLimit?: RateLimitRule
  handler: Handler
}

const ANONYMOUS: Ctx = { userId: '', isAdmin: false }

/**
 * Derives the client address to key the rate limiter on. This deliberately reads only
 * `info.remoteAddr` — the TCP peer address Deno itself observed — and never the
 * `X-Forwarded-For` header. That header is set by the client, not the network, so trusting
 * it would let anyone mint an unlimited supply of fresh rate-limit budgets simply by
 * sending a different value on every request, defeating the control it's supposed to be.
 * A real deployment behind a reverse proxy must configure rate limiting on the proxy
 * itself, which does see the true peer address; this server does not attempt to do that
 * job for it.
 */
function clientAddress(info?: Deno.ServeHandlerInfo): string {
  const addr = info?.remoteAddr
  return addr && 'hostname' in addr ? addr.hostname : 'unknown'
}

export function makeHandler(
  routes: Route[],
  env: Env,
): (req: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const compiled = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }))
  // One limiter per makeHandler call, so each server instance (each `withServer` in tests)
  // has its own state and none bleed into one another.
  const limiter = makeRateLimiter(env.now)

  return async (req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> => {
    const url = new URL(req.url)

    if (!url.pathname.startsWith('/api/')) return serveStatic(url)

    let pathMatched = false
    for (const route of compiled) {
      const match = route.pattern.exec({ pathname: url.pathname })
      if (!match) continue
      pathMatched = true
      if (route.method !== req.method) continue

      try {
        if (route.rateLimit) {
          // Key on the route's registered pattern, not the concrete URL: every distinct
          // activation token would otherwise get its own fresh budget and the limit would
          // do nothing.
          const key = `${clientAddress(info)}|${route.method} ${route.path}`
          limiter.check(key, route.rateLimit)
        }
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
        const response = errorResponse(error)
        if (error instanceof AppError && error.code === 'TooManyRequests') {
          const retryAfterSeconds = error.details?.retryAfterSeconds
          response.headers.set('retry-after', String(retryAfterSeconds ?? 0))
        }
        return response
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
