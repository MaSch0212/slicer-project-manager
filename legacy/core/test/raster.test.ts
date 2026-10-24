import type { AppError } from '@spm/contract/errors.ts'
import type { Mesh } from '../src/previews/mesh/mesh.ts'
import {
  AZIMUTH_DEGREES,
  CAMERA_BASIS,
  DEFAULT_SIZE,
  ELEVATION_DEGREES,
  renderMesh,
} from '../src/previews/raster.ts'
import { assert, test } from './harness.ts'
import {
  concatMeshes,
  cubeMesh,
  degenerateTriangleMesh,
  farDegenerateTriangleMesh,
  manyTrianglesMesh,
  rotatedBoxMesh,
  scaleMesh,
  sphereMesh,
  tetrahedronMesh,
  thinPlateMesh,
} from './fixtures/make-mesh.ts'

const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

/**
 * A Validation error that also says which of them it is.
 *
 * Several of the guards in the rasterizer sit in front of each other: remove one and a
 * malformed mesh still throws `Validation`, just from the wrong place and with a message
 * that misdirects whoever reads the queue's error. Matching the message is what keeps each
 * guard independently covered.
 */
const validationSaying =
  (fragment: string) =>
  (e: unknown): boolean =>
    validation(e) && (e as AppError).message.includes(fragment)

/**
 * The four colours an axis-aligned cube can produce, written out rather than recomputed.
 *
 * A cube shows the camera exactly three normals (+Z on top, -Y in front, +X on the right),
 * and `abs(dot(normal, light))` gives their three hidden opposites the same shades, so the
 * whole image is these four values and nothing else. They are literals on purpose: deriving
 * them from the rasterizer's own light vector and ambient term would make the test agree
 * with whatever the code does, including a light pointed the wrong way.
 */
const BACKGROUND = '31,35,42'
const TOP = '188,116,50' // +Z, the brightest: the light comes from above
const FRONT = '151,93,41' // -Y, the mid tone: the light also comes from the viewer's front
const RIGHT = '111,68,30' // +X, the darkest of the three

/**
 * Compares two image-sized byte buffers and, when they differ, says so in one short line.
 *
 * Never `assert.deepEqual` on these. Two 196,608-byte `Uint8Array`s that differ in a couple
 * of bytes diff in 62 ms, but a pair that differs almost everywhere — exactly what a real
 * rendering regression produces — spends 80 seconds building the diff and then dies with
 * `RangeError: Array buffer allocation failed`. The regression would be reported as an OOM
 * with no clue what changed.
 */
function assertSameBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: buffer lengths differ`)
  let differing = 0
  let first = -1
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === expected[i]) continue
    differing++
    if (first < 0) first = i
  }
  const detail =
    first < 0 ? '' : `, first at byte ${first} (${actual[first]} vs ${expected[first]})`
  assert.equal(differing, 0, `${what}: ${differing} of ${actual.length} bytes differ${detail}`)
}

function at(image: { rgb: Uint8Array; width: number }, x: number, y: number): string {
  const i = (y * image.width + x) * 3
  return `${image.rgb[i]},${image.rgb[i + 1]},${image.rgb[i + 2]}`
}

function distinctColours(rgb: Uint8Array): Set<string> {
  const seen = new Set<string>()
  for (let i = 0; i < rgb.length; i += 3) seen.add(`${rgb[i]},${rgb[i + 1]},${rgb[i + 2]}`)
  return seen
}

/** 1 where a pixel belongs to the model, 0 where it is untouched background. */
function silhouette(image: { rgb: Uint8Array; width: number; height: number }): Uint8Array {
  const mask = new Uint8Array(image.width * image.height)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = at(image, i % image.width, Math.floor(i / image.width)) === BACKGROUND ? 0 : 1
  }
  return mask
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number }

function silhouetteBounds(image: {
  rgb: Uint8Array
  width: number
  height: number
}): Bounds | null {
  const mask = silhouette(image)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!mask[y * image.width + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY }
}

/** The model colours present in one row, joined — a row is usually one face at the extremes. */
function modelColoursInRow(
  image: { rgb: Uint8Array; width: number; height: number },
  y: number,
): string {
  const seen = new Set<string>()
  for (let x = 0; x < image.width; x++) {
    const colour = at(image, x, y)
    if (colour !== BACKGROUND) seen.add(colour)
  }
  return [...seen].sort().join(' + ')
}

function meshOf(values: number[]): Mesh {
  return { positions: Float32Array.from(values), triangleCount: values.length / 9 }
}

test('renderMesh produces a square RGB buffer of the default 256px size', () => {
  const image = renderMesh(cubeMesh())
  assert.equal(DEFAULT_SIZE, 256)
  assert.deepEqual({ width: image.width, height: image.height }, { width: 256, height: 256 })
  // Exactly what encodePng demands; a byte more or less and the PNG is unencodable.
  assert.equal(image.rgb.length, 256 * 256 * 3)
})

test('the camera literals encode the constants they document, and are orthonormal', () => {
  // The nine numbers are literals so no transcendental function runs in the render path.
  // Nothing else in this suite can catch a mistyped digit: an error in the eighth decimal
  // shifts a 256px render by about two hundred-thousandths of a pixel. When this fails it
  // prints the replacements, so retuning the camera is: edit the two angles, run the tests,
  // paste what they say.
  const azimuth = (AZIMUTH_DEGREES * Math.PI) / 180
  const elevation = (ELEVATION_DEGREES * Math.PI) / 180
  const cosA = Math.cos(azimuth)
  const sinA = Math.sin(azimuth)
  const cosE = Math.cos(elevation)
  const sinE = Math.sin(elevation)
  const right = [-sinA, cosA, 0]
  const up = [-sinE * cosA, -sinE * sinA, cosE]
  const view = [cosE * cosA, cosE * sinA, sinE]

  const names = ['RIGHT', 'UP', 'VIEW']
  const expected = [right, up, view]
  const actual = [CAMERA_BASIS.right, CAMERA_BASIS.up, CAMERA_BASIS.view]
  const stale: string[] = []
  for (let v = 0; v < 3; v++) {
    for (let i = 0; i < 3; i++) {
      // Close, not equal: the literals are the exact doubles these expressions produce on V8,
      // but asserting equality would re-promise the libm determinism the literals exist to
      // avoid depending on. 1e-12 still catches any transcription mistake.
      if (Math.abs(actual[v]![i]! - expected[v]![i]!) < 1e-12) continue
      // String(x) is the shortest decimal that round-trips to the same double, so what this
      // prints is exact, not rounded.
      stale.push(`const ${names[v]}_${'XYZ'[i]} = ${String(expected[v]![i])}`)
    }
  }
  assert.equal(stale.length, 0, `camera literals are stale — replace with:\n${stale.join('\n')}`)

  // Orthonormal and right-handed: what the projection and the derived pixel area both assume.
  // Tighter than the 1e-12 above because this is arithmetic on the literals themselves, not a
  // comparison against libm — but not exact, because at a general azimuth the residuals are a
  // couple of ulp rather than the clean zeros an exact-diagonal camera happened to produce.
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const basis = CAMERA_BASIS
  for (const axis of ['right', 'up', 'view'] as const) {
    assert.ok(Math.abs(dot(basis[axis], basis[axis]) - 1) < 1e-15, `${axis} is not a unit vector`)
  }
  assert.ok(Math.abs(dot(basis.right, basis.up)) < 1e-15, 'right and up are not perpendicular')
  assert.ok(Math.abs(dot(basis.right, basis.view)) < 1e-15, 'right and view are not perpendicular')
  assert.ok(Math.abs(dot(basis.up, basis.view)) < 1e-15, 'up and view are not perpendicular')
  const cross = [
    basis.right[1] * basis.up[2] - basis.right[2] * basis.up[1],
    basis.right[2] * basis.up[0] - basis.right[0] * basis.up[2],
    basis.right[0] * basis.up[1] - basis.right[1] * basis.up[0],
  ]
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(cross[i]! - basis.view[i]!) < 1e-15, `right x up is not view at ${i}`)
  }
})

test('renderMesh honours an explicit size', () => {
  const image = renderMesh(cubeMesh(), { size: 64 })
  assert.deepEqual({ width: image.width, height: image.height }, { width: 64, height: 64 })
  assert.equal(image.rgb.length, 64 * 64 * 3)
})

test('a cube renders as exactly three face shades over one background colour', () => {
  const image = renderMesh(cubeMesh())
  assert.deepEqual([...distinctColours(image.rgb)].sort(), [BACKGROUND, RIGHT, FRONT, TOP].sort())
})

test('the cube face shades land on the right faces, so the render is not flipped or unlit', () => {
  const image = renderMesh(cubeMesh())
  // Three points well inside the three visible faces of the fitted cube: the top face, and
  // the lower-left and lower-right ones.
  assert.equal(at(image, 128, 70), TOP)
  assert.equal(at(image, 70, 170), FRONT)
  assert.equal(at(image, 180, 170), RIGHT)
  // Three *different* tones at those three points, which is what makes the cube read as a
  // cube. Asserted over the sampled pixels, not over the literals above, so the check depends
  // on the render.
  assert.equal(new Set([at(image, 128, 70), at(image, 70, 170), at(image, 180, 170)]).size, 3)
  // And the brightest of the three really is the one on top: a vertically mirrored render
  // would put a side shade in the topmost row and the top shade in the bottom one.
  const bounds = silhouetteBounds(image)!
  assert.equal(modelColoursInRow(image, bounds.minY), TOP)
  assert.notEqual(modelColoursInRow(image, bounds.maxY), TOP)
})

test('the light points where it is documented to point, in all three axes', () => {
  // The cube tests cannot see this. `abs(dot(normal, light))` erases the sign, and a cube's
  // faces come in opposite pairs, so negating any single light component leaves an
  // axis-aligned box pixel-for-pixel identical. Negating one genuinely changes every curved or
  // oblique model in the library, so the signs need a mesh whose normals are not symmetric
  // about the light.
  //
  // The tetrahedron is that mesh: none of its four faces opposes another. Its face tones
  // depend only on the fixed world normals and the fixed world light, not on the camera, so
  // these are golden values rather than anything derived from the rasterizer's own light
  // vector. Negating LIGHT_X gives (121,74,32), LIGHT_Y (96,59,26) and (81,50,22), LIGHT_Z
  // (180,111,48) — each set differs from this one.
  const shades = distinctColours(renderMesh(tetrahedronMesh()).rgb)
  assert.deepEqual([...shades].sort(), [BACKGROUND, '201,124,54', '89,55,24'].sort())
})

test('the cube silhouette has the point symmetry the mesh has', () => {
  // The cube is invariant under p -> -p, and projection is linear, so its projected outline
  // must be invariant under a 180° rotation about the frame centre. This holds for *any*
  // camera basis — unlike a left-right mirror, which was only available while the camera sat
  // on an exact diagonal — so it survives a change of view direction. An off-centre fit or a
  // non-uniform scale breaks it.
  const image = renderMesh(cubeMesh())
  const mask = silhouette(image)
  const last = DEFAULT_SIZE - 1
  let mismatches = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (mask[y * image.width + x] !== mask[(last - y) * image.width + (last - x)]) mismatches++
    }
  }
  assert.equal(mismatches, 0)
})

test('a box rotated 45° about Z still reads as a box', () => {
  // The orientation an exact isometric camera cannot draw: both side normals would be
  // perpendicular to a (1,-1,1) view direction and the box would flatten into a two-tone
  // rectangle. Rotating a part 45° to fit the bed is routine, so the camera's azimuth offset
  // exists for this case. Three distinct model tones means three faces survived.
  const image = renderMesh(rotatedBoxMesh(45))
  const shades = distinctColours(image.rgb)
  shades.delete(BACKGROUND)
  assert.equal(shades.size, 3, `expected three visible faces, got ${[...shades].join(' ')}`)
})

test('the fitted mesh fills the frame minus the 6% margin', () => {
  // A sphere is the honest test of the fit: its projected outline is a circle inscribed in
  // the projected bounding box, so fitting the box corners instead of the vertices would
  // leave it visibly short of the frame.
  const image = renderMesh(sphereMesh(64, 32))
  const bounds = silhouetteBounds(image)!
  const span = 256 * (1 - 2 * 0.06)
  assert.ok(
    Math.abs(bounds.maxX - bounds.minX + 1 - span) <= 2,
    `horizontal span ${bounds.maxX - bounds.minX + 1} is not within 2px of ${span}`,
  )
  assert.ok(
    Math.abs(bounds.maxY - bounds.minY + 1 - span) <= 2,
    `vertical span ${bounds.maxY - bounds.minY + 1} is not within 2px of ${span}`,
  )
  // Centred: the margin is the same on opposite sides.
  assert.equal(bounds.minX, DEFAULT_SIZE - 1 - bounds.maxX)
  assert.equal(bounds.minY, DEFAULT_SIZE - 1 - bounds.maxY)
})

test('a sphere fills its bounding box like a round outline, not a polygon', () => {
  // What this measures is *shape*, not scale. Filled area over bounding-box area is π/4 for
  // any ellipse, so this cannot see anisotropy — it would pass just as happily on a squashed
  // sphere, and it tolerates something like 20% shear. Anisotropic scale is covered next door,
  // by the fit test asserting both spans against the same number.
  //
  // What it does catch is an outline that stops being round: a hexagon, a diamond, a silhouette
  // torn by a coverage bug. Camera-independent, which the cube's projected aspect was not. The
  // UV tessellation costs about 0.8% of the ideal π/4.
  const image = renderMesh(sphereMesh(64, 32))
  const bounds = silhouetteBounds(image)!
  const box = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1)
  let filled = 0
  for (const on of silhouette(image)) filled += on
  const ratio = filled / box
  assert.ok(
    Math.abs(ratio - Math.PI / 4) < 0.02,
    `filled/bounding-box ratio ${ratio} is not a disc's ${Math.PI / 4}`,
  )
})

