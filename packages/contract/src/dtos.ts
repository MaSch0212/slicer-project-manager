export type Capabilities = {
  requiresAuth: boolean
  canManageUsers: boolean
  canPickLocalFolder: boolean
  canLaunchSlicer: boolean
  canConfigureSlicers: boolean
  canBrowseModelSites: boolean
}

/**
 * The local library folder a shell has open (spec 2.6).
 *
 * Only the Electron shell in local-folder mode can produce one, which is exactly what
 * `Capabilities.canPickLocalFolder` says. The absolute path is the only field because it is the
 * only thing the UI has to show: the folder *is* the library, and everything else about it
 * already arrives as projects, files and settings.
 */
export type LocalLibraryDto = { dir: string }

/**
 * The remote server a shell is pointed at (spec 2.6's other mode).
 *
 * The origin and nothing else, for the same reason `LocalLibraryDto` is one path: it *is* the
 * library, and everything about its contents already arrives as projects, files and settings.
 * Only the Electron shell can produce one; `HttpApiClient` refuses `library.connect` exactly as
 * it refuses `library.pick`, because a browser cannot re-point itself at another server.
 */
export type RemoteLibraryDto = { origin: string }

export type UserStatus = 'pending' | 'active' | 'disabled'

export type UserDto = {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  status: UserStatus
  diskUsageBytes: number
  quotaBytes: number | null
  createdAt: number
  activatedAt?: number
}

export type FileKind = 'model' | 'slicer_project' | 'other'
export type SlicerId = 'cura' | 'prusaslicer' | 'anycubic' | 'bambu' | 'orca'
export type PreviewState = 'pending' | 'ready' | 'failed' | 'unsupported'

export type FileDto = {
  id: string
  name: string
  kind: FileKind
  slicer?: SlicerId
  sizeBytes: number
  previewState: PreviewState
  thumbUrl?: string
  rawUrl: string
}

export type ProjectDto = {
  id: string
  name: string
  website?: string
  notes?: string
  isArchived: boolean
  state: 'ok' | 'missing'
  tags: string[]
  fileCounts: { model: number; slicerProject: number; other: number }
  coverThumbUrl?: string
  createdAt: number
  updatedAt: number
}

export type ProjectDetailDto = ProjectDto & { files: FileDto[] }

export type ProjectQuery = {
  search?: string
  tags?: string[]
  includeArchived?: boolean
  sort?: 'name' | 'createdAt' | 'updatedAt'
  dir?: 'asc' | 'desc'
}

export type RescanResultDto = {
  adopted: number
  markedMissing: number
  filesAdded: number
  filesRemoved: number
  previewsQueued: number
}

/** What POST /api/import/curamanager reports back after an archive import. */
export type ZipImportResultDto = {
  projectsExtracted: number
  filesExtracted: number
  bytesExtracted: number
  /** The single wrapping folder the archive was stripped of, if it had one. */
  strippedRoot: string | null
  /** Entries deliberately not written: loose root files, dot-entries, __MACOSX noise. */
  skipped: number
  projectsUpdated: number
  tagsApplied: number
  rescan: RescanResultDto
}

export type SettingsDto = {
  theme: 'light' | 'dark' | 'system'
  language: 'en' | 'de'
  viewMode: 'grid' | 'list'
  sort: 'name' | 'createdAt' | 'updatedAt'
  dir: 'asc' | 'desc'
}

export const DEFAULT_SETTINGS: SettingsDto = {
  theme: 'system',
  language: 'en',
  viewMode: 'grid',
  sort: 'updatedAt',
  dir: 'desc',
}

/**
 * One installed slicer the shell is prepared to launch.
 *
 * **A `SlicerId` names a product; this names an install, and the two are one-to-many.** Measured:
 * the developer's machine has UltiMaker Cura 5.12.0 and 5.13.0 side by side, both working, both
 * able to run at once. Everything in the slicer UI is built on keeping them apart.
 *
 * `id` is the install's *origin key* — the uninstall subkey and its hive, the MSIX package family,
 * or a generated id for a manual entry — and never its path. An MSIX install path embeds the
 * package version, so a stored path breaks silently on update.
 */
export type SlicerInstallDto = {
  id: string
  slicerId: SlicerId
  label: string
  /** Null for a manual entry with no readable version. Never read from the executable. */
  version: string | null
  /** The last known path. Re-checked before every launch; shown so the user can tell two apart. */
  path: string
  origin: 'registry' | 'msix' | 'manual'
  /** `missing`: the stored path failed and re-resolution from the origin key found nothing. */
  state: 'ok' | 'missing'
}

