import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { PREVIEW_HANDLERS } from '../src/previews/handlers.ts'
import { makeMeshHandler } from '../src/previews/mesh-handler.ts'
import { makeOcctLoader, parseStepFile } from '../src/previews/mesh/step.ts'
import { runPreviewQueue, type PreviewJob } from '../src/previews/queue.ts'
import { rescan } from '../src/projects/rescan.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { stepFixturePath, writeStepFixture } from './fixtures/make-step.ts'

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

function seedProjectDir(lib: Library): { ctx: Ctx; dir: string } {
  const ctx = seedUser(lib)
  const dir = join(lib.dir, 'marc', 'Cube')
  mkdirSync(dir, { recursive: true })
  return { ctx, dir }
}

type PreviewRow = { state: string; source: string | null; error: string | null }

function previewRows(lib: Library): PreviewRow[] {
  return lib.db
    .prepare(
      `SELECT pv.state, pv.source, pv.error
       FROM previews pv JOIN files f ON f.id = pv.file_id ORDER BY f.rel_path`,
    )
    .all() as PreviewRow[]
}

/**
 * Makes this library's STEP files reachable by the queue, which `classifyFile` does not yet do.
 *
 * This task lands inert on purpose: `.step` and `.stp` still classify as `other`, so `rescan`
 * writes a `files` row of that kind and `claimPendingPreviews` — which offers a job only to a
 * handler claiming its kind — never hands it to anybody. The `previews` row itself already exists
 * and is `pending`, because `rescan` queues one for every file it sees whatever the kind.
 *
 * So the single column task 4 will change is the single column this changes, and it changes it
 * *after* `rescan` rather than by hand-building a `files` row: the id, the relative path, the size
 * and the content hash all stay the production writer's. Task 4's end-to-end bullet is what closes
 * the remaining gap, and it is the reason the assertions below are not sufficient on their own.
 */
function promoteStepFilesToModels(lib: Library): void {
  lib.db
    .prepare(
      "UPDATE files SET kind = 'model' WHERE rel_path LIKE '%.step' OR rel_path LIKE '%.stp'",
    )
    .run()
}

function job(absPath: string): PreviewJob {
  return { fileId: newId(), absPath, kind: 'model', contentHash: null, claimedAt: Date.now() }
}

/** A plausible file that is not a STEP file. Nothing here ever needs to parse it. */
const NOT_STEP = 'solid cube\nfacet normal 0 0 0\nendsolid cube\n'

test('the cube fixture parses to the mesh these numbers were measured on', async () => {
  // 8 247 bytes is an identity check on the file rather than a property of STEP: it says the
  // fixture under test is the one the counts below were measured on. `occt-import-js` is pinned to
  // an exact version with a committed `deno.lock`, so a change here means the package moved.
  assert.equal(statSync(stepFixturePath()).size, 8247)

  const mesh = await parseStepFile(stepFixturePath())
  // 12 is a WEAK swap-canary and should not be read as a strong one. Twelve triangles is what any
  // correct tessellation of a box returns, from any kernel at any tolerance, so it would survive
  // the library being swapped for a different one. The reference library's 3 380 and 20 530 are
  // numbers only this build produces; they stay in the spike because they need `D:\SPM Library`,
  // which CI has not got. What pins the build here is the exact version plus the committed lock.
  assert.equal(mesh.triangleCount, 12)
  // 108 floats = 12 triangles x 9, and the check that matters is the de-indexing. OCCT returns 72
  // floats over 24 shared vertices plus an index table; a `positions` of 72 would mean the index
  // was ignored and the rasterizer was handed a quarter of a box.
  assert.equal(mesh.positions.length, 108)
})

test('a .stp whose first bytes are not ISO-10303-21; is refused, and the real one is not', async () => {
  await withLibrary(async (lib) => {
    const { dir } = seedProjectDir(lib)
    const decoy = join(dir, 'not-really.stp')
    writeFileSync(decoy, NOT_STEP)

    const thrown = await parseStepFile(decoy).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(thrown instanceof AppError)
    assert.equal(thrown.code, 'Validation')
    assert.match(thrown.message, /ISO-10303-21;/)
    // Thirteen bytes, Latin-1, with the newline shown as a dot — the operator's next question
    // after "not a STEP file" is always "then what is it".
    assert.equal((thrown.details as { found: string }).found, 'solid cube.fa')

    // The other half, and what makes the assertion above worth having: a `parseStepFile` that
    // threw unconditionally would satisfy everything up to here exactly as well.
    assert.equal((await parseStepFile(stepFixturePath())).triangleCount, 12)
  })
})

test('leading whitespace before the magic is tolerated', async () => {
  await withLibrary(async (lib) => {
    const { dir } = seedProjectDir(lib)
    // Insurance rather than a measured need: all ten STEP files in the reference library carry
    // the sequence at offset 0, with no BOM and nothing in front of it. The tolerance is here
    // because it costs four byte comparisons, and the alternative is refusing a file OCCT reads.
    const original = readFileSync(stepFixturePath())
    const padded = new Uint8Array(4 + original.length)
    padded.set(new TextEncoder().encode('\r\n\t '), 0)
    padded.set(original, 4)
    const path = join(dir, 'padded.stp')
    writeFileSync(path, padded)

    assert.equal((await parseStepFile(path)).triangleCount, 12)
  })
})

