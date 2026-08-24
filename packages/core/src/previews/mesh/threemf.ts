import { AppError } from '@spm/contract/errors.ts'
import { findZipEntry, readZipEntries, readZipEntryBytes } from '../../files/zip.ts'
import type { Mesh } from './mesh.ts'

const MODEL_ENTRY_NAME = '3D/3dmodel.model'

// The scan walks the inflated model part as raw UTF-8 bytes, never as a string. The model part
// of a real 3MF is routinely hundreds of megabytes (674 MB for the three "Köln Pokal" files in
// the reference library), and decoding it whole cost two ways. It is a second full-size copy
// alive at the same time as the bytes it was decoded from — measured at +466 MB of peak RSS for
// the 466 MB "Baby Groot" model, i.e. one byte per character, since V8 keeps an all-ASCII string
// in its one-byte representation rather than UTF-16. And past 0x1fffffe8 characters a string
// cannot exist at all: those three files died with a bare "Cannot create a string longer than
// 0x1fffffe8 characters", which is not an AppError and so escaped the queue's failure contract.
//
// Matching markers as bytes is exact rather than approximate: every element and attribute name
// in the 3MF core schema is ASCII, and UTF-8 is self-synchronising — a byte below 0x80 only
// ever appears as itself, never as part of a multi-byte sequence — so an ASCII needle can never
// match the interior of a non-ASCII character. Non-ASCII bytes can only occur inside attribute
// *values* or text content, which the marker search does not inspect.
const ENCODER = new TextEncoder()

/** A byte sequence to search for, plus the index of the byte the search anchors on. */
type Marker = { readonly bytes: Uint8Array; readonly anchor: number }

const marker = (text: string, anchor: number): Marker => ({
  bytes: ENCODER.encode(text),
  anchor,
})

// Each marker anchors on a byte chosen to be absent from the *other* elements, not on its first
// byte. Anchoring on byte 0 would anchor four of these five on '<' — the commonest byte in an XML
// document, one per element — so a cursor crossing a long stretch of the wrong element (the
// `<triangle` cursor traversing 400 MB of `<vertex>` before the first triangle, and the `<vertex`
// cursor traversing the triangles after the last one) would stop and compare at every single tag
// on the way. With a byte the other element does not contain, that whole stretch is one intrinsic
// scan and zero JS-level iterations: 'x' never appears in `<triangle v1=… v2=… v3=…/>`, 'g' never
// appears in `<vertex x=… y=… z=…/>`, and neither 'h' nor '!' appears in either. Measured at −24%
// on the marker scan of the 466 MB reference model.
const MESH_TAG = marker('<mesh', 4) // 'h'
const COMMENT_START = marker('<!--', 1) // '!'
const COMMENT_END = marker('-->', 2) // '>', rather than a '-' that every negative coordinate has
const VERTEX_MARKER = marker('<vertex', 6) // 'x'
const TRIANGLE_MARKER = marker('<triangle', 6) // 'g'
const GT = 0x3e // '>'

// Decoding is confined to bounded windows, and the tag slices taken out of them always run from a
// '<' byte to a '>' byte. Both are ASCII, so by the self-synchronisation property above such a cut
// can never begin or end mid-character; a multi-byte value inside the tag survives intact.
// (`TextDecoder` is also non-fatal by default, so even genuinely malformed bytes yield U+FFFD
// instead of throwing something that is not an AppError.)
const DECODER = new TextDecoder()

/**
 * How much of the document one decoded window covers, in bytes.
 *
 * Decoding each tag on its own was correct but call-bound: `TextDecoder.decode` costs ~107 ns for
 * a 60-byte tag against ~3 ns for a `slice` of a string that is already decoded, and the filling
 * pass runs it 8 million times on the reference model. A window holds ~130 tags, so the same work
 * costs one call instead of 130 — measured at −60% on the decode half of the pass. The live string
 * stays bounded by this constant no matter how large the document is, which is the property the
 * whole task exists to establish; 8 KB is small enough to be irrelevant next to the mesh arrays and
 * large enough that the per-call overhead has stopped mattering.
 */
const TAG_WINDOW_BYTES = 8192

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

function isXmlWhitespace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a
}

/**
 * `String.prototype.indexOf` for bytes. Finds the marker's anchor byte with the typed array's own
 * `indexOf` — a single intrinsic memchr-style scan rather than a JS loop over every position — and
 * only then compares the rest, so a near-miss costs one byte comparison. Each call resumes from
 * `from` and never rescans behind it, which is what keeps the caller's cursors linear.
 *
 * `from` is clamped at 0 because a negative `fromIndex` means "offset from the end" to
 * `TypedArray.prototype.indexOf`, not "the start" — handing it the -1 that every cursor here
 * uses for "not found" would quietly search only the tail instead of failing.
 */
