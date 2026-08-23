import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { Router } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { loginSchema } from '@spm/contract/schemas.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { TranslateService } from '../../core/i18n/translate.service'

@Component({
  selector: 'spm-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, JigButton, JigInputField, JigInput, JigHint, JigErrors, JigMessage],
  template: `
    <main class="spm-main spm-main--narrow">
      <form class="spm-card spm-stack" (submit)="onSubmit(); $event.preventDefault()">
        <h1>{{ t.translations().auth.signIn }}</h1>

        <!-- The hint is a SIBLING of the field, never a child: content projected into
             <jig-input-field> becomes a prefix or suffix adornment, which renders the
             validation message inside the input box. -->
        <div class="spm-field">
          <jig-input-field [label]="t.translations().auth.username">
            <input
              jigInput
              [formField]="loginForm.username"
              jigErrors
              [jigErrorsHint]="usernameHint"
              autocomplete="username"
            />
          </jig-input-field>
          <jig-hint #usernameHint />
        </div>

        <div class="spm-field">
          <jig-input-field [label]="t.translations().auth.password">
            <input
              type="password"
              jigInput
              [formField]="loginForm.password"
              jigErrors
              [jigErrorsHint]="passwordHint"
              autocomplete="current-password"
            />
          </jig-input-field>
          <jig-hint #passwordHint />
        </div>

        @if (errorKey()) {
          <jig-message color="error" role="alert">
            {{ t.translations().auth.signInFailed }}
          </jig-message>
        }

        <button jigButton kind="primary" type="submit" [disabled]="loginForm().submitting()">
          {{ t.translations().auth.signIn }}
        </button>
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly api = inject(API_CLIENT)
  private readonly auth = inject(AuthStore)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  readonly model = signal({ username: '', password: '' })
  // The same schema the server validates with (spec 2.3).
  readonly loginForm = form(this.model, (path) => {
    validateStandardSchema(path, loginSchema)
  })
  readonly errorKey = signal<'signInFailed' | null>(null)

  async onSubmit(): Promise<void> {
    this.errorKey.set(null)
    await submit(this.loginForm, {
      // `submit` only calls `action` when the form is valid (ruling 53): an empty username
      // or password never reaches the network, and never burns the auth rate-limit budget
      // on a request the server would only reject anyway.
      action: async () => {
        try {
          const { username, password } = this.model()
          this.auth.setUser(await this.api.auth.login(username, password))
          await this.router.navigate(['/projects'])
        } catch {
          // Unknown user, pending, disabled and wrong password are one message (spec 5.1).
          this.errorKey.set('signInFailed')
        }
      },
      // Reveal the field-level errors on a rejected submit attempt: jigErrors defaults to
      // showing on `touched`, so an untouched invalid field would otherwise fail silently
      // (ruling 53).
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }
}
