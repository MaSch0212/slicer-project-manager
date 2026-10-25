import { t } from '../core/i18n'
import { FileBox } from '../ui'
import { StubPage } from './stub'

export default function ViewerPage() {
  return (
    <StubPage
      title={t('viewer.title')}
      icon={FileBox}
      back={{ href: '/projects', label: t('projects.backToProjects') }}
    />
  )
}
