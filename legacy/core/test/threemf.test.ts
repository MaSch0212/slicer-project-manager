import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import type { Mesh } from '../src/previews/mesh/mesh.ts'
import { parse3mfMesh } from '../src/previews/mesh/threemf.ts'
import { assert, test } from './harness.ts'
import { writeZip } from './fixtures/make-3mf.ts'

const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

type ObjectSpec = { vertices: [number, number, number][]; triangles: [number, number, number][] }

/**
 * Builds `3D/3dmodel.model` XML with one `<object>` per entry in `objects`, each with its own
 * `<mesh>`. Triangle indices are local to their own object's vertex list, matching the 3MF
 * spec (and exercising `parse3mfMesh`'s per-mesh index scoping).
 */
function buildModelXml(objects: ObjectSpec[]): string {
  const objectXml = objects
    .map((obj, i) => {
      const vertexXml = obj.vertices
        .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
        .join('')
      const triangleXml = obj.triangles
        .map(([v1, v2, v3]) => `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
        .join('')
      return (
        `<object id="${i + 1}" type="model"><mesh>` +
        `<vertices>${vertexXml}</vertices><triangles>${triangleXml}</triangles>` +
        `</mesh></object>`
      )
    })
    .join('')
  const itemXml = objects.map((_, i) => `<item objectid="${i + 1}"/>`).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model unit="millimeter"><resources>${objectXml}</resources><build>${itemXml}</build></model>`
  )
}

/** A grid-free line of `n` vertices with `n` triangles, each referencing valid local indices. */
function buildGridModelXml(n: number): string {
  const vertexParts: string[] = new Array(n)
  const triangleParts: string[] = new Array(n)
  for (let i = 0; i < n; i++) {
    vertexParts[i] = `<vertex x="${i}" y="0" z="0"/>`
    triangleParts[i] = `<triangle v1="${i % n}" v2="${(i + 1) % n}" v3="${(i + 2) % n}"/>`
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter"><resources><object id="1" type="model"><mesh>' +
    `<vertices>${vertexParts.join('')}</vertices><triangles>${triangleParts.join('')}</triangles>` +
    '</mesh></object></resources><build><item objectid="1"/></build></model>'
  )
}

function write3mf(path: string, modelXml: string): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: modelXml },
  ])
}

async function withTmpDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-test-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a hand-built 3MF with a single triangle parses to that triangle', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'a.3mf')
    write3mf(
      path,
      buildModelXml([
        {
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
          triangles: [[0, 1, 2]],
        },
      ]),
    )
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a two-object 3MF concatenates both meshes, each with its own local vertex indices', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'two.3mf')
    write3mf(
      path,
      buildModelXml([
        {
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
          triangles: [[0, 1, 2]],
        },
        {
          // Deliberately reuses local indices 0,1,2 — they must resolve against this
          // object's own vertex list, not a global index space shared with the first object.
          vertices: [
            [0, 0, 5],
            [1, 0, 5],
            [1, 1, 5],
          ],
          triangles: [[0, 1, 2]],
        },
      ]),
    )
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 2)
    assert.deepEqual(
      Array.from(mesh.positions),
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 5, 1, 0, 5, 1, 1, 5],
    )
  })
})

test('an out-of-range triangle vertex index is rejected', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'bad-index.3mf')
    write3mf(
      path,
      buildModelXml([
        {
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          triangles: [[0, 1, 5]],
        },
      ]),
    )
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

test('a 3MF with vertices but no triangles is rejected', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'no-triangles.3mf')
    write3mf(
      path,
      buildModelXml([
        {
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
          triangles: [],
        },
      ]),
    )
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

test('a 3MF with no 3D/3dmodel.model entry is rejected', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'no-model.3mf')
    writeZip(path, [{ name: '[Content_Types].xml', data: '<Types/>' }])
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

test('a vertex with a non-finite coordinate is rejected', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'nan.3mf')
    const xml = buildModelXml([
      {
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
        ],
        triangles: [[0, 1, 2]],
      },
    ]).replace('x="1" y="0" z="0"', 'x="nan" y="0" z="0"')
    write3mf(path, xml)
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

