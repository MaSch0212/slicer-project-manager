import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import { drainSink, feedSink, makeLineSink, openFile, readFileChunks } from '../src/files/chunks.ts'
import { allocateMesh } from '../src/previews/mesh/limits.ts'
import { parseObj, parseObjFile } from '../src/previews/mesh/obj.ts'
import { parseStl, parseStlFile } from '../src/previews/mesh/stl.ts'
import { parse3mfMesh } from '../src/previews/mesh/threemf.ts'
import { assert, test } from './harness.ts'
import { writeZip } from './fixtures/make-3mf.ts'

const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

/**
 * Comfortably more than the 256 KB window `threemf.ts` holds and the 256 KB chunk
 * `readFileChunks` reads, so every fixture built to this size crosses several boundaries rather
 * than sitting inside one. Kept as a number the tests can reason about rather than importing the
 * constants: a test that scales itself to the implementation's window cannot notice the window
 * growing to swallow the document.
 */
const WELL_PAST_ONE_WINDOW = 1_500_000

async function withTmpDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-stream-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function write3mf(path: string, modelXml: string): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: modelXml },
  ])
}

/**
 * `n` vertices and `n` triangles, with `pad` bytes of filler on the `<model>` element.
 *
 * The padding is the point of the fixture: it shifts every byte of the geometry by a controlled
 * amount, so sweeping it moves each window boundary through a different position inside a tag —
 * the middle of an attribute name, the middle of a number, between `<` and `v`. A parser that
 * mishandles one of those alignments fails for one padding and not the others, which no single
 * fixture can catch.
 */
