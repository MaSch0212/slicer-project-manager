import { t } from '../core/i18n'
import { Upload } from '../ui'
import { StubPage } from './stub'

export default function ImportPage() {
  return <StubPage title={t('import.title')} icon={Upload} />
}
