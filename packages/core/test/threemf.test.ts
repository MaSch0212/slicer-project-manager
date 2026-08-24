import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
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

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'spm-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a hand-built 3MF with a single triangle parses to that triangle', () => {
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a two-object 3MF concatenates both meshes, each with its own local vertex indices', () => {
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 2)
    assert.deepEqual(
      Array.from(mesh.positions),
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 5, 1, 0, 5, 1, 1, 5],
    )
  })
})

test('an out-of-range triangle vertex index is rejected', () => {
  withTmpDir((dir) => {
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
    assert.throws(() => parse3mfMesh(path), validation)
  })
})

test('a 3MF with vertices but no triangles is rejected', () => {
  withTmpDir((dir) => {
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
    assert.throws(() => parse3mfMesh(path), validation)
  })
})

test('a 3MF with no 3D/3dmodel.model entry is rejected', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'no-model.3mf')
    writeZip(path, [{ name: '[Content_Types].xml', data: '<Types/>' }])
    assert.throws(() => parse3mfMesh(path), validation)
  })
})

test('a vertex with a non-finite coordinate is rejected', () => {
  withTmpDir((dir) => {
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
    assert.throws(() => parse3mfMesh(path), validation)
  })
})

test('the scanner does not go quadratic on a mesh with many vertices and triangles', () => {
  withTmpDir((dir) => {
    const smallPath = join(dir, 'small.3mf')
    const largePath = join(dir, 'large.3mf')
    const SMALL_N = 3000
    const LARGE_N = 30000 // 10x the tags of the small fixture

    write3mf(smallPath, buildGridModelXml(SMALL_N))
    write3mf(largePath, buildGridModelXml(LARGE_N))

    const t0 = performance.now()
    const small = parse3mfMesh(smallPath)
    const t1 = performance.now()
    const large = parse3mfMesh(largePath)
    const t2 = performance.now()

    assert.equal(small.triangleCount, SMALL_N)
    assert.equal(large.triangleCount, LARGE_N)

    const smallTime = Math.max(t1 - t0, 1)
    const largeTime = Math.max(t2 - t1, 1)
    // A linear (cached-cursor indexOf) scan takes roughly 10x as long for 10x the tags; a
    // quadratic scan (re-searching from the start each time, or a whole-document regex
    // backtracking) would take roughly 100x (measured 107x when a naive quadratic scan was
    // substituted in review). The 50x ceiling keeps a comfortable margin over the ~12-30x
    // observed across warm and cold runs while still catching a quadratic regression outright.
    assert.ok(
      largeTime / smallTime < 50,
      `large/small time ratio was ${largeTime / smallTime}, expected roughly linear scaling`,
    )
    // Absolute backstop: catches a pathological slowdown even in the (unlikely) case where
    // both times are inflated by the same constant factor and the ratio alone looks fine.
    assert.ok(largeTime < 5000, `large parse took ${largeTime}ms, expected well under 5s`)
  })
})

