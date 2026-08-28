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

/**
 * What the **model browser's** view may navigate to. A different policy, not a flag on the one
 * above.
 *
 * **Two answers, not three.** The renderer's third answer is `external`, which hands the URL to
 * `shell.openExternal` — and a browse view that did that would fire the user's system browser for
 * every link on every page and never move. `external` is exactly what a model browser must not do,
 * which is why this is a separate function: the two policies invert on `http(s)`, and a later
 * merge of them would silently make one of the two features useless.
 *
 * This is one of three legs holding arbitrary third-party content inside an app whose renderer has
 * an IPC bridge to the filesystem, and it is the weakest of the three as a *filter*. The other two
 * — the browse view's own `persist:` partition, and its absence of a preload — each remove a
 * capability outright. Nothing here is load-bearing on its own.
 *
 * - `allow` — **`http:` and `https:`.** This is a browser.
 *
 * - `allow` — **`blob:` and `data:`, and this arm is load-bearing.** The one download this project
 *   has ever completed came down a `blob:` URL: Thingiverse's "Download all files" produced
 *   `getURL()` = `blob:https://www.thingiverse.com/ae5e9664-…`, that single URL as the whole
 *   `getURLChain()`, and 21 060 699 bytes of real ZIP. Under an `http(s)`-only policy that
 *   download's fate turns on which of three interchangeable DOM idioms the site happens to use,
 *   all three measured on Electron 44: `<a download href="blob:…">` + `.click()` fires **no hook at
 *   all** and downloads regardless; `location.href = blobUrl` reaches `will-frame-navigate` and is
 *   **blocked**; `window.open(blobUrl)` is denied by the window-open handler. The control run —
 *   same navigation, policy off — completes the download. A `block` here is therefore not a
 *   security property, it is a coin flip: it stops two idioms, cannot see the third, and costs the
 *   feature. A `blob:` or `data:` document has no preload, no bridge, and no `spm://` on the browse
 *   partition; what actually decides a download's outcome is the `will-download` interceptor, which
 *   sees the item either way.
 *
 * - `allow` — **`about:blank`.** The deferred-popup idiom opens `about:blank` and assigns
 *   `location` afterwards, so blocking it blocks the *open* rather than the destination — the site
 *   never gets to reveal where it was going, and the window-open handler never gets to judge it.
 *   `about:blank` inherits the opener's origin, which for a browse view is a site, never
 *   `spm://app`. Only `about:blank`: `about:` is otherwise a scheme full of browser internals and
 *   nothing in the table below wants the rest of it.
 *
 * - `block` — **`spm:`, belt-and-braces.** The browse partition already refuses it: `protocol.handle`
 *   registers on `defaultSession` only, so `loadURL('spm://app/')` in a partitioned view came back
 *   `ERR_FAILED (-2)`, while the *same* load on the default session succeeded. That refusal is a
 *   property of a session this module cannot see, and a policy that silently depends on one is not
 *   a policy. The cost of naming it here is zero and the failure mode it covers is somebody moving
 *   the browse view onto the default session.
 *
 * - `block` — **`file:`, the one arm doing work Chromium does not already do**, and it is not
 *   theoretical: a file **dropped onto a `webContents`** is a `file:` navigation. Blocking it is how
 *   a dropped `.stl` fails to become the page.
 *
 * - `block` — **everything else**, `javascript:`, any custom scheme and an unparseable string
 *   included. The custom-scheme arm is the *measured-ignorance* answer for MakerWorld's only
 *   affordance for a logged-out visitor, `Open in Bambu Studio` (spec 9.3): what that hand-off does
 *   was never measured. Refusing an unmeasured scheme hand-off is the answer that can be revisited
 *   with a measurement; allowing it is not.
 *
 * **`spm:` and `file:` have no branch of their own on purpose.** They fall through to the same
 * default as everything else, because a branch whose body is the default's body is a branch no test
 * can distinguish and no mutation can kill. They are named in this docblock and pinned by value in
 * `test/browse.test.ts` instead.
 *
 * **This policy is consulted by four hooks, not one**, and attaching three of them is the gap that
 * passes every test written against the fourth. Measured on Electron 44: `will-frame-navigate`
 * fires *first* for the same URL and is the only one that covers subframes; `will-navigate` is
 * main-frame only; a 302 into a custom scheme arrived at **`will-redirect`** and not at
 * `will-navigate`, so the custom-scheme arm above is enforced there or it is not enforced at all;
 * and `setWindowOpenHandler` is the one that stops a site putting an unchromed top-level window on
 * screen. Attaching them is the browse view's job, not this module's.
 *
 * **No host allowlist**, and that is a decision rather than an omission — a list of four hostnames
 * would read as if it were the security boundary while doing none of that work, and it would break
 * a site's own CDN, its consent-management vendor, and the identity provider a user logs in
 * through. The registry in `browse/registry.ts` names sites; it does not gate them.
 */
export type BrowseNavigationPolicy = 'allow' | 'block'

export function browseNavigationPolicy(url: string): BrowseNavigationPolicy {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'allow'
  if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return 'allow'
  if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return 'allow'
  return 'block'
}
