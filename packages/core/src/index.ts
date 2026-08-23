export type { Ctx } from './ctx.ts'
export { closeLibrary, openLibrary, type Db, type Library } from './db/open.ts'
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

export { classifyFile, SLICER_HEADER_REGISTRY } from './files/classify.ts'
export { safeJoin } from './files/paths.ts'
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
  EMBEDDED_HANDLER,
  MAX_PREVIEW_ATTEMPTS,
  PREVIEW_LEASE_MS,
  runPreviewQueue,
  type PreviewHandler,
  type PreviewJob,
  type PreviewOutput,
} from './previews/queue.ts'
