import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrate.ts'
import { NOOP_LOGGER, type Logger } from '../log.ts'

export type Db = DatabaseSync
/**
 * The handle every core use case takes. The logger rides along here rather than being threaded
 * through each function signature: anything holding a Library can already write to the
 * library, so it may as well be able to say so.
 */
export type Library = { dir: string; db: Db; log: Logger }

export const SPM_DIR = '.spm'
export const PREVIEWS_DIR = 'previews'
export const DB_FILE = 'app.db'

/**
 * How long a write waits for a lock another connection holds before giving up.
 *
 * One library file is opened by several processes at once by design: the server, the desktop
 * app (spec 2.5) and the `import-curamanager` script. SQLite's default `busy_timeout` is
 * **0** -- a contended write fails immediately, with no retry at all -- so the very first
 * overlap between, say, the server's 30-second preview tick and a long-running import kills
 * one of them with "database is locked". Every write here is its own short autocommit
 * statement (milliseconds), so a lock is never held anywhere near this long; a wait that
 * actually reaches five seconds means something is genuinely wedged and an error is right.
 *
 * Note this only works because nothing opens an explicit deferred transaction: `busy_timeout`
 * cannot resolve a lock upgrade deadlock between two of those, only plain contention.
 */
export const BUSY_TIMEOUT_MS = 5000

export type OpenOptions = {
  busyTimeoutMs?: number
  /** Defaults to silence: importing core must not print anything the host did not ask for. */
  logger?: Logger
}

/**
 * Opens (creating if needed) the library at `libraryDir`. The database lives inside the
 * library so the folder is wholly self-describing (spec 3.1).
 */
export function openLibrary(libraryDir: string, opts: OpenOptions = {}): Library {
  mkdirSync(join(libraryDir, SPM_DIR, PREVIEWS_DIR), { recursive: true })
  const db = new DatabaseSync(join(libraryDir, SPM_DIR, DB_FILE))
  // Both are per-connection, so they must be set on every connection, not once per file:
  // ON DELETE CASCADE in the schema is inert without foreign_keys, and a connection that
  // skipped busy_timeout would still die instantly on the first contended write.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS)}`)
  runMigrations(db)
  return { dir: libraryDir, db, log: opts.logger ?? NOOP_LOGGER }
}

export function closeLibrary(lib: Library): void {
  lib.db.close()
}
