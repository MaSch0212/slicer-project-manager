import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classify3mf,
  classifyFile,
  CLASSIFIER_VERSION,
  MODEL_EXTENSIONS,
  slicerFromSliceInfo,
} from '../src/files/classify.ts'
import { fileContentHash } from '../src/files/hash.ts'
import { findZipEntry, readZipEntries, readZipEntryText } from '../src/files/zip.ts'
import { assert, test } from './harness.ts'
import {
  bambuLineageProject,
  curaProject,
  plainMesh3mf,
  prusaProject,
  sliceInfo,
  unslicedBambuProject,
} from './fixtures/make-3mf.ts'

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-zip-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('the zip reader lists entries and inflates a deflated one', async () => {
  await withDir((dir) => {
    const path = join(dir, 'p.3mf')
    plainMesh3mf(path)
    const entries = readZipEntries(path)
    assert.deepEqual(entries.map((e) => e.name).sort(), ['3D/3dmodel.model', '[Content_Types].xml'])
    const model = findZipEntry(entries, '3D/3dmodel.model')!
    assert.equal(model.method, 8)
    assert.match(readZipEntryText(path, model), /^<\?xml/)
  })
})

test('the zip reader rejects a file that is not a zip', async () => {
  await withDir((dir) => {
    const path = join(dir, 'not.3mf')
    writeFileSync(path, 'just some text, definitely not a zip archive')
    assert.throws(() => readZipEntries(path))
  })
})

test('Cura is identified by its Cura/ prefix', async () => {
  await withDir((dir) => {
    const path = join(dir, 'benchy.3mf')
    curaProject(path)
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'cura' })
  })
})

test('PrusaSlicer is identified by Metadata/Slic3r_PE.config', async () => {
  await withDir((dir) => {
    const path = join(dir, 'bracket.3mf')
    prusaProject(path)
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'prusaslicer' })
  })
})

