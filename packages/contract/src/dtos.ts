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
 * What core returns: IDs, never URLs (spec 4.2). Only a transport knows its own scheme, so
 * it decorates these into the DTOs above — /api/files/:id/thumb over HTTP,
 * spm://file/:id/thumb in Electron.
 */
export type CoreFileDto = Omit<FileDto, 'thumbUrl' | 'rawUrl'>
export type CoreProjectDto = Omit<ProjectDto, 'coverThumbUrl'> & { coverFileId?: string }
export type CoreProjectDetailDto = CoreProjectDto & { files: CoreFileDto[] }
