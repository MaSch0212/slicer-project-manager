import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core'
import { Router, RouterLink, RouterOutlet } from '@angular/router'
import { ColorSchemeService } from '@awdlab/jig/api/ng'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { TranslateService } from './core/i18n/translate.service'
import { SettingsStore } from './core/settings.store'

/** The shell: routing, nav and the theme sync. Tasks 19-22 fill in the remaining pages. */
@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <a routerLink="/projects">{{ t.translations().app.title }}</a>
      <nav>
        <a routerLink="/settings">{{ t.translations().settings.title }}</a>
        @if (capabilities.capabilities().canManageUsers && auth.isAdmin()) {
          <a routerLink="/admin/users">{{ t.translations().admin.title }}</a>
        }
        @if (auth.isAuthenticated()) {
          <button type="button" (click)="onSignOut()">{{ t.translations().app.signOut }}</button>
        }
      </nav>
      @if (signOutFailed()) {
        <p role="alert">{{ t.translations().errors.generic }}</p>
      }
    </header>
    <main><router-outlet /></main>
  `,
})
export class App {
  protected readonly auth = inject(AuthStore)
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)
  private readonly settings = inject(SettingsStore)
  // The actual theme hook: @awdlab/jig ships a `dark` class toggle driven by this service,
  // not a `data-theme` attribute (see task-18-report.md). ColorScheme is 'light' | 'dark' |
  // 'system' — the same union as SettingsDto['theme'] — so 'system' needs no manual
  // resolution here: ColorSchemeService itself resolves it against
  // `(prefers-color-scheme: dark)` and stays reactive to that media query changing.
  private readonly colorScheme = inject(ColorSchemeService)
  private readonly router = inject(Router)

  readonly signOutFailed = signal(false)

  constructor() {
    effect(() => {
      this.colorScheme.set(this.settings.settings().theme)
    })
  }

  /**
   * The nav used to bind `(click)="auth.logout()"` straight through. Two defects in one:
   * `AuthStore.logout` rethrows after clearing local state in its `finally`, so a failed
   * logout escaped as an unhandled rejection with nothing shown; and nothing navigated, so
   * a *successful* sign-out left the user on `/projects` with the grid still rendered.
   */
  async onSignOut(): Promise<void> {
    this.signOutFailed.set(false)
    try {
      await this.auth.logout()
    } catch {
      // The local session is already gone (logout clears it in a `finally`); what may have
      // survived is the server's own session row, which the user cannot fix from here — so
      // this reports, it does not offer a retry.
      this.signOutFailed.set(true)
    }
    // Outside the try on purpose: either way the user is signed out locally, so leaving
    // them on an authenticated route would be the same bug in both branches.
    await this.router.navigateByUrl('/login')
  }
}
