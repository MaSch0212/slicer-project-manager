/**
 * The URL shapes the desktop shell serves, in one dependency-free module.
 *
 * It is separate from `app.ts` because `app.ts` imports `electron` at its top level, and both
 * `dispatch.ts` (which must be unit-testable in plain Node) and task 3's protocol handler need
 * these strings. Nothing here imports anything.
 */

/**
 * The renderer's own host. `spm://app/` serves the Angular electron build — see the long note
 * in `app.ts` for why the renderer is not loaded from `file://`.
 */
export const RENDERER_HOST = 'app'
export const RENDERER_ORIGIN = `spm://${RENDERER_HOST}`

/**
 * The one path segment under the renderer's host that is *not* a renderer asset.
 *
 * The plan said `spm://file/<id>/thumb`, a second host. Ruling C-7 overrode it and left the
 * exact prefix to this task: `spm://file` is a different origin from `spm://app`, so a
 * `fetch()` from the renderer for a file — which is what B2's viewer does with `rawUrl` —
 * rejects with a bare `TypeError: Failed to fetch` until CORS headers exist. Task 1 measured
 * that and wrote it down in `app.ts`. Serving file bytes from a reserved path under the
 * renderer's own host makes them same-origin, and CORS never enters into it.
 *
 * `_spm` and not `files`, `api` or `spm`: the price of a path prefix is that it must never
 * collide with something the Angular build emits at the root of the renderer directory. That list
 * has grown once since this was written — the app icons added six root-level files — so it is
 * recorded here as measured from `packages/web/dist/electron/browser` rather than remembered:
 * `index.html`, `main.js`, `styles.css`, `chunk-<hash>.js`, a `.map` beside each of those, a
 * `media/` folder, and, from `packages/web/public/`, `favicon.ico`, `favicon.svg`,
 * `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and `manifest.webmanifest`.
 *
 * The reasoning survived the growth, and that is the point of writing the new names down: a
 * leading underscore is not a character the Angular builder produces at the top level for
 * anything, and it is not one anybody is going to give a favicon either. Everything the *public*
 * folder contributes is named by a person, which is a weaker guarantee than the builder's — so
 * the rule for adding a file there is that it must not start with `_`, and `shell.spec.ts` asserts
 * the ones that exist are served rather than swallowed by the reserved-prefix guard.
 *
 * `files.ts` answers the one canonical spelling under this prefix; `app.ts` goes on refusing
 * every other spelling of it. Both import the constant from here rather than spelling the string
 * a second time.
 */
export const RESERVED_PATH_SEGMENT = '_spm'

/**
 * What `createDecorators` is given in the desktop shell, so `FileDto.rawUrl` comes out as
 * `spm://app/_spm/files/<id>/raw` and `thumbUrl` as `spm://app/_spm/files/<id>/thumb`.
 */
export const FILE_URL_BASE = `${RENDERER_ORIGIN}/${RESERVED_PATH_SEGMENT}`

/**
 * Where an activation link would point if this shell ever issued one.
 *
 * It never does in local mode — `users.create` and `users.reissueInvite` both go through core's
 * `requireAdmin`, and `ensureLocalUser` makes the single local user a non-admin (spec 2.6), so
 * both throw `Forbidden` before a token is minted. The base exists because the dispatch entries
 * have to return the `ApiClient` shape regardless, and a placeholder string that is wrong would
 * be worse than one that is right. Same shape as the server's `activationUrl`: the token rides
 * in the fragment so it never reaches a log (spec 5.3).
 */
export const ACTIVATION_URL_BASE = `${RENDERER_ORIGIN}/activate`

/**
 * What may be navigated to, and where it should go instead.
 *
 * Here rather than in `app.ts` for the reason this module exists: `app.ts` imports `electron`, so
 * nothing in it can be reached by a plain `node --test`, and this is a decision that wants
 * exhaustive cheap coverage rather than one drive through a GUI.
 *
 * **The measurement that put it here.** Task 3's review asked whether the shell needs a
 * navigation policy. It does, and not marginally: with none, `location.href = 'https://example.com/'`
 * typed into the renderer's own main world navigated the app's window there, and the page that
 * arrived reported `typeof window.spm === 'object'` with keys `canStreamFromDisk,invoke` — the
 * whole IPC bridge, at a remote origin, because a preload is attached to the *webContents* and
 * follows it wherever it goes. That half is re-verified, twice, against the real bundled preload.
 *
 * **The half that followed it was wrong and is withdrawn.** It said `window.open('https://example.com/')`
 * was worse: "a second `BrowserWindow` at that origin, with the same bridge." The hazard is real;
 * the mechanism named for it is not. A popup never inherits the opener's preload and so has no
 * bridge of its own — `typeof window.spm === 'undefined'` in all twenty popups a 21-variant
 * re-measurement created, and `did-create-window` hands over merged options carrying no `preload`
 * key. What a popup **same-origin with a bridge-holding opener** has is `window.opener.spm`, the
 * opener's *live* bridge, and an `invoke` through it returned a real `ipcMain` answer. The original
 * popup was in exactly that position: the `location.href` test above had already taken its opener
 * to `https://example.com/`, so the two were same-origin. (That ordering is inferred from commit
 * `95d9e20`'s message — the probe script was not preserved — so it is an explanation, not a
 * measurement; the correction does not rest on it.) Same-origin-ness at the moment of the open is
 * the only variable that moves the answer: not the preload, not the handler's return shape, not the
 * features string. `noopener` severs the reach, and a supplied `webPreferences.preload` gives a
 * popup a full bridge at any origin. All of it on Electron 44.0.0, Windows 11; macOS and Linux
 * untested.
 *
 * Three answers, and each one is a different hook's job — see `createMainWindow`:
 *
 * - `allow` — inside the renderer's own origin. Includes `spm://app/_spm/...`, because clicking a
 *   file name in the project page is a top-level navigation to `rawUrl` and it has to keep
 *   working (it ends as a download; see `files.ts`).
 * - `external` — `http:`/`https:`, which the app produces in exactly one place: the project
 *   website link, `target="_blank"` in `project-detail.page.ts`. It belongs in the user's own
 *   browser, not in a window holding the bridge.
 * - `block` — everything else, `file:`, `data:`, `javascript:` and an unparseable string
 *   included. Nothing legitimate is in this bucket; it is the default because the list of
 *   schemes worth refusing is open-ended and the list worth allowing is two entries long.
 *
 * The host comparison is case-insensitive. `spm` is registered as a *standard* scheme, so
 * Chromium canonicalises `spm://APP/` and `spm://app/` to one origin, while Node's `URL` leaves
 * the case alone — matching only the lowercase spelling would refuse a navigation that really is
 * same-origin.
 */
export type NavigationPolicy = 'allow' | 'external' | 'block'

export function navigationPolicy(url: string): NavigationPolicy {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.protocol === 'spm:' && parsed.host.toLowerCase() === RENDERER_HOST) return 'allow'
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'external'
  return 'block'
}
