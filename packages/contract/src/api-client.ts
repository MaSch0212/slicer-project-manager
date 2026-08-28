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
  SlicerSessionDto,
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
    /**
     * The one decision the app asks the user to make: which install a product launches.
     *
     * `null` unbinds it, and that arm is not decoration. A product with exactly one install is
     * bound automatically the moment it is detected, so without a way back the only route to
     * "launch nothing for this product" was `remove` — which a scan undoes, because the install is
     * still installed, and which then re-binds it for being the only one. Spec 8.3 typed this
     * nullable; the first implementation of it did not, and nobody was asked.
     */
    bind(slicerId: SlicerId, installId: string | null): Promise<SlicerConfigDto>
    /**
     * The product used for a file that does not name a slicer, which is most of a library.
     *
     * `null` clears it, for the same reason `bind` takes one: a default that could be set and
     * never unset is a setting with no way back, and the launch paths already handle its absence —
     * they refuse and name the choice, which is what the whole default exists to avoid guessing at.
     */
    setDefault(slicerId: SlicerId | null): Promise<SlicerConfigDto>
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

    /**
     * Every launch directory under `<userData>/slicer-sessions/` (spec 6.3): the launches this
     * run made, the ones previous runs left unreconciled, and the files found with no record.
     *
     * **This is the comparison, run fresh.** Each call re-hashes the decompressed entries of the
     * file in each directory; `fs.watch` and the poll behind it only decide how promptly the
     * answer is ready, never what it is.
     *
     * It never deletes anything, and neither does the sweep at app start.
     */
    sessions(): Promise<SlicerSessionDto[]>

    /**
     * Answers one session, which is the only thing that removes a launch directory's file.
     *
     * `import` adds the returning file to the project as a **new** file under a derived,
     * non-clashing name — `bracket (orca).3mf`, then `bracket (orca) (2).3mf` — and never over
     * the original: a cross-slicer round trip is lossy, and deleting the original is a separate
     * action with a control that already exists. It answers with the file that was added.
     *
     * `discard` removes the file and answers `null`. The record beside it stays, gaining a
     * `sweptAt`, so a file recreated at the same path by the next Ctrl+S lands beside something
     * that still says which project it came from.
     *
     * `opts.projectId` is needed for an **orphan** alone — a file whose record is gone, where
     * only the user can say where it belongs. For a session that still has its `launch.json` the
     * project is already known and the argument is ignored.
     *
     * Refuses with `Conflict` while the file is still settling or has been reported unreadable:
     * importing half a write is the failure this whole loop exists to avoid.
     */
    resolveSession(
      launchId: string,
      action: 'import' | 'discard',
      opts?: { projectId?: string },
    ): Promise<FileDto | null>

    /**
     * Discards several sessions at once — the bulk action over the stale ones.
     *
     * Answers how many went, which is not always the number asked for: a session that vanished
     * between the list and the call is not an error, and neither is one whose file another
     * process has already removed.
     */
    discardSessions(launchIds: string[]): Promise<{ discarded: number }>
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
