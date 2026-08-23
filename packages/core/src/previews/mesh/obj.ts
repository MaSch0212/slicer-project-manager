import { AppError } from '@spm/contract/errors.ts'
import type { Mesh } from './mesh.ts'

/**
 * Resolves a face's vertex-index token ("5", "-1", "5/2", "5/2/9", "5//9") to a 0-based
 * offset into the vertex list seen so far. Only the part before the first "/" is read: the
 * texture and normal indices that can follow are irrelevant to a shape-only preview.
 *
 * Negative indices count back from the end of the vertex list *as of this face line*, per
 * the OBJ spec, which is why this takes `vertexCount` rather than a fixed total.
 */
function resolveVertexIndex(token: string, vertexCount: number): number {
  const slash = token.indexOf('/')
  const raw = slash === -1 ? token : token.slice(0, slash)
  const index = Number(raw)
  if (!Number.isInteger(index) || index === 0) {
    throw new AppError('Validation', 'malformed face vertex index in OBJ file', { token })
  }
  const resolved = index > 0 ? index - 1 : vertexCount + index
  if (resolved < 0 || resolved >= vertexCount) {
    throw new AppError('Validation', 'face vertex index is out of range in OBJ file', { token })
  }
  return resolved
}

/**
 * Visits each logical line of an OBJ file in order, already stripped of a trailing `\r`,
 * anything from the first `#` onward (a comment can start anywhere on a line, not only at
 * the start), and leading/trailing whitespace.
 *
 * Walks `text` by index rather than `text.split('\n')`: splitting holds every line of the
 * file as a live string simultaneously (millions, for the multi-hundred-MB OBJs some slicer
 * libraries contain), where this holds at most one.
 */
function forEachLine(text: string, visit: (line: string) => void): void {
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const raw = text.slice(start, end)
    const hash = raw.indexOf('#')
    visit((hash === -1 ? raw : raw.slice(0, hash)).trim())
    start = end + 1
  }
}

/**
 * Parses Wavefront OBJ text into triangle soup.
 *
 * Only `v` and `f` are understood; everything else (`vn`, `vt`, `g`, `usemtl`, `o`, `s`,
 * `mtllib`, comments, blank lines) is skipped rather than failing the parse, per the brief.
 * A face with more than 3 vertices is fan-triangulated around its first vertex.
 *
 * Two passes over the text: the first only counts vertices and the triangles each face will
 * fan out to, so `vertices` and `positions` below can be exactly the right size from the
 * start. Per the bounded-memory constraint, triangle (and vertex) data belongs in typed
 * arrays, not a `number[]` that grows one push at a time and is copied into a `Float32Array`
 * only at the end — for a multi-hundred-MB OBJ that copy is a second full-size allocation
 * alive at the same time as the first. The second pass is the only one that resolves face
 * indices and validates coordinates; the first pass's own validation is limited to the
 * "fewer than 3 vertices" shape check, since that's what its triangle count depends on.
 */
export function parseObj(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes)

  let vertexCount = 0
  let triangleCount = 0
  forEachLine(text, (line) => {
    if (line.length === 0) return
    const tokens = line.split(/\s+/)
    if (tokens[0] === 'v') {
      vertexCount++
    } else if (tokens[0] === 'f') {
      const faceVertexCount = tokens.length - 1
      if (faceVertexCount < 3) {
        throw new AppError('Validation', 'face with fewer than 3 vertices in OBJ file', { line })
      }
      triangleCount += faceVertexCount - 2 // fan-triangulating an n-gon yields n-2 triangles
    }
  })

  if (triangleCount === 0) throw new AppError('Validation', 'OBJ file has no faces')

  const vertices = new Float32Array(vertexCount * 3)
  const positions = new Float32Array(triangleCount * 9)
  let vertexWrite = 0
  let positionWrite = 0

  forEachLine(text, (line) => {
    if (line.length === 0) return
    const tokens = line.split(/\s+/)
    const keyword = tokens[0]

    if (keyword === 'v') {
      const x = Number(tokens[1])
      const y = Number(tokens[2])
      const z = Number(tokens[3])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new AppError('Validation', 'non-finite vertex coordinate in OBJ file', { line })
      }
      vertices[vertexWrite++] = x
      vertices[vertexWrite++] = y
      vertices[vertexWrite++] = z
    } else if (keyword === 'f') {
      const faceTokens = tokens.slice(1)
      const vertexCountSoFar = vertexWrite / 3
      const idx = faceTokens.map((token) => resolveVertexIndex(token, vertexCountSoFar))
      // Fan-triangulate: every triangle shares idx[0], the rest walk the polygon's edge.
      for (let k = 1; k < idx.length - 1; k++) {
        for (const vi of [idx[0]!, idx[k]!, idx[k + 1]!]) {
          positions[positionWrite++] = vertices[vi * 3]!
          positions[positionWrite++] = vertices[vi * 3 + 1]!
          positions[positionWrite++] = vertices[vi * 3 + 2]!
        }
      }
    }
  })

  return { positions, triangleCount }
}
