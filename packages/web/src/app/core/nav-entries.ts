import { Injectable, computed, inject } from '@angular/core'
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
 * somewhere. That is why `SpmNavList` has an anchor arm and a button arm: a control that acts is
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
 * The navigation entries and their gates. One definition, read by everything that needs to know
 * what the navigation contains.
 *
 * **It is a store rather than a field on `SpmNavList` because two different things read it**, and
 * only one of them renders it. `SpmNavList` renders the entries into both of its hosts; `App`
 * asks whether there are any, because a shell with nothing to navigate to must not draw sidebar
 * chrome around an empty list. That second question has to be answerable *outside* the component
 * that would be inside the chrome, and answering it by repeating the auth gate in `App` would be
 * re-deriving a gate — the one thing this task is not allowed to do. Reading the list's own
 * length is the honest condition, and it cannot drift from the list.
 *
 * It lives in `core/` and imports nothing from `features/desktop/` (constraint C2, which CI's
 * bundle greps enforce). The desktop-only Browse entry is reached the way every desktop-only
 * surface in shared code is reached: a capability flag and a `routerLink` string. Nothing here
 * asks which shell it is in (C3).
 *
 * ## The gates are copied, not re-derived
 *
 * Every condition below is the expression the header carried before this subsystem, with the
 * reason it was written that way carried along with it. Import and Change-folder are the only
 * entries that left, and they left because the settings General tab now offers both
 * (`features/settings/general.tab.ts`) — not because their gates were wrong.
 *
 * ## Why the labels are data and not markup
 *
 * The list is data so that the sidebar and the drawer cannot render different lists, and so that
 * a test can compare what each host actually rendered without reading this file. Reading
 * `t.translations()` inside the computed keeps it reactive to a language change, which markup
 * would have got for free and a plain array would have lost.
 */
@Injectable({ providedIn: 'root' })
export class NavEntriesStore {
  private readonly auth = inject(AuthStore)
  private readonly capabilities = inject(CapabilitiesStore)
  private readonly t = inject(TranslateService)

  private readonly icons = {
    projects: tablerStack2,
    browse: tablerSearch,
    settings: tablerSettings,
    users: tablerUsers,
    signOut: tablerLogout,
  }

  readonly entries = computed<readonly NavEntry[]>(() => {
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
