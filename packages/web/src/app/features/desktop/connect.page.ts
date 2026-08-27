import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { JigButton } from '@awdlab/jig/button'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { isAppError } from '@spm/contract/errors.ts'
import { TranslateService } from '../../core/i18n/translate.service'
import { SHELL_CLIENT } from './shell-client.token'

/**
 * Which library this is: a folder on this computer, or a server (spec 2.6).
 *
 * **The only part of the mode question that is not a native dialog**, and only because a native
 * message box cannot hold a text field. The question itself — folder or server — is asked by the
 * shell in `dialog.showMessageBox` before this page is ever reached; choosing "connect to a
 * server" is what navigates here. The folder button is here too so the page is a complete answer
 * on its own, for the user who reaches it from the menu and changes their mind.
 *
 * It is desktop-only in the way spec 2.5 prescribes: it lives under `features/desktop/` and is
 * referenced only from `routes.electron.ts`, so the web build physically cannot contain it — CI
 * greps both bundles to prove it. That is also why it may talk to the shell directly through
 * `SHELL_CLIENT` rather than through `API_CLIENT`: in remote mode `API_CLIENT` is
 * `HttpApiClient`, which refuses both of these calls, and this page is talking to the shell about
 * which library there should be rather than to a library.
 *
 * There is no navigation on success. The shell replaces the window when the transport changes and
 * reloads it when the library does, because everything the renderer is holding belongs to a
 * library it is no longer being served — a route change here would be the renderer deciding that
 * for itself and getting it wrong for the other mode.
 */
@Component({
  selector: 'app-desktop-connect-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JigButton, JigInput, JigInputField, JigMessage],
  template: `
    <main class="spm-main spm-main--narrow">
      <div class="spm-stack">
        <h1>{{ t.translations().desktop.connectTitle }}</h1>
        <p>{{ t.translations().desktop.connectLead }}</p>

        <div class="spm-card spm-stack">
          <h2>{{ t.translations().desktop.localHeading }}</h2>
          <p>{{ t.translations().desktop.localLead }}</p>
          <button jigButton kind="primary" type="button" [disabled]="busy()" (click)="onFolder()">
            {{ t.translations().desktop.chooseFolder }}
          </button>
        </div>

        <form class="spm-card spm-stack" (submit)="onConnect(); $event.preventDefault()">
          <h2>{{ t.translations().desktop.remoteHeading }}</h2>
          <p>{{ t.translations().desktop.remoteLead }}</p>

          <jig-input-field
            inputId="desktop-server-url"
            [label]="t.translations().desktop.serverUrl"
          >
            <input
              jigInput
              id="desktop-server-url"
              type="url"
              inputmode="url"
              autocomplete="off"
              [value]="url()"
              (input)="url.set($any($event.target).value)"
            />
          </jig-input-field>
          <p>{{ t.translations().desktop.serverUrlHint }}</p>

          @if (failed()) {
            <jig-message color="error" role="alert">
              {{ t.translations().desktop.connectFailed }}
            </jig-message>
          }

          <button jigButton kind="primary" type="submit" [disabled]="busy()">
            {{ t.translations().desktop.connect }}
          </button>
        </form>
      </div>
    </main>
  `,
})
export class DesktopConnectPage {
  private readonly shell = inject(SHELL_CLIENT)
  protected readonly t = inject(TranslateService)

  readonly url = signal('')
  readonly busy = signal(false)
  readonly failed = signal(false)

  async onFolder(): Promise<void> {
    this.busy.set(true)
    try {
      await this.shell.library.pick()
    } catch {
      // A folder that will not open is reported by the shell in the picker it puts back up; there
      // is nothing this page can add, and leaving the button disabled would be the worse answer.
    } finally {
      this.busy.set(false)
    }
  }

  async onConnect(): Promise<void> {
    this.failed.set(false)
    this.busy.set(true)
    try {
      await this.shell.library.connect(this.url())
    } catch (error) {
      // The shell validates the URL (`parseRemoteOrigin`), so a `Validation` failure is the user's
      // typing and is what this message is for. Anything else is the bridge itself, which is not
      // something this page can explain — but it is still a failure to connect, so it says so
      // rather than looking as though nothing happened.
      if (!isAppError(error)) console.error('desktop: connecting to a server failed', error)
      this.failed.set(true)
    } finally {
      this.busy.set(false)
    }
  }
}
