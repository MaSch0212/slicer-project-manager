import { t } from '../core/i18n'
import { Layers } from '../ui'
import { StubPage } from './stub'

export default function ProjectDetailPage() {
  return (
    <StubPage
      title={t('projects.title')}
      icon={Layers}
      back={{ href: '/projects', label: t('projects.backToProjects') }}
    />
  )
}
