import type { ApiClient, UploadBody } from '@spm/contract/api-client.ts'
import type {
  BrowseBounds,
  BrowseDownloadDto,
  BrowseNoticeDto,
  BrowseStateDto,
  Capabilities,
  LocalLibraryDto,
  ModelSiteDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RemoteLibraryDto,
  RescanResultDto,
  SettingsDto,
  SlicerConfigDto,
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchOptions,
  SlicerSessionDto,
  UserDto,
  ZipImportResultDto,
} from '@spm/contract/dtos.ts'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import type {
  CreateProjectInput,
  CreateUserInput,
  ProjectPatchInput,
  SettingsPatchInput,
  UpdateUserInput,
} from '@spm/contract/schemas.ts'

/**
 * The Electron transport: every `ApiClient` method forwarded down one IPC channel.
 *
 * It lives in `packages/web` because the renderer bundles it, and it is referenced only from
 * `api-client.token.electron.ts`, which `fileReplacements` swaps in for the electron build alone
 * — so the web bundle cannot pull it in. CI greps both bundles for `BRIDGE_MISSING` below to
 * prove that, in the same shape as the `DesktopPlaceholderPage` checks: a string literal and not
 * a class name, because the minifier renames the second and cannot touch the first.
 *
 * The wire types below are the renderer's copy of `packages/desktop/src/protocol.ts`. They are
 * duplicated rather than imported so the Angular build never resolves anything out of
 * `packages/desktop`; `packages/desktop/test/dispatch.test.ts` asserts the two declarations are
 * mutually assignable, so drift is a compile error rather than a runtime surprise.
 */
export type IpcFailure = {
  ok: false
  error: { code: AppErrorCode; message: string; details?: Record<string, unknown> }
}

export type IpcSuccess = { ok: true; value: unknown }

export type IpcResult = IpcSuccess | IpcFailure

export type SpmBridge = {
  /**
   * Which transport this window was built with — `'local'` for IPC, `'remote'` for the proxied
   * `HttpApiClient`. Fixed at window creation by the main process; see `BridgeMode` in
   * `packages/desktop/src/protocol.ts`, which is where the two values are explained.
   */
  mode: BridgeMode
  /**
   * Whether this value is a `File` with a real file behind it, and so can be streamed off disk
   * instead of buffered. A boolean and nothing more: the preload holds no state for it and this
   * world is never told *where* the file is.
   */
  canStreamFromDisk(file: unknown): boolean
  invoke(path: string, args: unknown[]): Promise<IpcResult>
}

/** The renderer's copy of `BridgeMode`; `packages/desktop/test/dispatch.test.ts` ties them. */
export type BridgeMode = 'local' | 'remote'

/**
 * The header the proxied `HttpApiClient` declares an upload's length in. Must equal
 * `UPLOAD_LENGTH_HEADER` in `packages/desktop/src/protocol.ts`; `dispatch.test.ts` asserts the
 * two strings are the same value.
 *
 * It exists because `content-length` is a forbidden header name: Chromium strips a script-set
 * one, and — measured on Electron 44.0.0 — does not put the body's own length on the `Request`
 * the shell's protocol handler receives either, so a remote upload would reach the server with
 * no length and be refused with 411 before a byte was written (spec 5.6).
 */
export const UPLOAD_LENGTH_HEADER = 'x-spm-content-length'

/**
 * The key the picked `File` itself travels under, for the preload to swap for a path in its own
 * world. Must equal `FILE_REF_KEY` in `packages/desktop/src/protocol.ts`;
 * `packages/desktop/test/dispatch.test.ts` asserts the two strings are the same value.
 */
export const FILE_REF_KEY = '__spmFileRef'

/**
 * Also the marker CI greps for. Keep it a literal in this file: a template built from parts, or a
 * message assembled at the call site, is not one string in the bundle and the grep would silently
 * match nothing — which this repo has already shipped once.
 */
export const BRIDGE_MISSING =
  'the desktop IPC bridge is missing from window.spm; the preload did not load'

export function desktopBridge(): SpmBridge {
  const candidate = (globalThis as { spm?: Partial<SpmBridge> }).spm
  if (
    !candidate ||
    typeof candidate.invoke !== 'function' ||
    typeof candidate.canStreamFromDisk !== 'function'
  ) {
    throw new AppError('Internal', BRIDGE_MISSING)
  }
  return candidate as SpmBridge
}