function indexOfBytes(bytes: Uint8Array, needle: Marker, from: number): number {
  const { bytes: pattern, anchor } = needle
  const target = pattern[anchor]!
  const lastStart = bytes.length - pattern.length
  // The anchor byte can only be at or after `from + anchor`, since the match itself starts at or
  // after `from`. Probing from there rather than from `from` also keeps the search monotonic.
  let probe = (from < 0 ? 0 : from) + anchor
  for (;;) {
    probe = bytes.indexOf(target, probe)
    if (probe === -1) return -1
    const start = probe - anchor
    // `probe` only ever increases, so once the implied start is past the last possible one there
    // is nothing further to find.
    if (start > lastStart) return -1
    let i = 0
    while (i < pattern.length && bytes[start + i] === pattern[i]) i++
    if (i === pattern.length) return start
    probe++
  }
}

/**
 * Finds the next `<name ...>` element start at or after `from`, requiring real XML whitespace
 * right after the element name rather than a literal space: a pretty-printer that wraps a
 * long attribute list onto its own line (`<vertex\n  x="0" .../>`) is still recognised, where
 * a plain search for `'<vertex '` would see no marker at all and silently skip the whole
 * element. A same-prefixed false start (there is none in the 3MF core schema, but the check is
 * cheap) is skipped by resuming the search right after it, keeping the cursor monotonic.
 */
