import type { ApiClient, UploadBody } from '@spm/contract/api-client.ts'
import type {
  Capabilities,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RescanResultDto,
  SettingsDto,
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
   * The path of the file behind a picked `File`, as an opaque token the preload can swap back,
   * or `null` when there is no file behind it. The path itself never reaches this world.
   */
  fileRef(file: unknown): string | null
  invoke(path: string, args: unknown[]): Promise<IpcResult>
}

/**
 * The key a preload-minted file token travels under. Must equal `FILE_REF_KEY` in
 * `packages/desktop/src/protocol.ts`; `packages/desktop/test/dispatch.test.ts` asserts the two
 * strings are the same value, so this cannot drift into a silent fallback to buffering.
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
    typeof candidate.fileRef !== 'function'
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
   * A `File` from a picker is backed by a real file, and the preload can name it: `fileRef`
   * returns an opaque token for it (and `null` for a `Blob` or a script-built `File`, measured —
   * `webUtils.getPathForFile` answers `''` for those). The main process then streams the file off
   * disk, so a 10 GiB archive costs a 64 KiB buffer instead of three copies of itself in memory.
   * The token, not the path: a path the untrusted main world could write would let a compromised
   * renderer have the main process open any file the user can read (constraint 4), so the preload
   * mints it, swaps it back in its own world, and strips any `localPath` it did not write.
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
      if ('blob' in body) {
        const ref = this.bridge.fileRef(body.blob)
        if (ref !== null) return { [FILE_REF_KEY]: ref }
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
