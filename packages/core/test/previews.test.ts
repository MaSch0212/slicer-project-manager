import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { extractEmbeddedThumbnail } from '../src/previews/embedded.ts'
import { readPngSize } from '../src/previews/png.ts'
import {
  MAX_PREVIEW_ATTEMPTS,
  PREVIEW_LEASE_MS,
  claimPendingPreviews,
  runPreviewQueue,
  EMBEDDED_HANDLER,
  type PreviewHandler,
} from '../src/previews/queue.ts'
import { rescan } from '../src/projects/rescan.ts'
import { getProject, listProjects } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import {
  bambuLineageProject,
  curaProject,
  plainMesh3mf,
  prusaProject,
  writeZip,
} from './fixtures/make-3mf.ts'
import { makePng } from './fixtures/make-png.ts'

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

test('readPngSize reads IHDR and rejects non-PNG bytes', () => {
  assert.deepEqual(readPngSize(makePng(300, 200)), { width: 300, height: 200 })
  assert.equal(readPngSize(new TextEncoder().encode('not a png at all really')), null)
  assert.equal(readPngSize(new Uint8Array(4)), null)
})

test('the Cura thumbnail is extracted at its measured size', async () => {
  await withLibrary((lib) => {
    const path = join(lib.dir, 'marc', 'a.3mf')
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    curaProject(path, makePng(300, 300))
    const found = extractEmbeddedThumbnail(path)
    assert.deepEqual({ width: found!.width, height: found!.height }, { width: 300, height: 300 })
  })
})

test('the PrusaSlicer thumbnail is extracted', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    prusaProject(path, makePng(256, 256))
    assert.equal(extractEmbeddedThumbnail(path)!.width, 256)
  })
})

test('the Bambu lineage uses plate_1.png, not its smaller or unlit siblings', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    writeZip(path, [
      { name: 'Metadata/slice_info.config', data: '<config><header/></config>' },
      { name: 'Metadata/plate_1_small.png', data: makePng(128, 128) },
      { name: 'Metadata/plate_no_light_1.png', data: makePng(512, 512) },
      { name: 'Metadata/top_1.png', data: makePng(512, 512) },
      { name: 'Metadata/pick_1.png', data: makePng(512, 512) },
      { name: 'Metadata/plate_1.png', data: makePng(511, 509) },
    ])
    // 511x509 is deliberately unique so only plate_1.png can satisfy this assertion.
    assert.deepEqual(
      (({ width, height }) => ({ width, height }))(extractEmbeddedThumbnail(path)!),
      { width: 511, height: 509 },
    )
  })
})

test('a project file with no embedded thumbnail yields null', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    bambuLineageProject(path, ['X-BBL-Client-Type'])
    assert.equal(extractEmbeddedThumbnail(path), null)
  })
})

test('the queue only claims kinds a handler covers', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    curaProject(join(dir, 'benchy.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const claimed = claimPendingPreviews(lib, [EMBEDDED_HANDLER], 10)
    assert.deepEqual(
      claimed.map((job) => job.kind),
      ['slicer_project'],
    )
  })
})

test('running the queue makes a slicer project preview ready and writes the png', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'benchy.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const counts = await runPreviewQueue(lib)
    assert.deepEqual(counts, { ready: 1, failed: 0, unsupported: 0 })

    const row = lib.db
      .prepare('SELECT file_id, state, source, png_path, width, height, source_hash FROM previews')
      .get() as {
      file_id: string
      state: string
      source: string
      png_path: string
      width: number
      height: number
      source_hash: Uint8Array
    }
    assert.equal(row.state, 'ready')
    assert.equal(row.source, 'embedded')
    assert.equal(row.width, 300)
    assert.equal(row.png_path, `.spm/previews/${row.file_id}.png`)
    assert.ok(existsSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)))
    assert.equal(
      readPngSize(readFileSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)))!.width,
      300,
    )
    assert.equal(row.source_hash.byteLength, 32)

    // The ready preview becomes the project cover.
    assert.equal(listProjects(lib, ctx, {})[0]!.coverFileId, row.file_id)
    assert.equal(
      getProject(lib, ctx, listProjects(lib, ctx, {})[0]!.id).files[0]!.previewState,
      'ready',
    )
  })
})

test('a project file with no thumbnail is unsupported, not failed', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    bambuLineageProject(join(dir, 'a.3mf'), ['X-BBL-Client-Type'])
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib), { ready: 0, failed: 0, unsupported: 1 })
    // Deterministic absence, so it is never retried.
    assert.equal(
      (lib.db.prepare('SELECT state FROM previews').get() as { state: string }).state,
      'unsupported',
    )
  })
})

test('model files stay pending until a rasterizer handler exists', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    plainMesh3mf(join(dir, 'mesh.3mf'))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib), { ready: 0, failed: 0, unsupported: 0 })
    const states = (lib.db.prepare('SELECT state FROM previews').all() as { state: string }[]).map(
      (r) => r.state,
    )
    assert.deepEqual(states, ['pending', 'pending'])
  })
})

test('a handler that throws fails the row and stops after MAX_PREVIEW_ATTEMPTS', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const exploding = {
      kinds: ['slicer_project'] as const,
      run: () => Promise.reject(new Error('boom')),
    }
    for (let i = 0; i < MAX_PREVIEW_ATTEMPTS; i++) {
      // Rows are re-queued between attempts so the retry budget is what bounds the loop.
      lib.db.prepare("UPDATE previews SET state = 'pending'").run()
      await runPreviewQueue(lib, { handlers: [exploding] })
    }
    const row = lib.db.prepare('SELECT state, attempts, error FROM previews').get() as {
      state: string
      attempts: number
      error: string
    }
    assert.equal(row.state, 'failed')
    assert.equal(row.attempts, MAX_PREVIEW_ATTEMPTS)
    assert.match(row.error, /boom/)

    lib.db.prepare("UPDATE previews SET state = 'pending'").run()
    assert.equal(claimPendingPreviews(lib, [exploding], 10).length, 0)
  })
})

