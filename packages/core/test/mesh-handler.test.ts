import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { MESH_HANDLER } from '../src/previews/mesh-handler.ts'
import type { Mesh } from '../src/previews/mesh/mesh.ts'
import { readPngSize } from '../src/previews/png.ts'
import {
  claimPendingPreviews,
  EMBEDDED_HANDLER,
  MAX_PREVIEW_ATTEMPTS,
  runPreviewQueue,
} from '../src/previews/queue.ts'
import { rescan } from '../src/projects/rescan.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { meshGeometry3mf } from './fixtures/make-3mf.ts'
import { binaryStl, cubeMesh } from './fixtures/make-mesh.ts'

const HANDLERS = [EMBEDDED_HANDLER, MESH_HANDLER]

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

/** Creates the user and the project folder every test here writes model files into. */
function seedProjectDir(lib: Library): { ctx: Ctx; dir: string } {
  const ctx = seedUser(lib)
  const dir = join(lib.dir, 'marc', 'Benchy')
  mkdirSync(dir, { recursive: true })
  return { ctx, dir }
}

/** One vertex per triangle corner: verbose, but valid OBJ that needs no index bookkeeping. */
function objText(mesh: Mesh): string {
  const lines: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`)
  }
  for (let t = 0; t < mesh.triangleCount; t++) {
    lines.push(`f ${t * 3 + 1} ${t * 3 + 2} ${t * 3 + 3}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 200 bytes of 0xff: long enough to carry a binary STL header, its triangle count (0xffffffff)
 * disagrees wildly with the file length, and there is no ASCII "solid" keyword to fall back
 * on. `parseStl` rejects exactly this with an AppError.
 */
function malformedStl(): Uint8Array {
  return new Uint8Array(200).fill(0xff)
}

type PreviewRow = {
  file_id: string
  state: string
  source: string | null
  png_path: string | null
  width: number | null
  height: number | null
  attempts: number
  error: string | null
}

function previewRows(lib: Library): PreviewRow[] {
  return lib.db
    .prepare(
      `SELECT pv.file_id, pv.state, pv.source, pv.png_path, pv.width, pv.height, pv.attempts,
              pv.error
       FROM previews pv JOIN files f ON f.id = pv.file_id ORDER BY f.rel_path`,
    )
    .all() as PreviewRow[]
}

test('an stl model is rasterized to a 256px png on disk by the real queue', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'cube.stl'), binaryStl(cubeMesh()))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })

    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'ready')
    assert.equal(row.source, 'rasterized')
    assert.equal(row.width, 256)
    assert.equal(row.height, 256)
    assert.equal(row.png_path, `.spm/previews/${row.file_id}.png`)

    // The row can only claim a png exists; the bytes on disk are what the UI actually serves.
    const onDisk = join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)
    assert.ok(existsSync(onDisk))
    assert.deepEqual(readPngSize(readFileSync(onDisk)), { width: 256, height: 256 })
  })
})

test('obj, 3mf and an UPPERCASE extension are rasterized too, not just lowercase stl', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // Extension dispatch is the whole job of this handler, so every branch of it is covered:
    // covering only .stl would leave two thirds of the switch untested.
    writeFileSync(join(dir, 'cube.obj'), objText(cubeMesh()))
    meshGeometry3mf(join(dir, 'tetra.3mf'))
    // Uppercase is not a curiosity: the reference library contains `.STL` files, and
    // `classifyFile` lowercases before matching, so they arrive here as `kind: 'model'`.
    // Pinned by a test because getting it wrong is silent *and* unrecoverable — a
    // case-sensitive match returns null, `unsupported` is terminal (queue.ts:147-155), and no
    // later fix re-queues the rows. Every uppercase model in the library would go permanently
    // blank with CI green.
    writeFileSync(join(dir, 'CUBE.STL'), binaryStl(cubeMesh()))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 3,
      failed: 0,
      unsupported: 0,
    })

    for (const row of previewRows(lib)) {
      assert.equal(row.state, 'ready')
      assert.equal(row.source, 'rasterized')
      assert.deepEqual(
        readPngSize(readFileSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`))),
        { width: 256, height: 256 },
      )
    }
  })
})

test('a malformed stl fails and stops after MAX_PREVIEW_ATTEMPTS', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'broken.stl'), malformedStl())
    await rescan(lib, ctx)

    // Deliberately run more times than the budget, re-queueing the row to pending before each
    // run the way a rescan would. What stops the retries has to be MAX_PREVIEW_ATTEMPTS, not
    // this loop running out.
    let failures = 0
    let atBudget: PreviewRow | undefined
    for (let i = 0; i < MAX_PREVIEW_ATTEMPTS + 2; i++) {
      lib.db.prepare("UPDATE previews SET state = 'pending', claimed_at = NULL").run()
      failures += (await runPreviewQueue(lib, { handlers: HANDLERS })).failed
      if (i === MAX_PREVIEW_ATTEMPTS - 1) atBudget = previewRows(lib)[0]!
    }

    // The parser's AppError reached the queue's failure path rather than being swallowed into
    // an `unsupported`, and its message is on the row so the file is diagnosable from it alone.
    assert.equal(atBudget!.state, 'failed')
    assert.match(atBudget!.error!, /binary STL|solid/)

    // Two runs past the budget added nothing: the row was claimed, and charged an attempt,
    // exactly MAX_PREVIEW_ATTEMPTS times.
    const row = previewRows(lib)[0]!
    assert.equal(row.attempts, MAX_PREVIEW_ATTEMPTS)
    assert.equal(failures, MAX_PREVIEW_ATTEMPTS)
    assert.equal(claimPendingPreviews(lib, HANDLERS, 10).length, 0)
    // Nothing was written for it.
    assert.equal(existsSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)), false)
  })
})

test('a .step file classified as other is never claimed', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')
    writeFileSync(join(dir, 'cube.stl'), binaryStl(cubeMesh()))
    await rescan(lib, ctx)

    assert.deepEqual(
      claimPendingPreviews(lib, HANDLERS, 10).map((job) => job.kind),
      ['model'],
    )
  })
})

test('a model the handler cannot read is unsupported, not failed', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'part.step'), 'ISO-10303-21;')
    await rescan(lib, ctx)

    // classifyFile only ever calls .stl/.obj/.3mf a model, so this is forced: the point is the
    // handler's contract for a `model` job in a format it has no parser for. `null` (→
    // `unsupported`, never retried) is right and a throw (→ `failed`, against the retry
    // budget) is wrong, because re-reading the file will never make it readable.
    lib.db.prepare("UPDATE files SET kind = 'model' WHERE rel_path = 'part.step'").run()

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 0,
      failed: 0,
      unsupported: 1,
    })
    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'unsupported')
    assert.equal(row.error, null)
    // Unsupported is terminal: the row is not re-queued and burns no further budget.
    assert.equal(row.attempts, 1)
  })
})

test('the default handler list still leaves models pending, so rasterizing is opt-in', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'cube.stl'), binaryStl(cubeMesh()))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib), { ready: 0, failed: 0, unsupported: 0 })
    assert.equal(previewRows(lib)[0]!.state, 'pending')
  })
})
