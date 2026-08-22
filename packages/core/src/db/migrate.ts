import { readFileSync } from 'node:fs'
import type { Db } from './open.ts'

const MIGRATIONS: ReadonlyArray<{ version: number; file: string }> = [
  { version: 1, file: '001_init.sql' },
]

/** Applies every migration newer than PRAGMA user_version. Returns the resulting version. */
export function runMigrations(db: Db): number {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = user_version

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    const url = new URL(`./migrations/${migration.file}`, import.meta.url)
    const sql = readFileSync(url, 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      // PRAGMA cannot be parameterised; the value comes from the frozen list above.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    version = migration.version
  }

  return version
}
