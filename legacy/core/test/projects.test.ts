import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { getProject, listProjects, listTags } from '../src/projects/queries.ts'
import {
  addTag,
  createProject,
  deleteProject,
  removeTag,
  sanitizeDirName,
  updateProject,
} from '../src/projects/usecases.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username: string): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  return { userId: id, isAdmin: false }
}

/** Adds a files row plus its preview row directly, standing in for a rescan. */
function seedFile(
  lib: Library,
  projectId: string,
  relPath: string,
  kind: 'model' | 'slicer_project' | 'other',
  previewState = 'pending',
): string {
  const id = newId()
  lib.db
    .prepare(
      'INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES (?, ?, ?, ?, 100, 0)',
    )
    .run(id, projectId, relPath, kind)
  lib.db
    .prepare('INSERT INTO previews (file_id, state, updated_at) VALUES (?, ?, 0)')
    .run(id, previewState)
  return id
}

test('sanitizeDirName strips separators and trims', () => {
  assert.equal(sanitizeDirName('Gridfinity Bin'), 'Gridfinity Bin')
  assert.equal(sanitizeDirName('  a/b:c*d?  '), 'a-b-c-d')
  assert.equal(sanitizeDirName('...'), 'project')
})

test('createProject makes the folder and returns the DTO', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    assert.equal(project.name, 'Benchy')
    assert.equal(project.state, 'ok')
    assert.equal(project.isArchived, false)
    assert.deepEqual(project.tags, [])
    assert.deepEqual(project.fileCounts, { model: 0, slicerProject: 0, other: 0 })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy')))
  })
})

test('two projects with the same name get distinct folders', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: 'Benchy' })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy (2)')))
  })
})

test('createProject applies website, notes and tags', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, {
      name: 'Bracket',
      website: 'https://printables.com/model/1',
      notes: 'PETG only',
      tags: ['Functional', 'petg'],
    })
    assert.equal(project.website, 'https://printables.com/model/1')
    assert.deepEqual(project.tags, ['Functional', 'petg'])
  })
})

test('one user cannot see or fetch another user project', async () => {
  await withLibrary((lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const mine = createProject(lib, marc, { name: 'Benchy' })

    assert.deepEqual(listProjects(lib, anna, {}), [])
    assert.throws(
      () => getProject(lib, anna, mine.id),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
    assert.throws(
      () => updateProject(lib, anna, mine.id, { name: 'Stolen' }),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
    assert.throws(
      () => deleteProject(lib, anna, mine.id, { deleteFiles: false }),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
  })
})

test('updateProject patches only what is given and clears with null', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const created = createProject(lib, ctx, { name: 'Benchy', website: 'https://a.example' })
    const renamed = updateProject(lib, ctx, created.id, { name: 'Benchy v2' })
    assert.equal(renamed.name, 'Benchy v2')
    assert.equal(renamed.website, 'https://a.example')

    const cleared = updateProject(lib, ctx, created.id, { website: null, isArchived: true })
    assert.equal(cleared.website, undefined)
    assert.equal(cleared.isArchived, true)
    assert.ok(cleared.updatedAt >= created.updatedAt)
  })
})

test('renaming a project does not move its folder', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const created = createProject(lib, ctx, { name: 'Benchy' })
    updateProject(lib, ctx, created.id, { name: 'Something else' })
    // dir_name is independent of the display name, exactly as library_dir is of username.
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy')))
  })
})

test('deleteProject keeps the folder unless deleteFiles is set', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const keep = createProject(lib, ctx, { name: 'Keep' })
    const wipe = createProject(lib, ctx, { name: 'Wipe' })
    writeFileSync(join(lib.dir, 'marc', 'Wipe', 'a.stl'), 'solid')

    deleteProject(lib, ctx, keep.id, { deleteFiles: false })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Keep')))

    deleteProject(lib, ctx, wipe.id, { deleteFiles: true })
    assert.equal(existsSync(join(lib.dir, 'marc', 'Wipe')), false)
    assert.deepEqual(listProjects(lib, ctx, {}), [])
  })
})

test('tags are per owner, case-insensitive, and cleaned up when orphaned', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })

    addTag(lib, ctx, project.id, 'Boat')
    addTag(lib, ctx, project.id, 'boat')
    assert.deepEqual(getProject(lib, ctx, project.id).tags, ['Boat'])

    removeTag(lib, ctx, project.id, 'BOAT')
    assert.deepEqual(getProject(lib, ctx, project.id).tags, [])
    const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }
    assert.equal(n, 0)
  })
})

