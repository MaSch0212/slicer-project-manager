import { t } from '../core/i18n'
import { FolderOpen } from '../ui'
import { StubPage } from './stub'

export default function ConnectPage() {
  return <StubPage title={t('desktop.connectTitle')} icon={FolderOpen} />
}
