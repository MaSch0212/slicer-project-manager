import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify3mf, classifyFile, slicerFromSliceInfo } from '../src/files/classify.ts'
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

test('an unreadable 3MF classifies as other rather than throwing', async () => {
  await withDir((dir) => {
    const path = join(dir, 'corrupt.3mf')
    writeFileSync(path, 'PK garbage')
    assert.deepEqual(classifyFile(path), { kind: 'other', slicer: null })
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