test('a large fan produces the exact expected geometry under the two-pass rewrite', () => {
  // Exercises the counting pass and the filling pass agreeing on size/order at a scale where
  // a bookkeeping bug in vertexWrite/positionWrite/vertexBase would show up as wrong data
  // rather than merely a wrong count.
  withTmpDir((dir) => {
    const path = join(dir, 'large-fan.3mf')
    const n = 2000
    write3mf(path, buildGridModelXml(n))
    const mesh = parse3mfMesh(path)

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

test('a <vertex> or <triangle> inside an XML comment is ignored, not ingested as geometry', () => {
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('single-quoted attribute values parse the same as double-quoted ones', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'single-quotes.3mf')
    const xml =
      "<?xml version='1.0'?><model unit='millimeter'><resources>" +
      "<object id='1' type='model'><mesh><vertices>" +
      "<vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='1' y='1' z='0'/>" +
      "</vertices><triangles><triangle v1='0' v2='1' v3='2'/></triangles></mesh></object>" +
      "</resources><build><item objectid='1'/></build></model>"
    write3mf(path, xml)
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a newline or tab after the element name (pretty-printed XML) still parses', () => {
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('an empty or whitespace-only attribute value is rejected, not coerced to 0', () => {
  withTmpDir((dir) => {
    const emptyX = join(dir, 'empty-x.3mf')
    write3mf(
      emptyX,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    assert.throws(() => parse3mfMesh(emptyX), validation)

    const whitespaceX = join(dir, 'whitespace-x.3mf')
    write3mf(
      whitespaceX,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="   " y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    assert.throws(() => parse3mfMesh(whitespaceX), validation)

    const emptyV1 = join(dir, 'empty-v1.3mf')
    write3mf(
      emptyV1,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices>' +
        '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>' +
        '</vertices><triangles><triangle v1="" v2="1" v3="2"/></triangles></mesh></object>' +
        '</resources><build><item objectid="1"/></build></model>',
    )
    assert.throws(() => parse3mfMesh(emptyV1), validation)
  })
})

test('a hyphenated decoy attribute does not leak into the real one (anchored, not \\b)', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'decoy.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex p-x="77" x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      '<vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    // If `\b` (rather than the whitespace anchor) matched the attribute name, the decoy
    // `p-x="77"` would win and the first vertex would come out at x=77, not x=0.
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('a 3MF whose objects are only <components> (no inline <mesh> anywhere) is rejected', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'components-only.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
      '<object id="2" type="model"><components><component objectid="1"/></components></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    // Must fail loudly (a blank/partial thumbnail reported as success is worse than a failed
    // preview), not return an empty or partial mesh.
    assert.throws(() => parse3mfMesh(path), validation)
  })
})

test('multi-byte UTF-8 around and inside the geometry does not shift the byte cursors', () => {
  // The scan walks raw UTF-8 bytes, so anything that makes a character wider than one byte is
  // where a byte/character confusion would surface: a decoded slice that starts or ends
  // mid-character, or a marker offset read as a character index. Umlauts (2 bytes), a CJK
  // quotation mark (3) and an emoji (4) are placed in a comment, in element text, in a
  // non-geometry attribute, and inside a <vertex> tag's own slice.
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

/**
 * Parses `path` with `TextDecoder.prototype.decode` instrumented, and reports the largest input
 * any single decode was handed. Patched on the prototype because the parser holds its own decoder
 * instance; restored in a `finally` so a throwing parse cannot leak the patch into another test.
 */
function largestDecodeDuringParse(path: string): { largest: number; calls: number; tris: number } {
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
    tris = parse3mfMesh(path).triangleCount
  } finally {
    proto.decode = original
  }
  return { largest, calls, tris }
}

test('no single decode grows with the document — the parse never materializes it', () => {
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
  withTmpDir((dir) => {
    const small = join(dir, 'small.3mf')
    const large = join(dir, 'large.3mf')
    const n = 6000
    const smallXml = buildGridModelXml(n)
    write3mf(small, smallXml)
    write3mf(large, buildGridModelXml(n * 4))
    const smallBytes = new TextEncoder().encode(smallXml).length

    const s = largestDecodeDuringParse(small)
    const l = largestDecodeDuringParse(large)

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

test('a document spanning many decode windows with a multi-byte character parses exactly', () => {
  // The windowed reader decodes a fixed span at a time and slices tags out of it by byte offset,
  // which is only valid while every code unit in that window came from exactly one byte. This
  // fixture is far larger than one window and puts a 4-byte character in the middle of it, so the
  // run crosses many aligned windows, one that is not, and the transitions in both directions.
  withTmpDir((dir) => {
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

    const mesh = parse3mfMesh(path)
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

test('a tag wider than one decode window parses, and the tags after it still do', () => {
  // The windowed reader cannot serve a tag that does not fit in a window, so it decodes that one
  // tag on its own. What has to hold is that it decodes the *whole* tag rather than the part that
  // would have fit — here the padding pushes `x` past the window edge, so a clipped slice loses
  // the attribute entirely — and that the tags after it are still read correctly.
  withTmpDir((dir) => {
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
    const mesh = parse3mfMesh(path)
    assert.equal(mesh.triangleCount, 1)
    assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
  })
})

test('an unterminated <vertex> tag or XML comment fails as a validation error', () => {
  withTmpDir((dir) => {
    // Both markers are found, then the search for their terminator runs off the end of the
    // buffer. Without the explicit guards this would slice to a negative index and surface as
    // a confusing attribute error, or loop, rather than as an AppError.
    const cutTag = join(dir, 'cut-tag.3mf')
    write3mf(
      cutTag,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"',
    )
    assert.throws(() => parse3mfMesh(cutTag), validation)

    const cutComment = join(dir, 'cut-comment.3mf')
    write3mf(
      cutComment,
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
        '<object id="1" type="model"><mesh><vertices><!-- never closed',
    )
    assert.throws(() => parse3mfMesh(cutComment), validation)
  })
})

test('a namespace-prefixed tag (<m:vertex>) yields no geometry and fails cleanly', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'namespaced.3mf')
    const xml =
      '<?xml version="1.0"?><model unit="millimeter"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<m:vertex x="0" y="0" z="0"/><m:vertex x="1" y="0" z="0"/><m:vertex x="1" y="1" z="0"/>' +
      '</vertices><triangles><m:triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '</resources><build><item objectid="1"/></build></model>'
    write3mf(path, xml)
    assert.throws(() => parse3mfMesh(path), validation)
  })
})
