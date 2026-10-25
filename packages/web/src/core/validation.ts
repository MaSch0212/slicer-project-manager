import { t } from './i18n'

/**
 * Form validation for UX only: the server validates everything again and its answer is the
 * truth (migration spec 3.4). These mirror `spm-core`'s rules (password 10 to 200 characters) so
 * a mistake is caught before a round trip, and so a rejected attempt never spends the auth rate
 * limit on a request the server would only refuse.
 */
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200

export type FieldErrors<K extends string> = Partial<Record<K, string>>

export function validateLogin(input: {
  username: string
  password: string
}): FieldErrors<'username' | 'password'> {
  const errors: FieldErrors<'username' | 'password'> = {}
  if (input.username === '') errors.username = t('common.required')
  if (input.password === '') errors.password = t('common.required')
  return errors
}

export function validateActivation(input: {
  password: string
  confirm: string
}): FieldErrors<'password' | 'confirm'> {
  const errors: FieldErrors<'password' | 'confirm'> = {}
  if (input.password.length < PASSWORD_MIN) {
    errors.password = t('common.tooShort', { min: PASSWORD_MIN })
  } else if (input.password.length > PASSWORD_MAX) {
    errors.password = t('errors.generic')
  }
  // The mismatch belongs to the confirmation field, not the password it is being compared with.
  if (input.confirm !== input.password) errors.confirm = t('auth.passwordMismatch')
  return errors
}

export const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0

export const PROJECT_NAME_MAX = 200
export const NOTES_MAX = 10_000
export const FILE_NAME_MAX = 255

export type ProjectFormErrors = FieldErrors<'name' | 'website' | 'notes'>

/**
 * The project form's cheap rules (name 1 to 200 once trimmed, website a valid URL or empty, notes
 * up to 10,000 characters). The server checks them again; this only saves a round trip.
 */
export function validateProjectForm(input: {
  name: string
  website?: string
  notes?: string
}): ProjectFormErrors {
  const errors: ProjectFormErrors = {}
  const name = input.name.trim()
  if (name === '') errors.name = t('common.required')
  else if (name.length > PROJECT_NAME_MAX) errors.name = t('projects.errorNameTooLong')
  const website = input.website?.trim() ?? ''
  if (website !== '' && !isUrl(website)) errors.website = t('projects.errorWebsite')
  if ((input.notes?.length ?? 0) > NOTES_MAX) errors.notes = t('projects.errorNotesTooLong')
  return errors
}

function isUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** The file-name rules a rename can break (separators, reserved characters, a leading dot). */
export function validateFileName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return t('common.required')
  if (
    trimmed.length > FILE_NAME_MAX ||
    /["*/:<>?\\|\0]/.test(trimmed) ||
    trimmed.startsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(trimmed)
  ) {
    return t('errors.invalidFileName')
  }
  return undefined
}

export const DISPLAY_NAME_MAX = 100

/** The profile form: a display name of 1 to 100 characters once trimmed. */
export function validateProfile(input: { displayName: string }): FieldErrors<'displayName'> {
  const errors: FieldErrors<'displayName'> = {}
  const name = input.displayName.trim()
  if (name === '') errors.displayName = t('common.required')
  else if (name.length > DISPLAY_NAME_MAX) errors.displayName = t('errors.generic')
  return errors
}

/**
 * The change-password form. The new password gets the same 10 to 200 floor and ceiling as an
 * activation; the current one only has to be there (the server judges it, and a wrong one is its
 * answer, not ours).
 */
export function validatePasswordChange(input: {
  current: string
  next: string
  confirm: string
}): FieldErrors<'current' | 'next' | 'confirm'> {
  const errors: FieldErrors<'current' | 'next' | 'confirm'> = {}
  if (input.current === '') errors.current = t('common.required')
  if (input.next.length < PASSWORD_MIN) errors.next = t('common.tooShort', { min: PASSWORD_MIN })
  else if (input.next.length > PASSWORD_MAX) errors.next = t('errors.generic')
  if (input.confirm !== input.next) errors.confirm = t('auth.passwordMismatch')
  return errors
}

export type CreateUserErrors = FieldErrors<'username' | 'displayName' | 'quota'>

/** Same rule as `spm-core`: 2 to 32 of letters, digits, dot, dash, underscore, starting alphanumeric. */
const USERNAME_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/

export function validateNewUser(input: {
  username: string
  displayName: string
  quotaMib: string
}): CreateUserErrors {
  const errors: CreateUserErrors = {}
  const username = input.username.trim()
  if (username === '') errors.username = t('common.required')
  else if (!USERNAME_RULE.test(username)) errors.username = t('admin.usernameRule')
  const displayName = input.displayName.trim()
  if (displayName === '') errors.displayName = t('common.required')
  else if (displayName.length > DISPLAY_NAME_MAX) errors.displayName = t('errors.generic')
  if (parseQuotaMib(input.quotaMib) === 'invalid') errors.quota = t('admin.invalidQuota')
  return errors
}

const MIB = 1024 * 1024

/**
 * What an admin typed into a quota field, in bytes: empty means no limit (`null`), a positive whole
 * number of MiB is that many bytes, and anything else is refused rather than reinterpreted (a
 * typed 0 must never silently become "unlimited").
 */
export function parseQuotaMib(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return 'invalid'
  const bytes = Number(trimmed) * MIB
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 'invalid'
}

/**
 * Whether what was typed is a server address the desktop shell will accept: an origin and nothing
 * else (`http:` or `https:`, no user name or password, no path, no query, no fragment). The shell
 * validates again, in Rust, and its answer is the truth; `server-addresses.json` is the table both
 * sides are tested against so the two cannot drift.
 */
export function isServerAddress(raw: string): boolean {
  const text = raw.trim()
  if (text === '') return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.pathname !== '' && url.pathname !== '/') return false
  // The parser has already normalised `/api/../..` into the bare origin, which would connect
  // somewhere other than what was typed. What was *typed* after the host must be no path at all.
  const typedPath = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/[?#].*$/s, '')
  return typedPath === '' || typedPath === '/'
}
