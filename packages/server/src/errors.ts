import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { NOOP_LOGGER, type Logger } from '@spm/core'
import { json } from './json.ts'

export const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  Validation: 400,
  InvalidToken: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  LastActiveAdmin: 409,
  TokenExpired: 410,
  LengthRequired: 411,
  QuotaExceeded: 413,
  TooManyRequests: 429,
  Internal: 500,
}

/**
 * `log` defaults to silence so a direct caller (or a test) never prints unbidden; the router
 * always passes the request's own logger, which is where unhandled errors actually surface.
 */
export function errorResponse(error: unknown, log: Logger = NOOP_LOGGER): Response {
  if (error instanceof AppError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details ?? {} } },
      { status: STATUS_BY_CODE[error.code] },
    )
  }
  // Never leak an internal message or stack to a client -- but do keep both server-side,
  // because a non-AppError reaching here is a bug, and the stack is the only thing that
  // makes it findable.
  log.error('unhandled error', {
    err: error,
    stack: error instanceof Error ? error.stack : undefined,
  })
  return json(
    { error: { code: 'Internal', message: 'internal error', details: {} } },
    { status: 500 },
  )
}
