import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import { classify3mf } from '../src/files/classify.ts'
import {
  DEFAULT_ZIP_CHUNK_BYTES,
  findZipEntry,
  openZip,
  readZipEntries,
  readZipEntryBytes,
  readZipEntryChunks,
  readZipEntryText,
  type ZipEntry,
} from '../src/files/zip.ts'
import { assert, test } from './harness.ts'
import { concatBytes, writeZip, type Zip64Options } from './fixtures/make-3mf.ts'

const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-zip64-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter"><resources/></model>'

/** A payload that deflates well and is far larger than one inflater output chunk. */
function bigXml(): string {
  const rows: string[] = ['<?xml version="1.0"?><model><resources><mesh><vertices>']
  for (let i = 0; i < 60_000; i++) {
    rows.push(`<vertex x="${i}.5" y="${-i}.25" z="${(i % 97) / 8}"/>`)
  }
  rows.push('</vertices></mesh></resources></model>')
  return rows.join('')
}

/** The three-entry archive every case below varies, written with the given zip64 shape. */
function writeSample(path: string, zip64?: Zip64Options, payload = MODEL_XML): void {
  writeZip(
    path,
    [
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: '3D/3dmodel.model', data: payload, deflate: true },
      { name: 'Metadata/stored.txt', data: 'stored verbatim, no deflate' },
    ],
    zip64,
  )
}

function collect(entries: ZipEntry[]): string[] {
  return entries.map((e) => `${e.name} m${e.method} c${e.compressedSize} u${e.uncompressedSize}`)
}

async function drain(
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ bytes: Uint8Array; maxChunk: number; count: number }> {
  const parts: Uint8Array[] = []
  let maxChunk = 0
  for await (const chunk of chunks) {
    // Copied, not kept: a chunk may be a view into a buffer the inflater still owns, and this
    // helper concatenates them long after the stream has moved on.
    parts.push(chunk.slice())
    if (chunk.byteLength > maxChunk) maxChunk = chunk.byteLength
  }
  return { bytes: concatBytes(parts), maxChunk, count: parts.length }
}

/** Overwrites `length` bytes at `at`, or splices them out when `replacement` is empty. */
function patchFile(path: string, at: number, length: number, replacement: Uint8Array): void {
  const bytes = new Uint8Array(readFileSync(path))
  writeFileSync(
    path,
    concatBytes([bytes.subarray(0, at), replacement, bytes.subarray(at + length)]),
  )
}

function findSignature(path: string, signature: number): number {
  const bytes = new Uint8Array(readFileSync(path))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = bytes.length - 4; i >= 0; i--) if (view.getUint32(i, true) === signature) return i
  throw new Error(`signature ${signature.toString(16)} not found in ${path}`)
}

const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

// ---------------------------------------------------------------------------------------------
// zip64
// ---------------------------------------------------------------------------------------------

test('a zip64 archive reads exactly like the same archive written 32-bit', async () => {
  await withDir((dir) => {
    const plain = join(dir, 'plain.3mf')
    const zip64 = join(dir, 'zip64.3mf')
    writeSample(plain)
    // The shape the 28 zip64 files in the reference library have: a saturated directory offset
    // and saturated per-entry sizes, beside a real 16-bit entry count and 32-bit directory size.
    writeSample(zip64, { end: true, saturateCdOffset: true, saturateEntries: true })

    assert.deepEqual(collect(readZipEntries(zip64)), collect(readZipEntries(plain)))
    const model = findZipEntry(readZipEntries(zip64), '3D/3dmodel.model')!
    assert.equal(readZipEntryText(zip64, model), MODEL_XML)
    const stored = findZipEntry(readZipEntries(zip64), 'Metadata/stored.txt')!
    assert.equal(readZipEntryText(zip64, stored), 'stored verbatim, no deflate')
  })
})

test('a zip64 3MF classifies as the model it is, not as "other"', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    // Before zip64 support these 28 real files threw out of readZipEntries, and classify3mf's
    // catch-all turned every one of them into kind 'other' — invisible to the preview queue.
    assert.deepEqual(classify3mf(path), { kind: 'model', slicer: null })
  })
})

