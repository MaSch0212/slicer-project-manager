import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { listProjects } from '../src/projects/queries.ts'
import { rescan } from '../src/projects/rescan.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { curaProject } from './fixtures/make-3mf.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  mkdirSync(join(lib.dir, username), { recursive: true })
  return { userId: id, isAdmin: false }
}

function root(lib: Library, username = 'marc'): string {
  return join(lib.dir, username)
}

test('a folder with no row is adopted, taking its name from the folder', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), 'Gridfinity Bin'))

    const result = await rescan(lib, ctx)
    assert.equal(result.adopted, 1)
    const [project] = listProjects(lib, ctx, {})
    assert.equal(project!.name, 'Gridfinity Bin')
    assert.equal(project!.state, 'ok')
  })
})

test('dot-folders are skipped at every level', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), '.git'), { recursive: true })
    mkdirSync(join(root(lib), 'Benchy', '.cache'), { recursive: true })
    writeFileSync(join(root(lib), 'Benchy', '.cache', 'junk.stl'), 'solid')
    writeFileSync(join(root(lib), 'Benchy', '.hidden.stl'), 'solid')
    writeFileSync(join(root(lib), 'Benchy', 'benchy.stl'), 'solid')

    await rescan(lib, ctx)
    const names = listProjects(lib, ctx, {}).map((p) => p.name)
    assert.deepEqual(names, ['Benchy'])
    const rows = lib.db.prepare('SELECT rel_path FROM files').all() as { rel_path: string }[]
    assert.deepEqual(
      rows.map((r) => r.rel_path),
      ['benchy.stl'],
    )
  })
})

test('the .spm folder is never adopted, even in a flat library', async () => {
  await withLibrary(async (lib) => {
    const id = newId()
    lib.db
      .prepare(
        `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
         VALUES (?, 'local', 'Local', '.', 0, 'active', 0)`,
      )
      .run(id)
    mkdirSync(join(lib.dir, 'Benchy'))

    await rescan(lib, { userId: id, isAdmin: false })
    assert.deepEqual(
      listProjects(lib, { userId: id, isAdmin: false }, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('files are indexed with their classification and a pending preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid benchy')
    writeFileSync(join(dir, 'notes.txt'), 'PETG')
    curaProject(join(dir, 'benchy.3mf'))

    const result = await rescan(lib, ctx)
    assert.equal(result.filesAdded, 3)
    assert.equal(result.previewsQueued, 3)

    const rows = (
      lib.db.prepare('SELECT rel_path, kind, slicer FROM files ORDER BY rel_path').all() as {
        rel_path: string
        kind: string
        slicer: string | null
      }[]
    ).map((r) => ({ ...r }))
    // node:sqlite rows have a null prototype; spread to plain objects so strict deepEqual
    // (node:assert/strict aliases deepEqual to deepStrictEqual) compares values, not prototypes.
    assert.deepEqual(rows, [
      { rel_path: 'benchy.3mf', kind: 'slicer_project', slicer: 'cura' },
      { rel_path: 'benchy.stl', kind: 'model', slicer: null },
      { rel_path: 'notes.txt', kind: 'other', slicer: null },
    ])
    const { n } = lib.db
      .prepare("SELECT COUNT(*) AS n FROM previews WHERE state = 'pending'")
      .get() as {
      n: number
    }
    assert.equal(n, 3)
  })
})

test('nested files keep a forward-slash relative path', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), 'Benchy', 'variants'), { recursive: true })
    writeFileSync(join(root(lib), 'Benchy', 'variants', 'small.stl'), 'solid')

    await rescan(lib, ctx)
    const { rel_path } = lib.db.prepare('SELECT rel_path FROM files').get() as { rel_path: string }
    assert.equal(rel_path, 'variants/small.stl')
  })
})

test('a project whose folder disappeared is marked missing and keeps its files', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)

    rmSync(dir, { recursive: true, force: true })
    const result = await rescan(lib, ctx)

    assert.equal(result.markedMissing, 1)
    assert.equal(result.filesRemoved, 0)
    const [project] = listProjects(lib, ctx, {})
    assert.equal(project!.state, 'missing')
    // The drive may simply be unmounted: a thousand tags must not evaporate.
    assert.equal(project!.fileCounts.model, 1)
  })
})

test('a folder that comes back is marked ok again', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    await rescan(lib, ctx)
    rmSync(dir, { recursive: true, force: true })
    await rescan(lib, ctx)
    mkdirSync(dir)

    await rescan(lib, ctx)
    assert.equal(listProjects(lib, ctx, {})[0]!.state, 'ok')
  })
})

test('a file removed from a present project loses its row and preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)

    rmSync(join(dir, 'benchy.stl'))
    const result = await rescan(lib, ctx)

    assert.equal(result.filesRemoved, 1)
    const { files, previews } = lib.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM previews) AS previews',
      )
      .get() as { files: number; previews: number }
    assert.equal(files, 0)
    assert.equal(previews, 0)
  })
})

test('a changed file resets its preview to pending and updates its hash', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    const file = join(dir, 'benchy.stl')
    writeFileSync(file, 'solid one')
    await rescan(lib, ctx)

    // Stand in for a finished preview so the reset is observable.
    lib.db.prepare("UPDATE previews SET state = 'ready', source_hash = X'00'").run()

    writeFileSync(file, 'solid one but longer now')
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 1)
    const row = lib.db.prepare('SELECT state FROM previews').get() as { state: string }
    assert.equal(row.state, 'pending')
    const file_row = lib.db.prepare('SELECT content_hash, size_bytes FROM files').get() as {
      content_hash: Uint8Array
      size_bytes: number
    }
    assert.equal(file_row.size_bytes, 'solid one but longer now'.length)
    assert.equal(file_row.content_hash.byteLength, 32)
  })
})

test('an untouched file is not re-queued', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)
    lib.db.prepare("UPDATE previews SET state = 'ready'").run()

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 0)
    assert.equal(result.filesAdded, 0)
    assert.equal(
      (lib.db.prepare('SELECT state FROM previews').get() as { state: string }).state,
      'ready',
    )
  })
})

test('rescan indexes files even when the user is over quota', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    lib.db.prepare('UPDATE users SET quota_bytes = 1 WHERE id = ?').run(ctx.userId)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid and definitely over one byte')

    // Refusing to index existing files would hide a user's own files from them (5.6).
    const result = await rescan(lib, ctx)
    assert.equal(result.filesAdded, 1)
  })
})

test('rescan only ever touches the calling user library', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    mkdirSync(join(root(lib, 'anna'), 'Bin'))

    const result = await rescan(lib, marc)
    assert.equal(result.adopted, 0)
    assert.equal((await rescan(lib, anna)).adopted, 1)
  })
})
