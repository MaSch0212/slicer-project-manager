import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import { readZipEntries, readZipEntryBytes, type ZipEntry } from '../src/files/zip.ts'
import { crc32, rewriteZip } from '../src/files/zip-write.ts'
import { assert, test } from './harness.ts'
import { writeZip, type ZipInput } from './fixtures/make-3mf.ts'
import { patchZipHeaders, reverseCentralDirectory } from './fixtures/patch-zip.ts'

const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter"><resources/></model>'
const FLAG_ENCRYPTED = 1 << 0
const FLAG_DATA_DESCRIPTOR = 1 << 3
const FLAG_UTF8 = 1 << 11
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-zipwrite-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** Three entries: one stored, one deflated, one binary — and content types first. */
const SAMPLE: ZipInput[] = [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
  { name: 'Metadata/stored.txt', data: 'stored verbatim, no deflate' },
]

const reason = (code: string) => (error: unknown) =>
  (error as AppError).details?.['reason'] === code

/** The compressed bytes of one entry, straight out of the file, past its own local header. */
function compressedBytes(path: string, entry: ZipEntry): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path))
  const view = new DataView(bytes.buffer)
  const at =
    entry.localHeaderOffset +
    30 +
    view.getUint16(entry.localHeaderOffset + 26, true) +
    view.getUint16(entry.localHeaderOffset + 28, true)
  return bytes.slice(at, at + entry.compressedSize)
}

/** The local file header's own copy of the fields the central directory also carries. */
function localHeaderOf(path: string, entry: ZipEntry) {
  const bytes = new Uint8Array(readFileSync(path))
  const view = new DataView(bytes.buffer)
  const at = entry.localHeaderOffset
  return {
    flags: view.getUint16(at + 6, true),
    method: view.getUint16(at + 8, true),
    crc: view.getUint32(at + 14, true),
    compressedSize: view.getUint32(at + 18, true),
    uncompressedSize: view.getUint32(at + 22, true),
  }
}

function find(entries: ZipEntry[], name: string): ZipEntry {
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`no entry ${name}`)
  return entry
}

test('a zip64 input whose values fit produces a readable non-zip64 output', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // The shape the reference library's 28 zip64 files actually have: a saturated directory
    // offset and saturated per-entry sizes, over payloads of a few kilobytes.
    writeZip(input, SAMPLE, { end: true, saturateCdOffset: true, saturateEntries: true })
    const before = readZipEntries(input)
    assert.ok(new Uint8Array(readFileSync(input)).length > 0)

    rewriteZip(input, output)

    const after = readZipEntries(output)
    assert.deepEqual(
      after.map((e) => `${e.name} m${e.method} c${e.compressedSize} u${e.uncompressedSize}`),
      before.map((e) => `${e.name} m${e.method} c${e.compressedSize} u${e.uncompressedSize}`),
    )
    // Not merely "it parses": the zip64 records are gone from the bytes entirely.
    const bytes = new Uint8Array(readFileSync(output))
    const view = new DataView(bytes.buffer)
    for (let at = 0; at + 4 <= bytes.length; at++) {
      const signature = view.getUint32(at, true)
      assert.notEqual(signature, ZIP64_EOCD_SIG)
      assert.notEqual(signature, ZIP64_LOCATOR_SIG)
    }
    assert.equal(
      new TextDecoder().decode(readZipEntryBytes(output, find(after, '3D/3dmodel.model'))),
      MODEL_XML,
    )
  }))

test('surviving entries keep their compressed bytes verbatim, stored and deflated alike', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    rewriteZip(input, output, { drop: new Set(['[Content_Types].xml']) })

    const before = readZipEntries(input)
    const after = readZipEntries(output)
    for (const name of ['3D/3dmodel.model', 'Metadata/stored.txt']) {
      assert.deepEqual(
        [...compressedBytes(output, find(after, name))],
        [...compressedBytes(input, find(before, name))],
        name,
      )
      assert.deepEqual(
        [...readZipEntryBytes(output, find(after, name))],
        [...readZipEntryBytes(input, find(before, name))],
        name,
      )
    }
    assert.equal(find(after, '3D/3dmodel.model').method, 8)
    assert.equal(find(after, 'Metadata/stored.txt').method, 0)
  }))

test('[Content_Types].xml stays first even when the central directory disagrees with the file', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    reverseCentralDirectory(input)
    // The directory now lists content types last while it still lies first in the file. A
    // rewriter that emitted in the order it read would put it last and break OPC.
    assert.equal(readZipEntries(input)[0]?.name, 'Metadata/stored.txt')

    rewriteZip(input, output)

    const after = readZipEntries(output)
    assert.equal(after[0]?.name, '[Content_Types].xml')
    assert.equal(after[0]?.localHeaderOffset, 0)
    assert.deepEqual(
      after.map((entry) => entry.name),
      ['[Content_Types].xml', '3D/3dmodel.model', 'Metadata/stored.txt'],
    )
  }))