test('a saturated entry count and directory size are taken from the zip64 record', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, {
      end: true,
      saturateTotal: true,
      saturateCdSize: true,
      saturateCdOffset: true,
      saturateEntries: true,
    })
    assert.equal(readZipEntries(path).length, 3)
  })
})

test('the zip64 record is ignored where the base record is not saturated', async () => {
  await withDir((dir) => {
    const plain = join(dir, 'plain.3mf')
    const path = join(dir, 'redundant.3mf')
    writeSample(plain)
    // A zip64 end record and locator, but every base field small enough to be honest — and then
    // the record poisoned, so a reader that consults it unconditionally cannot get this right.
    writeSample(path, { end: true })
    const record = findSignature(path, ZIP64_EOCD_SIG)
    const poison = new Uint8Array(24)
    new DataView(poison.buffer).setBigUint64(0, 999n, true) // entry count
    new DataView(poison.buffer).setBigUint64(8, 7n, true) // directory size
    new DataView(poison.buffer).setBigUint64(16, 4n, true) // directory offset
    patchFile(path, record + 32, 24, poison)

    assert.deepEqual(collect(readZipEntries(path)), collect(readZipEntries(plain)))
  })
})

test('entering the zip64 record does not make its unsaturated fields authoritative', async () => {
  await withDir((dir) => {
    const plain = join(dir, 'plain.3mf')
    const path = join(dir, 'partial.3mf')
    writeSample(plain)
    // Only the directory offset is saturated, so only the offset may be taken from the record —
    // even though the reader is now inside the zip64 branch and has the other two in its hand.
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    const record = findSignature(path, ZIP64_EOCD_SIG)
    const poison = new Uint8Array(16)
    new DataView(poison.buffer).setBigUint64(0, 999n, true) // entry count
    new DataView(poison.buffer).setBigUint64(8, 7n, true) // directory size
    patchFile(path, record + 32, 16, poison)

    assert.deepEqual(collect(readZipEntries(path)), collect(readZipEntries(plain)))
  })
})

test('a zip64 locator whose signature is wrong is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    const locator = findSignature(path, ZIP64_LOCATOR_SIG)
    // Everything else about the archive stays valid, so only the signature check can catch this;
    // the 8 bytes at locator+8 still hold the record's true offset.
    patchFile(path, locator, 4, new Uint8Array([0x50, 0x4b, 0x09, 0x09]))
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('a zip64 extra field is read positionally against the base record, not from the front', async () => {
  await withDir((dir) => {
    const plain = join(dir, 'plain.3mf')
    const path = join(dir, 'offset-only.3mf')
    writeSample(plain)
    // Only the local header offset is saturated, so the extra field's single 64-bit word is the
    // offset. A reader that takes words in fixed order without checking the base record reads it
    // as the uncompressed size and then reads the sizes as garbage.
    writeSample(path, { end: true, saturateEntryOffsetOnly: true })
    assert.deepEqual(collect(readZipEntries(path)), collect(readZipEntries(plain)))
    const model = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    assert.equal(readZipEntryText(path, model), MODEL_XML)
  })
})

test('a zip64 archive whose locator has been spliced out is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    const locator = findSignature(path, ZIP64_LOCATOR_SIG)
    patchFile(path, locator, 20, new Uint8Array(0))
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('a zip64 locator pointing past the end of the file is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    const locator = findSignature(path, ZIP64_LOCATOR_SIG)
    const far = new Uint8Array(8)
    new DataView(far.buffer).setBigUint64(0, 1n << 40n, true)
    patchFile(path, locator + 8, 8, far)
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('a zip64 record with the wrong signature is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true })
    const record = findSignature(path, ZIP64_EOCD_SIG)
    patchFile(path, record, 4, new Uint8Array([0, 0, 0, 0]))
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('a zip64 size past Number.MAX_SAFE_INTEGER is a Validation error, not a rounded offset', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    // One stored entry, so the only 0x02014b50 in the file is the central-directory header.
    writeZip(path, [{ name: 'a.txt', data: 'hello' }], {
      end: true,
      saturateCdOffset: true,
      saturateEntries: true,
    })
    const at = findSignature(path, 0x02014b50)
    const bytes = new Uint8Array(readFileSync(path))
    const nameLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      at + 28,
      true,
    )
    // The extra field's first word is the uncompressed size, because that is the first field the
    // base record saturated.
    const huge = new Uint8Array(8)
    new DataView(huge.buffer).setBigUint64(0, (1n << 62n) + 1n, true)
    patchFile(path, at + 46 + nameLength + 4, 8, huge)
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('an entry that says zip64 but carries no extra field is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    // saturateEntries writes the sentinels; end:false and no extra field is the lie.
    writeZip(path, [{ name: 'a.txt', data: 'hello' }], { end: true, saturateCdOffset: true })
    const cd = findSignature(path, 0x02014b50)
    const sentinel = new Uint8Array(4).fill(0xff)
    patchFile(path, cd + 42, 4, sentinel) // local header offset = 0xffffffff, no extra field
    assert.throws(() => readZipEntries(path), validation)
  })
})

test('a truncated central directory is a Validation error rather than a RangeError', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, {
      end: true,
      saturateCdOffset: true,
      saturateCdSize: true,
      saturateEntries: true,
    })
    const record = findSignature(path, ZIP64_EOCD_SIG)
    const shrunk = new Uint8Array(8)
    new DataView(shrunk.buffer).setBigUint64(0, 12n, true) // directory size, far too small
    patchFile(path, record + 40, 8, shrunk)
    assert.throws(() => readZipEntries(path), validation)
  })
})