function gridModelXml(n: number, pad = 0): string {
  const vertexParts: string[] = new Array(n)
  const triangleParts: string[] = new Array(n)
  for (let i = 0; i < n; i++) {
    vertexParts[i] = `<vertex x="${i}" y="0" z="0"/>`
    triangleParts[i] = `<triangle v1="${i % n}" v2="${(i + 1) % n}" v3="${(i + 2) % n}"/>`
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model unit="millimeter" pad="${'p'.repeat(pad)}"><resources><object id="1" type="model"><mesh>` +
    `<vertices>${vertexParts.join('')}</vertices><triangles>${triangleParts.join('')}</triangles>` +
    '</mesh></object></resources><build><item objectid="1"/></build></model>'
  )
}

function expectedGrid(n: number): Float32Array {
  const expected = new Float32Array(n * 9)
  let w = 0
  for (let i = 0; i < n; i++) {
    for (const vi of [i % n, (i + 1) % n, (i + 2) % n]) {
      expected[w++] = vi
      expected[w++] = 0
      expected[w++] = 0
    }
  }
  return expected
}

test('a 3MF model part many windows long parses exactly, at every window alignment', async () => {
  // 25 000 tag pairs is ~1.8 MB of model part, six times the parser's window, and the padding
  // sweep walks the boundary across a whole tag's width in one-byte steps. A boundary handled by
  // "retain from the last marker" rather than "retain from the last *safe* marker" loses exactly
  // one vertex or one triangle, at exactly one of these alignments.
  await withTmpDir(async (dir) => {
    const n = 25_000
    const expected = expectedGrid(n)
    for (const pad of [0, 1, 7, 13, 28, 45]) {
      const path = join(dir, `grid-${pad}.3mf`)
      const xml = gridModelXml(n, pad)
      assert.ok(xml.length > WELL_PAST_ONE_WINDOW, 'fixture must span several windows')
      write3mf(path, xml)
      const mesh = await parse3mfMesh(path)
      assert.equal(mesh.triangleCount, n, `triangle count at pad=${pad}`)
      assert.deepEqual(mesh.positions, expected, `positions at pad=${pad}`)
    }
  })
})

test('an XML comment far longer than the parser window is skipped, not buffered', async () => {
  // The one construct that may legally be longer than anything the parser is allowed to hold. It
  // is skipped *through* the stream, so the file grows by a megabyte and the parse does not.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'long-comment.3mf')
    const comment = `<!-- ${'x'.repeat(WELL_PAST_ONE_WINDOW)} <vertex x="99" y="99" z="99"/> -->`
    write3mf(
      path,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        comment +
        '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles>' +
        comment +
        '<triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    // The commented-out vertex must not have been ingested: if it had, index 0 would resolve to
    // (99,99,99) and every coordinate below would be wrong.
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a single tag longer than the parser window is refused, not buffered without limit', async () => {
  // The deliberate boundary of the design: a tag has to fit in the window because its attributes
  // are read out of one string. Growing the window for it would make the parser's memory a
  // function of the document again, so it is refused instead — with a Validation error, not an
  // out-of-memory.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'huge-tag.3mf')
    write3mf(
      path,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        `<vertex note="${'p'.repeat(WELL_PAST_ONE_WINDOW)}" x="0" y="0" z="0"/>` +
        '<vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

test('a comment that closes past a window edge is not partly re-read as document text', async () => {
  // The narrowest hole in a windowed scan, and the one that produces a *wrong answer* rather than
  // an error. A comment may legally close past the point where a marker near the window edge stops
  // being trustworthy; if the window then only discards up to that point, the last few bytes of the
  // comment's interior survive into the next window and are scanned as real XML. Here those bytes
  // are `<mesh`, which begins a new object and rebases every following triangle index — the
  // triangle then indexes vertex 3 of a mesh that has none, so the symptom is an out-of-range
  // error rather than a quietly wrong picture. The parser must consume at least as far as the
  // comment's close.
  //
  // Only a handful of byte alignments can express the hole at all — the comment has to close in
  // the last few bytes of the window with its `<mesh` still inside them — so the fixture aims at
  // 2^18 and sweeps a tag's width either side rather than asserting one exact offset. The
  // geometry has to come out right at all seventeen; which of them is the live one is an
  // implementation detail this test does not want to encode.
  await withTmpDir(async (dir) => {
    const head =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
      '</vertices>'
    // A comment whose interior *ends* with a bare `<mesh`, followed by a run of marker-free text
    // long enough that the scan genuinely runs out of markers at the window edge rather than
    // finding the real `<triangles>` there.
    const comment = '<!--<mesh-->'
    const tail =
      '...............................<triangles><triangle v1="0" v2="1" v3="2"/></triangles>' +
      '</mesh></object></resources><build><item objectid="1"/></build></model>'

    for (let offset = -8; offset <= 8; offset++) {
      // Place the comment's `<mesh` at 2^18 + offset, one window's worth of document into the
      // part, plus or minus a tag's width.
      const fillerLength = 262_144 + offset - head.length - '<!--'.length
      const path = join(dir, `edge-${offset + 8}.3mf`)
      write3mf(path, head + 'p'.repeat(fillerLength) + comment + tail)
      const mesh = await parse3mfMesh(path)
      assert.equal(mesh.triangleCount, 1, `triangle count at offset ${offset}`)
      assert.deepEqual(
        Array.from(mesh.positions),
        [0, 0, 0, 1, 0, 0, 1, 1, 0],
        `positions at offset ${offset}`,
      )
    }
  })
})

test('a 3MF whose two passes disagree is refused, not returned half-filled', async () => {
  // The counting pass sizes the arrays and the filling pass writes them, and a typed array is
  // silent about both kinds of disagreement: a write past the end is dropped, and a slot never
  // written reads back as zero. So a filling pass that saw one tag fewer would return a mesh with
  // a triangle at the origin, and one that saw more would drop geometry — both plausible pictures,
  // and neither an error. `obj.ts` and `stl.ts` already refused this; 3MF is the one with the most
  // ways to disagree with itself.
  //
  // Provoked the way a real deployment provokes it: the file changes between the two streams,
  // because a slicer rewrote the project during a backfill.
  //
  // The substitute is the *same length* with one `<triangle>` blanked to spaces. Equal length is
  // what makes this reach the guard at all — a shorter entry is caught earlier and elsewhere, by
  // the chunked reader's own "does not yield its declared uncompressed size" check — and it is
  // also the harder case, since every other cross-check in the stack still passes. The blanked
  // tag sits near the end of the document, past the window the filling pass has already read when
  // the swap lands.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'swapped.3mf')
    const n = 25_000
    const full = gridModelXml(n)
    const doomed = `<triangle v1="${n - 1000}" v2="${n - 999}" v3="${n - 998}"/>`
    const blanked = full.replace(doomed, ' '.repeat(doomed.length))
    assert.notEqual(blanked, full)
    assert.equal(blanked.length, full.length)
    write3mf(path, full)

    // Swapped on the filling pass's first *window* decode: the counting pass decodes nothing but
    // the archive's short entry names, so a decode of more than 200 bytes is unambiguously the
    // tag reader, and the tag reader only runs in pass two.
    const proto = TextDecoder.prototype as unknown as {
      decode: (input?: unknown, options?: unknown) => string
    }
    const original = proto.decode
    let swapped = false
    proto.decode = function (this: TextDecoder, input?: unknown, options?: unknown): string {
      if (!swapped && ArrayBuffer.isView(input) && input.byteLength > 200) {
        swapped = true
        write3mf(path, blanked)
      }
      return (original as (i?: unknown, o?: unknown) => string).call(this, input, options)
    }
    try {
      await assert.rejects(parse3mfMesh(path), validation)
      assert.ok(swapped, 'the substitution never happened, so nothing was actually tested')
    } finally {
      proto.decode = original
    }
  })
})

test('an ASCII STL vertex record that is not three numbers on one line is refused', async () => {
  // The narrowing that comes with reading a line at a time, made loud. A record split across
  // lines, or truncated, matches nothing — and a non-match is silent in both passes at once, so
  // the counts still agree and "a multiple of 3 per facet" still holds whenever the number of
  // dropped records is itself a multiple of three. That is a mesh quietly missing whole facets,
  // which is the one outcome worse than a refusal.
  await withTmpDir(async (dir) => {
    const facet = (x: number): string =>
      `facet normal 0 0 0\nouter loop\nvertex ${x} 0 0\nvertex ${x} 1 0\nvertex ${x} 1 1\n` +
      'endloop\nendfacet\n'
    const good = `solid s\n${facet(0)}${facet(1)}${facet(2)}${facet(3)}endsolid s\n`
    assert.equal(parseStl(new TextEncoder().encode(good)).triangleCount, 4)

    // Exactly three records split across lines, so the survivors are still a multiple of 9 floats
    // and every other guard in the parser is satisfied. Without the start-count check this parses
    // to three facets instead of four and says nothing.
    const split = good.replace(
      `vertex 1 0 0\nvertex 1 1 0\nvertex 1 1 1\n`,
      `vertex 1 0\n0\nvertex 1 1\n0\nvertex 1 1\n1\n`,
    )
    assert.notEqual(split, good)
    const splitBytes = new TextEncoder().encode(split)
    assert.throws(() => parseStl(splitBytes), validation)

    const path = join(dir, 'split.stl')
    writeFileSync(path, splitBytes)
    await assert.rejects(parseStlFile(path), validation)

    // A truncated last record, which the old whole-document regex caught only because it could
    // reach across the newline into the next line's tokens.
    const truncated = new TextEncoder().encode(`solid s\n${facet(0)}vertex 9 9\nendsolid s\n`)
    assert.throws(() => parseStl(truncated), validation)

    // Three records written as the keyword on one line and its numbers on the next. Exactly three,
    // so what survives is still a multiple of 9 floats and the facet-count guard stays quiet — the
    // file would otherwise parse to three facets instead of four and say nothing at all. Nothing
    // follows `vertex` on those lines, so only the end-of-line half of the start pattern sees
    // them: a check written as "keyword followed by whitespace" walks straight past this fixture.
    const wrappedFacet =
      'facet normal 0 0 0\nouter loop\nvertex\n1 0 0\nvertex\n1 1 0\nvertex\n1 1 1\n' +
      'endloop\nendfacet\n'
    const wrapped = new TextEncoder().encode(
      `solid s\n${facet(0)}${wrappedFacet}${facet(2)}${facet(3)}endsolid s\n`,
    )
    assert.throws(() => parseStl(wrapped), validation)

    // And the shape that must keep parsing: "vertex" inside a solid's name is not a record.
    const named = new TextEncoder().encode(
      `solid vertexcube\n${facet(0)}${facet(1)}endsolid vertexcube\n`,
    )
    assert.equal(parseStl(named).triangleCount, 2)
  })
})

/** How much of the document the largest single `TextDecoder.decode` was handed during `run`. */
async function largestDecode(run: () => Promise<unknown>): Promise<number> {
  const proto = TextDecoder.prototype as unknown as {
    decode: (input?: unknown, options?: unknown) => string
  }
  const original = proto.decode
  let largest = 0
  proto.decode = function (this: TextDecoder, input?: unknown, options?: unknown): string {
    const size = ArrayBuffer.isView(input) ? input.byteLength : 0
    if (size > largest) largest = size
    return original.call(this, input, options)
  }
  try {
    await run()
  } finally {
    proto.decode = original
  }
  return largest
}

test('the 3MF parse scales with triangle count, not with file size', async () => {
  // The property the whole task exists to establish, expressed as the difference between two
  // documents with *identical geometry*: one small, one with a megabyte of comment in it. If any
  // buffer were a function of the document rather than of the mesh, the second would decode more
  // than the first. (Wall clock is deliberately not asserted on: it is a function of the machine,
  // and this is a statement about allocation.)
  await withTmpDir(async (dir) => {
    const geometry =
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/>'
    const wrap = (body: string): string =>
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      `<object id="1" type="model"><mesh><vertices>${body}</triangles></mesh></object>` +
      '</resources><build><item objectid="1"/></build></model>'

    const small = join(dir, 'small.3mf')
    const padded = join(dir, 'padded.3mf')
    write3mf(small, wrap(geometry))
    write3mf(padded, wrap(`<!-- ${'x'.repeat(WELL_PAST_ONE_WINDOW)} -->${geometry}`))

    const smallDecode = await largestDecode(() => parse3mfMesh(small))
    const paddedDecode = await largestDecode(() => parse3mfMesh(padded))
    assert.ok(smallDecode > 0, 'expected the parse to decode something')
    assert.ok(
      paddedDecode <= smallDecode,
      `largest decode grew from ${smallDecode} to ${paddedDecode} bytes for the same geometry in ` +
        'a document a megabyte larger',
    )
    assert.deepEqual((await parse3mfMesh(padded)).positions, (await parse3mfMesh(small)).positions)
  })
})

/** A binary STL of `n` triangles whose coordinates are all distinct, so order is checkable. */
function binaryStlBytes(n: number): Uint8Array {
  const out = new Uint8Array(84 + n * 50)
  const view = new DataView(out.buffer)
  view.setUint32(80, n, true)
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50 + 12
    for (let i = 0; i < 9; i++) view.setFloat32(base + i * 4, t * 9 + i, true)
  }
  return out
}

test('a binary STL far longer than one read chunk streams to the same mesh as the buffer does', async () => {
  // 30 000 records is 1.5 MB, six read chunks, and 50 does not divide 262 144 — so records
  // straddle every boundary rather than lining up with it, which is the case the reassembly
  // buffer exists for and the only one where an off-by-one produces plausible-looking garbage
  // instead of a crash.
  await withTmpDir(async (dir) => {
    const bytes = binaryStlBytes(30_000)
    assert.ok(bytes.length > WELL_PAST_ONE_WINDOW)
    const path = join(dir, 'big.stl')
    writeFileSync(path, bytes)

    const streamed = await parseStlFile(path)
    const buffered = parseStl(bytes)
    assert.equal(streamed.triangleCount, 30_000)
    assert.deepEqual(streamed.positions, buffered.positions)
  })
})

test('an ASCII STL far longer than one read chunk streams to the same mesh as the buffer does', async () => {
  await withTmpDir(async (dir) => {
    const lines = ['solid big']
    for (let t = 0; t < 20_000; t++) {
      lines.push('  facet normal 0 0 0', '    outer loop')
      for (let i = 0; i < 3; i++) lines.push(`      vertex ${t} ${i} ${t * 3 + i}`)
      lines.push('    endloop', '  endfacet')
    }
    lines.push('endsolid big')
    // CRLF, so a line ending straddling a chunk boundary is exercised as well as a line body.
    const bytes = new TextEncoder().encode(lines.join('\r\n'))
    assert.ok(bytes.length > WELL_PAST_ONE_WINDOW)
    const path = join(dir, 'big-ascii.stl')
    writeFileSync(path, bytes)

    const streamed = await parseStlFile(path)
    assert.equal(streamed.triangleCount, 20_000)
    assert.deepEqual(streamed.positions, parseStl(bytes).positions)
  })
})

test('an OBJ far longer than one read chunk streams to the same mesh as the buffer does', async () => {
  // Every 500th line carries a comment with a 4-byte character in it, so multi-byte sequences
  // land on chunk boundaries repeatedly. A non-streaming `TextDecoder` would turn each split one
  // into two U+FFFD, and since they are inside comments the damage would be invisible in the
  // mesh — which is why the assertion is against the buffered parse of the identical bytes rather
  // than against a hand-written expectation.
  await withTmpDir(async (dir) => {
    const lines: string[] = []
    const n = 20_000
    for (let i = 0; i < n; i++) {
      if (i % 500 === 0) lines.push(`# grüße 😀 「三次元」 ${i}`)
      lines.push(`v ${i} ${i % 7} ${i % 13}`)
    }
    for (let i = 0; i + 3 <= n; i += 3) lines.push(`f ${i + 1} ${i + 2} ${i + 3}`)
    const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
    assert.ok(bytes.length > 300_000, 'fixture must span several read chunks')
    const path = join(dir, 'big.obj')
    writeFileSync(path, bytes)

    const streamed = await parseObjFile(path)
    const buffered = parseObj(bytes)
    assert.equal(streamed.triangleCount, buffered.triangleCount)
    assert.deepEqual(streamed.positions, buffered.positions)
  })
})

