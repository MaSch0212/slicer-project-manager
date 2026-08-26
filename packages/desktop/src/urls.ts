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
 * collide with something the Angular build emits at the root of the renderer directory, and the
 * build emits `index.html`, `favicon.ico`, `main.js`, `styles.css`, `chunk-<hash>.js` and a
 * `media/` folder. A leading underscore is not a character the Angular builder produces at the
 * top level for anything, which is why it was picked over a plausible-looking English word.
 *
 * Task 3 owns the handler that answers under this prefix, including refusing a renderer asset
 * request that tries to reach through it. It imports the constant from here rather than
 * spelling the string a second time.
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
