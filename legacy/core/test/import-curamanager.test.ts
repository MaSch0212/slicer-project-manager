import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import {
  importCuraManagerLibrary,
  readCuraManagerSidecar,
} from '../src/projects/import-curamanager.ts'
import { listProjects } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username: string, libraryDir: string): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, libraryDir)
  if (libraryDir !== '.') mkdirSync(join(lib.dir, libraryDir), { recursive: true })
  return { userId: id, isAdmin: false }
}

/** Writes a CuraManager-shaped project folder: files plus a PascalCase sidecar. */
function curaManagerProject(
  root: string,
  name: string,
  sidecar: Record<string, unknown> | null,
): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, `${name}.stl`), 'solid')
  if (sidecar) writeFileSync(join(root, name, 'metadata.json'), JSON.stringify(sidecar))
}

test('readCuraManagerSidecar accepts the PascalCase shape and tolerates a missing file', async () => {
  await withLibrary((lib) => {
    curaManagerProject(lib.dir, 'Benchy', {
      Tags: ['boat', 'benchmark'],
      Website: 'https://thingiverse.com/thing:763622',
      IsArchived: true,
    })
    assert.deepEqual(readCuraManagerSidecar(join(lib.dir, 'Benchy')), {
      tags: ['boat', 'benchmark'],
      website: 'https://thingiverse.com/thing:763622',
      isArchived: true,
    })

    curaManagerProject(lib.dir, 'Bare', null)
    assert.equal(readCuraManagerSidecar(join(lib.dir, 'Bare')), null)
  })
})

test('malformed sidecar json is ignored rather than fatal', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'Broken'))
    writeFileSync(join(lib.dir, 'Broken', 'metadata.json'), '{ this is not json')
    assert.equal(readCuraManagerSidecar(join(lib.dir, 'Broken')), null)
  })
})

test('a top-level JSON array is not a valid sidecar', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'ArrayJson'))
    writeFileSync(join(lib.dir, 'ArrayJson', 'metadata.json'), '[]')
    assert.equal(readCuraManagerSidecar(join(lib.dir, 'ArrayJson')), null)
  })
})

test('a flat CuraManager library imports into local mode with no restructuring', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'local', '.')
    curaManagerProject(lib.dir, 'Benchy', {
      Tags: ['boat'],
      Website: 'https://a.example',
      IsArchived: false,
    })
    curaManagerProject(lib.dir, 'Bracket', { Tags: ['petg', 'functional'], IsArchived: true })
    curaManagerProject(lib.dir, 'Plain', null)

    const result = await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })
    assert.equal(result.moved, 0)
    assert.equal(result.rescan.adopted, 3)
    assert.equal(result.projectsUpdated, 2)
    assert.equal(result.tagsApplied, 3)

    const projects = new Map(
      listProjects(lib, ctx, { includeArchived: true }).map((p) => [p.name, p]),
    )
    assert.deepEqual(projects.get('Benchy')!.tags, ['boat'])
    assert.equal(projects.get('Benchy')!.website, 'https://a.example')
    assert.equal(projects.get('Bracket')!.isArchived, true)
    assert.deepEqual(projects.get('Plain')!.tags, [])
  })
})

test('importing into a server library moves each folder under the target user', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc', 'marc')
    const anna = seedUser(lib, 'anna', 'anna')
    curaManagerProject(lib.dir, 'Benchy', { Tags: ['boat'] })

    const result = await importCuraManagerLibrary(lib, marc, { moveIntoUserFolder: true })
    assert.equal(result.moved, 1)
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy', 'Benchy.stl')))
    assert.equal(existsSync(join(lib.dir, 'Benchy')), false)
    // Another user's library root is never swept up.
    assert.ok(existsSync(join(lib.dir, 'anna')))
    assert.deepEqual(listProjects(lib, anna, {}), [])
    assert.deepEqual(
      listProjects(lib, marc, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('a folder already present at the destination is a Conflict, and nothing is moved or adopted', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc', 'marc')
    curaManagerProject(lib.dir, 'Benchy', { Tags: ['boat'] })
    // The destination already holds a folder with the same name.
    mkdirSync(join(lib.dir, 'marc', 'Benchy'), { recursive: true })
    writeFileSync(join(lib.dir, 'marc', 'Benchy', 'preexisting.txt'), 'do not touch')

    await assert.rejects(
      importCuraManagerLibrary(lib, marc, { moveIntoUserFolder: true }),
      (e: unknown) => {
        const err = e as AppError
        assert.equal(err.code, 'Conflict')
        assert.ok(String(err.message).includes('Benchy'))
        return true
      },
    )

    // All-or-nothing: the source is untouched...
    assert.ok(existsSync(join(lib.dir, 'Benchy', 'Benchy.stl')))
    // ...the pre-existing destination folder is untouched...
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy', 'preexisting.txt')))
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'Benchy.stl')), false)
    // ...and no project rows were created at all.
    assert.deepEqual(listProjects(lib, marc, {}), [])
  })
})

test('the .spm folder is never moved or adopted by the importer', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'marc', 'marc')
    curaManagerProject(lib.dir, 'Benchy', null)

    await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: true })
    assert.ok(existsSync(join(lib.dir, '.spm', 'app.db')))
    assert.deepEqual(
      listProjects(lib, ctx, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('importing twice applies no duplicate tags and no duplicate projects', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'local', '.')
    curaManagerProject(lib.dir, 'Benchy', { Tags: ['boat', 'BOAT'] })

    await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })
    const second = await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })

    assert.equal(second.rescan.adopted, 0)
    const [project] = listProjects(lib, ctx, {})
    assert.deepEqual(project!.tags, ['boat'])
    assert.equal(listProjects(lib, ctx, {}).length, 1)
  })
})