// ---------------------------------------------------------------------------------------------
// the chunked reader
// ---------------------------------------------------------------------------------------------

test('the chunked reader yields exactly the bytes the buffered reader returns', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'big.3mf')
    const payload = bigXml()
    writeSample(path, undefined, payload)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const buffered = readZipEntryBytes(path, entry)
    const streamed = await drain(readZipEntryChunks(path, entry))
    assert.ok(streamed.count > 1, 'the payload must span more than one chunk to test anything')
    assert.deepEqual(Array.from(streamed.bytes), Array.from(buffered))
  })
})

test('no chunk exceeds the requested bound, and the bound can be tiny', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'big.3mf')
    const payload = bigXml()
    writeSample(path, undefined, payload)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const streamed = await drain(readZipEntryChunks(path, entry, { maxChunkBytes: 1000 }))
    assert.ok(streamed.maxChunk <= 1000, `largest chunk was ${streamed.maxChunk}`)
    assert.equal(new TextDecoder().decode(streamed.bytes), payload)
    assert.ok(DEFAULT_ZIP_CHUNK_BYTES > 1000)
  })
})

test('a stored entry streams too, without an inflater', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path)
    const entry = findZipEntry(readZipEntries(path), 'Metadata/stored.txt')!
    assert.equal(entry.method, 0)
    const streamed = await drain(readZipEntryChunks(path, entry, { maxChunkBytes: 7 }))
    assert.ok(streamed.maxChunk <= 7)
    assert.equal(new TextDecoder().decode(streamed.bytes), 'stored verbatim, no deflate')
  })
})

test('a zip64 entry streams the same bytes as it reads', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'z.3mf')
    const payload = bigXml()
    writeSample(path, { end: true, saturateCdOffset: true, saturateEntries: true }, payload)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const streamed = await drain(readZipEntryChunks(path, entry, { maxChunkBytes: 8192 }))
    assert.equal(new TextDecoder().decode(streamed.bytes), payload)
  })
})