export type SlicerConfigDto = {
  installs: SlicerInstallDto[]
  /**
   * Which install each product launches. A `SlicerId` with one install is bound to it
   * automatically; one with two is left unbound and the UI asks. The app offers, it does not
   * guess — preferring the newer of two Curas is what the rejected file-association mechanism does.
   */
  bindings: Partial<Record<SlicerId, string>>
  /** Used for every file that does not name a slicer, which is most of a library. */
  defaultSlicerId: SlicerId | null
  /** False off Windows, where manual entry is the only mechanism the UI should offer. */
  detectionSupported: boolean
}

/**
 * Which of the two launch paths a launch takes (spec 6.1 and 6.2). They are different intents and
 * the difference is visible to the user, because it has to be.
 *
 * - `as-is` opens the user's own slicer project, unchanged, at its real place in the library. Four
 *   of five slicers then save back over it, which is the point: the work lands in the project
 *   folder and the next rescan indexes it.
 * - `new-project` starts a *new* slicer project from a file of any kind, usually in a slicer other
 *   than the one that wrote it. What the slicer is handed may be a stripped copy in a launch
 *   directory rather than the library file.
 */
export type SlicerLaunchMode = 'as-is' | 'new-project'

/**
 * What the renderer may say about a launch.
 *
 * `slicerId` is the product that was **actually** launched, which is not always the one asked for:
 * `slicerId` may be omitted and then the file's own slicer (for `as-is`) or the configured default
 * is used, and `notices` says so.
 */
export type SlicerLaunchOptions = { mode: SlicerLaunchMode; slicerId?: SlicerId }

/**
 * The outcome of one launch — and deliberately *not* a claim that anything opened.
 *
 * **A successful spawn is not evidence the file opened** (spec 6.4). Three of five slicers never
 * put a filename in a window title, and Anycubic's measured failure mode is a healthy process in
 * front of an empty plate. So this carries a `pid` and nothing that could be read as "it opened":
 * the UI says "Handed *file* to *slicer*", never "opened in your slicer".
 *
 * `notices` are sentences the app *knows* apply to this triple of (slicer launched, what the source
 * was, whether the copy was stripped) — a wizard that may appear in front of the model, a modal
 * that blocks loading, a file a slicer may silently discard. They are produced in the main process,
 * which is where the measurements live.
 */
export type SlicerLaunchDto = {
  /**
   * Identifies this launch — and, **for a launch that made one**, names its directory under
   * `<userData>/slicer-sessions/`.
   *
   * The two in-place paths make none: `as-is` always, and `new-project` for an `.stl` or an
   * `.obj`. Those hand the slicer the file where it already lives, so there is no copy to keep and
   * nothing to reconcile — whatever the slicer writes lands in the project folder, where the
   * ordinary rescan finds it. Joining this onto the sessions directory is therefore a path that
   * may legitimately not exist, and `stripped` is not the discriminator either: a `new-project`
   * launch of a config-less `.3mf` copies without stripping.
   */
  launchId: string
  slicerId: SlicerId
  /** Which install of that product, in the words `/settings/slicers` shows. */
  installLabel: string
  /** Whether embedded slicer configuration was removed from the copy that was handed over. */
  stripped: boolean
  notices: string[]
  /** Null when the platform gave the spawn no pid. Never a claim that the file loaded. */
  pid: number | null
}

/**
 * One launch directory under `<userData>/slicer-sessions/`, and what the app can honestly say
 * about the file in it (spec D 6.3 and 7.2–7.4).
 *
 * **Everything here is the result of a comparison, not of a notification.** `fs.watch` is an
 * optimisation; what decides whether anything came back is a hash of the decompressed entries,
 * recomputed for every one of these. A missed watch event costs promptness, never correctness.
 *
 * **Nothing in this list is ever deleted by the app on its own** (D constraint 10). A session
 * appears here so a person can answer it; the two answers are `slicers.resolveSession`'s
 * `import` and `discard`.
 */
