import type {
  Capabilities,
  LocalLibraryDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RemoteLibraryDto,
  RescanResultDto,
  ZipImportResultDto,
  SettingsDto,
  UserDto,
} from './dtos.ts'
import type {
  CreateProjectInput,
  CreateUserInput,
  ProjectPatchInput,
  SettingsPatchInput,
  UpdateUserInput,
} from './schemas.ts'

/**
 * Two arms because the two shells cannot upload the same way.
 *
 * `blob` is the browser's arm: `Content-Length` is a forbidden header name in the Fetch
 * standard, so a script-set one is silently stripped, and a `ReadableStream` body has no
 * length the browser could compute for itself. Handing fetch a `Blob` (the `File` an
 * `<input type="file">` yields is one) lets it set the header, which the server hard-requires
 * before it writes a byte (spec 5.6). It also avoids `duplex: 'half'` request streaming,
 * which is Chromium-and-HTTP/2-only.
 *
 * `stream` stays for the Node, Deno and Electron shells, which may set `Content-Length`
 * themselves and do support request streaming, so they can upload without buffering the file.
 */
export type UploadBody = { blob: Blob } | { stream: ReadableStream<Uint8Array>; sizeBytes: number }

export interface ApiClient {
  capabilities(): Promise<Capabilities>

  auth: {
    login(username: string, password: string): Promise<UserDto>
    logout(): Promise<void>
    checkToken(token: string): Promise<{ valid: boolean; username?: string }>
    activate(token: string, newPassword: string): Promise<UserDto>
  }

  /**
   * The local library folder, for the shells that have one (spec 2.6).
   *
   * Gated by `Capabilities.canPickLocalFolder`, like every other affordance: the UI offers this
   * where the capability says it exists and nowhere else, so no component has to know which
   * shell it is running in. `HttpApiClient` implements it by refusing — a browser talking to a
   * server has no local folder to open, and there is no route for one.
   */
  library: {
    /**
     * Asks the user for a folder and opens it, closing whatever was open before. Resolves to
     * `null` when the user cancels, which is not an error and leaves the current library alone.
     * The shell reloads the window itself on success, because switching the library invalidates
     * every piece of state the renderer is holding.
     */
    pick(): Promise<LocalLibraryDto | null>

    /**
     * Points the shell at a remote server instead of a folder (spec 2.6's other mode). Resolves
     * with the origin it settled on, or `null` when the user declined — the same shape as `pick`,
     * and for the same reason: a refusal is not an error and leaves everything as it was.
     *
     * Ungated by any capability, and deliberately: it is not an affordance the UI offers beside
     * the library, it is the *desktop-only* page that answers "which library is this" in the
     * first place, reachable from the shell's own menu. `HttpApiClient` refuses it — a browser
     * cannot re-point itself at another server — for the same reason it refuses `pick`.
     *
     * **The URL is untrusted and so is the call** (ruling C-20). The main process validates the
     * string — http or https, an origin and nothing else — and then asks the user to confirm the
     * origin in a native dialog before pointing anything at it, because nothing on this channel
     * ties the call to a user gesture. The shell replaces the window on success, because the
     * transport itself has changed.
     */
    connect(url: string): Promise<RemoteLibraryDto | null>
  }

  account: {
    me(): Promise<UserDto>
    changePassword(current: string, next: string): Promise<void>
    updateProfile(patch: { displayName?: string }): Promise<UserDto>
  }

  settings: {
    get(): Promise<SettingsDto>
    put(patch: SettingsPatchInput): Promise<SettingsDto>
  }

  users: {
    list(): Promise<UserDto[]>
    create(dto: CreateUserInput): Promise<{ user: UserDto; activationUrl: string }>
    reissueInvite(id: string): Promise<{ activationUrl: string }>
    update(id: string, patch: UpdateUserInput): Promise<UserDto>
    delete(id: string): Promise<void>
  }

  projects: {
    list(query: ProjectQuery): Promise<ProjectDto[]>
    get(id: string): Promise<ProjectDetailDto>
    create(dto: CreateProjectInput): Promise<ProjectDto>
    update(id: string, patch: ProjectPatchInput): Promise<ProjectDto>
    delete(id: string, opts: { deleteFiles: boolean }): Promise<void>
    addTag(id: string, name: string): Promise<void>
    removeTag(id: string, name: string): Promise<void>
    rescan(): Promise<RescanResultDto>
  }

  importer: {
    /**
     * Uploads a zipped CuraManager library and imports it server-side. The zip is read from
     * its trailing central directory, so the whole archive has to arrive before anything can
     * be validated -- there is no partial-progress variant of this call.
     */
    curaManagerZip(body: UploadBody): Promise<ZipImportResultDto>
  }

  files: {
    upload(projectId: string, name: string, body: UploadBody): Promise<FileDto>
    rename(id: string, name: string): Promise<FileDto>
    delete(id: string): Promise<void>
  }
}
