import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core'
import { RouterLink, RouterOutlet } from '@angular/router'
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
          <button type="button" (click)="auth.logout()">{{ t.translations().app.signOut }}</button>
        }
      </nav>
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

  constructor() {
    effect(() => {
      this.colorScheme.set(this.settings.settings().theme)
    })
  }
}
