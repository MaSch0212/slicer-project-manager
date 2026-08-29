import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { makePreviewHandlers, PREVIEW_HANDLERS } from '../src/previews/handlers.ts'
import type { Mesh } from '../src/previews/mesh/mesh.ts'
import { readPngSize } from '../src/previews/png.ts'
import {
  claimPendingPreviews,
  MAX_PREVIEW_ATTEMPTS,
  runPreviewQueue,
} from '../src/previews/queue.ts'
import { rescan } from '../src/projects/rescan.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { bambuLineageProject, meshGeometry3mf, slicerProjectWithMesh } from './fixtures/make-3mf.ts'
import { binaryStl, cubeMesh } from './fixtures/make-mesh.ts'
import { makePng } from './fixtures/make-png.ts'

/**
 * The production chain itself, not a local array spelling out the same two handlers.
 *
 * Rebuilding an equivalent array here is what made the order untested: inverting the one
 * `main.ts` used left core, server and e2e all green, because every order assertion was checking
 * a copy. `preview.spec.ts` cannot cover it either -- its fixture is a `.stl`, a kind
 * `EMBEDDED_HANDLER` does not claim, so the order never comes up.
 */
const HANDLERS = PREVIEW_HANDLERS

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
    // Pinned by a test because getting it wrong is silent *and* self-concealing — a
    // case-sensitive match returns null, the queue records `unsupported`, and it re-claims only
    // `pending` rows, so shipping the fix would not revisit a single one of them. Every
    // uppercase model in the library stays blank, with CI green, until its bytes change.
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

test('a file classified as other is never claimed', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // **`notes.txt` and not `part.step`, and subsystem F is why.** What this pins is the claim
    // filter — a job is offered only to a handler that claims its kind — and `.step` was the
    // vehicle for it while `classifyFile` still answered `other` for one. It answers `model` now,
    // so a `.step` here would assert the opposite of what ships.
    writeFileSync(join(dir, 'notes.txt'), 'PETG, 0.2mm')
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
    // **This used to be a `.step` file, and subsystem F is why it is not.** The fixture only has
    // to be a format `readMesh` has no arm for; `.step` was that until `parseStepFile` shipped,
    // at which point these same bytes — a bare `ISO-10303-21;` with no body — started reaching
    // OCCT, being refused by it, and leaving `failed` rather than `unsupported`. PLY is the
    // replacement for the same reason `.step` was chosen originally: a real mesh format that
    // nothing here parses, so the fixture is not a nonsense extension nobody would ever meet.
    writeFileSync(join(dir, 'part.ply'), 'ply\nformat ascii 1.0\nend_header\n')
    await rescan(lib, ctx)

    // `.ply` is not one of the extensions classifyFile calls a model, so this is forced: the
    // point is the handler's contract for a `model` job in a format it has no parser for. `null` (→
    // `unsupported`, never retried) is right and a throw (→ `failed`, against the retry
    // budget) is wrong, because re-reading the file will never make it readable.
    lib.db.prepare("UPDATE files SET kind = 'model' WHERE rel_path = 'part.ply'").run()

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

/** The kind classification actually gave each file, so a fixture drifting shows up here. */
function fileKinds(lib: Library): { relPath: string; kind: string }[] {
  const rows = lib.db
    .prepare('SELECT rel_path AS relPath, kind FROM files ORDER BY rel_path')
    .all() as { relPath: string; kind: string }[]
  // node:sqlite returns null-prototype rows, which deepEqual will not match a literal.
  return rows.map((row) => ({ relPath: row.relPath, kind: row.kind }))
}

test('a slicer project with no embedded thumbnail is rasterized rather than left unsupported', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    slicerProjectWithMesh(join(dir, 'unsliced.3mf'))
    await rescan(lib, ctx)

    // Pinned, because the whole point is the *slicer_project* path: if the fixture ever stopped
    // classifying as a project this test would silently become another `model` rasterizer test
    // and cover nothing new.
    assert.deepEqual(fileKinds(lib), [{ relPath: 'unsliced.3mf', kind: 'slicer_project' }])

    // 326 of the reference library's 374 projects look exactly like this. Before the handler
    // chain, EMBEDDED_HANDLER's `null` ended the job as `unsupported`, which is terminal — the
    // rows were permanently blank and no rescan would revisit them.
    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })

    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'ready')
    assert.equal(row.source, 'rasterized')
    assert.deepEqual(
      readPngSize(readFileSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`))),
      { width: 256, height: 256 },
    )
  })
})

test('a slicer project that has an embedded thumbnail still uses it, not the rasterizer', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // Geometry *and* a plate render, so both handlers could answer and only the order decides.
    // 311x233 is nothing the rasterizer can produce (it always writes 256x256), which is what
    // makes the size assertion below able to tell the two sources apart on the bytes alone.
    slicerProjectWithMesh(join(dir, 'sliced.3mf'), makePng(311, 233))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })

    const row = previewRows(lib)[0]!
    // Asserting `source`, not merely that a png exists: with the handler order inverted a png
    // would still be written and a file-exists check would stay green.
    assert.equal(row.source, 'embedded')
    assert.deepEqual({ width: row.width, height: row.height }, { width: 311, height: 233 })
    assert.deepEqual(
      readPngSize(readFileSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`))),
      { width: 311, height: 233 },
    )
  })
})

