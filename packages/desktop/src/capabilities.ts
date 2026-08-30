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
 * desktop suite: the app still landed on `spm://app/projects` and almost every test stayed green.
 * (The count that used to be here was of a suite that has since more than tripled, so it said
 * less each round; what matters is that flipping the flag did not move the app.)
 *
 * The guard is `!capabilities.requiresAuth || auth.isAuthenticated()` (guards.ts), and the bridge
 * satisfies *both* arms at once: this flag is the first, and `account.me` answering with
 * `ensureLocalUser`'s row is the second.
 *
 * `canPickLocalFolder` is true because `library.pick` opens a real native dialog and reopens the
 * library, and the library card the renderer shows for this flag — settings → General, spec G 6.1
 * — reaches it through `ApiClient` like every other affordance.
 *
 * `canLaunchSlicer` and `canConfigureSlicers` are true because spec D shipped them: the shell
 * detects the slicers installed on this machine, `/settings/slicers` configures them, and both
 * work whichever library is open. `canBrowseModelSites` is true because spec E shipped it, on the
 * same argument: the browse view is a `WebContentsView` in *this process*, and which library is
 * open has nothing to say about whether this process can embed one.
 *
 * **A flag flipped here is flipped in this column only**, and an earlier version of this comment
 * claimed otherwise. Local mode *returns* this object (`shell.ts:170`); remote mode unions
 * `REMOTE_SHELL_CAPABILITIES` with the backend (`remote.ts:305`) and never reads this one. The two
 * columns are edited together or the flag lights up in one mode and not the other — which is the
 * whole reason `test/capabilities.test.ts` asserts both of them whole.
 */
export const LOCAL_SHELL_CAPABILITIES: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: true,
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
 * The two slicer flags are true here for the same reason they are true in the local column — the
 * machine this process runs on has the slicers on it whatever library is open — and this is the
 * row spec 2.4 wrote the union for: the Deno server reports both false, and a server that cannot
 * launch a slicer must not be able to switch off a shell that can. `canBrowseModelSites` is true
 * here as well as locally, and **the landing goes to whichever library is open**: the browser is
 * embedded by this process on this machine, and `browse.land` streams the staged bytes through
 * the proxy to the remote server. The browser column stays false, now on evidence rather than on
 * a deferral — the sites refuse framing, a `WebContentsView` is what loads them, and a browser
 * build has no `WebContentsView`.
 */
export const REMOTE_SHELL_CAPABILITIES: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: true,
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
