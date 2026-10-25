import { t } from '../core/i18n'
import { CircleAlert, EmptyState, LinkButton } from '../ui'

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={CircleAlert}
      title={t('notFound.title')}
      description={t('notFound.description')}
      action={
        <LinkButton href="/projects" variant="primary">
          {t('notFound.home')}
        </LinkButton>
      }
    />
  )
}
