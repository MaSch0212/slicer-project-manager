import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core'
import {
  isAppErrorCode,
  type LibraryStateDto,
  type LocalLibraryDto,
  type RemoteLibraryDto,
} from '../api/generated'
import { ApiError } from './api/error'

/**
 * The desktop-only operations (migration spec 3.3): the few things that are not part of the
 * library API because only the shell can do them. In the desktop app they are Tauri `invoke`
 * commands; in a browser there is no such thing and `isDesktop()` is false.
 *
 * The library API itself is *not* here: it is the same same-origin `fetch` client in every host
 * (`core/api/client.ts`), and the desktop shell answers it on its own loopback origin.
 */

/** Whether this page is running inside the desktop app's webview. */
export function isDesktop(): boolean {
  try {
    return isTauri()
  } catch {
    return false
  }
}

export type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * What `invoke` rejects with is the shell's `{ code, message }` (an `AppError`), or, for a call the
 * ACL refused, a string. Either way the page sees the one failure shape every API call has.
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && isAppErrorCode(code)) {
      return new ApiError(code, typeof message === 'string' ? message : 'request failed')
    }
  }
  return new ApiError('Internal', error instanceof Error ? error.message : String(error))
}

/** A factory, so a test can hand it a fake `invoke`. */
export function createDesktopClient(invokeFn: InvokeFn = tauriInvoke) {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await invokeFn(command, args)) as T
    } catch (error) {
      throw asApiError(error)
    }
  }

  return {
    /** Which library is open: a folder, a server, or none yet. */
    libraryState: () => call<LibraryStateDto>('desktop_library_state'),
    /**
     * Opens the operating system's folder dialog and opens what the user picks. `null` is a
     * cancelled dialog. No path is passed in: the page cannot name a folder to open.
     */
    pickFolder: () => call<LocalLibraryDto | null>('desktop_library_pick'),
    /**
     * Connects to the server at `url`, once the user confirms it in a native dialog the page
     * cannot click. `null` is a declined confirmation.
     */
    connectRemote: (url: string) =>
      call<RemoteLibraryDto | null>('desktop_library_connect', { url }),
    /** The application menu's "Choose library…": asks which mode, then does what the answer says. */
    chooseLibrary: () => call<void>('desktop_library_choose'),
  }
}

export type DesktopClient = ReturnType<typeof createDesktopClient>

export const desktop: DesktopClient = createDesktopClient()
