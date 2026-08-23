import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newId } from '../src/db/ids.ts'
import { BUSY_TIMEOUT_MS, closeLibrary, openLibrary } from '../src/db/open.ts'
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

// SPM is a multi-process design over one library file: the server, the desktop app and the
// `import-curamanager` script all open the same `app.db`. SQLite's default `busy_timeout` is
// 0 -- zero retries -- so the *first* moment two of them write at once, one dies outright
// with "database is locked". These two tests pin the retry behaviour that makes concurrent
// access work at all; see the comment on BUSY_TIMEOUT_MS.
test('openLibrary sets a non-zero busy_timeout', async () => {
  await withLibrary((lib) => {
    const { timeout } = lib.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    assert.equal(timeout, BUSY_TIMEOUT_MS)
    assert.ok(BUSY_TIMEOUT_MS > 0)
  })
})

test('a write contending with another connection retries instead of failing instantly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-busy-'))
  // 300ms rather than the 5s default purely so the test is quick; the behaviour under test
  // -- that SQLite waits and retries at all -- is identical at either value.
  const lib = openLibrary(dir, { busyTimeoutMs: 300 })
  // Stands in for the running server holding a write lock. It never releases it, so the
  // contending write below must still fail in the end -- what changes is *when*: instantly
  // (the bug) versus after exhausting the retry budget (the fix).
  const other = new DatabaseSync(join(dir, '.spm', 'app.db'))
  try {
    other.exec('BEGIN IMMEDIATE')
    const started = Date.now()
    let threw = false
    try {
      lib.db.exec('CREATE TABLE contended (x)')
    } catch {
      threw = true
    }
    const elapsed = Date.now() - started
    assert.ok(threw, 'a permanently held lock must still surface as an error')
    assert.ok(elapsed >= 250, `gave up after ${elapsed}ms; expected it to retry for ~300ms`)
  } finally {
    other.close()
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
})
