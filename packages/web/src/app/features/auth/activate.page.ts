import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { activateSchema } from '@spm/contract/schemas.ts'
import { isAppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { JigButton } from '@awdlab/jig/button'
import { JigErrors } from '@awdlab/jig/errors'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSpinner } from '@awdlab/jig/spinner'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { TranslateService } from '../../core/i18n/translate.service'

// Ruling 54: only these codes mean the link itself is dead. Anything else (a password
// rejected on policy grounds, a rate limit, a transient failure) must not be reported as
// "this link is invalid" — the link is fine, only the attempt failed.
const DEAD_TOKEN_CODES: ReadonlySet<AppErrorCode> = new Set([
  'InvalidToken',
  'TokenExpired',
  'NotFound',
])

@Component({
  selector: 'spm-activate-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    JigButton,
    JigInputField,
    JigInput,
    JigHint,
    JigErrors,
    JigMessage,
    JigSpinner,
  ],
  template: `
    <main class="spm-main spm-main--narrow">
      @switch (state()) {
        @case ('checking') {
          <jig-spinner centered [size]="40" />
        }
        @case ('invalid') {
          <jig-message color="error" role="alert">
            {{ t.translations().auth.activateInvalid }}
          </jig-message>
        }
        @case ('ready') {
          <form class="spm-card spm-stack" (submit)="onSubmit(); $event.preventDefault()">
            <div class="spm-stack spm-stack--tight">
              <h1>{{ t.translations().auth.activateTitle }}</h1>
              @if (username(); as name) {
                <p class="spm-muted">{{ name }}</p>
              }
            </div>

            <div class="spm-field">
              <jig-input-field [label]="t.translations().auth.password">
                <input
                  type="password"
                  jigInput
                  [formField]="activateForm.password"
                  jigErrors
                  [jigErrorsHint]="passwordHint"
                  autocomplete="new-password"
                />
              </jig-input-field>
              <jig-hint #passwordHint />
            </div>

            <div class="spm-field">
              <jig-input-field [label]="t.translations().auth.confirmPassword">
                <input
                  type="password"
                  jigInput
                  [formField]="activateForm.confirm"
                  jigErrors
                  [jigErrorsHint]="confirmHint"
                  autocomplete="new-password"
                />
              </jig-input-field>
              <jig-hint #confirmHint />
            </div>

            @if (formError()) {
              <jig-message color="error" role="alert">
                {{ t.translations().errors.generic }}
              </jig-message>
            }

            <button jigButton kind="primary" type="submit" [disabled]="activateForm().submitting()">
              {{ t.translations().auth.activateSubmit }}
            </button>
          </form>
        }
      }
    </main>
  `,
})
export class ActivatePage {
  private readonly api = inject(API_CLIENT)
  private readonly auth = inject(AuthStore)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  // The token rides in the fragment so it never reaches an access log (spec 5.3).
  private readonly token = inject(ActivatedRoute).snapshot.fragment

  readonly state = signal<'checking' | 'ready' | 'invalid'>('checking')
  readonly username = signal<string | null>(null)
  // Set when a submit attempt fails for a reason other than a dead token (ruling 54) — the
  // link is still good, so the form stays up and the user can retry.
  readonly formError = signal(false)

  readonly model = signal({ password: '', confirm: '' })
  readonly activateForm = form(this.model, (path) => {
    validateStandardSchema(path, activateSchema)
  })

  constructor() {
    void this.check()
  }

  private async check(): Promise<void> {
    if (!this.token) {
      this.state.set('invalid')
      return
    }
    try {
      // Read-only check, so an expired link errors before a password is typed (spec 5.3).
      const result = await this.api.auth.checkToken(this.token)
      if (!result.valid) {
        this.state.set('invalid')
        return
      }
      this.username.set(result.username ?? null)
      this.state.set('ready')
    } catch {
      this.state.set('invalid')
    }
  }

  async onSubmit(): Promise<void> {
    const token = this.token
    if (!token) return
    this.formError.set(false)
    await submit(this.activateForm, {
      // `submit` only calls `action` when the form is valid (ruling 53): a too-short
      // password or a mismatched confirmation never reaches the network.
      action: async () => {
        try {
          // Activation issues a session, so there is no second login step (spec 5.3).
          this.auth.setUser(await this.api.auth.activate(token, this.model().password))
          await this.router.navigate(['/projects'])
        } catch (err) {
          if (isAppError(err) && DEAD_TOKEN_CODES.has(err.code)) {
            this.state.set('invalid')
          } else {
            // Validation, TooManyRequests, Internal, or a non-AppError: the link is fine,
            // only this attempt failed (ruling 54).
            this.formError.set(true)
          }
        }
      },
      // Reveal the field-level errors on a rejected submit attempt (ruling 53).
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }
}
