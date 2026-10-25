import { Show } from 'solid-js'
import type { Language, Theme, ViewMode } from '../api/generated'
import { t, setLanguage, type TranslationKey } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import { auth, capabilities, settings } from '../core/stores'
import {
  LayoutGrid,
  List,
  Monitor,
  Moon,
  SectionCard,
  SegmentedControl,
  Select,
  SettingRow,
  Sun,
  Switch,
  Text,
  type IconComponent,
} from '../ui'
import { AccountSection } from './settings-account'
import { ImportPanel } from './import-panel'

const THEMES: readonly { value: Theme; labelKey: TranslationKey; icon: IconComponent }[] = [
  { value: 'system', labelKey: 'settings.themeSystem', icon: Monitor },
  { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
  { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
]

/**
 * The General tab: how the app looks and behaves (language, theme, navigation, default view), the
 * user's own account, and the CuraManager import. Every control saves the moment it changes; a
 * save the server refuses puts the control back and says why.
 */
export function SettingsGeneral() {
  async function save(patch: Parameters<typeof settings.patch>[0]): Promise<boolean> {
    try {
      await settings.patch(patch)
      return true
    } catch (error) {
      // The store has already put the old value back.
      notify.error(errorMessage(error))
      return false
    }
  }

  async function onLanguage(language: Language) {
    // The text changes only once the choice is saved, so a refused save leaves the page in the
    // language the user was reading.
    if (await save({ language })) await setLanguage(language)
  }

  return (
    <div class="flex flex-col gap-6">
      <SectionCard title={t('settings.appearanceTitle')} description={t('settings.appearanceLead')}>
        <SettingRow label={t('settings.language')}>
          <Select<Language>
            aria-label={t('settings.language')}
            options={[
              { value: 'en', label: t('settings.languageEnglish') },
              { value: 'de', label: t('settings.languageGerman') },
            ]}
            value={settings.settings().language}
            onChange={(language) => void onLanguage(language)}
          />
        </SettingRow>
        <SettingRow label={t('settings.theme')}>
          <SegmentedControl<Theme>
            label={t('settings.theme')}
            value={settings.settings().theme}
            options={THEMES.map((theme) => ({
              value: theme.value,
              label: t(theme.labelKey),
              icon: theme.icon,
            }))}
            onChange={(theme) => void save({ theme })}
          />
        </SettingRow>
        <SettingRow label={t('settings.viewMode')} hint={t('settings.viewModeHint')}>
          <SegmentedControl<ViewMode>
            iconOnly
            label={t('settings.viewMode')}
            value={settings.settings().viewMode}
            options={[
              { value: 'grid', label: t('projects.viewModeGrid'), icon: LayoutGrid },
              { value: 'list', label: t('projects.viewModeList'), icon: List },
            ]}
            onChange={(viewMode) => void save({ viewMode })}
          />
        </SettingRow>
        <SettingRow label={t('settings.navCollapsed')} hint={t('settings.navCollapsedHint')}>
          <Switch
            labelHidden
            label={t('settings.navCollapsed')}
            checked={settings.settings().navCollapsed}
            onChange={(navCollapsed) => void save({ navCollapsed })}
          />
        </SettingRow>
      </SectionCard>

      {/*
        EXTENSION POINT (desktop step): where the library lives (choose a folder, or connect to a
        server). It is a card in this tab, rendered only where the shell can pick a local folder.
        Fill the body in; the capability gate stays.
      */}
      <Show when={capabilities.capabilities().canPickLocalFolder}>
        <SectionCard title={t('settings.libraryTitle')} description={t('settings.libraryLead')}>
          <Text variant="muted">{t('common.comingSoon')}</Text>
        </SectionCard>
      </Show>

      <Show when={capabilities.capabilities().requiresAuth && auth.isAuthenticated()}>
        <AccountSection />
      </Show>

      <SectionCard title={t('settings.importTitle')} description={t('settings.importLead')}>
        <ImportPanel />
      </SectionCard>
    </div>
  )
}