/**
 * Runs `parse3mfMesh` with `Uint8Array.prototype.indexOf` counted, and reports the bytes it
 * walked.
 *
 * The scanner's linearity is a property of one intrinsic: every search is
 * `bytes.indexOf(anchor, probe)` with a `probe` that only ever moves forward, so each byte of
 * the document is crossed a bounded number of times regardless of how many tags it holds. The
 * distance those calls cover is therefore the work the "does not go quadratic" claim is about,
 * and counting it measures the algorithm instead of the machine it ran on.
 *
 * Patching a prototype is heavy-handed, and it is deliberate: it costs production nothing, it
 * needs no seam widened in `threemf.ts` for a test's benefit, and it observes exactly the call
 * the doc comments in `indexOfBytes` reason about. The tests in this file run one at a time, and
 * the patch is removed in a `finally`.
 */
async function measureScan(path: string): Promise<{ mesh: Mesh; bytesWalked: number }> {
  const original = Uint8Array.prototype.indexOf
  let bytesWalked = 0
  Uint8Array.prototype.indexOf = function (this: Uint8Array, value: number, from?: number): number {
    const at = original.call(this, value, from)
    // Where the scan began, under `indexOf`'s own rules: a negative `from` counts back from the
    // end, and one past the end finds nothing. Clamped so a search that started beyond the array
    // cannot subtract its way to a negative distance.
    const raw = from === undefined ? 0 : from < 0 ? this.length + from : from
    const start = raw < 0 ? 0 : raw > this.length ? this.length : raw
    bytesWalked += (at === -1 ? this.length : at) - start
    return at
  }
  try {
    return { mesh: await parse3mfMesh(path), bytesWalked }
  } finally {
    Uint8Array.prototype.indexOf = original
  }
}

test('the scanner does not go quadratic on a mesh with many vertices and triangles', async () => {
  await withTmpDir(async (dir) => {
    const smallPath = join(dir, 'small.3mf')
    const largePath = join(dir, 'large.3mf')
    const SMALL_N = 3000
    const LARGE_N = 30000 // 10x the tags of the small fixture

    const smallXml = buildGridModelXml(SMALL_N)
    write3mf(smallPath, smallXml)
    const largeXml = buildGridModelXml(LARGE_N)
    write3mf(largePath, largeXml)

    const small = await measureScan(smallPath)
    const large = await measureScan(largePath)

    assert.equal(small.mesh.triangleCount, SMALL_N)
    assert.equal(large.mesh.triangleCount, LARGE_N)

    // ## Why this counts work per byte instead of comparing two sizes
    //
    // This assertion used to be a wall-clock ratio of the two parses, and it flaked: a loaded
    // machine measured 154x against a 50x ceiling that a quiet one clears at 12-30x. Replacing
    // the stopwatch with bytes walked removes the flake -- but measuring it also showed the
    // ratio itself was the wrong shape, and had been all along.
    //
    // The scanner reads the document in fixed-size windows. A scan that restarts from the front
    // of its *window* on every call is quadratic in the window, not in the document, so its total
    // work still grows linearly with the document and the ratio between a 3k-tag file and a
    // 30k-tag one stays around 10. Substituting exactly that mutant (`indexOfBytes` probing from
    // the buffer start and filtering matches behind `from`) leaves the ratio at 12.9 -- under any
    // ceiling this test could reasonably set -- while the work explodes 679x, from 7.94 bytes
    // walked per document byte to 5,395. The old test caught that mutant only through its
    // absolute `largeTime < 5000` backstop; the headline ratio, the one that flaked, was blind
    // to it.
    //
    // So the property to assert is the constant itself: the scan walks a small, bounded number of
    // bytes per document byte, whatever the document's size. That is what "linear" means here,
    // and it is what a cursor that never rewinds buys.
    const smallPerByte = small.bytesWalked / smallXml.length
    const largePerByte = large.bytesWalked / largeXml.length

    // Measured at 7.942 on the small fixture and 7.946 on the large: four monotonic cursors plus
    // the `>` searches that close each tag, each crossing the document about twice. 20 leaves room
    // for another cursor without leaving room for a rescan, which costs hundreds.
    assert.ok(
      largePerByte < 20,
      `scan walked ${largePerByte} bytes per document byte, expected a small constant`,
    )

    // The counter would also read near zero for an implementation that stopped calling `indexOf`
    // -- a whole-document regex, say, which is itself one of the quadratic shapes this test
    // refuses. A scan cannot find the tags without crossing the document at least once, so a
    // figure below 1 means the instrument, not the scanner, is what changed.
    assert.ok(
      smallPerByte >= 1,
      `scan walked ${smallPerByte} bytes per document byte; the counter is no longer observing it`,
    )

    // And the constant must not grow with the document, which is the part a single measurement
    // cannot show. Measured at 1.0005 across a 10x size step -- the constant really is constant.
    const growth = largePerByte / smallPerByte
    assert.ok(growth < 1.5, `work per byte grew ${growth}x over a 10x document, expected flat`)
    // Each of the three was shown to fail, against the mutation named:
    //   ceiling  `indexOfBytes` probing from the buffer start        6,606 bytes/byte
    //   growth   that, plus WINDOW_BYTES raised to hold the whole part      9.89x
    //   floor    `bytesWalked += 0`, i.e. the instrument blinded                0
    // The growth control needs the ceiling lifted to be reached at all, because the ceiling
    // catches that mutation too. It is kept rather than folded into the ceiling because it is
    // the assertion that states the property in the form the scanner's docs claim it: work per
    // byte does not depend on how many bytes there are.
  })
})