test('the queue processes a batch larger than its concurrency', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    for (let i = 0; i < 7; i++) curaProject(join(dir, `p${i}.3mf`), makePng(64 + i, 64))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { concurrency: 2 }), {
      ready: 7,
      failed: 0,
      unsupported: 0,
    })
  })
})

function previewRow(lib: Library): { state: string; attempts: number; claimedAt: number | null } {
  const row = lib.db
    .prepare('SELECT state, attempts, claimed_at AS claimedAt FROM previews')
    .get() as { state: string; attempts: number; claimedAt: number | null }
  // node:sqlite returns null-prototype rows, which deepEqual will not match a literal.
  return { state: row.state, attempts: row.attempts, claimedAt: row.claimedAt }
}

/** Two 3mf files with embedded thumbnails, both queued pending. */
async function seedTwoQueued(lib: Library): Promise<void> {
  const ctx = seedUser(lib)
  const dir = join(lib.dir, 'marc', 'Benchy')
  mkdirSync(dir)
  curaProject(join(dir, 'a.3mf'), makePng(300, 300))
  curaProject(join(dir, 'b.3mf'), makePng(301, 300))
  await rescan(lib, ctx)
}

test('a run in flight holds its rows: an overlapping tick claims nothing and redoes nothing', async () => {
  await withLibrary(async (lib) => {
    await seedTwoQueued(lib)

    const seen: string[] = []
    const slow: PreviewHandler = {
      kinds: ['slicer_project'],
      run: async (job) => {
        seen.push(job.fileId)
        // Stands in for a rasterizer run that outlives one queue interval. A macrotask, not
        // a shared gate, so the pre-fix behaviour shows up as a wrong count rather than as
        // a deadlock.
        await new Promise((resolve) => setTimeout(resolve, 40))
        return null
      },
    }

    // main.ts fires runPreviewQueue on a fixed interval. Subsystem B's rasterizer will
    // outlive one interval (spec 7.1), so the next tick must not re-select the same rows.
    const first = runPreviewQueue(lib, { handlers: [slow], concurrency: 2 })
    const overlapping = await runPreviewQueue(lib, { handlers: [slow] })
    await first

    assert.deepEqual(overlapping, { ready: 0, failed: 0, unsupported: 0 })
    assert.equal(seen.length, 2)
    assert.equal(new Set(seen).size, 2)
  })
})

test('claiming a row increments attempts, so a crash mid-job still burns the budget', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    // A handler still running is the hung case; a killed process is the same thing from the
    // row's point of view. Neither ever reaches the caught-throw branch, so attempts has to
    // move at claim time or the file is retried forever (spec 7.3).
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const hanging: PreviewHandler = { kinds: ['slicer_project'], run: () => gate.then(() => null) }
    const inFlight = runPreviewQueue(lib, { handlers: [hanging] })
    assert.equal(previewRow(lib).attempts, 1)
    assert.equal(previewRow(lib).state, 'pending')
    release()
    await inFlight

    // Back to pending for the remaining budget, the way a restart would find it.
    lib.db.prepare("UPDATE previews SET state = 'pending'").run()
    for (let i = 1; i < MAX_PREVIEW_ATTEMPTS; i++) {
      // A restart releases the abandoned lease; the retry budget is what bounds it.
      lib.db.prepare('UPDATE previews SET claimed_at = NULL').run()
      assert.equal(claimPendingPreviews(lib, [hanging], 10).length, 1)
      assert.equal(previewRow(lib).attempts, i + 1)
    }

    lib.db.prepare('UPDATE previews SET claimed_at = NULL').run()
    assert.equal(claimPendingPreviews(lib, [hanging], 10).length, 0)
  })
})

test('an expired lease is reclaimable, so a crash does not strand the row forever', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    assert.equal(claimPendingPreviews(lib, [EMBEDDED_HANDLER], 10).length, 1)
    // Still leased: nothing else may take it.
    assert.equal(claimPendingPreviews(lib, [EMBEDDED_HANDLER], 10).length, 0)

    lib.db.prepare('UPDATE previews SET claimed_at = ?').run(Date.now() - PREVIEW_LEASE_MS - 1_000)
    assert.equal(claimPendingPreviews(lib, [EMBEDDED_HANDLER], 10).length, 1)
    assert.equal(previewRow(lib).attempts, 2)
  })
})

test('a failing handler does not double-count the attempt it was claimed with', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const exploding: PreviewHandler = {
      kinds: ['slicer_project'],
      run: () => Promise.reject(new Error('boom')),
    }
    assert.deepEqual(await runPreviewQueue(lib, { handlers: [exploding] }), {
      ready: 0,
      failed: 1,
      unsupported: 0,
    })
    assert.equal(previewRow(lib).attempts, 1)
  })
})

test('rescan re-queueing a changed file releases any stale claim with the retry budget', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)
    await runPreviewQueue(lib)

    // The file changes on disk, so rescan re-queues it: attempts AND the lease both reset,
    // otherwise a file edited MAX_PREVIEW_ATTEMPTS times would stop previewing.
    curaProject(join(dir, 'a.3mf'), makePng(320, 320))
    await rescan(lib, ctx)
    assert.deepEqual(previewRow(lib), { state: 'pending', attempts: 0, claimedAt: null })
  })
})
