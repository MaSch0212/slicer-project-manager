import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { CLASSIFIER_VERSION } from '../src/files/classify.ts'
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

    // markedMissing is reported to the user: a still-missing project must not be re-counted.
    const again = await rescan(lib, ctx)
    assert.equal(again.markedMissing, 0)
  })
})

test('an absent library root degrades to missing projects instead of throwing', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)

    // Not just the project folder: the whole user root is gone (e.g. an unmounted network
    // drive), which is exactly the ENOENT case listProjectFolders must swallow.
    rmSync(root(lib), { recursive: true, force: true })
    const result = await rescan(lib, ctx)

    assert.equal(result.markedMissing, 1)
    assert.equal(result.filesRemoved, 0)
    const [project] = listProjects(lib, ctx, {})
    assert.equal(project!.state, 'missing')
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

test('a same-size edit is still detected by its changed mtime', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    const file = join(dir, 'benchy.stl')
    // Same length, different content: an in-place slicer re-save often looks exactly like
    // this, and size_bytes alone would never notice it.
    writeFileSync(file, 'solid one')
    await rescan(lib, ctx)
    const before = (
      lib.db.prepare('SELECT content_hash FROM files').get() as { content_hash: Uint8Array }
    ).content_hash
    lib.db.prepare("UPDATE previews SET state = 'ready', source_hash = X'00'").run()

    writeFileSync(file, 'solid TWO')
    assert.equal('solid one'.length, 'solid TWO'.length)
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 1)
    const row = lib.db.prepare('SELECT state FROM previews').get() as { state: string }
    assert.equal(row.state, 'pending')
    const after = lib.db.prepare('SELECT content_hash, size_bytes FROM files').get() as {
      content_hash: Uint8Array
      size_bytes: number
    }
    assert.equal(after.size_bytes, 'solid TWO'.length)
    const sameHash =
      after.content_hash.length === before.length &&
      after.content_hash.every((byte, i) => byte === before[i])
    assert.equal(sameHash, false)
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

/** Every `files` row's classification stamp, keyed by relative path. */
function classifiedBy(lib: Library): Record<string, number> {
  const rows = lib.db.prepare('SELECT rel_path, classified_by FROM files').all() as {
    rel_path: string
    classified_by: number
  }[]
  return Object.fromEntries(rows.map((row) => [row.rel_path, Number(row.classified_by)]))
}

/**
 * The headline case: a row an older build wrote comes back reclassified, **without its bytes
 * moving**.
 *
 * The "untouched" is the whole test. A fixture that rewrote the file would pass against the broken
 * behaviour too, because the stat mismatch alone would have reclassified it — so the file is
 * written once, indexed, forced back to the shape an older build left (`kind: 'other'`,
 * `classified_by = 0`) and rescanned with nothing on disk changed at all.
 *
 * The bytes are irrelevant to `classifyFile`, which reads the extension and nothing else; the real
 * STEP fixture is only needed by the end-to-end test in `step.test.ts`, which renders one.
 */
test('a file classified by an older version is re-asked, its bytes untouched', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Bracket')
    mkdirSync(dir)
    writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')
    await rescan(lib, ctx)

    // The row exactly as a build without migration 003 left it, and its preview row rendered.
    lib.db.prepare("UPDATE files SET kind = 'other', slicer = NULL, classified_by = 0").run()
    lib.db.prepare("UPDATE previews SET state = 'ready', png_path = 'x.png'").run()

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 1)
    assert.equal(result.filesAdded, 0)
    const row = lib.db.prepare('SELECT kind, classified_by FROM files').get() as {
      kind: string
      classified_by: number
    }
    assert.equal(row.kind, 'model')
    assert.equal(Number(row.classified_by), CLASSIFIER_VERSION)
    const preview = lib.db.prepare('SELECT state, png_path FROM previews').get() as {
      state: string
      png_path: string | null
    }
    assert.deepEqual(
      { state: preview.state, png_path: preview.png_path },
      { state: 'pending', png_path: null },
    )
  })
})

/**
 * All three write sites, three assertions and not one.
 *
 * A first-sight insert, a stat-mismatch update and a version-mismatch reclassify each set `kind`,
 * and each must stamp the version beside it. Leaving any one of them alone is invisible until the
 * next rescan — the row simply stays stale for ever — which is why one combined assertion at the
 * end would not locate it.
 */
test('all three rescan write sites stamp the classifier version', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'fresh.stl'), 'solid')
    writeFileSync(join(dir, 'edited.stl'), 'solid')
    writeFileSync(join(dir, 'stale.stl'), 'solid')

    // 1. The insert.
    await rescan(lib, ctx)
    assert.deepEqual(classifiedBy(lib), {
      'fresh.stl': CLASSIFIER_VERSION,
      'edited.stl': CLASSIFIER_VERSION,
      'stale.stl': CLASSIFIER_VERSION,
    })

    // 2. The stat-mismatch update, and 3. the version-mismatch reclassify, in one pass so a site
    //    that writes nothing is caught by the row it leaves behind rather than by the other's.
    lib.db
      .prepare("UPDATE files SET classified_by = 0 WHERE rel_path IN ('edited.stl', 'stale.stl')")
      .run()
    writeFileSync(join(dir, 'edited.stl'), 'solid, and now rather longer than it was')
    await rescan(lib, ctx)
    assert.deepEqual(classifiedBy(lib), {
      'fresh.stl': CLASSIFIER_VERSION,
      'edited.stl': CLASSIFIER_VERSION,
      'stale.stl': CLASSIFIER_VERSION,
    })
  })
})