export type SlicerSessionDto = {
  /**
   * How `resolveSession` and `discardSessions` name this one.
   *
   * The launch directory's own name for a session the app launched, which is the `launchId` of
   * the `SlicerLaunchDto` that made it. For an orphan it is whatever the entry under
   * `slicer-sessions/` is called, which is a file name and not a launch of anything.
   */
  launchId: string
  /**
   * Empty for an orphan with nothing beside it to say where it belongs, which is then the question
   * the user is asked. An orphan that turned up *inside* a launch directory carries that launch's
   * project, because asking a question the app can already answer is a worse kind of honesty.
   */
  projectId: string
  /** Empty for an orphan, whose record is gone and with it the id of what was launched. */
  fileId: string
  fileName: string
  /**
   * The product this session belongs to: the one that was launched, or — for an orphan, which was
   * launched by nothing — whatever the file itself classifies as.
   *
   * **Null only for an orphan that names no slicer at all**, an `.stl` being the obvious one.
   * There is genuinely nothing else to put there, and the two alternatives were both worse:
   * inventing a product the app has no evidence for, or leaving the file out of the list, which is
   * the one thing the "a file with no record is an unfinished session, not litter" rule forbids.
   */
  slicerId: SlicerId | null
  /** For an orphan, when the file appeared, which is the only "started" it has. */
  startedAt: number
  /**
   * Whether the process **this app spawned** is still running.
   *
   * Not "the slicer is open", and never "the slicer was closed": several slicers hand the file
   * to an already-running instance and exit immediately, so a dead process routinely means a
   * live slicer. False for every session from a previous run of the app, which spawned nothing
   * this process can watch.
   */
  processAlive: boolean
  /**
   * `settling` is a write in progress — 0 bytes, a lock, or a ZIP whose directory does not parse
   * — and becomes `unreadable` only after a bounded window of it.
   */
  fileState: 'unchanged' | 'changed' | 'settling' | 'unreadable'
  /** A file found with no `launch.json`: the user must say where it belongs. */
  isOrphan: boolean
  /** What the file was classified as when it was handed over. Absent for an orphan. */
  sourceSlicer?: SlicerId | null
  /**
   * What the returning file classifies as now, when that differs from `sourceSlicer`.
   *
   * A round trip can change what a file *is*: a Bambu project opened in Orca and saved comes back
   * classified `orca`. The reconcile carries this, the returning file's identity, and not the
   * record's.
   */
  returnedAs?: SlicerId | null
  sourceSizeBytes?: number
  returnedSizeBytes?: number
  /**
   * Entries added, removed and changed between the file as launched and the file as it is now.
   *
   * It reports **that** `Metadata/project_settings.config` changed, never which setting inside it
   * changed. Absent until the file has settled, and absent for an orphan, which has nothing to be
   * compared against.
   */
  entryDiff?: { added: string[]; removed: string[]; changed: string[] }
}

/**
 * One row of the model-site registry, as the renderer sees it (spec 4.4).
 *
 * The registry itself lives in `packages/desktop/src/browse/registry.ts` — this is the projection
 * of it that crosses the boundary, so the `/browse` page can render the start links without
 * duplicating a table of somebody else's websites. `identity()` and `hosts` deliberately do not
 * cross: `matchKey` runs in the renderer over `ModelSiteIdentity`, which is a different shape for a
 * different job, and `hosts` is not a permission list and would read like one.
 */
export type ModelSiteDto = {
  id: string
  displayName: string
  homeUrl: string
}

/**
 * Where the `/browse` page wants the native view, in **CSS pixels of the host page**.
 *
 * An intent and not an instruction. The main process converts by the window's current zoom factor
 * and intersects the result with a rectangle it computes for itself — the content area minus a
 * chrome inset it owns and this side never names (spec 4.2). A request that intersects to less than
 * the shell's minimum is treated as a call to `hide()`, because a `1×1` view is a live third-party
 * page running where nobody can see it.
 */
export type BrowseBounds = { x: number; y: number; width: number; height: number }

/**
 * What the browse chrome polls, and **the one DTO in this file whose strings a stranger wrote**.
 *
 * `url`, `title` and `lastError` are chosen by, or derived from, whatever site the browse view is
 * on. They arrive inside `spm://app` — the document that holds the IPC bridge — so spec 3.10's rule
 * is a property of this type and not a habit of whoever renders it:
 *
 * **Every string here is rendered as text only.** Never into `innerHTML` or `[innerHTML]`, never
 * through `bypassSecurityTrust*`, never into a `[href]`, a `[src]`, a CSS `url()` or a
 * `window.open`, and truncated for display, because a page can set a title of any length and the
 * app's own chrome should not be re-laid-out by one. Angular escapes interpolated text by default,
 * which makes the default safe — and that is a reason to write the rule down rather than a reason
 * to leave it to the page, because the two things a browse chrome obviously wants are to render the
 * URL as a link and the site's favicon as an image, which are precisely the two places the default
 * does not save you. The way to go somewhere is `browse.navigate`, which runs the URL through
 * `browseNavigationPolicy` in the main process rather than handing it to Chromium here.
 */
export type BrowseStateDto = {
  attached: boolean
  url: string | null
  title: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The registry row this URL belongs to, or null. Drives attribution, not permission (4.4). */
  siteId: string | null
  /** Set when the last navigation failed, so the UI can say what happened rather than spin. */
  lastError: string | null
}

/**
 * What core returns: IDs, never URLs (spec 4.2). Only a transport knows its own scheme, so
 * it decorates these into the DTOs above — /api/files/:id/thumb over HTTP,
 * spm://file/:id/thumb in Electron.
 */
export type CoreFileDto = Omit<FileDto, 'thumbUrl' | 'rawUrl'>
export type CoreProjectDto = Omit<ProjectDto, 'coverThumbUrl'> & { coverFileId?: string }
export type CoreProjectDetailDto = CoreProjectDto & { files: CoreFileDto[] }