test('nothing is drawn outside the frame', () => {
  for (const mesh of [cubeMesh(), tetrahedronMesh(), sphereMesh()]) {
    const image = renderMesh(mesh)
    const last = DEFAULT_SIZE - 1
    for (let i = 0; i < DEFAULT_SIZE; i++) {
      assert.equal(at(image, i, 0), BACKGROUND)
      assert.equal(at(image, i, last), BACKGROUND)
      assert.equal(at(image, 0, i), BACKGROUND)
      assert.equal(at(image, last, i), BACKGROUND)
    }
  }
})

test('the depth buffer, not triangle order, decides which surface is visible', () => {
  // Two overlapping triangles with different normals; the second is nearer the camera. An
  // implementation that simply painted in array order would render the two orderings
  // differently.
  const far = [-1, -1, 0, 1.2, -1, 0, 0, 1.2, 0]
  const near = [-1, -1, 1, 1.2, -1, 1, 0, 1.2, 2]
  const farFirst = renderMesh(meshOf([...far, ...near]), { size: 64 })
  const nearFirst = renderMesh(meshOf([...near, ...far]), { size: 64 })
  // Both triangles are visible somewhere, so the test would still have teeth if one of them
  // happened to be hidden entirely.
  assert.equal(distinctColours(farFirst.rgb).size, 3)
  assertSameBytes(farFirst.rgb, nearFirst.rgb, 'far-first vs near-first')

  // Order-independence alone does not pin the *direction*: a depth test with the sign
  // inverted, where the far surface wins, is equally order-independent. So name the winner.
  // Flat shading makes a face's colour a property of its normal alone, independent of the
  // fit, which is what lets a solo render supply the expected value.
  const nearColour = at(renderMesh(meshOf(near), { size: 64 }), 32, 32)
  const farColour = at(renderMesh(meshOf(far), { size: 64 }), 32, 32)
  assert.notEqual(nearColour, farColour)
  // (42, 42) sits inside both outlines: at that row the far triangle spans x 28..49 and the
  // near one covers 40..47, so whichever surface the depth test prefers is what shows here.
  assert.equal(at(farFirst, 42, 42), nearColour)
  assert.equal(at(nearFirst, 42, 42), nearColour)
})

