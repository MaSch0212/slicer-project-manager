import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '../src/db/ids.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

const TABLES = [
  'users',
  'activation_tokens',
  'sessions',
  'projects',
  'tags',
  'project_tags',
  'files',
  'previews',
  'user_settings',
]

test('openLibrary creates .spm/app.db and .spm/previews', async () => {
  await withLibrary((lib) => {
    assert.ok(existsSync(join(lib.dir, '.spm', 'app.db')))
    assert.ok(existsSync(join(lib.dir, '.spm', 'previews')))
  })
})

test('migrations create every table and set user_version', async () => {
  await withLibrary((lib) => {
    const names = lib.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`)
    const { user_version } = lib.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    assert.equal(user_version, 2)
  })
})

test('runMigrations is idempotent', async () => {
  await withLibrary((lib) => {
    assert.equal(runMigrations(lib.db), 2)
    assert.equal(runMigrations(lib.db), 2)
  })
})

test('usernames are unique case-insensitively', async () => {
  await withLibrary((lib) => {
    const insert = lib.db.prepare(
      "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', 0)",
    )
    insert.run(newId(), 'Marc', 'Marc', 'marc')
    assert.throws(() => insert.run(newId(), 'marc', 'Marc again', 'marc2'))
  })
})

test('deleting a user cascades to projects, files and previews', async () => {
  await withLibrary((lib) => {
    const userId = newId()
    const projectId = newId()
    const fileId = newId()
    lib.db
      .prepare(
        "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, 'marc', 'Marc', 'marc', 0, 'active', 0)",
      )
      .run(userId)
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run(projectId, userId, 'Benchy', 'Benchy')
    lib.db
      .prepare(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES (?, ?, 'benchy.stl', 'model', 10, 0)",
      )
      .run(fileId, projectId)
    lib.db
      .prepare("INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', 0)")
      .run(fileId)

    lib.db.prepare('DELETE FROM users WHERE id = ?').run(userId)

    for (const table of ['projects', 'files', 'previews']) {
      const { n } = lib.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      assert.equal(n, 0, `${table} was not cascaded`)
    }
  })
})

test('a project folder name is unique per owner', async () => {
  await withLibrary((lib) => {
    const userId = newId()
    lib.db
      .prepare(
        "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, 'marc', 'Marc', 'marc', 0, 'active', 0)",
      )
      .run(userId)
    const insert = lib.db.prepare(
      'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
    )
    insert.run(newId(), userId, 'Benchy', 'Benchy')
    assert.throws(() => insert.run(newId(), userId, 'Benchy again', 'Benchy'))
  })
})
