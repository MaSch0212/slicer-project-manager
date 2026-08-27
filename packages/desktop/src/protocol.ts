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
 * **The window between picking a file and uploading it is the renderer's, not one `invoke`'s**,
 * and an earlier version of this comment claimed otherwise. A `File` is a durable handle to a
 * *path*: the renderer can hold one for as long as it likes and redeem it later for whatever is
 * at that path then. Deleting the token map removed the map, not that property. Measured — pick a
 * file, replace the bytes at its path, then upload the same `File`, and the *replacement* was
 * streamed: 63 bytes of new contents under the old name.
 *
 * Measured in the same run, and the reason this is now checked rather than described: the browser
 * arm **refuses** that identical stale `File` with `NotReadableError`. Chromium snapshot-validates
 * a `File` against the size and modification time it had when it was picked, so the two shells
 * were giving different answers to the same user action and the desktop one was the permissive
 * answer. So the preload sends the snapshot it can see — `File.size` and `File.lastModified`,
 * which do **not** move when the file does (measured: 32 bytes and the same millisecond before
 * and after the swap) — and `sizeOfPickedFile` in the main process refuses a mismatch with
 * `Conflict`.
 *
 * The numbers come from the preload and never from the main world, for the same reason the path
 * does: a renderer that could supply them could make them agree with whatever it had swapped in.
 *
 * What that check is and is not: it is exactly what Chromium does, so the two shells now agree.
 * It is not a guarantee that the bytes are the ones the user saw — a writer that preserves size
 * and modification time defeats it, and the irreducible gap between the `stat` and the `open`
 * remains. Closing that would mean holding a file descriptor from the moment of the pick, which a
 * sandboxed preload cannot do.
 */
export type WireUploadBody =
  { localPath: string; sizeBytes: number; lastModifiedMs: number } | { bytes: Uint8Array }

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

/**
 * The path under the renderer's own origin that belongs to the remote server in remote mode.
 *
 * It is `/api` and not something reserved-looking because it is not the shell's choice: the
 * server decorates its DTOs with `/api/files/<id>/thumb`, a *relative* URL, and a document at
 * `spm://app` resolves that against its own origin. Serving it from anywhere else would mean
 * rewriting every URL in every DTO the server sends. See `remote.ts`.
 */
export const API_PATH_PREFIX = '/api'

/**
 * How the renderer tells the shell how many bytes an upload body has.
 *
 * Not `content-length`: that is a forbidden header name, so Chromium strips a script-set one, and
 * measured on Electron 44.0.0 it does not put the body's own length on the `Request` a protocol
 * handler receives either. The server refuses a body with no length (411, spec 5.6), so remote
 * uploads need the renderer to say so in a header of its own. Re-declared in
 * `packages/web/src/app/core/api/ipc-api-client.ts`; `dispatch.test.ts` asserts the two strings
 * are equal.
 */
export const UPLOAD_LENGTH_HEADER = 'x-spm-content-length'

/**
 * Which transport the window was created with — which is *not* quite the shell's mode.
 *
 * Two values, because there are two transports, and the shell has three states: local, remote,
 * and nothing chosen yet. "Nothing chosen yet" is `'local'` here, deliberately: with no library
 * open, `IpcApiClient` is exactly what a renderer needs — `capabilities` answers out of the shell,
 * every library call reports `Conflict`, and `library.pick` and `library.connect` are how the user
 * gets out of that state. Giving it a third value would mean rebuilding the window when the user
 * picked a folder, and a rebuild is a new `webContents`: heavier, and visible to anything holding
 * a handle on the old one.
 *
 * So the window is only ever rebuilt when the *transport* has to change, which is local↔remote.
 */
export type BridgeMode = 'local' | 'remote'

/** The command-line switch `additionalArguments` carries the mode to the preload in. */
export const MODE_SWITCH = '--spm-mode='

/**
 * Reads the mode out of a preload's `process.argv`.
 *
 * A switch rather than an IPC call because `API_CLIENT`'s factory is synchronous — Angular
 * injection is — and `additionalArguments` is the only synchronous channel a sandboxed preload
 * has. Measured on Electron 44.0.0: `process.argv` in a sandboxed, context-isolated preload
 * carries the switch, and it survives a `webContents.reload()`. It does **not** change for the
 * life of a webContents, which is why a mode change replaces the window rather than reloading it.
 *
 * Anything that is not exactly `remote` — a missing switch, a stray `--spm-mode=` from somewhere
 * else, a value from a future version — is `local`. The transports are not symmetric here: IPC
 * talks only to this process, while remote points the app at a server, so the value that needs a
 * clear statement to be chosen is the one that leaves the machine.
 */
export function modeFromArgv(argv: readonly string[]): BridgeMode {
  const found = argv.find((argument) => argument.startsWith(MODE_SWITCH))
  return found?.slice(MODE_SWITCH.length) === 'remote' ? 'remote' : 'local'
}

/** What `contextBridge.exposeInMainWorld(BRIDGE_KEY, ...)` puts on the renderer's `window`. */
export type SpmBridge = {
  /**
   * Which transport the renderer should use. Read from the window's own arguments, so it is
   * fixed for the life of the window and cannot disagree with what the shell is serving.
   */
  mode: BridgeMode
  /**
   * Whether this value is a `File` with a real file behind it, and so can be streamed off disk
   * instead of buffered. Answers a boolean and nothing else: it holds no state, mints nothing,
   * and never tells the main world *where* the file is.
   */
  canStreamFromDisk(file: unknown): boolean
  invoke(path: string, args: unknown[]): Promise<IpcResult>
}
