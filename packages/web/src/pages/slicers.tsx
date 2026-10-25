import { t } from '../core/i18n'
import { EmptyState, Settings } from '../ui'
import { SettingsLayout } from './settings-layout'

/**
 * EXTENSION POINT (desktop step): the slicers configuration (installs, bindings, the default
 * slicer) is built here. The route is gated by `canConfigureSlicers`, so the browser build never
 * reaches it; keep the page inside `SettingsLayout` so the tab strip stays the way back.
 */
export default function SlicersPage() {
  return (
    <SettingsLayout active="slicers">
      <EmptyState
        icon={Settings}
        title={t('common.comingSoon')}
        description={t('common.comingSoonHint')}
      />
    </SettingsLayout>
  )
}