function indexOfTag(bytes: Uint8Array, needle: Marker, from: number): number {
  let at = from
  for (;;) {
    at = indexOfBytes(bytes, needle, at)
    if (at === -1) return -1
    if (isXmlWhitespace(bytes[at + needle.bytes.length])) return at
    at += needle.bytes.length
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

/**
 * Called with the byte range of one tag, from its `<` up to and including its `>` (end
 * exclusive). Offsets rather than a decoded string so the counting pass, which only needs to
 * know that a tag was seen, does no decoding and allocates nothing per vertex or triangle.
 */
type TagVisitor = (start: number, end: number) => void

/**
 * Returns `bytes[start, end)` as text, decoding a `TAG_WINDOW_BYTES` window around it and serving
 * later tags out of that window until one falls outside. Tags arrive in document order and only
 * ever move forward, so in practice each window is decoded once and then sliced ~130 times.
 *
 * A window always begins at a tag's own `<`, so it never *starts* mid-character; its far end may
 * cut one, and a document may contain multi-byte characters anywhere in any case. Both are handled
 * by one check rather than by arithmetic: a byte offset may be used as a string index only if
 * every code unit in the window came from exactly one byte, and since no code unit can be produced
 * from less than one byte, `window.length === limit - base` proves exactly that. Any window
 * containing a multi-byte character — or clipping one at its edge — comes out shorter and falls
 * back to decoding its tags individually, which is slower but identical in result. That is what
 * makes this correct on a UTF-8 document rather than only on an ASCII one.
 */
function makeTagReader(bytes: Uint8Array): (start: number, end: number) => string {
  let base = 0
  let limit = 0
  let window = ''
  let aligned = false

  return (start, end) => {
    if (start < base || end > limit) {
      const nextLimit = Math.min(bytes.length, start + TAG_WINDOW_BYTES)
      if (end > nextLimit) {
        // A single tag longer than the window. No real producer writes one, and growing the
        // window for it would make the live string a function of the document rather than a
        // constant, so this one tag is decoded on its own and the window is left alone.
        return DECODER.decode(bytes.subarray(start, end))
      }
      base = start
      limit = nextLimit
      window = DECODER.decode(bytes.subarray(base, limit))
      aligned = window.length === limit - base
    }
    return aligned
      ? window.slice(start - base, end - base)
      : DECODER.decode(bytes.subarray(start, end))
  }
}

/**
 * Walks 3MF model XML once, calling back for each `<mesh>` boundary, `<vertex>` tag, and
 * `<triangle>` tag in document order — skipping anything inside an XML comment, since a
 * commented-out element must not be ingested as real geometry (it would silently shift every
 * later local vertex index by one). Shared between the counting and filling passes in
 * `parse3mfMesh` so both agree exactly on what counts as geometry; their comment-handling
 * can't drift apart because there is only one copy of it.
 *
 * No DOM, no whole-document string, and no regex over the whole document: byte-level
 * `indexOf`-based cursors are cached per marker kind (`<mesh`, `<vertex`, `<triangle`, `<!--`)
 * and only ever advanced forward, so the whole walk is O(document length) regardless of how the
 * four kinds interleave or how sparse any one of them is. Comments can't defeat that bound
 * either: finding one only ever pushes the *other* cursors forward past its end, never back,
 * and comments cannot nest or contain the literal text "--" (forbidden by the XML spec), so
 * searching for `-->` always finds the true close.
 *
 * Assumes the default (unprefixed) 3MF core XML namespace. A namespace-prefixed producer
 * (`<m:vertex>`) yields no geometry from this scan and fails cleanly downstream with "3MF
 * model has no triangles" rather than being handled — an accepted gap for the 3MF *core*
 * format this targets, not a bug.
 */
function scanMarkers(
  bytes: Uint8Array,
  onMesh: () => void,
  onVertex: TagVisitor,
  onTriangle: TagVisitor,
): void {
  let meshAt = indexOfBytes(bytes, MESH_TAG, 0)
  let vertexAt = indexOfTag(bytes, VERTEX_MARKER, 0)
  let triangleAt = indexOfTag(bytes, TRIANGLE_MARKER, 0)
  let commentAt = indexOfBytes(bytes, COMMENT_START, 0)

  for (;;) {
    let next = -1
    if (meshAt !== -1) next = meshAt
    if (vertexAt !== -1 && (next === -1 || vertexAt < next)) next = vertexAt
    if (triangleAt !== -1 && (next === -1 || triangleAt < next)) next = triangleAt
    if (commentAt !== -1 && (next === -1 || commentAt < next)) next = commentAt
    if (next === -1) break

    if (next === commentAt) {
      const commentEnd = indexOfBytes(bytes, COMMENT_END, commentAt + COMMENT_START.bytes.length)
      if (commentEnd === -1) {
        throw new AppError('Validation', 'unterminated XML comment in 3MF model')
      }
      const past = commentEnd + COMMENT_END.bytes.length
      // Any marker already cached inside [commentAt, past) was found by a plain search that
      // doesn't know about comments; re-search it from past the comment's close.
      if (meshAt !== -1 && meshAt < past) meshAt = indexOfBytes(bytes, MESH_TAG, past)
      if (vertexAt !== -1 && vertexAt < past) vertexAt = indexOfTag(bytes, VERTEX_MARKER, past)
      if (triangleAt !== -1 && triangleAt < past) {
        triangleAt = indexOfTag(bytes, TRIANGLE_MARKER, past)
      }
      commentAt = indexOfBytes(bytes, COMMENT_START, past)
      continue
    }

    if (next === meshAt) {
      onMesh()
      meshAt = indexOfBytes(bytes, MESH_TAG, meshAt + MESH_TAG.bytes.length)
      continue
    }

    if (next === vertexAt) {
      const tagEnd = bytes.indexOf(GT, vertexAt)
      if (tagEnd === -1) {
        throw new AppError('Validation', 'unterminated <vertex> tag in 3MF model')
      }
      onVertex(vertexAt, tagEnd + 1)
      vertexAt = indexOfTag(bytes, VERTEX_MARKER, tagEnd + 1)
      continue
    }

    // next === triangleAt
    const tagEnd = bytes.indexOf(GT, triangleAt)
    if (tagEnd === -1) {
      throw new AppError('Validation', 'unterminated <triangle> tag in 3MF model')
    }
    onTriangle(triangleAt, tagEnd + 1)
    triangleAt = indexOfTag(bytes, TRIANGLE_MARKER, tagEnd + 1)
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
 *
 * The scan runs over the inflated bytes; only individual tags are ever decoded to a string.
 */
export function parse3mfMesh(absPath: string): Mesh {
  const entries = readZipEntries(absPath)
  const modelEntry = findZipEntry(entries, MODEL_ENTRY_NAME)
  if (!modelEntry) {
    throw new AppError('Validation', `3MF file has no ${MODEL_ENTRY_NAME} entry`)
  }
  const bytes = readZipEntryBytes(absPath, modelEntry)

  let vertexCount = 0
  let triangleCount = 0
  scanMarkers(
    bytes,
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
  const readTag = makeTagReader(bytes)

  scanMarkers(
    bytes,
    () => {
      // A <triangle>'s v1/v2/v3 index into its *own* <mesh>'s <vertices> list, per the 3MF
      // spec, not a document-wide list — this is what keeps a second object's local index 0
      // from silently resolving to the first object's first vertex.
      vertexBase = vertexWrite / 3
    },
    (start, end) => {
      const tag = readTag(start, end)
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
    (start, end) => {
      const tag = readTag(start, end)
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