test('a large fan produces the exact expected geometry under the two-pass rewrite', async () => {
  // Exercises the counting pass and the filling pass agreeing on size/order at a scale where
  // a bookkeeping bug in vertexWrite/positionWrite/vertexBase would show up as wrong data
  // rather than merely a wrong count.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'large-fan.3mf')
    const n = 2000
    write3mf(path, buildGridModelXml(n))
    const mesh = await parse3mfMesh(path)

    assert.equal(mesh.triangleCount, n)
    const expected = new Float32Array(n * 9)
    let w = 0
    for (let i = 0; i < n; i++) {
      for (const vi of [i % n, (i + 1) % n, (i + 2) % n]) {
        expected[w++] = vi
        expected[w++] = 0
        expected[w++] = 0
      }
    }
    assert.deepEqual(mesh.positions, expected)
  })
})

test('a <vertex> or <triangle> inside an XML comment is ignored, not ingested as geometry', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'commented.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      // An empty comment sits exactly on the boundary the `-->` search anchors against: its
      // closing marker begins at the first byte the search is allowed to look at, so an
      // off-by-one in the anchor offset would step straight over it and report the comment
      // unterminated.
      '<!---->' +
      '<!-- a phantom vertex that must not shift real indices: <vertex x="99" y="99" z="99"/> -->' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles>' +
      '<!-- <triangle v1="0" v2="0" v3="0"/> a phantom degenerate triangle -->' +
      '<triangle v1="0" v2="1" v3="2"/>' +
      '</triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('single-quoted attribute values parse the same as double-quoted ones', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'single-quotes.3mf')
    const xml =
      "<?xml version='1.0'?><model unit='millimeter'><resources>" +
      "<object id='1' type='model'><mesh><vertices>" +
      "<vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='1' y='1' z='0'/>" +
      "</vertices><triangles><triangle v1='0' v2='1' v3='2'/></triangles></mesh></object>" +
      "</resources><build><item objectid='1'/></build></model>"
    write3mf(path, xml)
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a newline or tab after the element name (pretty-printed XML) still parses', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'pretty.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh>\n  <vertices>\n' +
      '    <vertex\n      x="0"\n      y="0"\n      z="0"/>\n' +
      '    <vertex x="1" y="0" z="0"/>\n' +
      '    <vertex x="1" y="1" z="0"/>\n' +
      '  </vertices>\n  <triangles>\n' +
      '    <triangle\ty="ignored"\tv1="0" v2="1" v3="2"/>\n' +
      '  </triangles>\n</mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('an empty or whitespace-only attribute value is rejected, not coerced to 0', async () => {
  await withTmpDir(async (dir) => {
    const emptyX = join(dir, 'empty-x.3mf')
    write3mf(
      emptyX,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    await assert.rejects(parse3mfMesh(emptyX), validation)

    const whitespaceX = join(dir, 'whitespace-x.3mf')
    write3mf(
      whitespaceX,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="   " y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    await assert.rejects(parse3mfMesh(whitespaceX), validation)

    const emptyV1 = join(dir, 'empty-v1.3mf')
    write3mf(
      emptyV1,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    await assert.rejects(parse3mfMesh(emptyV1), validation)
  })
})

test('a hyphenated decoy attribute does not leak into the real one (anchored, not \\b)', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'decoy.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex p-x="77" x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      '<vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    // If `\b` (rather than the whitespace anchor) matched the attribute name, the decoy
    // `p-x="77"` would win and the first vertex would come out at x=77, not x=0.
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a 3MF whose objects are only <components> (no inline <mesh> anywhere) is rejected', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'components-only.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
      '<object id="2" type="model"><components><component objectid="1"/></components></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    // Must fail loudly (a blank/partial thumbnail reported as success is worse than a failed
    // preview), not return an empty or partial mesh.
    await assert.rejects(parse3mfMesh(path), validation)
  })
})