test('the data-descriptor bit is cleared, the UTF-8 bit survives, and the local header gets real sizes', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    // Bit 3 plus bit 11, and one more bit nobody names, to prove "every other bit is copied".
    const flags = FLAG_DATA_DESCRIPTOR | FLAG_UTF8 | (1 << 1)
    patchZipHeaders(input, ({ file, centralAt, localAt }) => {
      file.setUint16(centralAt + 8, flags, true)
      file.setUint16(localAt + 6, flags, true)
    })

    rewriteZip(input, output)

    for (const entry of readZipEntries(output)) {
      assert.equal(entry.flags, FLAG_UTF8 | (1 << 1), entry.name)
      const local = localHeaderOf(output, entry)
      assert.equal(local.flags, entry.flags, entry.name)
      assert.equal(local.crc, entry.crc, entry.name)
      assert.equal(local.compressedSize, entry.compressedSize, entry.name)
      assert.equal(local.uncompressedSize, entry.uncompressedSize, entry.name)
    }
  }))

test('an entry with the encryption bit set is refused and no output is left behind', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    patchZipHeaders(input, ({ name, file, centralAt, localAt }) => {
      if (name !== 'Metadata/stored.txt') return
      file.setUint16(centralAt + 8, FLAG_ENCRYPTED, true)
      file.setUint16(localAt + 6, FLAG_ENCRYPTED, true)
    })

    assert.throws(() => rewriteZip(input, output), reason('encrypted'))
    assert.equal(existsSync(output), false)
  }))

test('replacement bytes are stored, with a recomputed CRC-32 and fresh sizes', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    const replacement = new TextEncoder().encode('<Types><Default Extension="png"/></Types>')

    const result = rewriteZip(input, output, {
      replace: new Map([['[Content_Types].xml', replacement]]),
    })

    assert.deepEqual(result.replaced, ['[Content_Types].xml'])
    const entry = find(readZipEntries(output), '[Content_Types].xml')
    assert.equal(entry.method, 0)
    assert.equal(entry.compressedSize, replacement.length)
    assert.equal(entry.uncompressedSize, replacement.length)
    assert.equal(entry.crc, crc32(replacement))
    // The mistake this exists for: carrying the original CRC across produces a file most readers
    // still open. The two CRCs must actually differ, or the assertion above proves nothing.
    assert.notEqual(entry.crc, find(readZipEntries(input), '[Content_Types].xml').crc)
    assert.deepEqual([...readZipEntryBytes(output, entry)], [...replacement])
    assert.equal(localHeaderOf(output, entry).crc, crc32(replacement))
  }))

test('a deflated entry can be replaced, and the replacement is not left claiming method 8', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    const replacement = new TextEncoder().encode('<model/>')

    rewriteZip(input, output, { replace: new Map([['3D/3dmodel.model', replacement]]) })

    const entry = find(readZipEntries(output), '3D/3dmodel.model')
    assert.equal(entry.method, 0)
    assert.deepEqual([...readZipEntryBytes(output, entry)], [...replacement])
  }))

test('a replacement naming an entry the archive does not have is refused', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    assert.throws(
      () =>
        rewriteZip(input, output, { replace: new Map([['Metadata/typo.xml', new Uint8Array()]]) }),
      // Not `'unrepresentable'`: this is the call being incoherent, not the archive.
      reason('invalid-request'),
    )
    assert.equal(existsSync(output), false)
  }))

test('dropping names that are not in the archive is not an error', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)

    const result = rewriteZip(input, output, {
      drop: new Set(['Metadata/stored.txt', 'Metadata/never-existed.config']),
    })

    assert.deepEqual(result.dropped, ['Metadata/stored.txt'])
    assert.deepEqual(result.kept, ['[Content_Types].xml', '3D/3dmodel.model'])
    assert.deepEqual(
      readZipEntries(output).map((entry) => entry.name),
      ['[Content_Types].xml', '3D/3dmodel.model'],
    )
  }))

test('an empty archive round-trips rather than producing an unreadable file', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    rewriteZip(input, output, { drop: new Set(SAMPLE.map((entry) => entry.name)) })
    assert.deepEqual(readZipEntries(output), [])
  }))

