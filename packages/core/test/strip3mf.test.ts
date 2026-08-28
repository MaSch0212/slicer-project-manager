import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import { classify3mf } from '../src/files/classify.ts'
import { strip3mf, stripRefusalReason } from '../src/files/strip3mf.ts'
import {
  readZipEntries,
  readZipEntryBytes,
  readZipEntryText,
  type ZipEntry,
} from '../src/files/zip.ts'
import { crc32, rewriteZip } from '../src/files/zip-write.ts'
import { assert, test } from './harness.ts'
import { sliceInfo, writeZip } from './fixtures/make-3mf.ts'
import { patchZipHeaders } from './fixtures/patch-zip.ts'

const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter"><resources/></model>'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-strip-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
<Relationship Id="rel1" Target="Metadata/thumbnail.png" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
<Relationship Id="rel2" Target="/Metadata/custom_gcode_per_layer.xml" Type="http://example.invalid/gcode"/>
<Relationship Id="rel3" Target="http://example.invalid/elsewhere" TargetMode="External" Type="http://example.invalid/external"/>
</Relationships>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/Metadata/slice_info.config" ContentType="application/xml"/>
</Types>`

/**
 * A Bambu-lineage project carrying **all five** entries of the strip set, plus the two kinds of
 * part that can name another part, plus every flavour of artwork the strip must keep.
 */
function bambuAllFive(path: string): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/slice_info.config', data: sliceInfo(['X-BBL-Client-Type']) },
    { name: 'Metadata/project_settings.config', data: '{"version":"02.08.02.61"}', deflate: true },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
    { name: 'Metadata/custom_gcode_per_layer.xml', data: '<custom_gcodes/>' },
    { name: 'Metadata/cut_information.xml', data: '<objects/>' },
    { name: 'Metadata/plate_1.png', data: PNG },
    { name: 'Metadata/pick_1.png', data: PNG },
    { name: 'Metadata/top_1.png', data: PNG },
    { name: 'Metadata/thumbnail.png', data: PNG },
  ])
}

const BAMBU_SET = [
  'Metadata/slice_info.config',
  'Metadata/project_settings.config',
  'Metadata/model_settings.config',
  'Metadata/custom_gcode_per_layer.xml',
  'Metadata/cut_information.xml',
]

function names(path: string): string[] {
  return readZipEntries(path).map((entry) => entry.name)
}

function find(path: string, name: string): ZipEntry {
  const entry = readZipEntries(path).find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`no entry ${name}`)
  return entry
}

const reason = (code: string) => (error: unknown) => stripRefusalReason(error) === code

test('a fully stripped Bambu-lineage project classifies model, and keeps every thumbnail', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    bambuAllFive(input)
    assert.deepEqual(classify3mf(input), { kind: 'slicer_project', slicer: 'bambu' })

    const result = strip3mf(input, output)

    assert.equal(result.stripped, true)
    assert.deepEqual(result.removed, BAMBU_SET)
    // The assertion row 17 exists for: `model`, and never `slicer_project` with `slicer: null`.
    assert.deepEqual(classify3mf(output), { kind: 'model', slicer: null })
    assert.deepEqual(names(output), [
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/plate_1.png',
      'Metadata/pick_1.png',
      'Metadata/top_1.png',
      'Metadata/thumbnail.png',
    ])
    for (const art of ['plate_1', 'pick_1', 'top_1', 'thumbnail']) {
      assert.deepEqual(
        [...readZipEntryBytes(output, find(output, `Metadata/${art}.png`))],
        [...PNG],
      )
    }
  }))

test('the half-strip this refuses to do is what produces an unattributable project', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const half = join(dir, 'half.3mf')
    bambuAllFive(input)
    // Not a call to strip3mf: this drives the rewriter directly to build the file the
    // all-or-nothing rule exists to prevent, so the classification assertion above has teeth.
    rewriteZip(input, half, { drop: new Set(['Metadata/slice_info.config']) })
    assert.deepEqual(classify3mf(half), { kind: 'slicer_project', slicer: null })
  }))

test('[Content_Types].xml is still first, and its Override for a removed part is gone', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    bambuAllFive(input)

    const result = strip3mf(input, output)

    assert.equal(names(output)[0], '[Content_Types].xml')
    assert.ok(result.rewritten.includes('[Content_Types].xml'))
    const types = readZipEntryText(output, find(output, '[Content_Types].xml'))
    assert.equal(types.includes('slice_info.config'), false)
    assert.ok(types.includes('Extension="png"'))
    assert.ok(types.includes('Extension="model"'))
  }))

test('a _rels part that referenced a removed target no longer does, and its CRC-32 matches', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    bambuAllFive(input)

    const result = strip3mf(input, output)

    assert.ok(result.rewritten.includes('_rels/.rels'))
    const entry = find(output, '_rels/.rels')
    const rels = readZipEntryText(output, entry)
    assert.equal(rels.includes('custom_gcode_per_layer.xml'), false)
    assert.ok(rels.includes('/3D/3dmodel.model'))
    assert.ok(rels.includes('Metadata/thumbnail.png'))
    // An external relationship names a URI, not a part; it must survive untouched.
    assert.ok(rels.includes('http://example.invalid/elsewhere'))
    // The easy mistake is carrying the original CRC across a rewritten part: an archive most
    // readers still open, until one does not.
    assert.equal(entry.crc, crc32(readZipEntryBytes(output, entry)))
    assert.equal(entry.method, 0)
    assert.equal(entry.uncompressedSize, readZipEntryBytes(output, entry).length)
  }))

test('surviving entries are byte-identical, decompressed and as stored compressed bytes', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    bambuAllFive(input)
    const source = new Uint8Array(readFileSync(input))

    strip3mf(input, output)

    const copy = new Uint8Array(readFileSync(output))
    // One deflated part and one stored part, which is the pair the "no recompression" rule is
    // about: a decompress/recompress round trip would keep the first column and break the second.
    for (const name of ['3D/3dmodel.model', 'Metadata/plate_1.png']) {
      const before = find(input, name)
      const after = find(output, name)
      assert.equal(after.method, before.method, name)
      assert.deepEqual(
        [...readZipEntryBytes(output, after)],
        [...readZipEntryBytes(input, before)],
        name,
      )
      assert.deepEqual([...slice(copy, after)], [...slice(source, before)], name)
    }
    assert.equal(find(output, '3D/3dmodel.model').method, 8)
    assert.equal(find(output, 'Metadata/plate_1.png').method, 0)
  }))

test('a Cura project loses every Cura/ entry and keeps its thumbnail', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, [
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
      { name: 'Cura/plugin_metadata.json', data: '{}' },
      { name: 'Cura/preferences.cfg', data: '[general]' },
      { name: 'Cura/nested/deep.cfg', data: 'x' },
      { name: 'Metadata/thumbnail.png', data: PNG },
    ])

    const result = strip3mf(input, output)

    assert.deepEqual(result.removed, [
      'Cura/plugin_metadata.json',
      'Cura/preferences.cfg',
      'Cura/nested/deep.cfg',
    ])
    assert.deepEqual(classify3mf(output), { kind: 'model', slicer: null })
    assert.deepEqual(names(output), [
      '[Content_Types].xml',
      '3D/3dmodel.model',
      'Metadata/thumbnail.png',
    ])
  }))

test('a PrusaSlicer project loses both Slic3r_PE parts', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, [
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
      { name: 'Metadata/Slic3r_PE.config', data: '; generated by PrusaSlicer' },
      { name: 'Metadata/Slic3r_PE_model.config', data: '<config/>' },
      { name: 'Metadata/Prusa_Slicer_wipe_tower_information.xml', data: '<wipe/>' },
      { name: 'Metadata/thumbnail.png', data: PNG },
    ])

    const result = strip3mf(input, output)

    assert.deepEqual(result.removed, [
      'Metadata/Slic3r_PE.config',
      'Metadata/Slic3r_PE_model.config',
    ])
    assert.deepEqual(classify3mf(output), { kind: 'model', slicer: null })
    assert.ok(names(output).includes('Metadata/Prusa_Slicer_wipe_tower_information.xml'))
  }))

test('a project saved but never sliced gets the Bambu-lineage set', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, [
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
      { name: 'Metadata/project_settings.config', data: '{"version":"02.06.00.51"}' },
      { name: 'Metadata/model_settings.config', data: '<config/>' },
    ])
    assert.deepEqual(classify3mf(input), { kind: 'slicer_project', slicer: null })

    const result = strip3mf(input, output)

    assert.deepEqual(result.classification, { kind: 'slicer_project', slicer: null })
    assert.deepEqual(classify3mf(output), { kind: 'model', slicer: null })
    assert.deepEqual(names(output), ['3D/3dmodel.model'])
  }))

test('a file carrying two flavours is refused rather than half-stripped', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // The measured cross-slicer artefact, in miniature: `classify3mf` is first-match-wins, so this
    // is `cura`, gets the Cura set, and comes out `prusaslicer`.
    writeZip(input, [
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
      { name: 'Cura/preferences.cfg', data: '[general]' },
      { name: 'Metadata/Slic3r_PE.config', data: '; generated by PrusaSlicer' },
    ])
    assert.deepEqual(classify3mf(input), { kind: 'slicer_project', slicer: 'cura' })

    assert.throws(() => strip3mf(input, output), reason('configuration-left-behind'))
    assert.equal(existsSync(output), false)
  }))

test('a model-kind 3MF is copied byte-for-byte and reports that nothing was stripped', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, [
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    ])

    const result = strip3mf(input, output)

    assert.equal(result.stripped, false)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.rewritten, [])
    assert.deepEqual(
      [...new Uint8Array(readFileSync(output))],
      [...new Uint8Array(readFileSync(input))],
    )
  }))

test('a .3mf that is not a readable zip is refused as unreadable', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeFileSync(input, 'not a zip at all, just some bytes')

    assert.throws(() => strip3mf(input, output), reason('unreadable'))
    assert.equal(existsSync(output), false)
  }))

test('an encrypted entry is refused as encrypted, not as something else', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    bambuAllFive(input)
    patchZipHeaders(input, ({ name, file, centralAt, localAt }) => {
      if (name !== '3D/3dmodel.model') return
      file.setUint16(centralAt + 8, 1, true)
      file.setUint16(localAt + 6, 1, true)
    })

    assert.throws(() => strip3mf(input, output), reason('encrypted'))
    assert.equal(existsSync(output), false)
  }))

test('stripping a file onto itself is refused rather than destroying it', () =>
  withDir((dir) => {
    const path = join(dir, 'in.3mf')
    bambuAllFive(path)
    const before = new Uint8Array(readFileSync(path))

    assert.throws(() => strip3mf(path, path), reason('unreadable'))
    assert.deepEqual([...new Uint8Array(readFileSync(path))], [...before])
  }))

test('stripRefusalReason ignores anything that is not one of the three', () => {
  assert.equal(stripRefusalReason(new Error('nope')), null)
  assert.equal(stripRefusalReason({ details: { reason: 'encrypted' } }), null)
})

test('the refusal is an AppError the boundary can carry', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    writeFileSync(input, 'not a zip')
    try {
      strip3mf(input, join(dir, 'out.3mf'))
      assert.fail('expected a refusal')
    } catch (error) {
      assert.equal((error as AppError).name, 'AppError')
      assert.equal((error as AppError).code, 'Validation')
    }
  }))

/** The compressed payload of one entry, straight out of the archive's bytes. */
function slice(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at =
    entry.localHeaderOffset +
    30 +
    view.getUint16(entry.localHeaderOffset + 26, true) +
    view.getUint16(entry.localHeaderOffset + 28, true)
  return bytes.slice(at, at + entry.compressedSize)
}

/** A Bambu-lineage project whose `_rels/.rels` is exactly the given text. */
function withRels(path: string, rels: string): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: '_rels/.rels', data: rels },
    { name: 'Metadata/slice_info.config', data: sliceInfo(['X-BBL-Client-Type']) },
    { name: 'Metadata/custom_gcode_per_layer.xml', data: '<custom_gcodes/>' },
  ])
}

const GONE = '/Metadata/custom_gcode_per_layer.xml'

test('a relationship element is repaired whatever legal shape it is written in', () =>
  withDir((dir) => {
    const shapes: Record<string, string> = {
      // Attribute order, quoting, the paired form, a comment in the way, a percent-encoded
      // target, and a namespace prefix — all legal OPC, none of them what the measured files use.
      reordered: `<Relationships><Relationship Type="t" Target="${GONE}" Id="a"/></Relationships>`,
      singleQuoted: `<Relationships><Relationship Id='a' Target='${GONE}' Type='t'/></Relationships>`,
      paired: `<Relationships><Relationship Id="a" Target="${GONE}" Type="t"></Relationship></Relationships>`,
      commented: `<Relationships><!-- note --><Relationship Id="a" Target="${GONE}" Type="t"/></Relationships>`,
      encoded: `<Relationships><Relationship Id="a" Target="/Metadata/custom_gcode_per_layer%2Exml" Type="t"/></Relationships>`,
      prefixed: `<r:Relationships xmlns:r="u"><r:Relationship Id="a" Target="${GONE}" Type="t"/></r:Relationships>`,
    }
    for (const [label, rels] of Object.entries(shapes)) {
      const input = join(dir, `${label}.3mf`)
      const output = join(dir, `${label}-out.3mf`)
      withRels(input, rels)

      const result = strip3mf(input, output)

      assert.deepEqual(result.rewritten, ['_rels/.rels'], label)
      assert.equal(
        readZipEntryText(output, find(output, '_rels/.rels')).includes('custom_gcode_per_layer'),
        false,
        label,
      )
    }
  }))

test('a reference the element patterns cannot match is refused, not shipped dangling', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // `>` inside an attribute value defeats `[^>]*?`, so the element is never matched and the
    // relationship survives. Before the outcome check this returned success with `rewritten: []`
    // and an archive naming a part that was gone — no edit, and no signal either.
    withRels(
      input,
      `<Relationships><Relationship Id="a>b" Target="${GONE}" Type="t"/></Relationships>`,
    )

    assert.throws(() => strip3mf(input, output), reason('configuration-left-behind'))
    assert.equal(existsSync(output), false)
  }))

test('the outcome check does not fire on references to parts that survived', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // The same unmatchable shape, but naming a part that is still there. A check that merely
    // looked for "an attribute the patterns missed" would refuse this too.
    withRels(
      input,
      `<Relationships><Relationship Id="a>b" Target="/3D/3dmodel.model" Type="t"/></Relationships>`,
    )

    const result = strip3mf(input, output)

    assert.deepEqual(result.rewritten, [])
    assert.ok(readZipEntryText(output, find(output, '_rels/.rels')).includes('/3D/3dmodel.model'))
  }))
