import type { UserDto } from '../api/generated'
import { setLanguage } from './i18n'
import { auth, capabilities, settings } from './stores'

/** True where there is something to show: signed in, or a shell with no sign-in at all. */
export function hasSession(): boolean {
  return !capabilities.capabilities().requiresAuth || auth.isAuthenticated()
}

async function loadPreferences(): Promise<void> {
  await settings.load()
  await setLanguage(settings.settings().language)
}

/**
 * Runs once before the first render: what the server is (capabilities), whether this browser
 * already has a session, and, if there is something to show, that user's settings and language.
 */
export async function bootstrap(): Promise<void> {
  await capabilities.load()
  await auth.refresh()
  if (hasSession()) await loadPreferences()
}

/** After a successful sign-in or activation: the new user's settings replace the defaults. */
export async function signedIn(user: UserDto): Promise<void> {
  auth.setUser(user)
  await loadPreferences()
}

/** Ends the session. The local state is gone even if the server call failed, which is rethrown. */
export async function signOut(): Promise<void> {
  try {
    await auth.logout()
  } finally {
    settings.reset()
  }
}
