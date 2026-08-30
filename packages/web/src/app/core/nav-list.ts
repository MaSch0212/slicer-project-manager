import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core'
import { RouterLink, RouterLinkActive } from '@angular/router'
import { JigIcon } from '@awdlab/jig/icon'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tablerLogout from '@iconify/icons-tabler/logout'
import tablerSearch from '@iconify/icons-tabler/search'
import tablerSettings from '@iconify/icons-tabler/settings'
import tablerStack2 from '@iconify/icons-tabler/stack-2'
import tablerUsers from '@iconify/icons-tabler/users'
import { AuthStore } from './auth.store'
import { CapabilitiesStore } from './capabilities.store'
import { TranslateService } from './i18n/translate.service'

/**
 * One entry of the navigation (spec G 4.4).
 *
 * `route` is `null` for sign out, which is the one entry that does something instead of going
 * somewhere. That is why the template has an anchor arm and a button arm: a control that acts is
 * a `<button>`, and an anchor with no destination is not a link to anything.
 */
export type NavEntry = {
  /** Stable across re-computation, so `@for` tracks an entry rather than its position. */
  readonly id: string
  readonly label: string
  /** Typed off one of the imported icons rather than importing `@iconify/types`, which is a
      transitive dependency this package does not declare. */
  readonly icon: typeof tablerStack2
  /** Where the entry goes, or `null` for the sign-out action, which goes nowhere. */
  readonly route: string | null
}

/**
 * The navigation entries and their gates, in one place (spec G 4.3).
 *
 * **Two hosts render this component: the desktop sidebar and the mobile drawer, both in
 * `app.ts`.** That is the whole reason it is a component rather than markup in the shell. A
 * second copy of this list is the cross-referenced-pair defect this project keeps finding, and
 * the cheapest way not to have it is not to have a second copy — the alternative was a sidebar
 * and a drawer that agree today and disagree the first time an entry is added to one of them.
 *
 * It lives in `core/` and imports nothing from `features/desktop/` (constraint C2, which CI's
 * bundle greps enforce). The desktop-only Browse entry is reached the way every desktop-only
 * surface in shared code is reached: a capability flag and a `routerLink` string. No component
 * here asks which shell it is in (C3).
 *
 * ## The gates are copied, not re-derived
 *
 * Every condition below is the expression the header carried before this component existed, with
 * the reason it was written that way carried along with it. Import and Change-folder are the only
 * entries that left, and they left because the settings General tab now offers both
 * (`features/settings/general.tab.ts`) — not because their gates were wrong.
 *
 * ## Why the labels are a computed array and not markup
 *
 * The list is data so that the two hosts cannot render different lists, and so that a test can
 * compare what each host rendered without reading this file. Reading `t.translations()` inside
 * the computed keeps it reactive to a language change, which markup would have got for free and
 * a plain array would have lost.
 */
@Component({
  selector: 'spm-nav-list',
  imports: [RouterLink, RouterLinkActive, JigIcon, JigTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="spm-nav-list" [class.spm-nav-list--collapsed]="collapsed()">
      @for (entry of entries(); track entry.id) {
        <li>
          <!-- The tooltip is bound to null when the labels are visible, and a falsy content is
               how JigTooltip is told there is no tooltip (read from the installed control: it
               removes its aria attributes and never constructs the overlay). So an expanded
               entry does not carry a tooltip repeating the words next to it.

               jigTooltipAutoAriaMode="none" because the accessible name is already the label
               span, which is only ever *visually* hidden. Left at its default the directive
               would add an aria-description saying the same thing the name says. -->
          @if (entry.route; as route) {
            <a
              class="spm-nav-entry"
              [routerLink]="route"
              routerLinkActive="spm-nav-active"
              [jigTooltip]="collapsed() ? entry.label : null"
              jigTooltipAutoAriaMode="none"
            >
              <jig-icon [icon]="entry.icon" />
              <span class="spm-nav-label">{{ entry.label }}</span>
            </a>
          } @else {
            <button
              class="spm-nav-entry"
              type="button"
              [jigTooltip]="collapsed() ? entry.label : null"
              jigTooltipAutoAriaMode="none"
              (click)="signOut.emit()"
            >
              <jig-icon [icon]="entry.icon" />
              <span class="spm-nav-label">{{ entry.label }}</span>
            </button>
          }
        </li>
      }
    </ul>
  `,
})
export class SpmNavList {
  private readonly auth = inject(AuthStore)
  private readonly capabilities = inject(CapabilitiesStore)
  private readonly t = inject(TranslateService)

  /**
   * Icons only, labels kept in the accessibility tree. Ignored by the drawer, which is always
   * the full list (spec G 4.3) — so this input has a default and the drawer simply omits it.
   */
  readonly collapsed = input(false)

  /**
   * Sign out is an action, so the entry list cannot complete it on its own: the shell owns the
   * navigation to `/login` that has to follow, and owns it for both hosts at once.
   */
  readonly signOut = output<void>()

  private readonly icons = {
    projects: tablerStack2,
    browse: tablerSearch,
    settings: tablerSettings,
    users: tablerUsers,
    signOut: tablerLogout,
  }

  protected readonly entries = computed<readonly NavEntry[]>(() => {
    const capabilities = this.capabilities.capabilities()
    const translations = this.t.translations()
    const entries: NavEntry[] = []

    // The same expression the auth guard uses (core/guards.ts), and for the same reason: in a
    // shell that requires no authentication there is nothing to be signed in *to*, so the
    // navigation must not wait for a user. This is a capability, not a shell check.
    if (!capabilities.requiresAuth || this.auth.isAuthenticated()) {
      entries.push({
        id: 'projects',
        label: translations.projects.title,
        icon: this.icons.projects,
        route: '/projects',
      })
      // Spec E 7.4's canBrowseModelSites. A route name and nothing more: this is shared code
      // and must not import from features/desktop/, so the route it names does not exist in the
      // web build at all. It is never rendered there either, because the capability that gates
      // it is false in the browser column -- the capability model doing its job in place of a
      // build-time condition.
      if (capabilities.canBrowseModelSites) {
        entries.push({
          id: 'browse',
          label: translations.browse.title,
          icon: this.icons.browse,
          route: '/browse',
        })
      }
      entries.push({
        id: 'settings',
        label: translations.settings.title,
        icon: this.icons.settings,
        route: '/settings',
      })
      if (capabilities.canManageUsers && this.auth.isAdmin()) {
        entries.push({
          id: 'users',
          label: translations.admin.title,
          icon: this.icons.users,
          route: '/admin/users',
        })
      }
      // Only where there is a session to end. Without this gate the desktop shell shows a
      // sign-out button that drops the user on /login: a page with nothing to sign in to
      // (auth.login answers Forbidden, which the login page renders as "Username or password is
      // not correct"), reached by a control that also takes the navigation away on the way out.
      // The button did nothing wrong -- there is simply no such thing as signing out of a folder
      // you opened.
      if (capabilities.requiresAuth) {
        entries.push({
          id: 'sign-out',
          label: translations.app.signOut,
          icon: this.icons.signOut,
          route: null,
        })
      }
    }

    return entries
  })
}
