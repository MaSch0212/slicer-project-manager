import type { AppError } from '@spm/contract/errors.ts'
import { parseObj } from '../src/previews/mesh/obj.ts'
import { assert, test } from './harness.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

test('a triangle face parses to one triangle', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
})

test('a quad face fan-triangulates into two triangles', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 2)
  assert.deepEqual(
    Array.from(mesh.positions),
    // Fan around vertex 0: (0,1,2) then (0,2,3).
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
  )
})

test('negative (relative) face indices resolve against the vertex count seen so far', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3 -2 -1\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
})

test('v/vt/vn face index forms ignore the texture and normal indices', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
})

test('a v//vn face index form (no texture index) also resolves correctly', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
})

test('a file of only comments (and no faces) is rejected', () => {
  const obj = '# just a comment\n# another one\n'
  assert.throws(() => parseObj(encode(obj)), validation)
})

test('a file with vertices but no faces is rejected', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\n'
  assert.throws(() => parseObj(encode(obj)), validation)
})

test('a face with a non-finite vertex coordinate is rejected', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv nan 1 0\nf 1 2 3\n'
  assert.throws(() => parseObj(encode(obj)), validation)
})

test('a face vertex index out of range is rejected', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 4\n'
  assert.throws(() => parseObj(encode(obj)), validation)
})

test('a face with fewer than 3 vertices is rejected, even alongside a valid face', () => {
  // A preceding valid triangle means a mesh with only the degenerate-face check disabled
  // would still produce non-empty output (and thus not trip the separate "no faces" check),
  // so this specifically exercises the fewer-than-3-vertices guard.
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\nf 1 2\n'
  assert.throws(() => parseObj(encode(obj)), validation)
})

test('g, usemtl and other directives are ignored rather than failing the parse', () => {
  const obj =
    'g mygroup\nusemtl material0\nv 0 0 0\nv 1 0 0\nv 1 1 0\ns off\nf 1 2 3\nmtllib x.mtl\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
})

test('a "#" comment starting partway through a line is truncated, not just one at line start', () => {
  const obj = 'v 0 0 0 # first corner\nv 1 0 0\nv 1 1 0\nf 1 2 3 # the face\n'
  const mesh = parseObj(encode(obj))
  assert.equal(mesh.triangleCount, 1)
  assert.deepEqual(Array.from(mesh.positions), [0, 0, 0, 1, 0, 0, 1, 1, 0])
})

test('a large fan produces the exact expected geometry under the two-pass rewrite', () => {
  // Exercises the counting pass and the filling pass agreeing on size/order at a scale where
  // an off-by-one in either pass (or in vertexWrite/positionWrite bookkeeping) would show up
  // as wrong data rather than just a wrong count.
  const n = 2000
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`v ${i} ${i * 2} 0`)
  lines.push(`f ${Array.from({ length: n }, (_, i) => i + 1).join(' ')}`)
  const mesh = parseObj(encode(lines.join('\n') + '\n'))

  const expectedTriangleCount = n - 2
  assert.equal(mesh.triangleCount, expectedTriangleCount)
  const expected = new Float32Array(expectedTriangleCount * 9)
  let w = 0
  for (let k = 1; k < n - 1; k++) {
    for (const vi of [0, k, k + 1]) {
      expected[w++] = vi
      expected[w++] = vi * 2
      expected[w++] = 0
    }
  }
  assert.deepEqual(mesh.positions, expected)
})
