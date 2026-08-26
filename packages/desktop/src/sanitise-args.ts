import { FILE_REF_KEY, LOCAL_PATH_KEY } from './protocol.ts'

/**
 * What the preload does to an argument list on its way out of the renderer.
 *
 * It lives here, and not inside `preload.ts`, for one reason: `preload.ts` imports `electron` and
 * calls `contextBridge.exposeInMainWorld` at load, so nothing in it can be tested without an
 * Electron process. This is the guard that stands between a forged `localPath` and the
 * filesystem, and a guard whose only coverage is "the main process's schema refused the shapes we
 * thought of" is not covered at all — see the note on `sanitiseArg`. With the resolver injected,
 * `test/dispatch.test.ts` asserts the output directly, under plain Node.
 */

/** `webUtils.getPathForFile`, narrowed: the path behind a picked `File`, or `''` for anything else. */
export type PathResolver = (file: unknown) => string

/**
 * How deep `sanitiseArg` will walk. Nothing legitimate comes close — the deepest argument any
 * dispatch entry takes today is `projects.list`'s `{ tags: [...] }`, at three — and the cap is
 * what makes a cyclic or adversarially nested argument terminate rather than hang the renderer.
 * Past it the value becomes `null`, which every schema refuses.
 */
export const MAX_ARG_DEPTH = 6

/**
 * Rewrites one argument, at every depth.
 *
 * Two jobs, and the second is the security-relevant one:
 *
 * 1. `{ [FILE_REF_KEY]: <File> }` becomes `{ localPath }` — the only place a path is ever written.
 * 2. `localPath` is **removed wherever it appears**. Without this a compromised renderer could
 *    send `{ localPath: 'C:/Users/…/.ssh/id_rsa' }` and have the main process read a file the user
 *    never chose, which is constraint 4's exact prohibition. Measured, with this stripped out: the
 *    main process opened the library's own `app.db` and copied all 135 168 bytes of it into a
 *    project as an ordinary uploaded file.
 *
 * Recursive rather than a check on the top-level argument objects, which is what it was first. At
 * depth 0 it happened to be complete, because the only two entries that take a body take it as a
 * whole argument and `uploadBodySchema` refused a nested one — but that is a property of today's
 * schemas, not of this guard. The moment an entry takes a body one level down, or inside an
 * array, a depth-0 strip is silently gone. A blacklist guarding an arbitrary-file-read capability
 * should not be one schema change away from doing nothing, and its tests should not be passing
 * because something else refused the input.
 *
 * Binary payloads are returned by identity: rebuilding a `Uint8Array` through `Object.entries`
 * would turn it into a plain object of numeric keys, and the bytes arm would upload nothing.
 */
export function sanitiseArg(value: unknown, pathOf: PathResolver, depth = 1): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
  if (depth > MAX_ARG_DEPTH) return null
  if (Array.isArray(value)) return value.map((item) => sanitiseArg(item, pathOf, depth + 1))

  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, FILE_REF_KEY)) {
    const localPath = pathOf(record[FILE_REF_KEY])
    // No file behind it: the object goes on with neither arm and the main process's
    // `uploadBodySchema` refuses it, rather than something being invented here.
    return localPath ? { [LOCAL_PATH_KEY]: localPath } : {}
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === LOCAL_PATH_KEY) continue
    out[key] = sanitiseArg(item, pathOf, depth + 1)
  }
  return out
}

/** The whole argument list. A non-array is passed through for the main process to refuse. */
export function sanitiseArgs(args: unknown, pathOf: PathResolver): unknown {
  return Array.isArray(args) ? args.map((arg) => sanitiseArg(arg, pathOf)) : args
}