test('the mesh ceiling refuses a model before its arrays are allocated, naming both sizes', async () => {
  // One ceiling, every entry point in this file — three buffered, four streamed. The eighth,
  // `parseStepFile`, consults the same ceiling and is pinned the same way in `step.test.ts`,
  // beside the fixture it needs; it is not here because it neither streams nor buffers a document
  // this suite can write, and its `limits` reach the check after OCCT has already tessellated.
  // A ceiling of one byte is
  // deliberately absurd, because the interesting question is not where the line sits (that is a
  // deployment decision and lives in the README) but that each format consults it at all, that
  // the refusal is a Validation error rather than an allocation failure, and that the message an
  // operator reads names what was needed and what is allowed.
  await withTmpDir(async (dir) => {
    const tiny = { maxMeshBytes: 1 }

    const stlPath = join(dir, 'cap.stl')
    const stlBytes = binaryStlBytes(100)
    writeFileSync(stlPath, stlBytes)
    const objBytes = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n')
    const objPath = join(dir, 'cap.obj')
    writeFileSync(objPath, objBytes)
    const asciiBytes = new TextEncoder().encode(
      'solid s\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\n' +
        'endloop\nendfacet\nendsolid s\n',
    )
    const asciiPath = join(dir, 'cap-ascii.stl')
    writeFileSync(asciiPath, asciiBytes)
    const threemfPath = join(dir, 'cap.3mf')
    write3mf(threemfPath, gridModelXml(10))

    assert.throws(() => parseStl(stlBytes, tiny), validation)
    assert.throws(() => parseStl(asciiBytes, tiny), validation)
    assert.throws(() => parseObj(objBytes, tiny), validation)
    await assert.rejects(parseStlFile(stlPath, tiny), validation)
    await assert.rejects(parseStlFile(asciiPath, tiny), validation)
    await assert.rejects(parseObjFile(objPath, tiny), validation)
    await assert.rejects(parse3mfMesh(threemfPath, tiny), validation)

    // The same model parses when the ceiling is one it fits under, so the refusals above are the
    // ceiling doing its job and not the fixtures being broken.
    assert.equal(parseStl(stlBytes, { maxMeshBytes: 1_000_000 }).triangleCount, 100)
    assert.equal((await parse3mfMesh(threemfPath, { maxMeshBytes: 1_000_000 })).triangleCount, 10)

    let message = ''
    try {
      parseStl(stlBytes, tiny)
    } catch (error) {
      message = (error as AppError).message
    }
    // Both numbers, because "too big" without them tells an operator nothing about whether the
    // fix is a bigger ceiling or a smaller model.
    assert.match(message, /0\.0 MB/)
    assert.match(message, /100 triangles/)
  })
})

