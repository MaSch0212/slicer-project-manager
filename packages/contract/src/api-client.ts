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
  SlicerConfigDto,
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchOptions,
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

  /**
   * The slicers installed on **this machine**, and which install each product launches.
   *
   * Gated by `Capabilities.canConfigureSlicers`. `HttpApiClient` refuses every method here for
   * the same reason it refuses `library.pick`: a browser talking to a server has no machine of
   * its own to configure, and there is no route for one. This is deliberately not a library
   * concern — the configuration is a property of the computer, not of whichever library is open,
   * so it is answered by the shell in both of the desktop shell's modes.
   *
   * **No method here takes a filesystem path.** `addManual` names a product and the path comes
   * from a native dialog the main process owns, exactly as `library.pick` does; the renderer is
   * the untrusted side of that boundary and never names a location on disk.
   */
  slicers: {
    /** What is configured right now. Cheap: one small file, no subprocess. */
    get(): Promise<SlicerConfigDto>
    /**
     * Looks for installed slicers and merges what it finds into what is already there.
     *
     * The expensive one — a PowerShell subprocess, measured at 880 ms — so it is a button and not
     * something the app does at start-up. A scan adds new installs, marks vanished ones `missing`
     * rather than dropping them, touches no manual entry, and **never re-points a binding the
     * user has made**.
     */
    scan(): Promise<SlicerConfigDto>
    /**
     * Asks the user for an executable and records it as an install of `slicerId`.
     *
     * Resolves to `null` when the user cancels — not an error, exactly like `library.pick`. This
     * is the answer to everything detection cannot see: per-user and portable installs, a vendor
     * whose registry entry does not name the main executable, and any sixth slicer someone wants
     * to point a `.3mf` at.
     */
    addManual(slicerId: SlicerId): Promise<SlicerConfigDto | null>
    /** Forgets an install, and any binding to it. A detected one returns on the next scan. */
    remove(installId: string): Promise<SlicerConfigDto>
    /** The one decision the app asks the user to make: which install a product launches. */
    bind(slicerId: SlicerId, installId: string): Promise<SlicerConfigDto>
    /** The product used for a file that names no slicer, which is most of a library. */
    setDefault(slicerId: SlicerId): Promise<SlicerConfigDto>
    /**
     * Throws the stored configuration away.
     *
     * The only way out of a `slicers.json` written by a newer build, which this one refuses to
     * overwrite: a downgrade quietly replacing a newer configuration is worse than the feature
     * being unavailable until somebody says otherwise.
     */
    resetConfig(): Promise<SlicerConfigDto>

    /**
     * Hands a file in the library to a slicer (spec 6.1 and 6.2).
     *
     * **Ids, never a path.** The renderer is the untrusted side of this boundary and names no
     * location on disk; the main process resolves the file through core's own ownership scoping,
     * so a renderer naming a project it does not own gets `NotFound`. The `projectId` is here
     * because the launch record and the later reconcile both need it and `FileDto` carries no
     * project — it is the id the project page is already holding.
     *
     * Omitting `slicerId` means "decide for me": `as-is` then uses the slicer the file itself
     * names, and both modes fall back to the configured default. The answer says which product
     * was picked, and `notices` says why.
     *
     * **This spawns a process and resolves as soon as it has.** It does not wait for a window,
     * cannot see the plate, and never claims the file opened.
     *
     * Refusals worth switching on: `NotFound` for a file, project or vanished install;
     * `Conflict` for a product with no install bound (the message names the choice, because the
     * app offers and does not guess); `Validation` for a strip that could not be done safely,
     * whose `details.reason` is `encrypted`, `unreadable` or `configuration-left-behind` — the
     * launch is refused outright and never falls back to the unstripped original.
     */
    open(fileId: string, projectId: string, opts: SlicerLaunchOptions): Promise<SlicerLaunchDto>
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