test('list filters by search across name, notes and tags', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: 'Bracket', notes: 'needs PETG' })
    const tagged = createProject(lib, ctx, { name: 'Bin' })
    addTag(lib, ctx, tagged.id, 'gridfinity')

    const names = (search: string) =>
      listProjects(lib, ctx, { search })
        .map((p) => p.name)
        .sort()
    assert.deepEqual(names('bench'), ['Benchy'])
    assert.deepEqual(names('PETG'), ['Bracket'])
    assert.deepEqual(names('GRIDFINITY'), ['Bin'])
    assert.deepEqual(names('nothing here'), [])
  })
})

test('a search term with LIKE wildcards is matched literally', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: '100% infill' })
    assert.deepEqual(
      listProjects(lib, ctx, { search: '%' }).map((p) => p.name),
      ['100% infill'],
    )
  })
})

test('a tags filter requires every tag', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const both = createProject(lib, ctx, { name: 'Both', tags: ['petg', 'functional'] })
    createProject(lib, ctx, { name: 'One', tags: ['petg'] })

    assert.deepEqual(
      listProjects(lib, ctx, { tags: ['petg', 'functional'] }).map((p) => p.id),
      [both.id],
    )
    assert.equal(listProjects(lib, ctx, { tags: ['petg'] }).length, 2)
  })
})

test('a case-variant or literal duplicate in the tags filter still matches', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const both = createProject(lib, ctx, { name: 'Both', tags: ['petg', 'functional'] })

    // A case-variant duplicate ('PETG' vs 'petg') must not inflate the required count past
    // what the project can ever satisfy.
    assert.deepEqual(
      listProjects(lib, ctx, { tags: ['petg', 'PETG'] }).map((p) => p.id),
      [both.id],
    )
    // A literal duplicate must behave the same way.
    assert.deepEqual(
      listProjects(lib, ctx, { tags: ['petg', 'petg'] }).map((p) => p.id),
      [both.id],
    )
  })
})

test('archived projects are hidden unless asked for', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Old' })
    updateProject(lib, ctx, project.id, { isArchived: true })

    assert.deepEqual(listProjects(lib, ctx, {}), [])
    assert.equal(listProjects(lib, ctx, { includeArchived: true }).length, 1)
  })
})

test('sort and direction are honoured', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'beta' })
    createProject(lib, ctx, { name: 'Alpha' })

    assert.deepEqual(
      listProjects(lib, ctx, { sort: 'name', dir: 'asc' }).map((p) => p.name),
      ['Alpha', 'beta'],
    )
    assert.deepEqual(
      listProjects(lib, ctx, { sort: 'name', dir: 'desc' }).map((p) => p.name),
      ['beta', 'Alpha'],
    )
  })
})

