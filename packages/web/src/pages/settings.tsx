import { t } from '../core/i18n'
import { Settings } from '../ui'
import { StubPage } from './stub'

export default function SettingsPage() {
  return <StubPage title={t('settings.title')} icon={Settings} />
}
