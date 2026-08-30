import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { FormField, form, submit, validate } from '@angular/forms/signals'
import type { SettingsDto } from '@spm/contract/dtos.ts'
import { serverUrlSchema } from '@spm/contract/schemas.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { API_CLIENT } from '../../core/api/api-client.token'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import { SettingsStore } from '../../core/settings.store'
import { ImportPanel } from '../import/import.panel'

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
 * Two further cards live here, both from user feedback (spec G 6.1 and 6.2):
 *
 * - **Where the library is.** Choosing a folder was a single icon button in the header with no
 *   way to reach the other kind of library at all; connecting to a server was reachable only from
 *   the shell's own start-up dialog. Both are `ApiClient` methods that already existed — no IPC,
 *   no capability and no main-process change was added for this card, only the UI over a
 *   transport that was already built.
 * - **Import.** Importing a CuraManager library is something you do once, so it belongs beside
 *   the other once-and-done settings rather than in the navigation. `/import` still resolves.
 *
 * **This file imports nothing from `features/desktop/`** — spec G C2, which CI's bundle greps
 * enforce. The library card is gated on `canPickLocalFolder`, which is false in the browser,
 * where the library lives on a server and there is no folder to choose; no component here asks
 * which shell it is in.
 *
 * No `<main>`: the page above owns the landmark, and a second one on the same page is invalid.
 */
