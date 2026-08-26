import { ipcMain } from 'electron'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { dispatch, isApiPath, type DispatchSession } from './dispatch.ts'
import { INVOKE_CHANNEL, type IpcResult } from './protocol.ts'

/**
 * The one channel, and the only place `dispatch` meets Electron.
 *
 * Two properties hold everything here up, and both are asserted:
 *
 * 1. **This handler never rejects.** Every failure — a bad path, a malformed argument list, an
 *    `AppError` from core, an unexpected throw — comes back as `{ ok: false, error: … }`. A
 *    rejection would reach the renderer as `Error invoking remote method 'spm:invoke': …` with
 *    `code` stripped off, which is the failure constraint 5 exists to prevent (see `protocol.ts`
 *    for the measurement).
 * 2. **The path comes from the renderer and is looked up, never called.** `isApiPath` is an own-
 *    property check against the table, so `__proto__`, `constructor` and `toString` are not paths
 *    and cannot be invoked.
 */

/** What the main process reports for a throw that is not an `AppError`. */
const INTERNAL: AppErrorCode = 'Internal'

export function toFailure(error: unknown): IpcResult {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        // Spread rather than `details: error.details`: `undefined` does survive the structured
        // clone, but an absent key is what the HTTP envelope produces, and the two shells should
        // hand `AppError` the same thing.
        ...(error.details ? { details: error.details } : {}),
      },
    }
  }
  // Anything else is a bug in the main process, not something the UI can act on. The message is
  // kept because it is the only clue a desktop user could paste into an issue; the stack is not,
  // because it names paths on their disk.
  return {
    ok: false,
    error: { code: INTERNAL, message: error instanceof Error ? error.message : String(error) },
  }
}

/**
 * `resolveSession` is a function rather than a value because the library the shell has open
 * changes: it is null until one is opened, and task 4 adds a control that swaps it without a
 * restart. A snapshot taken at registration time would keep answering out of the old library.
 */
export function registerInvokeHandler(resolveSession: () => DispatchSession | null): void {
  ipcMain.handle(INVOKE_CHANNEL, async (_event, request: unknown): Promise<IpcResult> => {
    try {
      if (typeof request !== 'object' || request === null) {
        throw new AppError('Validation', 'malformed invoke request')
      }
      const { path, args } = request as { path?: unknown; args?: unknown }
      if (!isApiPath(path)) {
        throw new AppError('NotFound', `no such api path: ${String(path)}`)
      }
      if (!Array.isArray(args)) {
        throw new AppError('Validation', `${path} was called without an argument list`)
      }
      return { ok: true, value: await dispatch[path](resolveSession(), args) }
    } catch (error) {
      return toFailure(error)
    }
  })
}