test('Anycubic is identified by its X-ACNext header item', async () => {
  await withDir((dir) => {
    const path = join(dir, 'ac.3mf')
    bambuLineageProject(path, ['X-ACNext-Client-Type', 'X-ACNext-Client-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'anycubic' })
  })
})

test('Bambu Studio is identified by X-BBL-Client-Type', async () => {
  await withDir((dir) => {
    const path = join(dir, 'bbl.3mf')
    bambuLineageProject(path, ['X-BBL-Client-Type', 'X-BBL-Client-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'bambu' })
  })
})

test('OrcaSlicer wins over Bambu even though it carries the X-BBL keys too', async () => {
  await withDir((dir) => {
    const path = join(dir, 'orca.3mf')
    // Orca's header is a superset of Bambu's; registry order is what separates them.
    bambuLineageProject(path, ['X-BBL-Client-Type', 'X-BBL-Client-Version', 'OrcaSlicer-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'orca' })
  })
})

test('an unsliced Bambu-lineage project is a slicer project of unknown slicer', async () => {
  await withDir((dir) => {
    const path = join(dir, 'unsliced.3mf')
    unslicedBambuProject(path)
    // Reported as null rather than guessed, so the UI falls back to the default slicer.
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: null })
  })
})

test('a slice_info.config with no known key yields a null slicer', async () => {
  assert.equal(slicerFromSliceInfo(sliceInfo(['X-Unknown-Client-Type'])), null)
})

test('the version value is never used as a discriminator', () => {
  // printer_model and version strings are traps (spec 3.4); only keys are matched.
  assert.equal(slicerFromSliceInfo(sliceInfo(['X-BBL-Client-Version'])), null)
})

test('a plain mesh 3MF is a model, not a slicer project', async () => {
  await withDir((dir) => {
    const path = join(dir, 'mesh.3mf')
    plainMesh3mf(path)
    assert.deepEqual(classify3mf(path), { kind: 'model', slicer: null })
  })
})

test('classifyFile routes by extension and falls back to other', async () => {
  await withDir((dir) => {
    for (const name of ['a.stl', 'b.STL', 'c.obj']) {
      writeFileSync(join(dir, name), 'solid x')
      assert.deepEqual(classifyFile(join(dir, name)), { kind: 'model', slicer: null })
    }
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    assert.deepEqual(classifyFile(join(dir, 'notes.txt')), { kind: 'other', slicer: null })

    const project = join(dir, 'x.3mf')
    curaProject(project)
    assert.deepEqual(classifyFile(project), { kind: 'slicer_project', slicer: 'cura' })
  })
})

/**
 * The two ways a `.3mf` fails to classify, which are the same answer and not the same failure.
 *
 * Both come back `other`, and for a long time that was the whole story. `rescan` now records which
 * version produced a row's `kind` and does not ask again until the bytes move, which splits them:
 * "we read the file and it is not a zip" is an answer worth recording, and "we could not open the
 * file" is a transient that must not be recorded as one. `unreadable` is the only thing here that
 * tells them apart, and `rescan`'s version-mismatch branch is what reads it.
 */
test('a 3MF that is not a zip answers other; one that cannot be opened says so', async () => {
  await withDir((dir) => {
    const corrupt = join(dir, 'corrupt.3mf')
    writeFileSync(corrupt, 'PK garbage')
    assert.deepEqual(classifyFile(corrupt), { kind: 'other', slicer: null })

    // Not a lock — no portable way to hold one from a test — but the identical failure at the
    // identical call: `openSync` rejects before a byte of content has been looked at.
    const gone = join(dir, 'gone.3mf')
    assert.deepEqual(classifyFile(gone), { kind: 'other', slicer: null, unreadable: true })
  })
})

test('fileContentHash is a stable 32-byte digest that follows content', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.stl')
    writeFileSync(path, 'solid one')
    const first = await fileContentHash(path)
    assert.equal(first.byteLength, 32)
    assert.deepEqual([...(await fileContentHash(path))], [...first])

    writeFileSync(path, 'solid two')
    assert.notDeepEqual([...(await fileContentHash(path))], [...first])
  })
})

/**
 * `classifyFile`'s complete answer set, paired with the version that produced it.
 *
 * **What breaks this test.** Changing what any extension classifies as, or adding one to
 * `MODEL_EXTENSIONS`, makes the computed table below differ from this literal. The only edit that
 * repairs it is one that touches `CLASSIFIER_VERSION` **in the same commit**, because `version`
 * sits inside the literal being edited — which is the whole mechanism. A forgotten bump ships a
 * classifier that answers differently with every existing row still marked as classified by it, so
 * `rescan` never re-asks the question and the change is invisible in the field.
 *
 * **`version: 1` here and `0 < CLASSIFIER_VERSION` in `db.test.ts` are not in conflict.** They are
 * opposite tests of the same constant, and both land in this commit. The migration test must
 * survive a bump — a backfill assertion pinned to today's value would go red for the wrong reason
 * and teach whoever bumped the constant to edit the test. This one exists to be broken by a bump:
 * going red *is* how the edit that changes an answer is forced to touch the version beside it.
 *
 * **What it cannot catch**, so nobody trusts it further than it goes:
 * - A change inside `classify3mf` that produces the same answers on the eight fixtures below.
 * - A branch added **outside** `MODEL_EXTENSIONS` — a new `.gcode`-shaped arm returning some other
 *   kind — which the enumeration does not reach and which therefore forces no row here.
 *
 * The snapshot pins the function's answers, not its reasoning, and nothing in this repository
 * measures which internal changes warrant a bump.
 */
const CLASSIFIER_SNAPSHOT = {
  version: 1,
  answers: {
    '.stl': 'model',
    '.obj': 'model',
    '.step': 'model',
    '.stp': 'model',
    '.3mf/cura': 'slicer_project',
    '.3mf/prusaslicer': 'slicer_project',
    '.3mf/orca': 'slicer_project',
    '.3mf/bambu': 'slicer_project',
    '.3mf/anycubic': 'slicer_project',
    '.3mf/unsliced': 'slicer_project',
    '.3mf/mesh': 'model',
    '.3mf/not-a-zip': 'other',
    '.gcode': 'other',
    '.txt': 'other',
  },
}

test('the classifier version and every answer it gives are frozen together', async () => {
  await withDir((dir) => {
    const answers: Record<string, string> = {}

    // Computed from MODEL_EXTENSIONS rather than hand-listed, and that is the point (decision 15).
    // A hand-written key set catches a *changed* answer and misses an *added* extension: `.ply`
    // added to MODEL_EXTENSIONS would change nothing already listed, force no new row, and leave
    // the version unbumped with the suite green. Iterating puts the new key into `answers`, where
    // the whole-object comparison below is what notices it.
    for (const ext of MODEL_EXTENSIONS) {
      const path = join(dir, `part${ext}`)
      writeFileSync(path, 'not read by classifyFile, which looks only at the name')
      answers[ext] = classifyFile(path).kind
    }

    const threeMf: [string, (path: string) => void][] = [
      ['cura', (path) => curaProject(path)],
      ['prusaslicer', (path) => prusaProject(path)],
      ['orca', (path) => bambuLineageProject(path, ['X-BBL-Client-Type', 'OrcaSlicer-Version'])],
      ['bambu', (path) => bambuLineageProject(path, ['X-BBL-Client-Type'])],
      ['anycubic', (path) => bambuLineageProject(path, ['X-ACNext-Client-Type'])],
      ['unsliced', (path) => unslicedBambuProject(path)],
      ['mesh', (path) => plainMesh3mf(path)],
      ['not-a-zip', (path) => writeFileSync(path, 'PK not really')],
    ]
    for (const [label, write] of threeMf) {
      const path = join(dir, `${label}.3mf`)
      write(path)
      answers[`.3mf/${label}`] = classifyFile(path).kind
    }

    for (const ext of ['.gcode', '.txt']) {
      const path = join(dir, `f${ext}`)
      writeFileSync(path, 'x')
      answers[ext] = classifyFile(path).kind
    }

    assert.deepEqual({ version: CLASSIFIER_VERSION, answers }, CLASSIFIER_SNAPSHOT)
  })
})
