import { t } from '../core/i18n'
import { Globe } from '../ui'
import { StubPage } from './stub'

export default function BrowsePage() {
  return <StubPage title={t('browse.title')} icon={Globe} />
}