/**
 * Reads either `UploadBody` arm into bytes. The fallback; see `readBody` for what happens first.
 *
 * Neither arm can cross IPC as itself. Measured in Electron 44.0.0, through a sandboxed,
 * context-isolated preload: a `Blob`, a `File` and a `ReadableStream` handed to
 * `ipcRenderer.invoke` all arrive in the main process as an **empty plain object** — the
 * structured clone drops them without throwing, so the failure would have been an upload of zero
 * bytes rather than an error. A `Uint8Array` arrives intact, `instanceof Uint8Array` and all, at
 * about 540 MB/s (1 GiB measured at 1.9 s, 128 MiB at 0.2 s).
 *
 * Buffering is bounded by whatever the renderer can hold, which is why it is the fallback and not
 * the route. Nothing in the UI reaches it: every upload this app can start — `<input type="file">`
 * on the project page, `jig-upload` on the import page — hands over a `File` that is backed by a
 * real file on disk.
 */
async function toBytes(body: UploadBody): Promise<Uint8Array> {
  if ('blob' in body) return new Uint8Array(await body.blob.arrayBuffer())
  return new Uint8Array(await new Response(body.stream).arrayBuffer())
}

export class IpcApiClient implements ApiClient {
  private readonly bridge: SpmBridge

  /** The bridge is injected the way `HttpApiClient` injects `fetch`, so tests can supply one. */
  constructor(bridge: SpmBridge = desktopBridge()) {
    this.bridge = bridge
  }

  /**
   * Constraint 5, the renderer half.
   *
   * The main process never rejects this channel; it answers `{ ok: false, error }` and this
   * rebuilds a real `AppError` from it, so a caller sees the same class with the same `code` it
   * would have seen over HTTP. Rethrowing whatever the channel threw is what would break it:
   * measured, an `Error` thrown out of an `ipcMain.handle` callback reaches the renderer as
   * `Error invoking remote method 'spm:invoke': Error: <message>` with `Object.keys()` empty, so
   * `code` is simply gone.
   */
  private async invoke<T>(path: string, args: unknown[] = []): Promise<T> {
    let result: IpcResult
    try {
      result = await this.bridge.invoke(path, args)
    } catch (error) {
      // The channel itself failed — no handler registered, or the main process is gone. Every
      // rejection this client produces must be an AppError, exactly as HttpApiClient promises.
      throw new AppError('Internal', error instanceof Error ? error.message : String(error))
    }
    if (result && result.ok === true) return result.value as T
    if (result && result.ok === false && result.error) {
      throw new AppError(result.error.code, result.error.message, result.error.details)
    }
    throw new AppError('Internal', `the desktop bridge returned an unrecognised result for ${path}`)
  }

  /**
   * Turns an `UploadBody` into the arm the main process takes, without the bytes crossing IPC
   * when they do not have to.
   *
   * A `File` from a picker is backed by a real file on disk, and `canStreamFromDisk` says so (it
   * is false for a `Blob` or a script-built `File`, measured — `webUtils.getPathForFile` answers
   * `''` for those). The `File` then travels in the arguments and the *preload* turns it into a
   * path in its own world, so the main process streams it and a 10 GiB archive costs a 64 KiB
   * buffer instead of three copies of itself in memory.
   *
   * The `File` and never a path: a path this world could write would let a compromised renderer
   * have the main process open any file the user can read (constraint 4). The *preload* holds
   * nothing between the two calls — `canStreamFromDisk` answers a boolean and forgets, and the
   * path is resolved inside the `invoke` that uses it.
   *
   * This world does hold something, and an earlier version of this comment glossed over it: the
   * `File` handed to `upload` is a durable handle to a path, and the caller may have been holding
   * it since the user picked it. Measured — replace the bytes at that path and the upload streams
   * the replacement. So the preload also sends the size and modification time Chromium recorded
   * at the pick, and the main process refuses a mismatch with `Conflict`. That is exactly what
   * Chromium itself does to a stale `File` in a browser (`NotReadableError`), which is the point:
   * without it the two shells answered the same user action differently.
   *
   * The `try` is the point of the method existing rather than the call being inline. `toBytes`
   * can reject — `RangeError` on a buffer too large for the renderer, `DOMException:
   * NotFoundError` when the file moved between the picker and the read — and an argument
   * expression is outside `invoke`'s own try, so those escaped as themselves. Every rejection
   * this client produces must be an `AppError`, exactly as `HttpApiClient` promises, or callers
   * that branch on `isAppError` (import.page.ts, project-detail.page.ts) get no diagnosis at all.
   */
  private async readBody(body: UploadBody): Promise<unknown> {
    try {
      if ('blob' in body && this.bridge.canStreamFromDisk(body.blob)) {
        return { [FILE_REF_KEY]: body.blob }
      }
      return { bytes: await toBytes(body) }
    } catch (error) {
      throw new AppError('Internal', error instanceof Error ? error.message : String(error))
    }
  }

