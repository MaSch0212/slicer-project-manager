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
