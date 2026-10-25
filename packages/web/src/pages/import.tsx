import { t } from '../core/i18n'
import { PageHeader } from '../ui'
import { ImportPanel } from './import-panel'

/**
 * `/import`: upload a zipped CuraManager library. Each project folder inside becomes a project and
 * brings the tags, source URL and archived state it carries. The settings page offers the same
 * panel; this route stays so links to it keep working.
 */
export default function ImportPage() {
  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader title={t('import.heading')} description={t('import.intro')} />
      <ImportPanel />
    </div>
  )
}
