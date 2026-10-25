import { createSignal } from 'solid-js'

/**
 * Whether the user has already been told what Cura does to a file it is given (ported from the
 * Angular `CuraHazardStore`, and wired into the launch flow in `core/slicer-launch.ts`).
 *
 * **The hazard is measured and the app can neither cause it nor fix it.** Cura is the one slicer of
 * the five that never saves in place: its Ctrl+S is always a Save-As, and it defaults to a sticky
 * global directory which on the machine the spikes ran on is a real folder inside the user's own
 * model library. A user who presses Ctrl+S and then Enter writes a copy into that folder, where
 * this app will index it as somebody else's project.
 *
 * The launch still happens after the warning, as far as *this* hazard is concerned. Cura against a
 * file is perfectly useful for viewing and slicing, and refusing to launch it over a save-as would
 * make the feature less useful than not having it, so this is a notice with a way past it, not a
 * gate. One unrelated thing can still refuse after the user presses past it: the shell refuses a
 * `.step` or a `.stp` handed to Cura outright, because Cura ships no STEP reader.
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
    /** Forgets the acknowledgement: what a new session starts from (and what a test needs). */
    reset: () => setSeen(false),
  }
}

export type CuraHazardStore = ReturnType<typeof createCuraHazardStore>

export const curaHazard = createCuraHazardStore()
