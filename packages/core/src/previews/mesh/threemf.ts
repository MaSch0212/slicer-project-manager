import { AppError } from '@spm/contract/errors.ts'
import { findZipEntry, readZipEntries, readZipEntryBytes } from '../../files/zip.ts'
import type { Mesh } from './mesh.ts'

const MODEL_ENTRY_NAME = '3D/3dmodel.model'

const MESH_TAG = '<mesh'
const COMMENT_START = '<!--'
const COMMENT_END = '-->'

// Accepts both quote styles and arbitrary XML whitespace around "=" (a pretty-printer is free
// to write `x = '0'`), anchored on "start-of-tag-or-whitespace" rather than `\b`: a hyphen is
// a word-boundary character but not whitespace, so `\b` would let a decoy like `p-x="77"` be
// mistaken for the `x` attribute.
const X_ATTR = /(?:^|\s)x\s*=\s*(?:"([^"]*)"|'([^']*)')/
const Y_ATTR = /(?:^|\s)y\s*=\s*(?:"([^"]*)"|'([^']*)')/
const Z_ATTR = /(?:^|\s)z\s*=\s*(?:"([^"]*)"|'([^']*)')/
const V1_ATTR = /(?:^|\s)v1\s*=\s*(?:"([^"]*)"|'([^']*)')/
const V2_ATTR = /(?:^|\s)v2\s*=\s*(?:"([^"]*)"|'([^']*)')/
const V3_ATTR = /(?:^|\s)v3\s*=\s*(?:"([^"]*)"|'([^']*)')/

function isXmlWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

/**
 * Finds the next `<name ...>` element start at or after `from`, requiring real XML whitespace
 * right after the element name rather than a literal space: a pretty-printer that wraps a
 * long attribute list onto its own line (`<vertex\n  x="0" .../>`) is still recognised, where
 * a plain `indexOf('<vertex ')` would see no marker at all and silently skip the whole element.
 * A same-prefixed false start (there is none in the 3MF core schema, but the check is cheap)
 * is skipped by resuming the search right after it, keeping the cursor monotonic.
 */
function indexOfTag(text: string, name: string, from: number): number {
  const marker = '<' + name
  let at = from
  for (;;) {
    at = text.indexOf(marker, at)
    if (at === -1) return -1
    if (isXmlWhitespace(text[at + marker.length])) return at
    at += marker.length
  }
}

/**
 * Reads one required, non-empty attribute out of an already-isolated tag's text. An empty or
 * whitespace-only value (`x=""`) would otherwise reach `Number()` as `0` — finite and a valid
 * integer — passing every downstream guard while silently placing a vertex or triangle index
 * at 0 instead of failing.
 */
function readAttr(tag: string, re: RegExp, name: string): string {
  const match = re.exec(tag)
  const value = match ? (match[1] ?? match[2]) : undefined
  if (value === undefined || value.trim().length === 0) {
    throw new AppError('Validation', `3MF tag is missing a valid "${name}" attribute`, { tag })
  }
  return value
}

type VertexVisitor = (tag: string) => void
type TriangleVisitor = (tag: string) => void

/**
 * Walks 3MF model XML once, calling back for each `<mesh>` boundary, `<vertex>` tag, and
 * `<triangle>` tag in document order — skipping anything inside an XML comment, since a
 * commented-out element must not be ingested as real geometry (it would silently shift every
 * later local vertex index by one). Shared between the counting and filling passes in
 * `parse3mfMesh` so both agree exactly on what counts as geometry; their comment-handling
 * can't drift apart because there is only one copy of it.
 *
 * No DOM, and no regex over the whole document: `indexOf`-based cursors are cached per marker
 * kind (`<mesh`, `<vertex`, `<triangle`, `<!--`) and only ever advanced forward, so the whole
 * walk is O(document length) regardless of how the four kinds interleave or how sparse any
 * one of them is. Comments can't defeat that bound either: finding one only ever pushes the
 * *other* cursors forward past its end, never back, and comments cannot nest or contain the
 * literal text "--" (forbidden by the XML spec), so `indexOf(COMMENT_END, ...)` always finds
 * the true close.
 *
 * Assumes the default (unprefixed) 3MF core XML namespace. A namespace-prefixed producer
 * (`<m:vertex>`) yields no geometry from this scan and fails cleanly downstream with "3MF
 * model has no triangles" rather than being handled — an accepted gap for the 3MF *core*
 * format this targets, not a bug.
 */
