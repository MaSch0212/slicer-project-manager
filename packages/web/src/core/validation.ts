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
