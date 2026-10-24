import { Injectable } from '@angular/core'
import { injectSnackbarCreator } from '@awdlab/jig/snackbar'

/**
 * Reports the outcome of an action the user just took. Spec §7: snackbars are jig's own surface
 * for that ("the result of an action the user just took"), as distinct from a toast (ambient,
 * not tied to something the user did) or an inline `jig-message` banner (a persistent statement
 * about the current state, or a multi-line report worth reading past the auto-hide window).
 *
 * Every method takes an already-translated string rather than a translation key: this service
 * does not inject `TranslateService`, so call sites stay responsible for their own i18n keys,
 * and stay testable here without a translation fixture. If the notification surface changes
 * again later, this is the one file that needs to.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly snackbars = injectSnackbarCreator()

  /** A just-completed action succeeded. */
  success(message: string): void {
    this.snackbars.show({ content: message, color: 'success' })
  }

  /**
   * A just-completed action failed. Closable, unlike success/info, because a failure is worth
   * more than the default auto-hide window — the user may be mid-read or mid-interruption when
   * it appears, and should be able to dismiss it on their own schedule rather than the timer's.
   *
   * `ariaLive` is deliberately left unset: jig derives it from `color` on its own (`error` maps
   * to `assertive`/`role="alert"`, verified against `awdlab-jig-snackbar.d.ts`), so setting it
   * explicitly here would just be restating — and risking drifting out of sync with — behavior
   * the library already gets right.
   */
  error(message: string): void {
    this.snackbars.show({ content: message, color: 'error', closable: true })
  }

  /** A just-completed action finished with a neutral, non-error outcome worth naming. */
  info(message: string): void {
    this.snackbars.show({ content: message, color: 'info' })
  }
}