test('a cube renders the same at 1x and at 1000x its size', () => {
  // Not asserted byte-identical: normalising a bounding box measured from floats a thousand
  // times larger can leave a shade one step apart. The silhouette must match exactly, and no
  // channel may differ by more than a single level.
  const small = renderMesh(cubeMesh())
  const large = renderMesh(scaleMesh(cubeMesh(), 1000))
  assertSameBytes(silhouette(small), silhouette(large), 'silhouette at 1x vs 1000x')
  let worst = 0
  for (let i = 0; i < small.rgb.length; i++) {
    const delta = Math.abs(small.rgb[i]! - large.rgb[i]!)
    if (delta > worst) worst = delta
  }
  assert.ok(worst <= 1, `channels differ by up to ${worst}`)
})

test('a cube renders the same at 1x and at 1/500th its size', () => {
  const small = renderMesh(scaleMesh(cubeMesh(), 0.002))
  const plain = renderMesh(cubeMesh())
  assertSameBytes(silhouette(small), silhouette(plain), 'silhouette at 1/500x vs 1x')
  let worst = 0
  for (let i = 0; i < plain.rgb.length; i++) {
    const delta = Math.abs(plain.rgb[i]! - small.rgb[i]!)
    if (delta > worst) worst = delta
  }
  assert.ok(worst <= 1, `channels differ by up to ${worst}`)
})