  capabilities(): Promise<Capabilities> {
    return this.invoke('capabilities')
  }

  readonly auth = {
    login: (username: string, password: string): Promise<UserDto> =>
      this.invoke('auth.login', [username, password]),
    logout: (): Promise<void> => this.invoke('auth.logout'),
    checkToken: (token: string): Promise<{ valid: boolean; username?: string }> =>
      this.invoke('auth.checkToken', [token]),
    activate: (token: string, newPassword: string): Promise<UserDto> =>
      this.invoke('auth.activate', [token, newPassword]),
  }

  readonly library = {
    // No arguments, and nothing the renderer could put in them: the folder comes from a native
    // dialog the main process owns. See the entry in packages/desktop/src/dispatch.ts.
    pick: (): Promise<LocalLibraryDto | null> => this.invoke('library.pick'),
    connect: (url: string): Promise<RemoteLibraryDto | null> =>
      this.invoke('library.connect', [url]),
  }

  /**
   * Slicer configuration, which the main process answers out of `slicers.json` and a PowerShell
   * subprocess. `addManual` takes only the product: the executable comes from a native dialog,
   * because a path from this side is a path from the untrusted side.
   */
  readonly slicers = {
    get: (): Promise<SlicerConfigDto> => this.invoke('slicers.get'),
    scan: (): Promise<SlicerConfigDto> => this.invoke('slicers.scan'),
    addManual: (slicerId: SlicerId): Promise<SlicerConfigDto | null> =>
      this.invoke('slicers.addManual', [slicerId]),
    remove: (installId: string): Promise<SlicerConfigDto> =>
      this.invoke('slicers.remove', [installId]),
    bind: (slicerId: SlicerId, installId: string | null): Promise<SlicerConfigDto> =>
      this.invoke('slicers.bind', [slicerId, installId]),
    setDefault: (slicerId: SlicerId | null): Promise<SlicerConfigDto> =>
      this.invoke('slicers.setDefault', [slicerId]),
    resetConfig: (): Promise<SlicerConfigDto> => this.invoke('slicers.resetConfig'),
    open: (
      fileId: string,
      projectId: string,
      opts: SlicerLaunchOptions,
    ): Promise<SlicerLaunchDto> => this.invoke('slicers.open', [fileId, projectId, opts]),
    sessions: (): Promise<SlicerSessionDto[]> => this.invoke('slicers.sessions'),
    // `opts ?? {}`, so the argument list is always three long. The dispatch table validates it
    // with a `z.tuple`, which counts elements; an omitted third argument and an explicit
    // `undefined` are the same length on this side and not on that one, and the difference would
    // be a `Validation` failure on the commonest call this method has.
    resolveSession: (
      launchId: string,
      action: 'import' | 'discard',
      opts?: { projectId?: string },
    ): Promise<FileDto | null> =>
      this.invoke('slicers.resolveSession', [launchId, action, opts ?? {}]),
    discardSessions: (launchIds: string[]): Promise<{ discarded: number }> =>
      this.invoke('slicers.discardSessions', [launchIds]),
  }

