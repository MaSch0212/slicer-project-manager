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
 * What core returns: IDs, never URLs (spec 4.2). Only a transport knows its own scheme, so
 * it decorates these into the DTOs above — /api/files/:id/thumb over HTTP,
 * spm://file/:id/thumb in Electron.
 */
export type CoreFileDto = Omit<FileDto, 'thumbUrl' | 'rawUrl'>
export type CoreProjectDto = Omit<ProjectDto, 'coverThumbUrl'> & { coverFileId?: string }
export type CoreProjectDetailDto = CoreProjectDto & { files: CoreFileDto[] }
