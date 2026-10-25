import { t } from '../core/i18n'
import { EmptyState, PageHeader, type IconComponent } from '../ui'

/**
 * A routed page that exists, is guarded and is reachable, but whose content is built in a later
 * step. Replace the page's body; keep its route and guard.
 */
export function StubPage(props: {
  title: string
  icon: IconComponent
  back?: { href: string; label: string }
}) {
  return (
    <div class="flex flex-col gap-6">
      <PageHeader title={props.title} back={props.back} />
      <EmptyState
        icon={props.icon}
        title={t('common.comingSoon')}
        description={t('common.comingSoonHint')}
      />
    </div>
  )
}
