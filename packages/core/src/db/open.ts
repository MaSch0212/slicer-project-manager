import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrate.ts'

export type Db = DatabaseSync
export type Library = { dir: string; db: Db }

export const SPM_DIR = '.spm'
export const PREVIEWS_DIR = 'previews'
export const DB_FILE = 'app.db'

/**
 * Opens (creating if needed) the library at `libraryDir`. The database lives inside the
 * library so the folder is wholly self-describing (spec 3.1).
 */
export function openLibrary(libraryDir: string): Library {
  mkdirSync(join(libraryDir, SPM_DIR, PREVIEWS_DIR), { recursive: true })
  const db = new DatabaseSync(join(libraryDir, SPM_DIR, DB_FILE))
  // Per-connection pragma: ON DELETE CASCADE in the schema is inert without it.
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return { dir: libraryDir, db }
}

export function closeLibrary(lib: Library): void {
  lib.db.close()
}