function scanMarkers(
  text: string,
  onMesh: () => void,
  onVertex: VertexVisitor,
  onTriangle: TriangleVisitor,
): void {
  let meshAt = text.indexOf(MESH_TAG)
  let vertexAt = indexOfTag(text, 'vertex', 0)
  let triangleAt = indexOfTag(text, 'triangle', 0)
  let commentAt = text.indexOf(COMMENT_START)

  for (;;) {
    let next = -1
    if (meshAt !== -1) next = meshAt
    if (vertexAt !== -1 && (next === -1 || vertexAt < next)) next = vertexAt
    if (triangleAt !== -1 && (next === -1 || triangleAt < next)) next = triangleAt
    if (commentAt !== -1 && (next === -1 || commentAt < next)) next = commentAt
    if (next === -1) break

    if (next === commentAt) {
      const commentEnd = text.indexOf(COMMENT_END, commentAt + COMMENT_START.length)
      if (commentEnd === -1) {
        throw new AppError('Validation', 'unterminated XML comment in 3MF model')
      }
      const past = commentEnd + COMMENT_END.length
      // Any marker already cached inside [commentAt, past) was found by a plain-text search
      // that doesn't know about comments; re-search it from past the comment's close.
      if (meshAt !== -1 && meshAt < past) meshAt = text.indexOf(MESH_TAG, past)
      if (vertexAt !== -1 && vertexAt < past) vertexAt = indexOfTag(text, 'vertex', past)
      if (triangleAt !== -1 && triangleAt < past) triangleAt = indexOfTag(text, 'triangle', past)
      commentAt = text.indexOf(COMMENT_START, past)
      continue
    }

    if (next === meshAt) {
      onMesh()
      meshAt = text.indexOf(MESH_TAG, meshAt + MESH_TAG.length)
      continue
    }

    if (next === vertexAt) {
      const tagEnd = text.indexOf('>', vertexAt)
      if (tagEnd === -1) {
        throw new AppError('Validation', 'unterminated <vertex> tag in 3MF model')
      }
      onVertex(text.slice(vertexAt, tagEnd + 1))
      vertexAt = indexOfTag(text, 'vertex', tagEnd + 1)
      continue
    }

    // next === triangleAt
    const tagEnd = text.indexOf('>', triangleAt)
    if (tagEnd === -1) {
      throw new AppError('Validation', 'unterminated <triangle> tag in 3MF model')
    }
    onTriangle(text.slice(triangleAt, tagEnd + 1))
    triangleAt = indexOfTag(text, 'triangle', tagEnd + 1)
  }
}

/**
 * Parses the mesh geometry out of a 3MF file's `3D/3dmodel.model` entry, concatenating every
 * `<object>`'s mesh found in the document into one triangle soup. `<build>`/`<item>`
 * transforms are never read — the thumbnail only needs the shape, and the rasterizer fits its
 * own bounding box, so per-object placement on the build plate is irrelevant here.
 *
 * Runs `scanMarkers` twice: once to count vertices and triangles so `vertices` and the
 * returned `positions` can be allocated as exactly-sized typed arrays up front, then again to
 * fill them. Per the bounded-memory constraint, triangle data belongs in typed arrays, not a
 * `number[]` accumulator copied into a `Float32Array` only at the end — for the 54 MB 3MFs the
 * reference library actually contains, that copy is a second full-size allocation alive at the
 * same time as the first. The extra linear scan costs roughly half again the time to buy back
 * most of the memory, which measured out worth it (see the task report).
 */
export function parse3mfMesh(absPath: string): Mesh {
  const entries = readZipEntries(absPath)
  const modelEntry = findZipEntry(entries, MODEL_ENTRY_NAME)
  if (!modelEntry) {
    throw new AppError('Validation', `3MF file has no ${MODEL_ENTRY_NAME} entry`)
  }
  const text = new TextDecoder().decode(readZipEntryBytes(absPath, modelEntry))

  let vertexCount = 0
  let triangleCount = 0
  scanMarkers(
    text,
    () => {},
    () => {
      vertexCount++
    },
    () => {
      triangleCount++
    },
  )
  if (triangleCount === 0) {
    throw new AppError('Validation', '3MF model has no triangles')
  }

  const vertices = new Float32Array(vertexCount * 3)
  const positions = new Float32Array(triangleCount * 9)
  let vertexWrite = 0
  let positionWrite = 0
  let vertexBase = 0 // where the current <mesh>'s vertices start, in vertex (not float) units

  scanMarkers(
    text,
    () => {
      // A <triangle>'s v1/v2/v3 index into its *own* <mesh>'s <vertices> list, per the 3MF
      // spec, not a document-wide list — this is what keeps a second object's local index 0
      // from silently resolving to the first object's first vertex.
      vertexBase = vertexWrite / 3
    },
    (tag) => {
      const x = Number(readAttr(tag, X_ATTR, 'x'))
      const y = Number(readAttr(tag, Y_ATTR, 'y'))
      const z = Number(readAttr(tag, Z_ATTR, 'z'))
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new AppError('Validation', 'non-finite vertex coordinate in 3MF model', { tag })
      }
      vertices[vertexWrite++] = x
      vertices[vertexWrite++] = y
      vertices[vertexWrite++] = z
    },
    (tag) => {
      const localCount = vertexWrite / 3 - vertexBase
      for (const [re, name] of [
        [V1_ATTR, 'v1'],
        [V2_ATTR, 'v2'],
        [V3_ATTR, 'v3'],
      ] as const) {
        const index = Number(readAttr(tag, re, name))
        if (!Number.isInteger(index) || index < 0 || index >= localCount) {
          throw new AppError('Validation', 'triangle vertex index out of range in 3MF model', {
            tag,
          })
        }
        const vi = vertexBase + index
        positions[positionWrite++] = vertices[vi * 3]!
        positions[positionWrite++] = vertices[vi * 3 + 1]!
        positions[positionWrite++] = vertices[vi * 3 + 2]!
      }
    },
  )

  return { positions, triangleCount }
}
