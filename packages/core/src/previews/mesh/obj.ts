import { AppError } from '@spm/contract/errors.ts'
import { drainSink, feedSink, makeLineSink, openFile } from '../../files/chunks.ts'
import { allocateMesh, assertMeshFits, type MeshLimits } from './limits.ts'
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
 * One logical line of an OBJ file, stripped of anything from the first `#` onward (a comment can
 * start anywhere on a line, not only at the start) and of surrounding whitespace — which also
 * removes the `\r` of a CRLF file, so line endings never reach the token split.
 */
function normalizeObjLine(raw: string): string {
  const hash = raw.indexOf('#')
  return (hash === -1 ? raw : raw.slice(0, hash)).trim()
}

type ObjCounts = { vertexCount: number; triangleCount: number }

/**
 * Pass one: how many vertices, and how many triangles the faces will fan out to.
 *
 * Validation here is limited to the "fewer than 3 vertices" shape check, since that is what the
 * triangle count depends on; coordinates and index ranges are pass two's business.
 */
function makeObjCounter(): { visit: (raw: string) => void; counts: () => ObjCounts } {
  let vertexCount = 0
  let triangleCount = 0
  return {
    visit: (raw) => {
      const line = normalizeObjLine(raw)
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
    },
    counts: () => ({ vertexCount, triangleCount }),
  }
}

/** Pass two: the same lines, resolved and written into the arrays pass one sized. */
function makeObjFiller(counts: ObjCounts): { visit: (raw: string) => void; mesh: () => Mesh } {
  const vertices = allocateMesh(counts.vertexCount * 3, 'vertex table')
  const positions = allocateMesh(counts.triangleCount * 9, 'triangles')
  let vertexWrite = 0
  let positionWrite = 0

  return {
    visit: (raw) => {
      const line = normalizeObjLine(raw)
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
    },
    mesh: () => {
      // Only reachable if the file changed between the two passes; without it a shortened file
      // would return an array whose tail is zeroes and render a mesh with a spike at the origin.
      if (positionWrite !== positions.length) {
        throw new AppError('Validation', 'OBJ file changed while it was being read', {
          expectedFloats: positions.length,
          wroteFloats: positionWrite,
        })
      }
      return { positions, triangleCount: counts.triangleCount }
    },
  }
}

/** Shared by both entry points: what pass one proved, checked before pass two allocates. */
function checkedCounts(counts: ObjCounts, limits: MeshLimits | undefined): ObjCounts {
  if (counts.triangleCount === 0) throw new AppError('Validation', 'OBJ file has no faces')
  assertMeshFits(counts.vertexCount, counts.triangleCount, limits)
  return counts
}

/**
 * Parses Wavefront OBJ text out of a buffer the caller already holds.
 *
 * Only `v` and `f` are understood; everything else (`vn`, `vt`, `g`, `usemtl`, `o`, `s`,
 * `mtllib`, comments, blank lines) is skipped rather than failing the parse, per the brief.
 * A face with more than 3 vertices is fan-triangulated around its first vertex.
 *
 * Two passes over the input, so `vertices` and `positions` can be exactly the right size from the
 * start. Per the bounded-memory constraint, triangle (and vertex) data belongs in typed arrays,
 * not a `number[]` that grows one push at a time and is copied into a `Float32Array` only at the
 * end — for a multi-hundred-MB OBJ that copy is a second full-size allocation alive at the same
 * time as the first.
 *
 * Kept synchronous, and kept as the *only* place the format logic lives: `parseObjFile` runs the
 * identical visitors over a chunk stream, so there is no second parser to disagree with this one.
 */
export function parseObj(bytes: Uint8Array, limits?: MeshLimits): Mesh {
  const counter = makeObjCounter()
  feedSink(makeLineSink(counter.visit), bytes)
  const filler = makeObjFiller(checkedCounts(counter.counts(), limits))
  feedSink(makeLineSink(filler.visit), bytes)
  return filler.mesh()
}

/**
 * Parses an OBJ from disk without ever holding it whole.
 *
 * Two reads rather than two walks over one decoded string. The string was the expensive half:
 * `TextDecoder().decode()` of a 138 MB OBJ is a 138 MB one-byte string alive next to the 138 MB of
 * bytes it came from, on top of the mesh. Here the live text is one incomplete line.
 *
 * Reading the file twice costs almost nothing next to that: measured on the reference library's
 * only large OBJ (`Baby_Yoda.obj`, 138 MB, 1 556 670 triangles), 1 593 ms against the buffered
 * parser's 1 519 ms, +4.9%.
 */
export async function parseObjFile(absPath: string, limits?: MeshLimits): Promise<Mesh> {
  // One descriptor for both passes, per the note in `parseStlFile`.
  const file = openFile(absPath)
  try {
    const counter = makeObjCounter()
    await drainSink(makeLineSink(counter.visit), file.chunks())
    const filler = makeObjFiller(checkedCounts(counter.counts(), limits))
    await drainSink(makeLineSink(filler.visit), file.chunks())
    return filler.mesh()
  } finally {
    file.close()
  }
}
