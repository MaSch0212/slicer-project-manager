import type { Session } from 'electron'

/**
 * What the app's **own** session grants, as against the browse partition's blanket refusal.
 *
 * Spec 3.7 recorded that `defaultSession` had no permission handler of either kind, which is
 * Electron's "neither handler" column: a document on it is **granted** geolocation and
 * notifications with no prompt. The exposure was and is bounded — the main window only ever loads
 * `spm://app`, the app's own bundle, and every remote document subsystem E introduces is on the
 * browse partition — but leaving the app's own session on those defaults while `browse/host.ts`
 * argues at length for handlers on the partition is an inconsistency with nothing behind it.
 *
 * **The reason it was recorded rather than fixed was not caution for its own sake, and it turned
 * out to be right.** `packages/web` calls `navigator.clipboard.writeText` (`users.page.ts`'s
 * `onCopy`, the one-time activation link), and whether this Electron raises a permission for that
 * at all was unmeasured. Open question 9.20 asked for one run with a *recording* handler on
 * `defaultSession` while the app was exercised. That run was made — **Electron 44.0.0, Windows 11,
 * three launches of the real shell, one variable each:**
 *
 * 1. **A recorder that grants everything.** A `writeText` driven by a real click in the renderer
 *    raised the *request* handler exactly once, as `'clipboard-sanitized-write'` with
 *    `requestingUrl: 'spm://app/projects'`. The *check* handler saw `media` (video and audio),
 *    `web-app-installation`, `geolocation` and `notifications` during startup alone, and
 *    `navigator.permissions.query` answered `granted` for geolocation, notifications and the
 *    clipboard alike.
 * 2. **A blanket deny.** The same click **rejected**:
 *    `NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.` So
 *    the blanket deny the earlier round declined would have removed a working feature, exactly as
 *    3.7 suspected and could not show.
 * 3. **A deny with this list.** The click resolved, `query({ name: 'clipboard-write' })` answered
 *    `granted`, and geolocation and notifications both answered `denied`.
 *
 * So the rule is a refusal with **one** measured exception, and the exception is named by the
 * string Chromium actually raises rather than by the one the web API is spelled with:
 * `navigator.clipboard.writeText` is `clipboard-sanitized-write`, and a handler written against
 * `'clipboard-write'` would deny the very thing it meant to allow.
 *
 * **`clipboard-read` is deliberately absent.** Nothing in `packages/web` reads the clipboard; the
 * check handler saw the name only because `permissions.query` asked about it, and a paste the app
 * never performs is not a capability to grant ahead of a caller. The next feature that needs a
 * permission adds itself here on purpose, which is the cost this list is for.
 */
export const APP_SESSION_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write']

/** Whether the app's own session grants this permission. See {@link APP_SESSION_PERMISSIONS}. */
export function isAppSessionPermissionAllowed(permission: string): boolean {
  return APP_SESSION_PERMISSIONS.includes(permission)
}

/**
 * Installs both handlers on one session.
 *
 * **Both, for the reason `browse/host.ts` gives about the partition's own pair**: with the request
 * handler alone, `navigator.permissions.query` still answers `granted` out of an API that never
 * raises a request, so a page reads a permission nobody refused. Re-measured here — with both, the
 * query answers `denied`.
 *
 * The session is a parameter and has no default, which is what keeps this module free of a *value*
 * import from `electron`: the type import above is erased, so the whole file runs under plain
 * `node --test` against a fake, the way `browse/notices.ts` does. `app.ts` is the only caller and
 * it passes `session.defaultSession`.
 */
export function applyAppSessionPermissions(target: Session): void {
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isAppSessionPermissionAllowed(permission))
  })
  target.setPermissionCheckHandler((_contents, permission) =>
    isAppSessionPermissionAllowed(permission),
  )
}
