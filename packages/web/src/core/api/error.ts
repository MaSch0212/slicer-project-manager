import { isAppErrorCode, type AppErrorCode, type ErrorEnvelope } from '../../api/generated'

/**
 * The one failure shape every API call rejects with. Callers switch on `code` (an
 * `AppErrorCode`, which doubles as the i18n key family, see core/i18n/errors.ts) and never see a
 * `TypeError` or a raw `Response`.
 */
export class ApiError extends Error {
  readonly code: AppErrorCode
  readonly details: Record<string, unknown>
  /** The HTTP status, or 0 when no response arrived at all. */
  readonly status: number

  constructor(
    code: AppErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = options.status ?? 0
    this.details = options.details ?? {}
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/**
 * Turns a failed response into an `ApiError`: the server's envelope when it is one, otherwise an
 * `Internal` that says what status arrived (a proxy or gateway answering with its own page).
 */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ErrorEnvelope>
    const error = body.error
    if (error && isAppErrorCode(error.code)) {
      return new ApiError(error.code, error.message ?? 'request failed', {
        status: response.status,
        details: error.details ?? {},
      })
    }
  } catch {
    // Not JSON: fall through.
  }
  return new ApiError('Internal', `request failed with status ${response.status}`, {
    status: response.status,
  })
}
