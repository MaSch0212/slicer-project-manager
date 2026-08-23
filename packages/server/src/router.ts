import { AppError } from '@spm/contract/errors.ts'
import { NOOP_LOGGER, resolveSession, type Ctx, type Library, type Logger } from '@spm/core'
import { errorResponse } from './errors.ts'
import { makeRateLimiter, type RateLimitRule } from './rate-limit.ts'
import { readSessionToken } from './session.ts'
import { serveStatic } from './static.ts'

export type Env = {
  lib: Library
  /** Defaults to the library own logger, which is silent unless the host configured one. */
  log?: Logger
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
  // 'unknown' is a defensive fallback for a missing or malformed `info`, not an expected
  // runtime path: both `main.ts` (via Deno.serve) and the test harness always supply a real
  // `remoteAddr`. It deliberately is NOT a way to opt out of per-client keying — every
  // caller that hits this branch shares one bucket, which is the same as being unlimited in
  // practice, so this should never be relied on to mean "no address available, limit
  // anyway."
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
  const log = env.log ?? env.lib.log ?? NOOP_LOGGER

  /** Everything under /api/. Split out so the caller can time and log every exit path once. */
  const handleApi = async (
    req: Request,
    url: URL,
    info: Deno.ServeHandlerInfo | undefined,
    seen: { ctx: Ctx },
  ): Promise<Response> => {
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
        if (route.auth === 'session') {
          const token = readSessionToken(req)
          const resolved = token ? await resolveSession(env.lib.db, token) : null
          if (!resolved) throw new AppError('Unauthorized', 'a valid session is required')
          seen.ctx = resolved
        }
        const params = Object.fromEntries(
          Object.entries(match.pathname.groups).map(([key, value]) => [key, value ?? '']),
        )
        return await route.handler({ req, url, params, env, ctx: seen.ctx })
      } catch (error) {
        const response = errorResponse(error, log)
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
    return errorResponse(new AppError('NotFound', 'no such endpoint'), log)
  }

  return async (req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> => {
    const url = new URL(req.url)
    const started = Date.now()

    // Static assets are a page load's worth of noise -- every chunk, style and thumbnail --
    // so they sit one level below the API: `debug` shows them, the default `info` does not.
    if (!url.pathname.startsWith('/api/')) {
      const response = await serveStatic(url)
      log.debug('static', {
        method: req.method,
        path: url.pathname,
        status: response.status,
        ms: Date.now() - started,
      })
      return response
    }

    const seen = { ctx: ANONYMOUS }
    const response = await handleApi(req, url, info, seen)
    const fields: Record<string, unknown> = {
      method: req.method,
      path: url.pathname,
      status: response.status,
      ms: Date.now() - started,
    }
    // Only once a session resolved -- an anonymous userId is the empty string, which reads
    // as a field whose value went missing rather than as "nobody was signed in".
    if (seen.ctx.userId) fields.userId = seen.ctx.userId
    // A 5xx is the server's own fault and belongs in the level an operator always has on.
    // 4xx stays at `info`: a 401 on an expired cookie is routine, not a warning sign.
    if (response.status >= 500) log.error('request failed', fields)
    else log.info('request', fields)
    return response
  }
}