test('multi-byte UTF-8 around and inside the geometry does not shift the byte cursors', async () => {
  // The scan walks raw UTF-8 bytes, so anything that makes a character wider than one byte is
  // where a byte/character confusion would surface: a decoded slice that starts or ends
  // mid-character, or a marker offset read as a character index. Umlauts (2 bytes), a CJK
  // quotation mark (3) and an emoji (4) are placed in a comment, in element text, in a
  // non-geometry attribute, and inside a <vertex> tag's own slice.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'utf8.3mf')
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter">' +
      '<metadata name="Title">Köln Pokal — Kugel 「三次元」 😀</metadata>' +
      '<resources><object id="1" type="model" name="Grüße"><mesh><vertices>' +
      '<!-- Kommentar mit Umlauten: äöüß 😀 und ein Phantom: <vertex x="99" y="99" z="99"/> -->' +
      '<vertex x="0" y="0" z="0"/>' +
      '<vertex note="größer 😀 「三次元」" x="1" y="0" z="0"/>' +
      '<vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles>' +
      '</mesh></object></resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

/**
 * Parses `path` with `TextDecoder.prototype.decode` instrumented, and reports the largest input
 * any single decode was handed. Patched on the prototype because the parser holds its own decoder
 * instance; restored in a `finally` so a throwing parse cannot leak the patch into another test.
 */
async function largestDecodeDuringParse(
  path: string,
): Promise<{ largest: number; calls: number; tris: number }> {
  const proto = TextDecoder.prototype as unknown as {
    decode: (input?: unknown, options?: unknown) => string
  }
  const original = proto.decode
  let largest = 0
  let calls = 0
  proto.decode = function (this: TextDecoder, input?: unknown, options?: unknown): string {
    calls++
    const size = ArrayBuffer.isView(input)
      ? input.byteLength
      : input instanceof ArrayBuffer
        ? input.byteLength
        : 0
    if (size > largest) largest = size
    return original.call(this, input, options)
  }
  let tris: number
  try {
    // Parsed into a local first: in an object literal, `largest` and `calls` would be read
    // before the `parse3mfMesh` call that fills them, and both would come back 0.
    tris = (await parse3mfMesh(path)).triangleCount
  } finally {
    proto.decode = original
  }
  return { largest, calls, tris }
}

test('no single decode grows with the document — the parse never materializes it', async () => {
  // The point of the byte scan. A whole-document `TextDecoder().decode()` is not merely
  // wasteful: the three "Köln Pokal" files in the reference library inflate to a 674 MB model
  // part, past V8's 0x1fffffe8-character cap, and died with a bare "Cannot create a string
  // longer than..." instead of an AppError. Those real files are the motivating cases and were
  // verified by hand; per ruling F-2 no >512 MB fixture is built here, because it would add
  // minutes to every CI run and risk OOM on a shared runner.
  //
  // Two fixtures, one four times the other, express the property *relatively* rather than
  // against a hard-coded ceiling that would silently become meaningless if the fixture or the
  // window size were retuned: what has to hold is that the largest decode is a constant, so
  // quadrupling the document must not move it at all.
  await withTmpDir(async (dir) => {
    const small = join(dir, 'small.3mf')
    const large = join(dir, 'large.3mf')
    const n = 6000
    const smallXml = buildGridModelXml(n)
    write3mf(small, smallXml)
    write3mf(large, buildGridModelXml(n * 4))
    const smallBytes = new TextEncoder().encode(smallXml).length

    const s = await largestDecodeDuringParse(small)
    const l = await largestDecodeDuringParse(large)

    assert.equal(s.tris, n)
    assert.equal(l.tris, n * 4)
    // Guards the guard: if the parse stopped decoding altogether, the bounds below would hold
    // vacuously.
    assert.ok(s.calls > 0 && l.calls > 0, 'expected the parse to decode something')
    assert.ok(
      l.largest <= s.largest,
      `largest decode grew from ${s.largest} to ${l.largest} bytes when the document grew 4x; ` +
        'it must be bounded by a constant, not by the document',
    )
    // And that constant must be a small fraction of even the smaller document, so that
    // "decode it in four big pieces" does not pass the invariant above.
    assert.ok(
      l.largest * 4 <= smallBytes,
      `largest decode was ${l.largest} bytes against a ${smallBytes}-byte model part; ` +
        'a bounded window should be a small fraction of it',
    )
  })
})

test('a document spanning many decode windows with a multi-byte character parses exactly', async () => {
  // The windowed reader decodes a fixed span at a time and slices tags out of it by byte offset,
  // which is only valid while every code unit in that window came from exactly one byte. This
  // fixture is far larger than one window and puts a 4-byte character in the middle of it, so the
  // run crosses many aligned windows, one that is not, and the transitions in both directions.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'windows.3mf')
    const n = 2000
    const marked = 1200
    const vertexParts: string[] = []
    const triangleParts: string[] = []
    for (let i = 0; i < n; i++) {
      vertexParts.push(
        i === marked
          ? // Enough multi-byte characters that the byte/character drift they introduce (2 per
            // emoji, 1 per umlaut) exceeds the length of a whole tag. A smaller drift is not
            // enough to fail: the attribute regexes are position-independent, so a slice that
            // starts a few characters into its own tag still finds the right `x`, `y` and `z`.
            // Only a drift wider than a tag makes a misaligned window read the *next* tag's
            // numbers, which is what turns the hazard into a visible wrong answer.
            `<vertex note="${'😀'.repeat(24)}größer" x="${i}" y="0" z="0"/>`
          : `<vertex x="${i}" y="0" z="0"/>`,
      )
      triangleParts.push(`<triangle v1="${i % n}" v2="${(i + 1) % n}" v3="${(i + 2) % n}"/>`)
    }
    write3mf(
      path,
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<model unit="millimeter"><resources><object id="1" type="model"><mesh>' +
        `<vertices>${vertexParts.join('')}</vertices>` +
        `<triangles>${triangleParts.join('')}</triangles>` +
        '</mesh></object></resources><build><item objectid="1"/></build></model>',
    )

    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, n)
    const expected = new Float32Array(n * 9)
    let w = 0
    for (let i = 0; i < n; i++) {
      for (const vi of [i % n, (i + 1) % n, (i + 2) % n]) {
        expected[w++] = vi
        expected[w++] = 0
        expected[w++] = 0
      }
    }
    assert.deepEqual(mesh.positions, expected)
  })
})

