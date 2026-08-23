import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core'
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { ColorSchemeService } from '@awdlab/jig/api/ng'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigMessage } from '@awdlab/jig/message'
import { JigToolbar } from '@awdlab/jig/toolbar'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tablerLogout from '@iconify/icons-tabler/logout'
import tablerSettings from '@iconify/icons-tabler/settings'
import tablerStack2 from '@iconify/icons-tabler/stack-2'
import tablerUpload from '@iconify/icons-tabler/upload'
import tablerUsers from '@iconify/icons-tabler/users'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { TranslateService } from './core/i18n/translate.service'
import { SettingsStore } from './core/settings.store'

/** The shell: routing, nav and the theme sync. */
@Component({
  selector: 'app-root',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    JigButton,
    JigIcon,
    JigMessage,
    JigToolbar,
    JigTooltip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="spm-shell">
      <header class="spm-header">
        <div class="spm-header-inner">
          <!-- One tab stop for the whole bar, arrow keys between the items, and the end
               placement stays right-aligned as the window narrows. -->
          <jig-toolbar>
            <a class="spm-brand" routerLink="/projects">{{ t.translations().app.title }}</a>

            <!-- One <ng-container placement="end">, not one attribute per link: the toolbar
                 resolves projection slots at compile time, so a control-flow block whose root
                 holds several projectable nodes drops all but the first out of its slot
                 (NG8011). Wrapping them makes the @if a single node again. -->
            @if (auth.isAuthenticated()) {
              <ng-container placement="end">
                <a jigButton kind="text" routerLink="/projects" routerLinkActive="spm-nav-active">
                  <jig-icon [icon]="icons.projects" />
                  {{ t.translations().projects.title }}
                </a>
                <a jigButton kind="text" routerLink="/import" routerLinkActive="spm-nav-active">
                  <jig-icon [icon]="icons.import" />
                  {{ t.translations().import.title }}
                </a>
                <a jigButton kind="text" routerLink="/settings" routerLinkActive="spm-nav-active">
                  <jig-icon [icon]="icons.settings" />
                  {{ t.translations().settings.title }}
                </a>
                @if (capabilities.capabilities().canManageUsers && auth.isAdmin()) {
                  <a
                    jigButton
                    kind="text"
                    routerLink="/admin/users"
                    routerLinkActive="spm-nav-active"
                  >
                    <jig-icon [icon]="icons.users" />
                    {{ t.translations().admin.title }}
                  </a>
                }
                <button
                  jigButton
                  kind="icon"
                  type="button"
                  [jigTooltip]="t.translations().app.signOut"
                  jigTooltipAutoAriaMode="label"
                  (click)="onSignOut()"
                >
                  <jig-icon [icon]="icons.signOut" />
                </button>
              </ng-container>
            }
          </jig-toolbar>
        </div>
      </header>

      @if (signOutFailed()) {
        <div class="spm-header-inner">
          <jig-message color="error" role="alert">{{
            t.translations().errors.generic
          }}</jig-message>
        </div>
      }

      <router-outlet />
    </div>
  `,
})
export class App {
  protected readonly auth = inject(AuthStore)
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)
  private readonly settings = inject(SettingsStore)
  // The actual theme hook: @awdlab/jig ships a `dark` class toggle driven by this service,
  // not a `data-theme` attribute. ColorScheme is 'light' | 'dark' | 'system' — the same
  // union as SettingsDto['theme'] — so 'system' needs no manual resolution here:
  // ColorSchemeService itself resolves it against `(prefers-color-scheme: dark)` and stays
  // reactive to that media query changing.
  private readonly colorScheme = inject(ColorSchemeService)
  private readonly router = inject(Router)

  protected readonly icons = {
    projects: tablerStack2,
    import: tablerUpload,
    settings: tablerSettings,
    users: tablerUsers,
    signOut: tablerLogout,
  }

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
