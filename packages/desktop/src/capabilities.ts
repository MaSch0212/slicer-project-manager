import type { Capabilities } from '@spm/contract/dtos.ts'

/**
 * Spec 2.4's capability model, which is the one part of this app that only the desktop shell can
 * exercise in full: it is the only client that can be pointed at two different backends.
 *
 * The model is two columns and a union. The **shell** contributes what the process it runs in can
 * do — open a native folder dialog, launch a slicer, embed a model browser. The **backend**
 * contributes what the thing holding the data can do — require a login, host user accounts. A
 * browser has one shell column and one backend column and never notices the difference; the
 * Electron app pointed at a remote server needs remote auth *and* local slicer launching at the
 * same time, which is the row a build-time flag cannot express.
 *
 * Nothing here imports `electron`, so `test/capabilities.test.ts` covers every flag under plain
 * `node --test`.
 */

/**
 * The shell's column in **local folder** mode (spec 2.4, second column).
 *
 * `requiresAuth: false` is what spec 2.6 says local mode is, and it is asserted on directly. It
 * is *not*, on its own, what gets the renderer off `/login`, and the carried-in ruling that said
 * so is wrong — measured in task 4, by flipping this one flag back to `true` and running the
 * desktop suite: the app still lands on `spm://app/projects` and thirteen of fourteen tests stay
 * green. The guard is `!capabilities.requiresAuth || auth.isAuthenticated()` (guards.ts), and the
 * bridge satisfies *both* arms at once: this flag is the first, and `account.me` answering with
 * `ensureLocalUser`'s row is the second.
 *
 * `canPickLocalFolder` is true because `library.pick` opens a real native dialog and reopens the
 * library, and the header control the renderer shows for this flag reaches it through `ApiClient`
 * like every other affordance.
 *
 * The three slicer/browser flags stay false until specs D and E ship them, which is a deliberate
 * departure from the spec table: a capability whose feature does not exist lights up UI that goes
 * nowhere. When D flips `canLaunchSlicer` here it lights up in **both** modes with no other
 * change, which is the whole point of the union below.
 */
export const LOCAL_SHELL_CAPABILITIES: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

/**
 * The shell's column in **remote server** mode (spec 2.4, third column, shell half).
 *
 * **One flag differs from the local column, and it is the whole reason this is a second constant
 * rather than one shared one.** `canPickLocalFolder` is false here. It is not a property of the
 * shell — the process can obviously still open a folder dialog, and the menu still offers one —
 * it is a property of the *mode*: the library on screen belongs to the server, and a "change
 * library folder" control beside it would swap the entire app to somebody else's library while
 * the page around it still showed remote data. Spec 2.4 says `no` for this row and this is where
 * that `no` comes from.
 *
 * The consequence is stated here because it is the trap: with a single flat shell column — which
 * is what this package had until task 5 — `union` produces `true` for this flag in remote mode,
 * and the test that would catch it is not the union's, it is this constant's. `test/
 * capabilities.test.ts` asserts both objects whole.
 *
 * The three slicer/browser flags are false for the same reason as above, and their *row* is the
 * one spec 2.4 wrote the union for: a server that reports them false must not be able to switch
 * off a slicer the desktop shell can genuinely launch.
 */
export const REMOTE_SHELL_CAPABILITIES: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

/**
 * The union of a shell column and a backend column — spec 2.4's "the client uses the union".
 *
 * It is `||` on all six, and that is not one rule applied six times. Three different arguments
 * happen to land on the same operator, and a reader who takes it for "OR because booleans" will
 * get the next flag wrong:
 *
 * | flag                    | who owns it | why `\|\|` is right                                              |
 * | ----------------------- | ----------- | --------------------------------------------------------------- |
 * | `requiresAuth`          | backend     | It is a **restriction**, not an affordance, so the safe combinator is the *most restrictive* answer — and for a boolean restriction that is `\|\|`. `&&` would let the shell's `false` switch off a login screen while every request still came back 401. |
 * | `canManageUsers`        | backend     | Only a backend with user rows can offer this; the shell contributes a constant `false` and the `\|\|` passes the backend's answer through untouched. |
 * | `canPickLocalFolder`    | **mode**    | `\|\|` is right only because the shell column is mode-scoped — see `REMOTE_SHELL_CAPABILITIES`. Over one flat shell column this flag is where a naive union is a defect, not a style. |
 * | `canLaunchSlicer`       | shell       | The row spec 2.4 wrote the union for: a backend that cannot launch a slicer must not be able to veto a shell that can. `&&` would make the remote column identical to the browser's. |
 * | `canConfigureSlicers`   | shell       | as above |
 * | `canBrowseModelSites`   | shell       | as above |
 *
 * There is deliberately no second operand for local mode. With no backend there is nothing to
 * union with, and passing the *local* column to itself would be a no-op that read as if it were
 * doing something — so `shellCapabilities` below answers that case by returning the column.
 */
export function unionCapabilities(shell: Capabilities, backend: Capabilities): Capabilities {
  return {
    requiresAuth: shell.requiresAuth || backend.requiresAuth,
    canManageUsers: shell.canManageUsers || backend.canManageUsers,
    canPickLocalFolder: shell.canPickLocalFolder || backend.canPickLocalFolder,
    canLaunchSlicer: shell.canLaunchSlicer || backend.canLaunchSlicer,
    canConfigureSlicers: shell.canConfigureSlicers || backend.canConfigureSlicers,
    canBrowseModelSites: shell.canBrowseModelSites || backend.canBrowseModelSites,
  }
}

/**
 * Whether a value off the wire is a `Capabilities`. The remote server is not trusted to be the
 * server we think it is: it may be a proxy's error page, an old build, or an unrelated service on
 * the port the user typed.
 *
 * Every one of the six keys must be present and boolean. A partial object would union into
 * `undefined || false` — `false` — which would silently switch off affordances the shell really
 * has rather than saying the backend answered nonsense.
 */
export function isCapabilities(value: unknown): value is Capabilities {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (Object.keys(LOCAL_SHELL_CAPABILITIES) as (keyof Capabilities)[]).every(
    (key) => typeof record[key] === 'boolean',
  )
}