test('a tag wider than one decode window parses, and the tags after it still do', async () => {
  // The windowed reader cannot serve a tag that does not fit in a window, so it decodes that one
  // tag on its own. What has to hold is that it decodes the *whole* tag rather than the part that
  // would have fit — here the padding pushes `x` past the window edge, so a clipped slice loses
  // the attribute entirely — and that the tags after it are still read correctly.
  await withTmpDir(async (dir) => {
    const path = join(dir, 'wide-tag.3mf')
    const padding = 'p'.repeat(9000)
    write3mf(
      path,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        `<vertex note="${padding}" x="0" y="0" z="0"/>` +
        '<vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    const mesh = await parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('an unterminated <vertex> tag or XML comment fails as a validation error', async () => {
  await withTmpDir(async (dir) => {
    // Both markers are found, then the search for their terminator runs off the end of the
    // buffer. Without the explicit guards this would slice to a negative index and surface as
    // a confusing attribute error, or loop, rather than as an AppError.
    const cutTag = join(dir, 'cut-tag.3mf')
    write3mf(
      cutTag,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"',
    )
    await assert.rejects(parse3mfMesh(cutTag), validation)

    const cutComment = join(dir, 'cut-comment.3mf')
    write3mf(
      cutComment,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices><!-- never closed',
    )
    await assert.rejects(parse3mfMesh(cutComment), validation)
  })
})

test('a namespace-prefixed tag (<m:vertex>) yields no geometry and fails cleanly', async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, 'namespaced.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<m:vertex x="0" y="0" z="0"/><m:vertex x="1" y="0" z="0"/><m:vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><m:triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    await assert.rejects(parse3mfMesh(path), validation)
  })
})