test('the DOS timestamp and the attribute words survive the copy', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    patchZipHeaders(input, ({ file, centralAt, localAt }) => {
      file.setUint16(centralAt + 12, 0x4a2b, true)
      file.setUint16(centralAt + 14, 0x5d1c, true)
      file.setUint16(localAt + 10, 0x4a2b, true)
      file.setUint16(localAt + 12, 0x5d1c, true)
      file.setUint32(centralAt + 38, 0x81a40000, true)
    })

    rewriteZip(input, output)

    for (const entry of readZipEntries(output)) {
      assert.equal(entry.modTime, 0x4a2b, entry.name)
      assert.equal(entry.modDate, 0x5d1c, entry.name)
      assert.equal(entry.externalAttributes, 0x81a40000, entry.name)
    }
  }))

test('an entry larger than one copy chunk survives the copy intact', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // Past the rewriter's 1 MiB copy buffer, and stored rather than deflated so the *compressed*
    // bytes are what crosses several chunks. A mutation that wrote the whole buffer instead of
    // the last partial slice is invisible on any entry that fits in one chunk.
    const big = new Uint8Array(3 * (1 << 20) + 777)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    writeZip(input, [...SAMPLE, { name: 'Metadata/big.bin', data: big }])

    rewriteZip(input, output, { drop: new Set(['Metadata/stored.txt']) })

    const entry = find(readZipEntries(output), 'Metadata/big.bin')
    assert.equal(entry.uncompressedSize, big.length)
    assert.deepEqual([...readZipEntryBytes(output, entry)], [...big])
    assert.equal(entry.crc, crc32(big))
  }))

test('a size that genuinely does not fit a non-zip64 record is refused', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    // The archive is a few hundred bytes; the *declaration* is what does not fit. `0xffffffff`
    // is itself unrepresentable, being the sentinel that sends a reader to a zip64 record this
    // writer does not emit — so it is the cheapest value that proves the branch.
    writeZip(input, SAMPLE, { saturateEntries: true })
    patchZipHeaders(input, ({ name, file, centralAt }) => {
      if (name !== 'Metadata/stored.txt') return
      const extraAt = centralAt + 46 + file.getUint16(centralAt + 28, true)
      file.setBigUint64(extraAt + 4, BigInt(0xffffffff), true)
    })
    assert.equal(find(readZipEntries(input), 'Metadata/stored.txt').uncompressedSize, 0xffffffff)

    assert.throws(() => rewriteZip(input, output), reason('unrepresentable'))
    assert.equal(existsSync(output), false)
  }))

test('an entry whose sizes really do live in a data descriptor round-trips', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    const before = find(readZipEntries(input), '3D/3dmodel.model')
    // The genuine article, not just the flag: bit 3 set *and* the local header's CRC and both
    // sizes zeroed, which is what a streaming writer emits. A rewriter reading sizes from the
    // local header would pass the flag test and produce a zero-length entry here.
    patchZipHeaders(input, ({ file, centralAt, localAt }) => {
      file.setUint16(centralAt + 8, FLAG_DATA_DESCRIPTOR, true)
      file.setUint16(localAt + 6, FLAG_DATA_DESCRIPTOR, true)
      file.setUint32(localAt + 14, 0, true)
      file.setUint32(localAt + 18, 0, true)
      file.setUint32(localAt + 22, 0, true)
    })

    rewriteZip(input, output)

    const after = find(readZipEntries(output), '3D/3dmodel.model')
    assert.equal(after.flags, 0)
    assert.equal(after.crc, before.crc)
    assert.equal(after.compressedSize, before.compressedSize)
    assert.equal(after.uncompressedSize, before.uncompressedSize)
    assert.deepEqual(localHeaderOf(output, after), {
      flags: 0,
      method: before.method,
      crc: before.crc,
      compressedSize: before.compressedSize,
      uncompressedSize: before.uncompressedSize,
    })
    assert.equal(new TextDecoder().decode(readZipEntryBytes(output, after)), MODEL_XML)
  }))

test('a local header with no signature is refused as unreadable, and leaves nothing behind', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    // The central directory still parses, so this is caught during the copy, after the output
    // file has been created — which is the branch that has to unlink what it wrote.
    patchZipHeaders(input, ({ name, file, localAt }) => {
      if (name !== 'Metadata/stored.txt') return
      file.setUint32(localAt, 0x0badf00d, true)
    })

    assert.throws(() => rewriteZip(input, output), reason('unreadable'))
    assert.equal(existsSync(output), false)
  }))

test('an entry that runs off the end of the file is refused as unreadable', () =>
  withDir((dir) => {
    const input = join(dir, 'in.3mf')
    const output = join(dir, 'out.3mf')
    writeZip(input, SAMPLE)
    const beyond = readFileSync(input).length + 4096
    patchZipHeaders(input, ({ name, file, centralAt }) => {
      if (name !== 'Metadata/stored.txt') return
      file.setUint32(centralAt + 20, beyond, true)
    })

    assert.throws(() => rewriteZip(input, output), reason('unreadable'))
    assert.equal(existsSync(output), false)
  }))