/**
 * Idempotence: a second pass over an untouched library re-asks nothing and re-pends nothing.
 *
 * A row whose `classified_by` is never written is reclassified on **every** tick for ever — 402
 * zip reads a tick in the reference library rather than 402 once per version bump.
 *
 * **And `previewsQueued === 0` cannot see that on its own, so it is not what this test rests on.**
 * Measured, against a mutation that stamps 0 at the insert site: the second pass does reclassify
 * every row, gets the same kind back for each, and therefore re-pends nothing — the counter reads
 * 0 either way. Because only a *changed* kind re-pends, the wasted work leaves no trace in any
 * result field at all. The stamp itself is the only observable there is, so it is asserted
 * directly, after the first pass, where a missed write site puts a stale value.
 */
test('a second rescan over an untouched library reclassifies and queues nothing', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    curaProject(join(dir, 'benchy.3mf'))

    assert.equal((await rescan(lib, ctx)).previewsQueued, 3)
    // Nothing is stale, which is what makes the second pass cheap rather than merely quiet.
    assert.deepEqual(classifiedBy(lib), {
      'part.step': CLASSIFIER_VERSION,
      'benchy.stl': CLASSIFIER_VERSION,
      'benchy.3mf': CLASSIFIER_VERSION,
    })
    lib.db.prepare("UPDATE previews SET state = 'ready'").run()

    // A probe that makes "was `classifyFile` called again?" observable, which no result field is.
    // The 3MF's bytes are replaced with the same number of bytes that are not a zip, and its mtime
    // is put back — so its stat is unchanged and `classify3mf` would now answer `other` where it
    // answered `slicer_project`. A second pass that re-asks the question therefore changes the
    // kind, re-pends the row and shows up in `previewsQueued`; one that short-circuits on the
    // version cannot. This is what catches a `classified_by` the SELECT never fetched, whose
    // comparison is then against `undefined` and reclassifies every row on every tick for ever.
    const threeMf = join(dir, 'benchy.3mf')
    const stat = statSync(threeMf)
    writeFileSync(threeMf, new Uint8Array(stat.size))
    utimesSync(threeMf, stat.atime, stat.mtime)

    const second = await rescan(lib, ctx)
    assert.equal(second.previewsQueued, 0)
    assert.equal(second.filesAdded, 0)
    const states = (lib.db.prepare('SELECT state FROM previews').all() as { state: string }[]).map(
      (row) => row.state,
    )
    assert.deepEqual(states, ['ready', 'ready', 'ready'])
    const kind = lib.db.prepare("SELECT kind FROM files WHERE rel_path = 'benchy.3mf'").get() as {
      kind: string
    }
    assert.equal(kind.kind, 'slicer_project')
  })
})

/**
 * A reclassification that lands on the kind the row already had re-pends nothing.
 *
 * A version bump made for a `.step` change must not re-render the 1 311 STLs in the reference
 * library. Asserting `previewsQueued === 0` is not enough on its own: a `resetPreview` that ran
 * without incrementing the counter would leave that assertion green and the thumbnail gone, so the
 * row's own `state`, `png_path` and `attempts` are what is compared.
 */
test('a reclassification to the same kind leaves the preview row exactly as it was', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)
    lib.db
      .prepare("UPDATE previews SET state = 'ready', png_path = 'benchy.png', attempts = 2")
      .run()
    lib.db.prepare('UPDATE files SET classified_by = 0').run()

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 0)
    const row = lib.db.prepare('SELECT state, png_path, attempts FROM previews').get() as {
      state: string
      png_path: string | null
      attempts: number
    }
    assert.deepEqual(
      { state: row.state, png_path: row.png_path, attempts: Number(row.attempts) },
      { state: 'ready', png_path: 'benchy.png', attempts: 2 },
    )
    // And the stamp was still written, or the row would be reclassified again on the next tick.
    assert.deepEqual(classifiedBy(lib), { 'benchy.stl': CLASSIFIER_VERSION })
  })
})

/**
 * The `insertPreview` fallback beside `resetPreview`, which is not defensive padding.
 *
 * `UPDATE previews … WHERE file_id = ?` against a row that is not there updates nothing and
 * reports nothing, so a file whose preview row is missing — a database restored without it, a row
 * deleted by hand, any future path that inserts a file without one — would reclassify to `model`
 * and then never render. The stat-mismatch path has guarded it this way since it was written.
 */
test('a version-stale file whose preview row was deleted gets a pending one', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Bracket')
    mkdirSync(dir)
    writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')
    await rescan(lib, ctx)
    lib.db.prepare("UPDATE files SET kind = 'other', slicer = NULL, classified_by = 0").run()
    lib.db.prepare('DELETE FROM previews').run()

    assert.equal((await rescan(lib, ctx)).previewsQueued, 1)
    const preview = lib.db.prepare('SELECT state FROM previews').get() as
      { state: string } | undefined
    assert.equal(preview?.state, 'pending')
  })
})