  /**
   * The model browser, which the main process answers out of a `WebContentsView` it owns.
   *
   * Nothing here holds a view, a URL policy or a rectangle in device pixels: `attach` and
   * `setBounds` send CSS pixels and the shell decides what becomes of them, and `navigate` sends a
   * string the shell runs through its own policy. That asymmetry is the point — this side is the
   * untrusted one, and it is also the one whose document holds the bridge, so the strings that come
   * back in a `BrowseStateDto` are a stranger's and are rendered as text only.
   *
   * `attach`'s optional `url` is spread rather than always sent: the dispatch tuple is
   * `[bounds, url?]`, and passing an explicit `undefined` would be an argument list of length two
   * with a hole in it rather than one of length one.
   */
  readonly browse = {
    sites: (): Promise<ModelSiteDto[]> => this.invoke('browse.sites'),
    attach: (bounds: BrowseBounds, url?: string): Promise<BrowseStateDto> =>
      this.invoke('browse.attach', url === undefined ? [bounds] : [bounds, url]),
    detach: (): Promise<void> => this.invoke('browse.detach'),
    hide: (): Promise<void> => this.invoke('browse.hide'),
    show: (): Promise<BrowseStateDto> => this.invoke('browse.show'),
    setBounds: (bounds: BrowseBounds): Promise<void> => this.invoke('browse.setBounds', [bounds]),
    navigate: (url: string): Promise<BrowseStateDto> => this.invoke('browse.navigate', [url]),
    back: (): Promise<BrowseStateDto> => this.invoke('browse.back'),
    forward: (): Promise<BrowseStateDto> => this.invoke('browse.forward'),
    reload: (): Promise<BrowseStateDto> => this.invoke('browse.reload'),
    state: (): Promise<BrowseStateDto> => this.invoke('browse.state'),
    clearLastPage: (): Promise<void> => this.invoke('browse.clearLastPage'),
    downloads: (): Promise<BrowseDownloadDto[]> => this.invoke('browse.downloads'),
    discard: (downloadId: string): Promise<void> => this.invoke('browse.discard', [downloadId]),
    notices: (): Promise<BrowseNoticeDto[]> => this.invoke('browse.notices'),
    dismissNotice: (id: string): Promise<void> => this.invoke('browse.dismissNotice', [id]),
  }

  readonly account = {
    me: (): Promise<UserDto> => this.invoke('account.me'),
    changePassword: (current: string, next: string): Promise<void> =>
      this.invoke('account.changePassword', [current, next]),
    updateProfile: (patch: { displayName?: string }): Promise<UserDto> =>
      this.invoke('account.updateProfile', [patch]),
  }

  readonly settings = {
    get: (): Promise<SettingsDto> => this.invoke('settings.get'),
    put: (patch: SettingsPatchInput): Promise<SettingsDto> => this.invoke('settings.put', [patch]),
  }

  readonly users = {
    list: (): Promise<UserDto[]> => this.invoke('users.list'),
    create: (dto: CreateUserInput): Promise<{ user: UserDto; activationUrl: string }> =>
      this.invoke('users.create', [dto]),
    reissueInvite: (id: string): Promise<{ activationUrl: string }> =>
      this.invoke('users.reissueInvite', [id]),
    update: (id: string, patch: UpdateUserInput): Promise<UserDto> =>
      this.invoke('users.update', [id, patch]),
    delete: (id: string): Promise<void> => this.invoke('users.delete', [id]),
  }

  readonly projects = {
    // The query object goes across whole. No query string to build: the main process hands it
    // straight to `projectQuerySchema`, which is the same schema the server parses its search
    // params into, so both shells reject the same inputs.
    list: (query: ProjectQuery): Promise<ProjectDto[]> => this.invoke('projects.list', [query]),
    get: (id: string): Promise<ProjectDetailDto> => this.invoke('projects.get', [id]),
    create: (dto: CreateProjectInput): Promise<ProjectDto> => this.invoke('projects.create', [dto]),
    update: (id: string, patch: ProjectPatchInput): Promise<ProjectDto> =>
      this.invoke('projects.update', [id, patch]),
    delete: (id: string, opts: { deleteFiles: boolean }): Promise<void> =>
      this.invoke('projects.delete', [id, opts]),
    addTag: (id: string, name: string): Promise<void> => this.invoke('projects.addTag', [id, name]),
    removeTag: (id: string, name: string): Promise<void> =>
      this.invoke('projects.removeTag', [id, name]),
    rescan: (): Promise<RescanResultDto> => this.invoke('projects.rescan'),
  }

  readonly importer = {
    curaManagerZip: async (body: UploadBody): Promise<ZipImportResultDto> =>
      this.invoke('importer.curaManagerZip', [await this.readBody(body)]),
  }

  readonly files = {
    upload: async (projectId: string, name: string, body: UploadBody): Promise<FileDto> =>
      this.invoke('files.upload', [projectId, name, await this.readBody(body)]),
    rename: (id: string, name: string): Promise<FileDto> => this.invoke('files.rename', [id, name]),
    delete: (id: string): Promise<void> => this.invoke('files.delete', [id]),
  }
}