test('openZip streams from the descriptor it already holds', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'big.3mf')
    const payload = bigXml()
    writeSample(path, undefined, payload)
    const zip = openZip(path)
    try {
      const entry = findZipEntry(zip.entries, '3D/3dmodel.model')!
      const streamed = await drain(zip.readChunks(entry, { maxChunkBytes: 4096 }))
      assert.deepEqual(Array.from(streamed.bytes), Array.from(zip.read(entry)))
    } finally {
      zip.close()
    }
  })
})

/**
 * Pulls one chunk, closes the zip, then pulls again — with a decoy file opened in between so the
 * descriptor number the generator still holds has been handed to something else.
 *
 * That decoy is the whole test. Without the guard the second pull does not fail: descriptor
 * numbers are recycled lowest-free-first, so the read succeeds against the decoy and the consumer
 * receives plausible bytes from the wrong file. Measured before the fix on a stored entry: 30
 * chunks out of 30 came from the decoy, no error anywhere.
 */
async function pullAcrossClose(dir: string, entryName: string): Promise<unknown> {
  const path = join(dir, 'z.3mf')
  const decoyPath = join(dir, 'decoy.bin')
  writeFileSync(decoyPath, new Uint8Array(2 * 1024 * 1024).fill(0x44))

  const zip = openZip(path)
  const entry = findZipEntry(zip.entries, entryName)!
  const chunks = zip.readChunks(entry, { maxChunkBytes: 4096 })
  const first = await chunks.next()
  assert.equal(first.done, false)

  zip.close()
  const decoy = openSync(decoyPath, 'r')
  try {
    // Drained to the end rather than pulled once: the deflated path reads ahead, so the first
    // pull after `close()` can legitimately be served from output that was inflated while the zip
    // was still open. What must not happen is the *iteration* running to completion — that would
    // mean a later read went through against the recycled descriptor.
    for (;;) {
      const step = await chunks.next().then(
        (result) => result,
        (error: unknown) => ({ failedWith: error }) as const,
      )
      if ('failedWith' in step) return step.failedWith
      if (step.done) return undefined
    }
  } finally {
    closeSync(decoy)
    await chunks.return(undefined).catch(() => {})
  }
}

test('pulling a deflated chunked read after close() fails instead of reading another file', async () => {
  await withDir(async (dir) => {
    writeSample(join(dir, 'z.3mf'), undefined, bigXml())
    const error = await pullAcrossClose(dir, '3D/3dmodel.model')
    assert.ok(error, 'the pull after close() resolved instead of throwing')
    assert.ok(validation(error))
    assert.match((error as Error).message, /already closed/)
  })
})

test('pulling a stored chunked read after close() fails instead of reading another file', async () => {
  await withDir(async (dir) => {
    // Stored is the dangerous one: it reads the file directly with no inflater to notice that the
    // bytes are nonsense, so a recycled descriptor produces wrong data rather than an error.
    writeZip(join(dir, 'z.3mf'), [
      { name: 'Metadata/stored.txt', data: 'x'.repeat(200_000) },
      { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    ])
    const error = await pullAcrossClose(dir, 'Metadata/stored.txt')
    assert.ok(error, 'the pull after close() resolved instead of throwing')
    assert.ok(validation(error))
    assert.match((error as Error).message, /already closed/)
  })
})

test('an entry that does not inflate to its declared size is a Validation error', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path)
    const entries = readZipEntries(path)
    const model = findZipEntry(entries, '3D/3dmodel.model')!
    const stored = findZipEntry(entries, 'Metadata/stored.txt')!
    // `import-zip.ts` charges the quota against `uncompressedSize` before writing the bytes this
    // returns, so a declaration that does not match what comes out is a quota bypass, not a
    // cosmetic inconsistency.
    assert.throws(() => readZipEntryBytes(path, { ...model, uncompressedSize: 3 }), validation)
    assert.throws(() => readZipEntryBytes(path, { ...stored, uncompressedSize: 3 }), validation)
    await assert.rejects(
      () => drain(readZipEntryChunks(path, { ...model, uncompressedSize: 3 })),
      validation,
    )
    await assert.rejects(
      () => drain(readZipEntryChunks(path, { ...stored, uncompressedSize: 3 })),
      validation,
    )
  })
})