test('a STEP file OCCT cannot read fails rather than going quietly unsupported', async () => {
  await withLibrary(async (lib) => {
    const { dir } = seedProjectDir(lib)
    // A real header with the body cut off: it passes the magic guard, and OCCT then refuses it.
    // OCCT writes its own parse diagnostic to stderr while this test runs. That noise is the
    // library's own and there is no way to silence it that does not also wrap the real factory.
    const truncated = join(dir, 'truncated.stp')
    writeFileSync(truncated, readFileSync(stepFixturePath()).subarray(0, 200))

    const thrown = await parseStepFile(truncated).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(thrown instanceof AppError)
    assert.equal(thrown.code, 'Validation')
  })
})

test('the mesh handler throws for a broken .stp where it still returns null for .txt', async () => {
  await withLibrary(async (lib) => {
    const { dir } = seedProjectDir(lib)
    const handler = makeMeshHandler()

    // Both spellings, because the arm carries two case labels and one of them would otherwise be
    // a claim rather than a test.
    for (const name of ['cube.step', 'cube.stp']) {
      const output = await handler.run(job(writeStepFixture(dir, name)))
      assert.equal(output?.source, 'rasterized')
    }

    const broken = join(dir, 'broken.stp')
    writeFileSync(broken, NOT_STEP)
    await assert.rejects(() => handler.run(job(broken)), AppError)

    // The contrast is the assertion. `null` is a terminal, message-less `unsupported` row, and a
    // later tidy-up that turned the throw above into one would blank every unreadable STEP file in
    // a library for good — the queue re-claims only `pending`, and only a content-hash change
    // re-queues. Pinning both outcomes in one test is what makes that change go red.
    const notAMesh = join(dir, 'notes.txt')
    writeFileSync(notAMesh, 'nothing to render here')
    assert.equal(await handler.run(job(notAMesh)), null)
  })
})

test('a not-really-STEP .stp leaves a failed row carrying the reason', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeFileSync(join(dir, 'not-really.stp'), NOT_STEP)
    await rescan(lib, ctx)
    promoteStepFilesToModels(lib)

    assert.deepEqual(await runPreviewQueue(lib, { handlers: PREVIEW_HANDLERS }), {
      ready: 0,
      failed: 1,
      unsupported: 0,
    })

    // The row is what ships, and an exception is only how it gets there. `unsupported` would be
    // indistinguishable from a file there was never anything to draw from: same blank thumbnail,
    // and `error = NULL` where this has to carry the reason.
    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'failed')
    assert.match(row.error ?? '', /ISO-10303-21;/)
  })
})

test('a .step file through the real handler chain ends ready, not unsupported', async () => {
  await withLibrary(async (lib) => {
    const { ctx, dir } = seedProjectDir(lib)
    writeStepFixture(dir, 'cube.step')
    await rescan(lib, ctx)
    promoteStepFilesToModels(lib)

    // Through `PREVIEW_HANDLERS`, not a local array spelling out the same two handlers.
    // `EMBEDDED_HANDLER_WITH_MODELS` is first and claims `model`, so it sees this job before the
    // rasterizer does; it returns `null` for anything that is not a readable zip, which means
    // "ask the next one". If it ever stopped doing so, every STEP file in a library would end
    // `unsupported`, which is terminal. That is the outcome that cost 326 projects, so it is
    // pinned here rather than reasoned about.
    assert.deepEqual(await runPreviewQueue(lib, { handlers: PREVIEW_HANDLERS }), {
      ready: 1,
      failed: 0,
      unsupported: 0,
    })
    const row = previewRows(lib)[0]!
    assert.equal(row.state, 'ready')
    assert.equal(row.source, 'rasterized')
  })
})

test('makeOcctLoader builds the module once, however often it is asked', async () => {
  let calls = 0
  const load = makeOcctLoader(() => {
    calls++
    return Promise.resolve({ ReadStepFile: () => ({ success: false }) })
  })

  await load()
  await load()
  assert.equal(calls, 1)
})

test('makeOcctLoader never caches a rejection', async () => {
  let calls = 0
  const load = makeOcctLoader(() => {
    calls++
    return calls === 1
      ? Promise.reject(new Error('wasm did not start'))
      : Promise.resolve({ ReadStepFile: () => ({ success: false }) })
  })

  await assert.rejects(load, /wasm did not start/)
  // The half that matters. A cached rejection turns one bad start — a `.wasm` not yet staged, a
  // machine momentarily out of address space — into every STEP file in the process `failed` for
  // as long as it runs, and nothing else in this suite would notice.
  assert.ok(await load())
  assert.equal(calls, 2)
})
