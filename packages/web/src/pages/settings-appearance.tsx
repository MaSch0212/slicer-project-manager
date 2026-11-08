import type { Language, Theme, ViewMode } from '../api/generated'
import { t, setLanguage, type TranslationKey } from '../core/i18n'
import { errorMessage } from '../core/i18n/errors'
import { notify } from '../core/notify'
import { settings } from '../core/stores'
import {
  LayoutGrid,
  List,
  Monitor,
  Moon,
  SegmentedControl,
  Select,
  SettingRow,
  Sun,
  Switch,
  type IconComponent,
} from '../ui'

const THEMES: readonly { value: Theme; labelKey: TranslationKey; icon: IconComponent }[] = [
  { value: 'system', labelKey: 'settings.themeSystem', icon: Monitor },
  { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
  { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
]

/**
 * How the app looks and behaves: language, theme, the default project view, and whether the
 * sidebar is collapsed. Every control saves the moment it changes; a save the server refuses puts
 * the control back and says why.
 */
export function AppearanceSection() {
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
    <div class="flex flex-col gap-5">
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
    </div>
  )
}
