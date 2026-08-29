export type { Ctx } from './ctx.ts'
export { closeLibrary, openLibrary, SPM_DIR, type Db, type Library } from './db/open.ts'
export { newId } from './db/ids.ts'
export { runMigrations } from './db/migrate.ts'
export {
  consoleSink,
  createLogger,
  DEFAULT_LOG_LEVEL,
  formatRecord,
  LOG_LEVELS,
  NOOP_LOGGER,
  parseLogLevel,
  type Logger,
  type LogFields,
  type LogLevel,
  type LogLevelSetting,
  type LogRecord,
  type LogSink,
} from './log.ts'

export { activateAccount, login, type LoginResult } from './auth/login.ts'
export { checkActivationToken, issueActivationToken } from './auth/activation.ts'
export {
  createSession,
  deleteSession,
  pruneExpiredSessions,
  resolveSession,
  SESSION_TTL_MS,
} from './auth/sessions.ts'

export { ensureBootstrapAdmin, ensureLocalUser } from './users/bootstrap.ts'
export { changePassword, getSettings, me, putSettings, updateProfile } from './users/account.ts'
export {
  createUser,
  deleteUser,
  listUsers,
  reissueInvite,
  requireAdmin,
  updateUser,
} from './users/admin.ts'
export { diskUsageBytes, diskUsageByUser } from './users/usage.ts'

export { getProject, listProjects } from './projects/queries.ts'
export {
  addTag,
  createProject,
  deleteProject,
  removeTag,
  sanitizeDirName,
  updateProject,
} from './projects/usecases.ts'
export {
  rescan,
  RELATIVE_PATH_SEPARATOR,
  type RescanOptions,
  type RescanProgress,
} from './projects/rescan.ts'
export {
  importCuraManagerLibrary,
  moveFlatLibraryIntoUserFolder,
  readCuraManagerSidecar,
  applyCuraManagerSidecars,
  type ImportProgress,
} from './projects/import-curamanager.ts'
export {
  importCuraManagerZip,
  planZipImport,
  type ZipImportProgress,
  type ZipImportResult,
  type ZipPlan,
} from './projects/import-zip.ts'

export { classifyFile, SLICER_HEADER_REGISTRY, type Classification } from './files/classify.ts'
export {
  diffDigests,
  entryDiff,
  entryDigests,
  entryHash,
  type EntryDiff,
} from './files/entry-hash.ts'
// The rest of `files/zip.ts` stays inside core; this one predicate is out because task 5's watch
// has to tell a `.3mf` mid-write from a file that was never a ZIP, and nothing else can.
export { readsAsZip } from './files/zip.ts'
export { safeJoin } from './files/paths.ts'
// The rewriter behind this (`files/zip-write.ts`) is deliberately not exported: it is how the
// strip is implemented, not something a caller above core should be reaching for.
export {
  strip3mf,
  stripRefusalReason,
  type Strip3mfResult,
  type StripRefusalReason,
} from './files/strip3mf.ts'
export {
  assertWithinQuota,
  contentTypeFor,
  deleteFile,
  renameFile,
  resolveFilePath,
  resolvePreviewPath,
  uploadFile,
} from './files/usecases.ts'

export {
  DEFAULT_CONCURRENCY,
  EMBEDDED_HANDLER,
  MAX_PREVIEW_ATTEMPTS,
  PREVIEW_LEASE_MS,
  runPreviewQueue,
  type PreviewHandler,
  type PreviewJob,
  type PreviewOutput,
} from './previews/queue.ts'
export { MESH_HANDLER, makeMeshHandler } from './previews/mesh-handler.ts'
export { PREVIEW_HANDLERS, makePreviewHandlers } from './previews/handlers.ts'
export {
  DEFAULT_MAX_MESH_BYTES,
  DEFAULT_MAX_STEP_BYTES,
  type MeshLimits,
} from './previews/mesh/limits.ts'
