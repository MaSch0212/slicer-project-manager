import type { Mesh } from '../../src/previews/mesh/mesh.ts'

/** Builds triangle soup from an array of flat x,y,z triples, checking the count as it goes. */
function mesh(values: number[]): Mesh {
  if (values.length % 9 !== 0) throw new Error('mesh fixture needs 9 floats per triangle')
  return { positions: Float32Array.from(values), triangleCount: values.length / 9 }
}

/** Applies a uniform scale, for the "renders the same at any absolute size" tests. */
export function scaleMesh(source: Mesh, factor: number): Mesh {
  const positions = new Float32Array(source.positions.length)
  for (let i = 0; i < positions.length; i++) positions[i] = source.positions[i]! * factor
  return { positions, triangleCount: source.triangleCount }
}

/** Concatenates two meshes, so a test can splice an extra triangle into a known model. */
export function concatMeshes(a: Mesh, b: Mesh): Mesh {
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions, 0)
  positions.set(b.positions, a.positions.length)
  return { positions, triangleCount: a.triangleCount + b.triangleCount }
}

const CUBE_CORNERS: readonly (readonly [number, number, number])[] = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
]

// Two triangles per face, counter-clockwise seen from outside. The winding is consistent
// here only so the fixture is easy to reason about; the rasterizer must not depend on it.
const CUBE_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 2, 1], // -Z
  [4, 5, 6, 7], // +Z
  [0, 1, 5, 4], // -Y
  [2, 3, 7, 6], // +Y
  [1, 2, 6, 5], // +X
  [3, 0, 4, 7], // -X
]

/** An axis-aligned unit cube centred on the origin: 12 triangles, 6 axis-aligned normals. */
export function cubeMesh(): Mesh {
  const values: number[] = []
  for (const [a, b, c, d] of CUBE_FACES) {
    for (const [i, j, k] of [
      [a, b, c],
      [a, c, d],
    ] as const) {
      values.push(...CUBE_CORNERS[i]!, ...CUBE_CORNERS[j]!, ...CUBE_CORNERS[k]!)
    }
  }
  return mesh(values)
}

/**
 * A tetrahedron standing on its base: four triangles, four distinct normals.
 *
 * Deliberately *not* the version built on alternating cube corners. That one has a face
 * normal of exactly (1, -1, 1), which is the isometric camera's own view direction, so it
 * renders as a flat triangle — correct, but useless as a test of a three-dimensional shape.
 */
export function tetrahedronMesh(): Mesh {
  const h = Math.sqrt(3) / 4 // half-height of an equilateral base of side 1
  const v: readonly (readonly [number, number, number])[] = [
    [0, 2 * h, -0.3],
    [0.5, -h, -0.3],
    [-0.5, -h, -0.3],
    [0, 0, 0.5],
  ]
  const values: number[] = []
  for (const [i, j, k] of [
    [0, 2, 1], // base
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ] as const) {
    values.push(...v[i]!, ...v[j]!, ...v[k]!)
  }
  return mesh(values)
}

/**
 * A UV sphere of unit radius: the smooth-ish model in the visual set.
 *
 * Flat-shaded facets are the point — a sphere is where a broken normal or a light aimed from
 * inside the model shows up as banding rather than a smooth gradient.
 */
export function sphereMesh(segments = 32, rings = 16): Mesh {
  const values: number[] = []
  const at = (ring: number, segment: number): [number, number, number] => {
    const theta = (ring / rings) * Math.PI
    const phi = (segment / segments) * 2 * Math.PI
    return [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)] as [
      number,
      number,
      number,
    ]
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = at(ring, segment)
      const b = at(ring + 1, segment)
      const c = at(ring + 1, segment + 1)
      const d = at(ring, segment + 1)
      // The pole rings collapse to a point on one side, which would make one of the two
      // triangles degenerate; emit only the triangle that has area there.
      if (ring > 0) values.push(...a, ...b, ...d)
      if (ring < rings - 1) values.push(...b, ...c, ...d)
    }
  }
  return mesh(values)
}

/** Three collinear points: a triangle with no area, which parsers happily pass through. */
export function degenerateTriangleMesh(): Mesh {
  return mesh([0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1])
}

/** A grid of pillars, sized to a triangle count in the range of the largest real models. */
export function manyTrianglesMesh(triangleTarget: number): Mesh {
  const boxes = Math.ceil(triangleTarget / 12)
  const side = Math.ceil(Math.sqrt(boxes))
  const values: number[] = []
  for (let n = 0; n < boxes; n++) {
    const ox = (n % side) / side
    const oy = Math.floor(n / side) / side
    const oz = ((n * 7) % 13) / 13
    for (const [a, b, c, d] of CUBE_FACES) {
      for (const [i, j, k] of [
        [a, b, c],
        [a, c, d],
      ] as const) {
        for (const corner of [CUBE_CORNERS[i]!, CUBE_CORNERS[j]!, CUBE_CORNERS[k]!]) {
          values.push(corner[0] / side + ox, corner[1] / side + oy, corner[2] / side + oz)
        }
      }
    }
  }
  return mesh(values)
}

/**
 * A box rotated about Z, as a part is routinely rotated to fit the print bed.
 *
 * At 45° this is the orientation an *exact* isometric camera cannot draw: the two side
 * normals become (1,1,0) and (1,-1,0), both perpendicular to the (1,-1,1) view direction, so
 * the box collapses into a flat two-tone rectangle. The camera's azimuth offset is what keeps
 * it a box.
 */
export function rotatedBoxMesh(degrees: number): Mesh {
  const angle = (degrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const source = cubeMesh()
  const positions = new Float32Array(source.positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = source.positions[i]!
    const y = source.positions[i + 1]!
    positions[i] = x * cos - y * sin
    positions[i + 1] = x * sin + y * cos
    positions[i + 2] = source.positions[i + 2]!
  }
  return { positions, triangleCount: source.triangleCount }
}

/**
 * A flat plate `aspect` times longer than it is wide: two triangles, real area, real normal.
 *
 * Drawable by every test the rasterizer applies, and yet it paints nothing. Once the fit
 * stretches its long axis across the frame, the short one is a fraction of a pixel wide and
 * slips between the sample points. This is the shape that shows why "did any triangle have
 * area" is not the same question as "did anything get drawn".
 */
export function thinPlateMesh(aspect: number): Mesh {
  const w = 0.5 / aspect
  return mesh([-0.5, -w, 0, 0.5, -w, 0, 0.5, w, 0, -0.5, -w, 0, 0.5, w, 0, -0.5, w, 0])
}

/**
 * A collinear triangle that reaches far past a unit model, and whose *projected* area is not
 * exactly zero.
 *
 * `degenerateTriangleMesh` runs along (1,1,1) through the origin, so its three projected
 * points land on exact halves and the screen-space cross product cancels to exactly 0. That
 * makes it indistinguishable from an edge-on triangle, and it cannot show that the
 * zero-normal half of the drawability test is doing anything.
 *
 * This one can. Every coordinate is a multiple of 1/64, so the vertices are exact in Float32
 * and `a`, `a + 3d`, `a + 8d` are exactly collinear (the face normal is exactly zero), but the
 * projection rounds to a screen area of +3.55e-15 rather than 0. Only the zero-normal
 * test rejects it — and it reaches to 13.5, so a fit that failed to reject it would shrink a
 * unit cube to a speck.
 */
export function farDegenerateTriangleMesh(): Mesh {
  return mesh([
    0.453125, 0.15625, -0.546875, 3.796875, -4.40625, -1.546875, 10.484375, -13.53125, -3.546875,
  ])
}