@Component({
  selector: 'app-settings-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    ImportPanel,
    JigButton,
    JigErrors,
    JigHint,
    JigInput,
    JigInputField,
    JigMessage,
    JigSelect,
  ],
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

      @if (capabilities.capabilities().canPickLocalFolder) {
        <section class="spm-card spm-stack">
          <h2>{{ t.translations().settings.libraryTitle }}</h2>
          <p class="spm-muted">{{ t.translations().settings.libraryLead }}</p>

          <div class="spm-row">
            <button jigButton kind="primary" type="button" (click)="onChooseFolder()">
              {{ t.translations().settings.chooseFolder }}
            </button>
            @if (!connectOpen()) {
              <button jigButton kind="secondary" type="button" (click)="connectOpen.set(true)">
                {{ t.translations().settings.connectToServer }}
              </button>
            }
          </div>

          @if (connectOpen()) {
            <form class="spm-stack" (submit)="onConnect(); $event.preventDefault()">
              <!-- The hint is a SIBLING of the field, never a child: content projected into
                   <jig-input-field> becomes an adornment, which renders the validation
                   message inside the input box.

                   inputId alone, with no id on the input itself: the field puts that id on the
                   input it wraps as well as in its label's for attribute. Measured, because the
                   pattern next door in features/desktop/connect.page.ts spells both out --
                   setting the input's own id to something else and rendering it left jig's value
                   on the element regardless, so a hand-written one is not the thing doing the
                   work and can only drift from the label.

                   No backticks in this comment: the template is a JS template literal, so a
                   backtick ends it before it is ever text. -->
              <div class="spm-field">
                <jig-input-field
                  inputId="settings-server-url"
                  [label]="t.translations().settings.serverUrl"
                >
                  <input
                    jigInput
                    type="url"
                    inputmode="url"
                    autocomplete="off"
                    [formField]="connectForm.url"
                    jigErrors
                    [jigErrorsHint]="serverUrlHint"
                  />
                </jig-input-field>
                <jig-hint #serverUrlHint />
              </div>
              <p class="spm-muted">{{ t.translations().settings.serverUrlHint }}</p>

              <div class="spm-row">
                <button
                  jigButton
                  kind="primary"
                  type="submit"
                  [disabled]="connectForm().submitting()"
                >
                  {{ t.translations().settings.connect }}
                </button>
                <button jigButton kind="text" type="button" (click)="onCancelConnect()">
                  {{ t.translations().settings.connectCancel }}
                </button>
              </div>
            </form>
          }
        </section>
      }

      <section class="spm-card spm-stack">
        <h2>{{ t.translations().import.heading }}</h2>
        <spm-import-panel />
      </section>
    </div>
  `,
})
export class SettingsGeneralTab {
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  private readonly api = inject(API_CLIENT)
  private readonly notify = inject(NotifyService)

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

  /**
   * Whether the server address field is showing. Closed by default so the common answer — a
   * different folder on this computer — is one click, and the rarer one does not put an empty
   * text field in front of everybody who came here to change the theme.
   */
  readonly connectOpen = signal(false)

  readonly connectModel = signal({ url: '' })

  /**
   * The address is validated **before** the transport is called, and that ordering is the point.
   * `serverUrlSchema` allows `http:` and `https:` and no other scheme, and refuses an address
   * carrying credentials; `submit()` only runs its action when the form is valid, so
   * `javascript:alert(1)` never becomes an argument to `library.connect` — it is refused here,
   * in the renderer, rather than trusted to whatever is on the other end of the bridge.
   *
   * **`validate` and not `validateStandardSchema`, for one reason: the message.**
   * `validateStandardSchema` surfaces zod's own issue text, which is English in a file that has
   * no business holding translations, and constraint C4 binds every string a user reads. So the
   * schema still decides *whether* the address is allowed and this decides what is *said* about
   * it. Reading `t.translations()` inside the validator is also what makes the message follow a
   * language change, rather than freezing whichever language the form was built in.
   */
  readonly connectForm = form(this.connectModel, (path) => {
    validate(path.url, ({ value }) =>
      serverUrlSchema.safeParse(value()).success
        ? null
        : { kind: 'serverUrl', message: this.t.translations().settings.serverUrlInvalid },
    )
  })

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

  /**
   * Asks the shell for a different library folder (spec G 6.1).
   *
   * **Nothing happens here on success, and that is the design rather than an omission.** The
   * shell that opened the library is the only thing that knows every store in this renderer is
   * now holding data from a library it has closed, so it reloads the window itself. `null` is a
   * cancelled picker and is not a failure either: the library that was open stays open, and
   * saying anything about it would be reporting on a dialog the user themselves dismissed.
   *
   * So only the rejection is handled, and it goes to a snackbar rather than a banner: it is the
   * result of an action the user just took (spec G 7).
   */
  async onChooseFolder(): Promise<void> {
    try {
      await this.api.library.pick()
    } catch {
      // A folder that will not open is the realistic case: a file where a folder was, a drive
      // that is not mounted, a database from a newer schema. The shell has already logged the
      // detail; this is the user-facing half.
      this.notify.error(this.t.translations().settings.libraryFailed)
    }
  }

  /**
   * Closes the connect form and empties it.
   *
   * Emptying is the point. What is in the field at this moment is, in the case that matters, an
   * address that was just refused — and leaving it there means the next person to open the form
   * meets their own rejected typing under a red message they did not just earn. `reset` rather
   * than assigning the model, because it clears `touched` along with the value: the same field
   * showing a validation error over an empty box would be the same wart in a different shape.
   */
  onCancelConnect(): void {
    this.connectOpen.set(false)
    this.connectForm().reset({ url: '' })
  }

  /** Points the shell at a server instead. Same three outcomes as `onChooseFolder`. */
  async onConnect(): Promise<void> {
    await submit(this.connectForm, {
      action: async () => {
        try {
          await this.api.library.connect(this.connectModel().url)
        } catch {
          // `submit()` is `try { … } finally { … }` with no catch of its own, so a rejected
          // action escapes as an unhandled rejection unless it is caught here — the same
          // pattern LoginPage and ProjectsPage.onCreate use, and for the same reason.
          // `onInvalid` never fires for this: it is only ever reached by schema validation.
          this.notify.error(this.t.translations().settings.connectFailed)
        }
      },
      // Reveal the field error on a rejected attempt: jigErrors shows on `touched`, so an
      // untouched invalid field would otherwise refuse the address with nothing said.
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
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