test('a tied updated_at still yields both projects across two single-row pages', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const a = createProject(lib, ctx, { name: 'Alpha' })
    const b = createProject(lib, ctx, { name: 'Beta' })

    // Two createProject calls can already land on the same millisecond by accident, which
    // would make this test pass for the wrong reason. Setting updated_at explicitly is the
    // only way to be sure the tie is genuine rather than incidental.
    lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id IN (?, ?)').run(1000, a.id, b.id)

    const page0 = listProjects(lib, ctx, { limit: 1, offset: 0 })

    // A read-only rerun of the identical query, on an untouched table, is deterministic with
    // or without a tiebreaker — SQLite has no reason to reorder ties it was never asked to
    // reorder. The defect this guards against only shows up once the table is written to
    // between two page fetches, exactly as fact 2 describes: a rescan stamps many rows with
    // the same updated_at, and a later write can move a tied row to a different physical spot
    // in the table. Reproduce that by deleting and reinserting `a`'s row verbatim: same id,
    // same (still tied) updated_at, but a fresh position.
    const row = lib.db.prepare('SELECT * FROM projects WHERE id = ?').get(a.id) as {
      id: string
      owner_id: string
      name: string
      dir_name: string
      website: string | null
      notes: string | null
      is_archived: number
      state: string
      created_at: number
      updated_at: number
    }
    lib.db.prepare('DELETE FROM projects WHERE id = ?').run(a.id)
    lib.db
      .prepare(
        `INSERT INTO projects (id, owner_id, name, dir_name, website, notes, is_archived, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.name,
        row.dir_name,
        row.website,
        row.notes,
        row.is_archived,
        row.state,
        row.created_at,
        row.updated_at,
      )

    const page1 = listProjects(lib, ctx, { limit: 1, offset: 1 })

    assert.equal(page0.length, 1)
    assert.equal(page1.length, 1)
    // Not one project twice, and not one of them missing: p.id ASC as a final tiebreaker is
    // what makes the two pages agree on a total order over the tied rows even after that write.
    assert.deepEqual([page0[0]!.id, page1[0]!.id].sort(), [a.id, b.id].sort())
  })
})

test('offset beyond the end returns an empty array, not an error', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Solo' })
    assert.deepEqual(listProjects(lib, ctx, { limit: 10, offset: 50 }), [])
  })
})

test('omitting limit still returns every row, unchanged from before paging existed', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    // 3 rows would pass under almost any plausible accidental default, including the 48-row
    // page size this very segment is about to introduce elsewhere (spec 1 fact 3). Seeding past
    // the schema's own `limit` cap (200) means no value the schema would even accept as a
    // default could satisfy this assertion by accident. Raw inserts, not createProject, because
    // this only needs rows in the table, not 201 real folders on disk.
    const total = 201
    for (let i = 0; i < total; i++) {
      lib.db
        .prepare(
          `INSERT INTO projects (id, owner_id, name, dir_name, is_archived, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 'ok', 0, 0)`,
        )
        .run(newId(), ctx.userId, `Project ${i}`, `dir-${i}`)
    }
    assert.equal(listProjects(lib, ctx, {}).length, total)
  })
})

test('offset without limit is ignored, not treated as "skip everything"', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'One' })
    createProject(lib, ctx, { name: 'Two' })
    // Spec 3.1: offset is "only meaningful with limit". A caller that sends offset alone (say,
    // by building the query object programmatically) must still get the whole list back, not a
    // list with that many rows silently skipped and no limit to bound it.
    assert.equal(listProjects(lib, ctx, { offset: 1 }).length, 2)
  })
})

test('the id tiebreaker is always ascending, even when dir is desc', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const a = createProject(lib, ctx, { name: 'Alpha' })
    const b = createProject(lib, ctx, { name: 'Beta' })
    lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id IN (?, ?)').run(1000, a.id, b.id)
    const [lower, higher] = [a.id, b.id].sort()

    // Spec 3.2: "always ASC, never following dir" — it is there to make the order total, not to
    // be meaningful. Asserting only set membership (as the tied-page test above does) cannot
    // catch the tiebreaker being made to track `dir`; this checks the actual emitted order.
    assert.deepEqual(
      listProjects(lib, ctx, { dir: 'asc' }).map((p) => p.id),
      [lower, higher],
    )
    assert.deepEqual(
      listProjects(lib, ctx, { dir: 'desc' }).map((p) => p.id),
      [lower, higher],
    )
  })
})

test('file counts and the cover file id come back on the list DTO', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    seedFile(lib, project.id, 'benchy.stl', 'model')
    seedFile(lib, project.id, 'notes.txt', 'other')
    const ready = seedFile(lib, project.id, 'benchy.3mf', 'slicer_project', 'ready')

    const [dto] = listProjects(lib, ctx, {})
    assert.deepEqual(dto!.fileCounts, { model: 1, slicerProject: 1, other: 1 })
    // No model preview is ready yet, so the slicer project thumbnail is the cover.
    assert.equal(dto!.coverFileId, ready)

    const modelReady = seedFile(lib, project.id, 'a-model.stl', 'model', 'ready')
    assert.equal(listProjects(lib, ctx, {})[0]!.coverFileId, modelReady)
  })
})

test("listTags returns the owner's distinct tags, sorted case-insensitively", async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'A', tags: ['Zebra'] })
    createProject(lib, ctx, { name: 'B', tags: ['apple', 'functional'] })

    // 'Zebra' sorts before 'apple' under plain (case-sensitive) ordering -- 'Z' is 90, 'a' is
    // 97 -- so this only passes with COLLATE NOCASE actually applied, not by accident.
    assert.deepEqual(listTags(lib, ctx), ['apple', 'functional', 'Zebra'])
  })
})

test("listTags does not return another user's tags", async () => {
  await withLibrary((lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    createProject(lib, marc, { name: 'Mine', tags: ['petg'] })

    assert.deepEqual(listTags(lib, anna), [])
    assert.deepEqual(listTags(lib, marc), ['petg'])
  })
})

test('getProject returns its files with preview state', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    seedFile(lib, project.id, 'benchy.stl', 'model')

    const detail = getProject(lib, ctx, project.id)
    assert.equal(detail.files.length, 1)
    assert.equal(detail.files[0]!.name, 'benchy.stl')
    assert.equal(detail.files[0]!.kind, 'model')
    assert.equal(detail.files[0]!.previewState, 'pending')
  })
})
