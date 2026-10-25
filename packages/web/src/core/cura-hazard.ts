import { createSignal } from 'solid-js'

/**
 * Whether the user has already been told what Cura does to a file it is given (ported from the
 * Angular `CuraHazardStore`).
 *
 * **This is a desktop-only notice, and nothing in the browser build shows it yet.** It guards the
 * "hand this file to my slicer" action, which exists only where `capabilities.canLaunchSlicer` is
 * true: the Tauri shell, through a desktop command. A browser has no way to start a program on the
 * user's machine, so there is nothing to warn about there. The store is kept (small, tested, and
 * the behaviour is specified) so the desktop step can wire the warning without redesigning it.
 *
 * TODO(desktop step): in the project detail page's file actions, when the slicer that would be used
 * is Cura (see legacy `resolveLaunchSlicer`) and `!curaHazard.acknowledged()`, show the
 * `projects.curaHazard*` notice with a "hand it over anyway" path and a "don't show this again"
 * checkbox that calls `acknowledge()`. The strings are already in both locale files.
 *
 * Once per session, deliberately not persisted: a warning that reappears after a restart is the
 * right way for it to be wrong.
 */
export function createCuraHazardStore() {
  const [seen, setSeen] = createSignal(false)
  return {
    /** True once the user has said they do not want to be told again. */
    acknowledged: seen,
    acknowledge: () => setSeen(true),
  }
}

export const curaHazard = createCuraHazardStore()
