import { Injectable, signal } from '@angular/core'

/**
 * Whether the user has already been told what Cura does to a file it is given.
 *
 * **The hazard is measured and the app can neither cause it nor fix it.** Cura is the one slicer
 * of the five that never saves in place: its Ctrl+S is always a Save-As, and it defaults to a
 * sticky global directory which on the machine the spikes ran on is a real folder inside the
 * user's own model library. A user who presses Ctrl+S and then Enter writes a copy into that
 * folder, where this app will index it as somebody else's project.
 *
 * The launch still happens after the warning, as far as *this* hazard is concerned. Cura against a
 * file is perfectly useful for viewing and slicing, and refusing to launch it over a save-as would
 * make the feature less useful than not having it — so this is a notice with a way past it, not a
 * gate.
 *
 * **One unrelated thing can still refuse after the user presses past it**, and it is not this
 * store's: the main process refuses a `.step` or a `.stp` handed to Cura outright, because Cura
 * ships no STEP reader and the measured alternative is an empty plate and a line in a log the user
 * will never open. That refusal arrives as an `AppError` from the launch call, after this warning
 * rather than instead of it, because nothing the page holds today says which formats a product
 * reads.
 *
 * **Once per session, in the renderer's sense of a session.** The flag lives here, in a root
 * provider, rather than in a component, because it must survive navigating between projects; it
 * is deliberately not persisted. There is no client-side store in this app to persist it to —
 * nothing anywhere reads or writes `localStorage` — and the server-side settings are the Deno
 * server's, which subsystem D may not change. A warning that reappears after a restart is the
 * right way for that to be wrong.
 */
@Injectable({ providedIn: 'root' })
export class CuraHazardStore {
  private readonly seen = signal(false)

  /** True once the user has said they do not want to be told again. */
  readonly acknowledged = this.seen.asReadonly()

  acknowledge(): void {
    this.seen.set(true)
  }
}