test('a mesh too large for the engine to allocate is a Validation error, not a RangeError', () => {
  // `SPM_MAX_MESH_MB` is an operator's ceiling and the same configuration ships to a NAS and to a
  // workstation, so the allocation can still fail under it — past what V8 will construct, or
  // simply for want of memory. The length came out of a file either way, and everything a file can
  // cause has to arrive as an AppError rather than as a bare RangeError escaping the queue.
  assert.throws(() => allocateMesh(2 ** 40, 'triangles'), validation)
  assert.throws(() => allocateMesh(2 ** 40, 'triangles'), /too large to allocate its triangles/)
  // The ordinary case still returns an array, so the assertion above is not vacuous.
  assert.equal(allocateMesh(9, 'triangles').length, 9)
})

test('a line split across chunks is rejoined, and a multi-byte character across chunks survives', async () => {
  // The line sink's whole contract in one assertion. Fed byte by byte, every line boundary and
  // every one of the emoji's four bytes lands on a chunk boundary.
  const text = 'alpha\nbeta 😀 gamma\r\n\nlast'
  const bytes = new TextEncoder().encode(text)

  const oneChunk: string[] = []
  feedSink(
    makeLineSink((line) => oneChunk.push(line)),
    bytes,
  )

  const byteAtATime: string[] = []
  const sink = makeLineSink((line) => byteAtATime.push(line))
  for (let i = 0; i < bytes.length; i++) sink.push(bytes.subarray(i, i + 1))
  sink.end()

  assert.deepEqual(oneChunk, ['alpha', 'beta 😀 gamma\r', '', 'last'])
  assert.deepEqual(byteAtATime, oneChunk)
})

