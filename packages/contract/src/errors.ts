export type AppErrorCode =
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'Conflict'
  | 'Validation'
  | 'QuotaExceeded'
  | 'LengthRequired'
  | 'InvalidToken'
  | 'TokenExpired'
  | 'LastActiveAdmin'
  | 'Internal'

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export type QuotaExceededDetails = {
  usageBytes: number
  quotaBytes: number
  incomingBytes: number
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
