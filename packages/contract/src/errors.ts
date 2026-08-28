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
  | 'TooManyRequests'
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

/**
 * `details.reason` on the `Internal` raised when slicer detection could not run at all — a
 * PowerShell that timed out, a missing `powershell.exe`, an overflowed buffer.
 *
 * It lives here rather than in the desktop shell that throws it because it crosses the IPC
 * boundary: `/settings/slicers` switches on it to tell "detection did not run" apart from every
 * other `Internal`, and `AppErrorCode` alone cannot say which. A `reason` two packages each
 * spell by hand is a string that drifts, and the drift is silent — the page would simply fall
 * back to its generic message.
 */
export const DETECTION_FAILED = 'detection-failed'

export type QuotaExceededDetails = {
  usageBytes: number
  quotaBytes: number
  incomingBytes: number
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
