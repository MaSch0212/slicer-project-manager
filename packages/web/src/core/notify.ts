import { showToast } from '../ui/toast'
import { t } from './i18n'

/**
 * Reports the outcome of an action the user just took. Each method takes an already-translated
 * string, so call sites own their i18n keys and this stays testable without a locale. A failure
 * is announced assertively, stays longer than a success, and can be dismissed.
 *
 * Needs `<ToastRegion />` mounted (the app shell does it).
 */
export const notify = {
  success: (message: string): void => void showToast('success', message, t('common.close')),
  error: (message: string): void => void showToast('error', message, t('common.close')),
  info: (message: string): void => void showToast('info', message, t('common.close')),
}
