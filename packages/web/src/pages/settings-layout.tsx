import { useNavigate } from '@solidjs/router'
import type { JSX } from 'solid-js'
import { t } from '../core/i18n'
import { capabilities } from '../core/stores'
import { cx, PageHeader, TabPanel, Tabs } from '../ui'

export type SettingsTab = 'general' | 'slicers'

const PATHS: Record<SettingsTab, string> = {
  general: '/settings',
  slicers: '/settings/slicers',
}

/**
 * The frame of every settings screen: the page header and a tab strip that is a navigation control
 * (each tab is its own route, so `/settings/slicers` stays deep-linkable and guarded).
 *
 * EXTENSION POINT (desktop step): a tab appears here only when its capability says the shell can
 * do it. The Slicers tab is `canConfigureSlicers`; the browser build never shows it, and its route
 * is guarded by the same flag in `routes.tsx`. Add a tab by adding a `SettingsTab` value, its path
 * and its capability test below, then wrap the new page in `SettingsLayout`.
 */
export function SettingsLayout(props: {
  active: SettingsTab
  /** `narrow` keeps the header, tabs and content to a readable measure; `full` uses the page. */
  width?: 'narrow' | 'full'
  children: JSX.Element
}) {
  const navigate = useNavigate()
  const items = () => [
    { value: 'general', label: t('settings.general') },
    ...(capabilities.capabilities().canConfigureSlicers
      ? [{ value: 'slicers', label: t('settings.slicers') }]
      : []),
  ]
  return (
    <div class={cx('flex flex-col gap-6', props.width === 'narrow' && 'max-w-3xl')}>
      <PageHeader title={t('settings.title')} />
      <Tabs
        label={t('settings.tabs')}
        items={items()}
        value={props.active}
        onChange={(value) => navigate(PATHS[value as SettingsTab])}
      >
        <TabPanel value={props.active}>{props.children}</TabPanel>
      </Tabs>
    </div>
  )
}
