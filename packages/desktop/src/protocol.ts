import type { AppErrorCode } from '@spm/contract/errors.ts'

/**
 * The wire contract of the single IPC channel, shared by the preload and the main process.
 *
 * Deliberately free of runtime imports beyond the `AppErrorCode` union, which is a type: the
 * preload is bundled separately and anything this module pulls in is pulled into the preload
 * too. `dispatch.ts` and `@spm/core` must never end up there.
 */

/** Decision 3 of the plan: one channel carrying a dotted `ApiClient` path, not thirty. */
export const INVOKE_CHANNEL = 'spm:invoke'

/** The name the preload publishes on `window`. */
export const BRIDGE_KEY = 'spm'

export type IpcRequest = { path: string; args: unknown[] }

/**
 * A failure is *returned*, not thrown, and this is the whole reason (constraint 5).
 *
 * Measured in Electron 44.0.0, sandboxed renderer, contextIsolation on: an `Error` thrown out of
 * an `ipcMain.handle` callback reaches the renderer as a plain `Error` whose message is
 * `Error invoking remote method 'spm:invoke': Error: <original message>` and whose
 * `Object.keys()` is empty — `code` and `details` are gone, and even the message has been
 * rewrapped. Returning the same `Error` as a *value* is no better: it arrives `instanceof Error`
 * with the right message, but `Object.getOwnPropertyNames` is `['stack', 'message']`, so custom
 * properties and even a reassigned `name` are dropped by the structured clone.
 *
 * A plain object survives whole, so that is what crosses. `IpcApiClient` in the renderer turns
 * it back into a real `AppError` with the same `code`.
 */
export type IpcFailure = {
  ok: false
  error: { code: AppErrorCode; message: string; details?: Record<string, unknown> }
}

export type IpcSuccess = { ok: true; value: unknown }

export type IpcResult = IpcSuccess | IpcFailure

/**
 * How an upload reaches the main process, and why there are two arms.
 *
 * `localPath` is the one that matters: every upload the UI can start comes from a real file the
 * user picked, so the bytes never have to cross IPC at all — the main process streams them off
 * disk. Measured in Electron 44.0.0 with `sandbox: true`, `contextIsolation: true`: `webUtils`
 * is available in the preload and `webUtils.getPathForFile(file)` returns the absolute path for
 * a `File` that came from an `<input type="file">`, and the **empty string** for a `File` or
 * `Blob` a script made up. That empty string is the discriminator; it does not have to be
 * guessed at.
 *
 * `bytes` remains for the arm that has no path — `ApiClient.UploadBody` permits a plain `Blob`,
 * and a generated one has no file behind it. Nothing in the UI takes that arm today.
 *
 * **A `localPath` may only ever be written by the preload.** A path from the untrusted main world
 * would let a compromised renderer make the main process read any file the user can read and copy
 * it into the library, which is exactly what constraint 4 forbids. So the main world never
 * handles a path at all: it puts the `File` object itself under `FILE_REF_KEY` in the arguments,
 * and the preload — in its own isolated world, where the main world cannot reach — replaces it
 * with `{ localPath }` on the way out and strips any `localPath` it did not write itself, at
 * every depth.
 *
 * Passing the `File` rather than an earlier-minted token is deliberate and was measured: a `File`
 * nested inside an object inside the argument array arrives in the preload still `instanceof
 * File`, and `webUtils.getPathForFile` resolves it there. The first version of this handed the
 * main world an opaque token from a separate `fileRef()` call and kept a map of live tokens in
 * the preload; that map was unbounded (20 000 entries minted from the renderer in 12 ms, none
 * evicted, the first still redeemable) and left a window between naming a file and reading it in
 * which the file could be swapped — both measured. Resolving inside the `invoke` that uses the
 * path removes the map and the token lifetime outright, rather than bounding them.
 *
 * A window between naming the file and opening it still exists and cannot be closed by this
 * design: the preload resolves the path and the main process opens it a moment later. What
 * changed is that the renderer can no longer *hold it open* — it is the duration of one `invoke`
 * rather than the lifetime of the process — and that nothing is handed to the main world it could
 * store, replay or enumerate. Closing it entirely would mean opening a file descriptor in the
 * preload and passing that, which a sandboxed preload cannot do.
 */
export type WireUploadBody = { localPath: string } | { bytes: Uint8Array }

/**
 * The key the renderer puts the picked `File` under. Declared here and re-declared in
 * `packages/web/src/app/core/api/ipc-api-client.ts`; `dispatch.test.ts` asserts the two strings
 * are equal, so they cannot drift.
 */
export const FILE_REF_KEY = '__spmFileRef'

/**
 * The key the preload writes a resolved path under, and strips everywhere else. Same shape as
 * `WireUploadBody`'s path arm, tied to it by a compile-time check in `dispatch.test.ts`.
 */
export const LOCAL_PATH_KEY = 'localPath'

/** What `contextBridge.exposeInMainWorld(BRIDGE_KEY, ...)` puts on the renderer's `window`. */
export type SpmBridge = {
  /**
   * Whether this value is a `File` with a real file behind it, and so can be streamed off disk
   * instead of buffered. Answers a boolean and nothing else: it holds no state, mints nothing,
   * and never tells the main world *where* the file is.
   */
  canStreamFromDisk(file: unknown): boolean
  invoke(path: string, args: unknown[]): Promise<IpcResult>
}
