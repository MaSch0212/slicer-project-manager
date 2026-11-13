import { createMemo, createRoot } from 'solid-js'
import type { Capabilities } from '../api/generated'
import { LogOut, Search, Settings, Users, type IconComponent } from '../ui/icons'
import { isDesktop } from './desktop'
import { t, type TranslationKey } from './i18n'
import { auth, capabilities } from './stores'

/**
 * One entry of the navigation (subsystem G, 4.4). `route` is `null` for sign out, the one entry
 * that does something instead of going somewhere.
 */
export type NavEntry = {
  readonly id: string
  readonly labelKey: TranslationKey
  readonly icon: IconComponent
  readonly route: string | null
}

/**
 * The entries and their gates, as a pure function of what the server and the session say, so a
 * test can run every combination. Every gate is a capability or the session, never "which shell
 * is this" (parent spec 2.4).
 *
 * Import and Change-folder are not here: the settings page offers both. Nor is the project list:
 * it is reached through the views above these entries, "All projects" first, so that one row and
 * not two is marked as where you are.
 *
 * `settingsInTitleBar` drops the Settings entry where the window's own title bar already has a
 * button for it and the app menu an entry: a third way to the same page was just noise. It is
 * about where the chrome is drawn, not about what the shell can do — a browser has no title bar
 * of the app's own, so there the sidebar is still the way to settings.
 */
export function navEntriesFor(
  caps: Capabilities,
  session: { isAuthenticated: boolean; isAdmin: boolean },
  options: { settingsInTitleBar?: boolean } = {},
): readonly NavEntry[] {
  // The same expression as the auth guard, for the same reason: with nothing to sign in *to*,
  // the navigation must not wait for a user.
  if (caps.requiresAuth && !session.isAuthenticated) return []
  const entries: NavEntry[] = []
  if (caps.canBrowseModelSites) {
    entries.push({ id: 'browse', labelKey: 'browse.title', icon: Search, route: '/browse' })
  }
  if (!options.settingsInTitleBar) {
    entries.push({ id: 'settings', labelKey: 'settings.title', icon: Settings, route: '/settings' })
  }
  if (caps.canManageUsers && session.isAdmin) {
    entries.push({ id: 'users', labelKey: 'admin.title', icon: Users, route: '/admin/users' })
  }
  // Only where there is a session to end: there is no such thing as signing out of a folder you
  // opened, and the button would drop the user on a login page with nothing to sign in to.
  if (caps.requiresAuth) {
    entries.push({ id: 'sign-out', labelKey: 'app.signOut', icon: LogOut, route: null })
  }
  return entries
}

export const navEntries = createRoot(() =>
  createMemo(() =>
    navEntriesFor(
      capabilities.capabilities(),
      { isAuthenticated: auth.isAuthenticated(), isAdmin: auth.isAdmin() },
      { settingsInTitleBar: isDesktop() },
    ),
  ),
)

/**
 * The routes that want the whole frame rather than the shell's centred column.
 *
 * `/browse` is a placeholder for a native view laid over the window, and a letterboxed
 * rectangle in the middle of the page was the thing that made it look like a web page
 * pretending to be a browser. `/settings` owns its scrolling too: its section menu is a column
 * beside the content, which only works if the content is what scrolls.
 */
const FULL_BLEED: readonly ((path: string) => boolean)[] = [
  (path) => path === '/browse',
  (path) => path === '/settings',
  // The list and the detail panel beside it are two scrolling columns of one frame.
  (path) => path === '/projects' || /^\/projects\/[^/]+(\/view\/[^/]+)?$/.test(path),
]

/** Whether this path is one of them. */
export function isFullBleed(path: string): boolean {
  return FULL_BLEED.some((matches) => matches(path))
}

/** The entry's label in the current language. */
export const navLabel = (entry: NavEntry): string => t(entry.labelKey)
