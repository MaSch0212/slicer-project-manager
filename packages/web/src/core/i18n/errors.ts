import { isApiError } from '../api/error'
import { formatBytes } from '../format-bytes'
import { t } from './index'

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

/**
 * The words for a failed call, in the current language.
 *
 * The server's `code` strings are the i18n key family (`QuotaExceeded` -> `errors.quotaExceeded`);
 * codes with no specific sentence share `errors.generic`. Pages that can say more (a bad tag name,
 * a bad file name) look at `error.code` themselves and pick a more specific key first.
 */
export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return t('errors.generic')
  switch (error.code) {
    case 'QuotaExceeded':
      return t('errors.quotaExceeded', {
        usage: formatBytes(num(error.details['usageBytes'])),
        quota: formatBytes(num(error.details['quotaBytes'])),
      })
    case 'NotFound':
      return t('errors.notFound')
    case 'LastActiveAdmin':
      return t('admin.lastAdmin')
    case 'Forbidden':
      return t('errors.forbidden')
    case 'Conflict':
      return t('errors.conflict')
    default:
      return t('errors.generic')
  }
}