test('renderMesh is byte-identical across two runs in the same process', () => {
  assertSameBytes(renderMesh(sphereMesh()).rgb, renderMesh(sphereMesh()).rgb, 'sphere twice')
  assertSameBytes(renderMesh(cubeMesh()).rgb, renderMesh(cubeMesh()).rgb, 'cube twice')
})

test('a degenerate triangle alongside real geometry changes nothing', () => {
  // It must be skipped, not divided by: a zero-length normal would otherwise smear NaN
  // through the shading, and NaN written into a Uint8Array silently becomes 0.
  //
  // Both fixtures, because they are rejected by different halves of the drawability test.
  // The first one's projection cancels to an area of exactly zero, so the edge-on half also
  // catches it; the second one's does not, so only the zero-normal half stands between it and
  // the frame.
  const plain = renderMesh(cubeMesh()).rgb
  for (const spoiler of [degenerateTriangleMesh(), farDegenerateTriangleMesh()]) {
    const image = renderMesh(concatMeshes(cubeMesh(), spoiler))
    assertSameBytes(image.rgb, plain, 'cube plus a degenerate triangle')
    assert.deepEqual([...distinctColours(image.rgb)].sort(), [BACKGROUND, RIGHT, FRONT, TOP].sort())
  }
})

test('a mesh whose triangles are all degenerate is a Validation error, not a blank tile', () => {
  // The message matters, not just the code: an all-degenerate mesh leaves the bounding box
  // untouched, so without its own guard it would fail *by accident* on the Infinity extent
  // that follows, and this test could not tell the two apart.
  const noArea = validationSaying('covers any area in this view')
  assert.throws(() => renderMesh(degenerateTriangleMesh()), noArea)
  assert.throws(() => renderMesh(farDegenerateTriangleMesh()), noArea)
  // Every vertex at one point.
  assert.throws(() => renderMesh(meshOf([1, 2, 3, 1, 2, 3, 1, 2, 3])), noArea)
  // Collinear along (1,-1,1). That was the view direction back when the camera was an exact
  // isometric, so this projected to a single point; at 32° off the front it is 10.6° away from
  // VIEW and projects to a short line instead. It is still rejected, and still for the right
  // reason — three collinear vertices have no normal — so the fixture stays as a plain
  // collinear case rather than being re-aimed at a view direction that will move again.
  assert.throws(() => renderMesh(meshOf([0, 0, 0, 1, -1, 1, 2, -2, 2])), noArea)
})

