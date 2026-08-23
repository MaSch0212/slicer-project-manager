import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import type { SettingsDto } from '@spm/contract/dtos.ts'
import { TranslateService } from '../../core/i18n/translate.service'
import { SettingsStore } from '../../core/settings.store'

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ t.translations().settings.title }}</h1>

    @if (saveFailed()) {
      <p role="alert">{{ t.translations().errors.generic }}</p>
    }

    <label>
      {{ t.translations().settings.language }}
      <select [value]="settings.settings().language" (change)="onLanguage($event)">
        <option value="en">English</option>
        <option value="de">Deutsch</option>
      </select>
    </label>

    <label>
      {{ t.translations().settings.theme }}
      <select [value]="settings.settings().theme" (change)="onPatch('theme', $event)">
        <option value="system">{{ t.translations().settings.themeSystem }}</option>
        <option value="light">{{ t.translations().settings.themeLight }}</option>
        <option value="dark">{{ t.translations().settings.themeDark }}</option>
      </select>
    </label>

    <label>
      {{ t.translations().settings.viewMode }}
      <select [value]="settings.settings().viewMode" (change)="onPatch('viewMode', $event)">
        <option value="grid">{{ t.translations().settings.viewModeGrid }}</option>
        <option value="list">{{ t.translations().settings.viewModeList }}</option>
      </select>
    </label>
  `,
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  /**
   * SettingsStore.patch is optimistic and rethrows after rolling the key back. Without this
   * the page had no error handling at all: a failed save silently reverted the control with
   * nothing said, and `onPatch` handed a rejecting promise straight to a template `(change)`
   * binding, so the failure escaped as an unhandled rejection. Same convention as the six
   * later pages: catch the network call, surface it in a `role="alert"`.
   */
  readonly saveFailed = signal(false)

  // Public, like ProjectsPage.onCreate/onRescan and the auth pages' onSubmit: the specs
  // drive these directly.
  async onLanguage(event: Event): Promise<void> {
    const language = (event.target as HTMLSelectElement).value as 'en' | 'de'
    if (!(await this.save({ language }))) return
    // Reactive switch at runtime; no rebuild, no reload (spec 6.4). setLanguage is
    // synchronous — see TranslateService — the UI updates once the translations signal
    // is republished by the base class's own effect. Only after the PUT succeeded: a
    // language that did not persist must not look as though it had.
    this.t.setLanguage(language)
  }

  async onPatch<K extends 'theme' | 'viewMode'>(key: K, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value as SettingsDto[K]
    // TypeScript cannot narrow an object literal keyed by a generic parameter back to
    // Partial<SettingsDto> (a known limitation around computed property types), so this
    // cast stands in for what is, at every call site, a genuine Pick<SettingsDto, K> — the
    // value itself was already checked against SettingsDto[K] above, so passing a mismatched
    // key/value pair still fails to compile.
    await this.save({ [key]: value } as Pick<SettingsDto, K>)
  }

  /** Returns whether the save landed, so a caller can gate follow-up work on it. */
  private async save(partial: Partial<SettingsDto>): Promise<boolean> {
    this.saveFailed.set(false)
    try {
      await this.settings.patch(partial)
      return true
    } catch {
      // The store has already rolled the key back to its previous value, so the control
      // snaps back on its own; all that is missing is saying why.
      this.saveFailed.set(true)
      return false
    }
  }
}
