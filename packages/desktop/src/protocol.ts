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

/** What `contextBridge.exposeInMainWorld(BRIDGE_KEY, ...)` puts on the renderer's `window`. */
export type SpmBridge = {
  invoke(path: string, args: unknown[]): Promise<IpcResult>
}