test('geometry too thin to reach a sample point is a Validation error, not a blank tile', () => {
  // Every triangle here has a normal and a non-zero projected area, so it passes every
  // drawability test the rasterizer applies — and still paints nothing, because once the fit
  // stretches the long axis across the frame the short one is a fraction of a pixel wide and
  // slips between the sample points. Counting attempts instead of writes misses this
  // entirely and hands back an all-background tile as if it had worked.
  assert.throws(() => renderMesh(thinPlateMesh(100_000)), validationSaying('rendered no pixels'))
  // A plate only a hundred times longer than it is wide still draws, so the guard is not
  // simply rejecting anything thin.
  assert.ok(distinctColours(renderMesh(thinPlateMesh(100)).rgb).size > 1)
})

test('non-finite coordinates are a Validation error rather than a blank tile', () => {
  // The parsers reject these before the rasterizer sees them, but `renderMesh` is callable
  // without one, and NaN would otherwise flow through the fit and return an empty image.
  const nonFinite = validationSaying('non-finite vertex coordinate')
  assert.throws(() => renderMesh(meshOf([0, 0, 0, 1, 0, 0, 0, NaN, 0])), nonFinite)
  assert.throws(() => renderMesh(meshOf([0, 0, 0, 1, 0, 0, 0, Infinity, 0])), nonFinite)
})

test('a degenerate triangle reaching past the model does not shrink the fit', () => {
  // The whole reason the fitting pass skips undrawable triangles. These collinear ones run
  // out to (1,1,1) and to 13.5 while the cube spans ±0.5, so framing to every vertex would
  // size the frame around geometry that draws nothing — the far one would shrink the cube to
  // a speck a twentieth of its proper size.
  const expected = silhouetteBounds(renderMesh(cubeMesh()))
  for (const spoiler of [degenerateTriangleMesh(), farDegenerateTriangleMesh()]) {
    const stretched = concatMeshes(cubeMesh(), spoiler)
    assert.deepEqual(silhouetteBounds(renderMesh(stretched)), expected)
  }
})

test('an empty or inconsistent mesh is a Validation error', () => {
  // Again message-specific: an empty mesh would otherwise fall through to the "no triangle
  // with any area" guard, and an over-long triangleCount to the non-finite guard (reading
  // past the end of a typed array yields undefined, and the arithmetic turns that into NaN).
  // Both are the wrong diagnosis for the caller.
  const noTriangles = validationSaying('no triangles')
  // A Mesh without positions at all only happens when the type was bypassed, but the failure
  // still has to be an AppError rather than a bare TypeError out of `positions.length`.
  assert.throws(
    () => renderMesh({ triangleCount: 1 } as unknown as Mesh),
    validationSaying('must be a Float32Array'),
  )
  assert.throws(() => renderMesh({ positions: new Float32Array(0), triangleCount: 0 }), noTriangles)
  assert.throws(
    () => renderMesh({ positions: new Float32Array(9), triangleCount: -1 }),
    noTriangles,
  )
  assert.throws(
    () => renderMesh({ positions: new Float32Array(9), triangleCount: 2 }),
    validationSaying('does not match triangleCount * 9'),
  )
})

test('a nonsensical size is a Validation error', () => {
  const cube = cubeMesh()
  for (const size of [0, -1, 1.5, NaN, Infinity, 100_000]) {
    assert.throws(() => renderMesh(cube, { size }), validation, `size ${size} was accepted`)
  }
})

test('a mesh in the size class of the real library renders without blowing up', () => {
  // 600k triangles is a big model, not the biggest: the reference library's largest is
  // Baby Groot/Body_high_detail.stl at 3,295,832 triangles, 26 models are over 600k and 16
  // are over 1M. The measured ceiling for the whole 1,311-model library is 702 ms for a single
  // tile (mean 12.6 ms, p99 272 ms) — that is the number to size a preview queue against.
  // 600k is used here because it renders in ~100 ms, and what is being tested is that memory
  // stays bounded (nothing per-triangle is retained) and the result is still a valid tile.
  const image = renderMesh(manyTrianglesMesh(600_000))
  assert.equal(image.rgb.length, 256 * 256 * 3)
  assert.ok(distinctColours(image.rgb).size > 1, 'the large mesh rendered a blank tile')
})