test('a slicer project whose model part holds no geometry fails, and is not silently unsupported', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // Every handler in the chain is out of answers, but for two different reasons: no embedded
    // thumbnail (`null`) and a model part with nothing in it (`AppError`). The throw has to win,
    // or a broken project becomes a permanent `unsupported` with no message to debug it from.
    bambuLineageProject(join(dir, 'empty.3mf'), ['X-BBL-Client-Type'])
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 0,
      failed: 1,
      unsupported: 0,
    })
    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'failed')
    assert.match(row.error!, /no triangles/)
  })
})

test('a model-kind 3MF with an embedded thumbnail uses it rather than being rasterized', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // `meshGeometry3mf` has no slicer metadata, so `classify3mf` calls it a plain `model` — the
    // same kind the 28 zip64 files in the reference library get. Before EMBEDDED_HANDLER covered
    // `model`, all 28 were rasterized to 256² while 16 of them carried a 512²/1024² picture that
    // nothing ever read. 311x233 is a size the rasterizer cannot produce, so the assertion below
    // can tell the two sources apart from the bytes alone.
    meshGeometry3mf(join(dir, 'plain.3mf'), makePng(311, 233))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })
    const row = previewRows(lib)[0]!
    assert.equal(row.source, 'embedded')
    assert.deepEqual({ width: row.width, height: row.height }, { width: 311, height: 233 })
  })
})

test('an stl still rasterizes: EMBEDDED_HANDLER covering model declines rather than claims', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    // The risk in widening EMBEDDED_HANDLER to `model`: a kind it cannot read must fall through,
    // not end the chain. An STL is not a zip at all, so `extractEmbeddedThumbnail` returns null
    // and the rasterizer behind it still gets the job.
    writeFileSync(join(dir, 'cube.stl'), binaryStl(cubeMesh()))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })
    const row = previewRows(lib)[0]!
    assert.equal(row.source, 'rasterized')
    assert.deepEqual({ width: row.width, height: row.height }, { width: 256, height: 256 })
  })
})

test('a model over the configured mesh ceiling fails with a message naming both sizes', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'cube.stl'), binaryStl(cubeMesh()))
    slicerProjectWithMesh(join(dir, 'project.3mf'))
    await rescan(lib, ctx)

    // Through `makePreviewHandlers`, not by calling a parser directly: what is being pinned is
    // that the operator's ceiling reaches the rasterizer at all, across the whole chain the
    // server builds. A ceiling of 1 byte refuses everything, which is the point -- the ceiling's
    // *value* is a deployment decision and belongs in the README, not in an assertion here.
    const handlers = makePreviewHandlers({ maxMeshBytes: 1 })
    assert.deepEqual(await runPreviewQueue(lib, { handlers }), {
      ready: 0,
      failed: 2,
      unsupported: 0,
    })

    for (const row of previewRows(lib)) {
      // `failed`, not `unsupported`: a refusal carries a reason, and `unsupported` writes
      // `error = NULL`, which would leave an operator with a blank thumbnail and nothing to read.
      assert.equal(row.state, 'failed')
      assert.match(row.error!, /needs .* MB .* more than the .* MB this server permits/)
    }
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
