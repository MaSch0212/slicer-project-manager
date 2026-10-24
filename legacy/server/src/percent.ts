import { AppError } from '@spm/contract/errors.ts'

/**
 * Decodes a percent-encoded string, or `null` if the escape is malformed (e.g. a bare `%`
 * or `%zz`). Catches `URIError` specifically — anything else is a genuinely unexpected
 * failure and must keep propagating rather than being laundered into "malformed".
 */
export function tryDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}

/**
 * Decodes a percent-encoded string, or throws a 400 `AppError` if the escape is malformed.
 * For request data (headers, path segments) where a bad escape is the caller's mistake and
 * deserves to be reported, not silently treated as absent.
 */
export function decodeURIComponentOrThrow(value: string, label: string): string {
  const decoded = tryDecodeURIComponent(value)
  if (decoded === null) {
    throw new AppError('Validation', `${label} is not correctly percent-encoded`)
  }
  return decoded
}
