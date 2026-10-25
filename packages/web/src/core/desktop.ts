import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core'
import {
  isAppErrorCode,
  type DiscardedSessionsDto,
  type FileDto,
  type LibraryStateDto,
  type LocalLibraryDto,
  type RemoteLibraryDto,
  type SlicerConfigDto,
  type SlicerId,
  type SlicerLaunchDto,
  type SlicerLaunchOptions,
  type SlicerSessionDto,
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
      const { details } = error as { details?: unknown }
      return new ApiError(code, typeof message === 'string' ? message : 'request failed', {
        details:
          typeof details === 'object' && details !== null
            ? (details as Record<string, unknown>)
            : undefined,
      })
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

    /**
     * Slicers (subsystem D): which slicers this computer has, handing a file to one, and what
     * became of the files it was handed. A property of the *computer*, so it works the same in
     * local and in remote mode. **No call takes a path**: the one path on the whole surface comes
     * out of a native dialog the shell owns, and a launch names a file by its ids.
     *
     * `null` is the way to say "nothing" (unbind, no default); an argument that is left out is a
     * mistake the shell refuses.
     */
    slicers: {
      get: () => call<SlicerConfigDto>('desktop_slicers_get'),
      /** Searches this computer for installed slicers (Windows only) and merges what it finds. */
      scan: () => call<SlicerConfigDto>('desktop_slicers_scan'),
      /** Opens a native file dialog for one product's program; `null` is a cancelled dialog. */
      addManual: (slicerId: SlicerId) =>
        call<SlicerConfigDto | null>('desktop_slicers_add_manual', { slicerId }),
      remove: (installId: string) => call<SlicerConfigDto>('desktop_slicers_remove', { installId }),
      /** Points a product at one of its installs; `null` unbinds it. */
      bind: (slicerId: SlicerId, installId: string | null) =>
        call<SlicerConfigDto>('desktop_slicers_bind', { slicerId, installId }),
      /** The product a file that names no slicer is opened with; `null` clears it. */
      setDefault: (slicerId: SlicerId | null) =>
        call<SlicerConfigDto>('desktop_slicers_set_default', { slicerId }),
      /** Throws the configuration away: the only way out of one this build cannot read. */
      resetConfig: () => call<SlicerConfigDto>('desktop_slicers_reset_config'),
      /** Hands a file of a project to a slicer. */
      open: (fileId: string, projectId: string, opts: SlicerLaunchOptions) =>
        call<SlicerLaunchDto>('desktop_slicers_open', { fileId, projectId, opts }),
      sessions: () => call<SlicerSessionDto[]>('desktop_slicers_sessions'),
      /** The user's answer to one session. `import` answers with the file it added. */
      resolveSession: (
        launchId: string,
        action: 'import' | 'discard',
        options: { projectId?: string } = {},
      ) =>
        call<FileDto | null>('desktop_slicers_resolve_session', {
          launchId,
          action,
          projectId: options.projectId ?? null,
        }),
      discardSessions: (launchIds: readonly string[]) =>
        call<DiscardedSessionsDto>('desktop_slicers_discard_sessions', { launchIds }),
    },
  }
}

export type DesktopClient = ReturnType<typeof createDesktopClient>

export const desktop: DesktopClient = createDesktopClient()
