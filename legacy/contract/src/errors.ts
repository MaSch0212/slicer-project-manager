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

/**
 * Every `AppErrorCode`, as a value, so a code arriving from somewhere untrusted can be checked
 * against the union instead of cast into it.
 *
 * The desktop shell's remote mode is what needs it: an error envelope comes off the wire from
 * another machine, and an `AppError` carrying a code nothing switches on is worse than an honest
 * `Internal` — every UI that branches on a code would silently take its default arm, and nothing
 * would say why.
 */
export const APP_ERROR_CODES = [
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Validation',
  'QuotaExceeded',
  'LengthRequired',
  'InvalidToken',
  'TokenExpired',
  'LastActiveAdmin',
  'TooManyRequests',
  'Internal',
] as const satisfies readonly AppErrorCode[]

/**
 * The other direction of the tie above: `satisfies` catches a member of the list the union does
 * not have, and this catches one the union has and the list does not — which is the direction
 * that would make `isAppErrorCode` quietly answer `false` for a real code.
 */
type AssertNever<T extends never> = T
export type AppErrorCodesAreComplete = AssertNever<
  Exclude<AppErrorCode, (typeof APP_ERROR_CODES)[number]>
>

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (APP_ERROR_CODES as readonly string[]).includes(value)
}
