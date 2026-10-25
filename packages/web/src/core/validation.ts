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
