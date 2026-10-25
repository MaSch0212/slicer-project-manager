import { createMemo, createRoot } from 'solid-js'
import type { Capabilities } from '../api/generated'
import { Layers, LogOut, Search, Settings, Users, type IconComponent } from '../ui/icons'
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
 * Import and Change-folder are not here: the settings page offers both.
 */
export function navEntriesFor(
  caps: Capabilities,
  session: { isAuthenticated: boolean; isAdmin: boolean },
): readonly NavEntry[] {
  // The same expression as the auth guard, for the same reason: with nothing to sign in *to*,
  // the navigation must not wait for a user.
  if (caps.requiresAuth && !session.isAuthenticated) return []
  const entries: NavEntry[] = [
    { id: 'projects', labelKey: 'projects.title', icon: Layers, route: '/projects' },
  ]
  if (caps.canBrowseModelSites) {
    entries.push({ id: 'browse', labelKey: 'browse.title', icon: Search, route: '/browse' })
  }
  entries.push({ id: 'settings', labelKey: 'settings.title', icon: Settings, route: '/settings' })
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
    navEntriesFor(capabilities.capabilities(), {
      isAuthenticated: auth.isAuthenticated(),
      isAdmin: auth.isAdmin(),
    }),
  ),
)

/** The entry's label in the current language. */
export const navLabel = (entry: NavEntry): string => t(entry.labelKey)