test('abandoning a chunked read part-way closes the descriptor', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'big.3mf')
    writeSample(path, undefined, bigXml())
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!

    // Descriptors are handed out lowest-free-first and returned on close, so opening and closing
    // one before and after says whether anything in between kept one. Unlinking the file would
    // not: both runtimes open with delete-sharing, so a leaked handle does not block it.
    const probe = (): number => {
      const fd = openSync(path, 'r')
      closeSync(fd)
      return fd
    }
    const before = probe()

    let seen = 0
    for await (const chunk of readZipEntryChunks(path, entry, { maxChunkBytes: 4096 })) {
      seen += chunk.byteLength
      if (seen > 8192) break
    }
    assert.ok(seen > 0)
    assert.equal(probe(), before, 'the abandoned generator left a descriptor open')
    unlinkSync(path)
  })
})

test('corrupt deflate data fails the chunked read as a Validation error', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, undefined, bigXml())
    const entries = readZipEntries(path)
    const entry = findZipEntry(entries, '3D/3dmodel.model')!
    // Wreck the middle of the compressed stream: the local header (30 bytes plus the name) is
    // intact, so the failure lands in the inflater rather than in the offset arithmetic.
    const at = entry.localHeaderOffset + 30 + '3D/3dmodel.model'.length + 64
    patchFile(path, at, 32, new Uint8Array(32).fill(0x5a))
    await assert.rejects(() => drain(readZipEntryChunks(path, entry)), validation)
  })
})

test('corrupt deflate data fails the buffered read as a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path, undefined, bigXml())
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const at = entry.localHeaderOffset + 30 + '3D/3dmodel.model'.length + 64
    patchFile(path, at, 32, new Uint8Array(32).fill(0x5a))
    assert.throws(() => readZipEntryBytes(path, entry), validation)
  })
})

test('an unsupported compression method is a Validation error on both paths', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const bzip2: ZipEntry = { ...entry, method: 12 }
    assert.throws(() => readZipEntryBytes(path, bzip2), validation)
    await assert.rejects(() => drain(readZipEntryChunks(path, bzip2)), validation)
  })
})

test('an inflated entry comes back as a plain Uint8Array, not a node Buffer', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    const bytes = readZipEntryBytes(path, entry)
    // `inflateRawSync` returns a `Buffer` on both runtimes, and a `Buffer` is a `Uint8Array`
    // whose `slice` is a view rather than a copy and whose `toString` decodes UTF-8. Handing one
    // to callers that reasonably assume `Uint8Array` semantics is the trap the old re-copy
    // happened to close; the zero-copy view that replaced it has to close it too.
    assert.equal(Object.getPrototypeOf(bytes), Uint8Array.prototype)
    const half = bytes.slice(0, 4)
    half[0] = 0x21
    assert.notEqual(bytes[0], 0x21, 'slice must copy, as Uint8Array.prototype.slice does')
  })
})

test('an entry whose declared length is impossible is a Validation error', async () => {
  await withDir((dir) => {
    const path = join(dir, 'z.3mf')
    writeSample(path)
    const entry = findZipEntry(readZipEntries(path), '3D/3dmodel.model')!
    // A central directory can lie. `new Uint8Array(n)` answers a bad n with a bare RangeError,
    // which is not the failure contract the preview queue reads.
    assert.throws(() => readZipEntryBytes(path, { ...entry, compressedSize: 2 ** 52 }), validation)

    // A negative offset has to be rejected *as an offset*, and the message is the only way to
    // see which check fired: `readSync` reads from the descriptor's current position when given
    // a negative one, so without the guard this read succeeds against the wrong bytes and only
    // trips over some later inconsistency — a Validation error either way, for the wrong reason.
    assert.throws(
      () => readZipEntryBytes(path, { ...entry, localHeaderOffset: -1 }),
      (e: unknown) => validation(e) && /impossible offset/.test((e as Error).message),
    )
  })
})
