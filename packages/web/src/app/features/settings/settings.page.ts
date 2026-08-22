import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import type { SettingsDto } from '@spm/contract/dtos.ts'
import { TranslateService } from '../../core/i18n/translate.service'
import { SettingsStore } from '../../core/settings.store'

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ t.translations().settings.title }}</h1>

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
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>

    <label>
      {{ t.translations().settings.viewMode }}
      <select [value]="settings.settings().viewMode" (change)="onPatch('viewMode', $event)">
        <option value="grid">Grid</option>
        <option value="list">List</option>
      </select>
    </label>
  `,
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  protected async onLanguage(event: Event): Promise<void> {
    const language = (event.target as HTMLSelectElement).value as 'en' | 'de'
    await this.settings.patch({ language })
    // Reactive switch at runtime; no rebuild, no reload (spec 6.4). setLanguage is
    // synchronous — see TranslateService — the UI updates once the translations signal
    // is republished by the base class's own effect.
    this.t.setLanguage(language)
  }

  protected onPatch<K extends 'theme' | 'viewMode'>(key: K, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value as SettingsDto[K]
    // TypeScript cannot narrow an object literal keyed by a generic parameter back to
    // Partial<SettingsDto> (a known limitation around computed property types), so this
    // cast stands in for what is, at every call site, a genuine Pick<SettingsDto, K> — the
    // value itself was already checked against SettingsDto[K] above, so passing a mismatched
    // key/value pair still fails to compile.
    return this.settings.patch({ [key]: value } as Pick<SettingsDto, K>)
  }
}