test('a file with no newline at all is refused rather than buffered whole', async () => {
  // Without the cap the sink's carry-over is the file, which is exactly the failure this task
  // removes. One megabyte of `a` is well past it.
  const sink = makeLineSink(() => {})
  assert.throws(() => sink.push(new TextEncoder().encode('a'.repeat(2_000_000))), validation)
})

test('readFileChunks yields the file in order and reuses one buffer', async () => {
  await withTmpDir(async (dir) => {
    const bytes = new Uint8Array(5000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    const path = join(dir, 'bytes.bin')
    writeFileSync(path, bytes)

    const parts: Uint8Array[] = []
    let sameBuffer = true
    let first: ArrayBufferLike | undefined
    for await (const chunk of readFileChunks(path, 1024)) {
      // A copy, because the next pull overwrites this one — which is the documented contract and
      // is asserted on directly below.
      parts.push(chunk.slice())
      first ??= chunk.buffer
      if (chunk.buffer !== first) sameBuffer = false
    }
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const part of parts) {
      joined.set(part, at)
      at += part.length
    }
    assert.deepEqual(joined, bytes)
    assert.equal(parts.length, 5) // 4 full 1024-byte chunks and a 904-byte tail
    assert.ok(sameBuffer, 'every chunk should be a view into the same reused buffer')
  })
})

test('pulling an openFile stream after close() fails instead of reading another file', async () => {
  // A descriptor number is recycled the moment it is closed, so an unguarded read does not fail —
  // it reads whatever file has since taken the number. The zip reader carries the same guard for
  // the same reason, and a generator has to re-check it on every pull rather than once, because
  // its reads happen whenever the consumer asks and that can be after the holder let go.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'closed.bin')
    writeFileSync(path, new Uint8Array(4096))
    const file = openFile(path)
    const chunks = file.chunks(64)
    assert.equal((await chunks.next()).value?.byteLength, 64)
    file.close()
    await assert.rejects(chunks.next(), validation)
  })
})

test('drainSink and feedSink agree on the same bytes', async () => {
  await withTmpDir(async (dir) => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    const bytes = new TextEncoder().encode(text)
    const path = join(dir, 'lines.txt')
    writeFileSync(path, bytes)

    const streamed: string[] = []
    await drainSink(
      makeLineSink((line) => streamed.push(line)),
      readFileChunks(path, 97),
    )
    const buffered: string[] = []
    feedSink(
      makeLineSink((line) => buffered.push(line)),
      bytes,
    )
    assert.deepEqual(streamed, buffered)
    assert.equal(streamed.length, 5000)
  })
})
