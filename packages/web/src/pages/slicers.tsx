import { t } from '../core/i18n'
import { Settings } from '../ui'
import { StubPage } from './stub'

export default function SlicersPage() {
  return (
    <StubPage
      title={t('settings.slicers')}
      icon={Settings}
      back={{ href: '/settings', label: t('settings.title') }}
    />
  )
}
