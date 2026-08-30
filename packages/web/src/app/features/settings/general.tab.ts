import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import type { SettingsDto } from '@spm/contract/dtos.ts'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { TranslateService } from '../../core/i18n/translate.service'
import { SettingsStore } from '../../core/settings.store'

/**
 * The General tab of the settings page (spec G 6).
 *
 * It is a component of its own rather than markup inside `SettingsPage` because the page is now
 * a tab strip over a `<router-outlet />`: `/settings` has to activate a child route, and a child
 * route needs something to render. Everything here — the three controls and the optimistic-save
 * error handling — moved out of `SettingsPage` unchanged.
 *
 * **`viewMode` stays here on purpose.** Spec G 0 defers moving the grid/list control to the
 * projects page to segment H, so that removing it here and adding it there happens in one commit
 * and the application is never without it.
 *
 * No `<main>`: the page above owns the landmark, and a second one on the same page is invalid.
 */
@Component({
  selector: 'app-settings-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JigInputField, JigMessage, JigSelect],
  template: `
    <div class="spm-stack">
      @if (saveFailed()) {
        <jig-message color="error" role="alert">{{ t.translations().errors.generic }}</jig-message>
      }

      <div class="spm-card spm-stack">
        <jig-input-field
          class="spm-block"
          inputId="settings-language"
          [label]="t.translations().settings.language"
        >
          <jig-select
            inputId="settings-language"
            [label]="t.translations().settings.language"
            [options]="languageOptions()"
            [value]="settings.settings().language"
            (valueChange)="onLanguage($event)"
          />
        </jig-input-field>

        <jig-input-field
          class="spm-block"
          inputId="settings-theme"
          [label]="t.translations().settings.theme"
        >
          <jig-select
            inputId="settings-theme"
            [label]="t.translations().settings.theme"
            [options]="themeOptions()"
            [value]="settings.settings().theme"
            (valueChange)="onPatch('theme', $event)"
          />
        </jig-input-field>

        <jig-input-field
          class="spm-block"
          inputId="settings-view-mode"
          [label]="t.translations().settings.viewMode"
        >
          <jig-select
            inputId="settings-view-mode"
            [label]="t.translations().settings.viewMode"
            [options]="viewModeOptions()"
            [value]="settings.settings().viewMode"
            (valueChange)="onPatch('viewMode', $event)"
          />
        </jig-input-field>
      </div>
    </div>
  `,
})
export class SettingsGeneralTab {
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  // Computed, not constant: the labels are translated, so they have to rebuild when the
  // language changes — which this very tab is what changes.
  protected readonly languageOptions = computed(() => [
    { label: 'English', value: 'en' as const },
    { label: 'Deutsch', value: 'de' as const },
  ])
  protected readonly themeOptions = computed(() => {
    const s = this.t.translations().settings
    return [
      { label: s.themeSystem, value: 'system' as const },
      { label: s.themeLight, value: 'light' as const },
      { label: s.themeDark, value: 'dark' as const },
    ]
  })
  protected readonly viewModeOptions = computed(() => {
    const s = this.t.translations().settings
    return [
      { label: s.viewModeGrid, value: 'grid' as const },
      { label: s.viewModeList, value: 'list' as const },
    ]
  })

  /**
   * SettingsStore.patch is optimistic and rethrows after rolling the key back. Without this
   * the page had no error handling at all: a failed save silently reverted the control with
   * nothing said, and `onPatch` handed a rejecting promise straight to a template binding,
   * so the failure escaped as an unhandled rejection.
   */
  readonly saveFailed = signal(false)

  // Public, like ProjectsPage.onCreate/onRescan and the auth pages' onSubmit: the specs
  // drive these directly.
  async onLanguage(language: SettingsDto['language'] | null): Promise<void> {
    if (!language) return
    if (!(await this.save({ language }))) return
    // Reactive switch at runtime; no rebuild, no reload (spec 6.4). setLanguage is
    // synchronous — see TranslateService — the UI updates once the translations signal
    // is republished by the base class's own effect. Only after the PUT succeeded: a
    // language that did not persist must not look as though it had.
    this.t.setLanguage(language)
  }

  async onPatch<K extends 'theme' | 'viewMode'>(
    key: K,
    value: SettingsDto[K] | null,
  ): Promise<void> {
    if (value === null) return
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
