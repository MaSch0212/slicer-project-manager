import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import type { SettingsDto } from '@spm/contract/dtos.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import tablerPrinter from '@iconify/icons-tabler/printer'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { SettingsStore } from '../../core/settings.store'

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, JigButton, JigIcon, JigInputField, JigMessage, JigSelect],
  template: `
    <main class="spm-main spm-main--narrow">
      <div class="spm-stack">
        <h1>{{ t.translations().settings.title }}</h1>

        @if (saveFailed()) {
          <jig-message color="error" role="alert">{{
            t.translations().errors.generic
          }}</jig-message>
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

        <!--
          Spec 2.4's canConfigureSlicers, and the whole of how a desktop-only page is reached
          from a page both builds share: a capability and a routerLink string. This file imports
          nothing from features/desktop/ — spec 2.5's rule, and the one CI's bundle greps
          enforce. In the browser the route is not in the bundle at all and this flag is false in
          the server's column, so the link is never rendered; nothing here had to ask which shell
          it was running in.
        -->
        @if (capabilities.capabilities().canConfigureSlicers) {
          <div class="spm-card spm-stack">
            <p class="spm-muted">{{ t.translations().slicers.lead }}</p>
            <!-- In a flex row rather than loose in the stack: a stack stretches its children, and
                 the anchor then spans the whole card and reads as a banner, not as a control. -->
            <div class="spm-row">
              <a jigButton kind="secondary" routerLink="/settings/slicers">
                <jig-icon [icon]="icons.slicers" />
                {{ t.translations().settings.slicers }}
              </a>
            </div>
          </div>
        }
      </div>
    </main>
  `,
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore)
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)

  protected readonly icons = { slicers: tablerPrinter }

  // Computed, not constant: the labels are translated, so they have to rebuild when the
  // language changes — which this very page is what changes.
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
