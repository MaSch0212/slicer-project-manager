import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core'
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { ColorSchemeService } from '@awdlab/jig/api/ng'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigMessage } from '@awdlab/jig/message'
import { JigToolbar } from '@awdlab/jig/toolbar'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tablerFolder from '@iconify/icons-tabler/folder'
import tablerLogout from '@iconify/icons-tabler/logout'
import tablerSearch from '@iconify/icons-tabler/search'
import tablerSettings from '@iconify/icons-tabler/settings'
import tablerStack2 from '@iconify/icons-tabler/stack-2'
import tablerUpload from '@iconify/icons-tabler/upload'
import tablerUsers from '@iconify/icons-tabler/users'
import { API_CLIENT } from './core/api/api-client.token'
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
            <!-- The same mark the browser tab shows: packages/web/public/favicon.svg, which the
                 Angular build copies to the site root unhashed.

                 alt="" is what does the work. The link's own text already names the app, so a
                 second accessible name here would have a screen reader announce "Slicer Project
                 Manager Slicer Project Manager". aria-hidden says the same thing twice on
                 purpose: this is exactly the kind of decoration someone later "fixes" by adding
                 alt text.

                 width and height are the intrinsic box, so the header does not reflow between
                 layout and image decode. The src is resolved through the base href="/" in
                 index.html, which is what makes it spm://app/favicon.svg in the Electron
                 renderer rather than a lookup relative to the current route.

                 No backticks in this comment, and no dollar-brace either: the template is a JS
                 template literal, so both are syntax before they are text. Measured -- a first
                 version of this comment quoted the file path in backticks and esbuild failed
                 with 'Expected "}" but found "packages"'. -->
            <a class="spm-brand" routerLink="/projects">
              <img
                class="spm-brand-mark"
                src="favicon.svg"
                alt=""
                aria-hidden="true"
                width="28"
                height="28"
              />
              {{ t.translations().app.title }}
            </a>

            <!-- One <ng-container placement="end">, not one attribute per link: the toolbar
                 resolves projection slots at compile time, so a control-flow block whose root
                 holds several projectable nodes drops all but the first out of its slot
                 (NG8011). Wrapping them makes the @if a single node again. -->
            <!-- The same expression the auth guard uses (core/auth/guards.ts), and for the same
                 reason: in a shell that requires no authentication there is nothing to be
                 signed in *to*, so the navigation must not wait for a user. This is a
                 capability, not a shell check — no component here knows it is in Electron. -->
            @if (!capabilities.capabilities().requiresAuth || auth.isAuthenticated()) {
              <ng-container placement="end">
                <a jigButton kind="text" routerLink="/projects" routerLinkActive="spm-nav-active">
                  <jig-icon [icon]="icons.projects" />
                  {{ t.translations().projects.title }}
                </a>
                <a jigButton kind="text" routerLink="/import" routerLinkActive="spm-nav-active">
                  <jig-icon [icon]="icons.import" />
                  {{ t.translations().import.title }}
                </a>
                <!-- Spec E 7.4's canBrowseModelSites. A routerLink string and nothing more:
                     this file is shared code and must not import from features/desktop/, so the
                     route it names does not exist in the web build at all. It is never rendered
                     there either, because the capability that gates it is false in the browser
                     column -- the capability model doing its job in place of a build-time
                     condition, exactly as the folder picker below does. -->
                @if (capabilities.capabilities().canBrowseModelSites) {
                  <a jigButton kind="text" routerLink="/browse" routerLinkActive="spm-nav-active">
                    <jig-icon [icon]="icons.browse" />
                    {{ t.translations().browse.title }}
                  </a>
                }
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
                <!-- Spec 2.4's canPickLocalFolder, and the whole of how the desktop shell's
                     folder picker reaches the UI: a capability, an ApiClient call, and no
                     component that knows what an Electron is. False in the browser, where the
                     library lives on a server and there is no folder to choose. The dialog and
                     the reload both belong to the main process -- all this does is ask. -->
                @if (capabilities.capabilities().canPickLocalFolder) {
                  <button
                    jigButton
                    kind="icon"
                    type="button"
                    [jigTooltip]="t.translations().app.changeFolder"
                    jigTooltipAutoAriaMode="label"
                    (click)="onChangeFolder()"
                  >
                    <jig-icon [icon]="icons.folder" />
                  </button>
                }
                <!-- Only where there is a session to end. Without this gate the desktop shell
                     shows a sign-out button that drops the user on /login: a page with nothing
                     to sign in to (auth.login answers Forbidden, which the login page renders as
                     "Username or password is not correct"), reached by a control that also takes
                     the navigation away on the way out. The button did nothing wrong — there is
                     simply no such thing as signing out of a folder you opened. -->
                @if (capabilities.capabilities().requiresAuth) {
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
                }
              </ng-container>
            }
          </jig-toolbar>
        </div>
      </header>

      @if (signOutFailed() || changeFolderFailed()) {
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
  private readonly api = inject(API_CLIENT)
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
    browse: tablerSearch,
    settings: tablerSettings,
    users: tablerUsers,
    folder: tablerFolder,
    signOut: tablerLogout,
  }

  readonly signOutFailed = signal(false)
  readonly changeFolderFailed = signal(false)

  constructor() {
    effect(() => {
      this.colorScheme.set(this.settings.settings().theme)
    })
  }

  /**
   * Asks the shell for a different library folder.
   *
   * Nothing happens here on success, and that is the design rather than an omission: the shell
   * that opened the folder is the only thing that knows every store in this renderer is now
   * holding data from a library it has closed, so it reloads the window itself. A cancelled
   * picker resolves to null and is not a failure — the library that was open stays open.
   */
  async onChangeFolder(): Promise<void> {
    this.changeFolderFailed.set(false)
    try {
      await this.api.library.pick()
    } catch {
      // A folder that will not open is the realistic case: a file where a folder was, a drive
      // that is not mounted, a database from a newer schema. The shell has already logged the
      // detail; this is the user-facing half.
      this.changeFolderFailed.set(true)
    }
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
