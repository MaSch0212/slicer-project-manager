import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
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
  Internal: 500,
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details ?? {} } },
      { status: STATUS_BY_CODE[error.code] },
    )
  }
  // Never leak an internal message or stack to a client.
  console.error('unhandled error', error)
  return json(
    { error: { code: 'Internal', message: 'internal error', details: {} } },
    { status: 500 },
  )
}
