import { AppError } from '@spm/contract/errors.ts'
import { drainSink, type ChunkSink } from '../../files/chunks.ts'
import { findZipEntry, readZipEntries, readZipEntryChunks } from '../../files/zip.ts'
import { allocateMesh, assertMeshFits, type MeshLimits } from './limits.ts'
import type { Mesh } from './mesh.ts'

const MODEL_ENTRY_NAME = '3D/3dmodel.model'

// The scan walks the inflated model part as raw UTF-8 bytes, never as a string, and now never as
// one buffer either. The model part of a real 3MF is routinely hundreds of megabytes (674 MB for
// the three "Köln Pokal" files in the reference library), and decoding it whole cost two ways. It
// is a second full-size copy alive at the same time as the bytes it was decoded from — measured at
// +466 MB of peak RSS for the 466 MB "Baby Groot" model, i.e. one byte per character, since V8
// keeps an all-ASCII string in its one-byte representation rather than UTF-16. And past
// 0x1fffffe8 characters a string cannot exist at all: those three files died with a bare "Cannot
// create a string longer than 0x1fffffe8 characters", which is not an AppError and so escaped the
// queue's failure contract.
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

/**
 * How many bytes of the model part are held at once.
 *
 * This is the *whole* of the parser's document-side memory: bytes arrive from
 * `readZipEntryChunks`, are copied into this one buffer, and the buffer is compacted down to the
 * earliest byte any cursor still needs after every scan. So peak is `this + the mesh arrays + the
 * inflater's own queue`, and none of the three is a function of the model part's size.
 *
 * Chosen an order of magnitude above the largest thing that has to fit in it whole — one tag,
 * `TAG_WINDOW_BYTES` being the point past which even the decoder stops trying — so that the
 * compaction the scan does after each window moves a few dozen bytes rather than most of the
 * buffer, while staying small enough to be noise next to a 100 MB mesh. Comments are *not* bound
 * by it: a comment whose close has not arrived is scanned a window at a time and then thrown away
 * except for the two bytes a straddling `-->` could need (see `makeModelScanner`), so a
 * multi-megabyte comment costs scanning and no memory.
 */
const WINDOW_BYTES = 256 * 1024

/**
 * The chunk size asked of `readZipEntryChunks`.
 *
 * Only a loop-granularity knob: every chunk is copied into the window and dropped, so this bounds
 * neither the window nor what the inflater holds (that is `COMPRESSED_SLICE_BYTES × the entry's
 * compression ratio`, and the archive picks the ratio). Kept well under `WINDOW_BYTES` so that a
 * chunk never has to be split across two window fills in the common case.
 */
const ZIP_CHUNK_BYTES = 64 * 1024

/**
 * How close to the end of a window a marker may start and still be acted on.
 *
 * `<triangle` is the longest marker at 9 bytes, and `indexOfTag` reads the byte *after* the name to
 * insist on real XML whitespace, so the last 10 bytes of a window are a place where a marker may be
 * present but unrecognisable. Anything found at or after `windowLength - this` is therefore left
 * for the next window rather than processed, and — the half that actually matters — anything *not*
 * found is only proven absent below that line. Getting this too small does not merely slow the scan
 * down; it silently drops the geometry that straddles a window boundary.
 */
const MARKER_LOOKAHEAD = 10

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
 *
 * At the very end of a window the byte after the name may simply not have arrived yet, and this
 * cannot tell that apart from a false start — which is exactly why `MARKER_LOOKAHEAD` exists and
 * why nothing found in that tail is trusted either way.
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
 * exclusive), **relative to the window it was found in**. Offsets rather than a decoded string so
 * the counting pass, which only needs to know that a tag was seen, does no decoding and allocates
 * nothing per vertex or triangle.
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

/** What one pass over one window found, and where the next window has to start. */
type WindowScan = {
  /** Bytes the caller may discard. Everything from here on is still needed. */
  consumedTo: number
  /** `consumedTo` points at a `<!--` whose `-->` is not in this window; skip to past it. */
  enteredComment: boolean
}

/**
 * Walks one window of 3MF model XML, calling back for each `<mesh>` boundary, `<vertex>` tag, and
 * `<triangle>` tag in document order — skipping anything inside an XML comment, since a
 * commented-out element must not be ingested as real geometry (it would silently shift every
 * later local vertex index by one). Shared between the counting and filling passes in
 * `parse3mfMesh` so both agree exactly on what counts as geometry; their comment-handling
 * can't drift apart because there is only one copy of it.
 *
 * No DOM, no whole-document string, and no regex over the whole document: byte-level
 * `indexOf`-based cursors are cached per marker kind (`<mesh`, `<vertex`, `<triangle`, `<!--`)
 * and only ever advanced forward. **Within a window** that makes the walk O(window length)
 * whatever the interleaving, and across windows it stays O(document length) because each of the
 * four cursors traverses each window exactly once — which is the same four traversals a
 * whole-document scan made, just cut into pieces. What it is *not* is a fresh search per tag:
 * dropping the cursor cache would make the `<triangle` search re-cross the entire run of vertices
 * for every vertex, and that is the quadratic the scaling test in `threemf.test.ts` catches.
 * Comments can't defeat the bound either: finding one only ever pushes the *other* cursors forward
 * past its end, never back, and comments cannot nest or contain the literal text "--" (forbidden
 * by the XML spec), so searching for `-->` always finds the true close.
 *
 * Nothing in the last `MARKER_LOOKAHEAD` bytes is acted on unless `final`, because a marker there
 * may be cut in half by the window edge — and, more subtly, a marker *not* found is only proven
 * absent up to that same line. Both directions of that are what makes the answer independent of
 * where the chunk boundaries happen to fall.
 *
 * Assumes the default (unprefixed) 3MF core XML namespace. A namespace-prefixed producer
 * (`<m:vertex>`) yields no geometry from this scan and fails cleanly downstream with "3MF
 * model has no triangles" rather than being handled — an accepted gap for the 3MF *core*
 * format this targets, not a bug.
 */
function scanWindow(
  bytes: Uint8Array,
  final: boolean,
  onMesh: () => void,
  onVertex: TagVisitor,
  onTriangle: TagVisitor,
): WindowScan {
  const limit = final ? bytes.length : bytes.length - MARKER_LOOKAHEAD
  if (limit <= 0) return { consumedTo: 0, enteredComment: false }

  let meshAt = indexOfBytes(bytes, MESH_TAG, 0)
  let vertexAt = indexOfTag(bytes, VERTEX_MARKER, 0)
  let triangleAt = indexOfTag(bytes, TRIANGLE_MARKER, 0)
  let commentAt = indexOfBytes(bytes, COMMENT_START, 0)
  // How far this window has definitively consumed. Only `limit` can fall behind it — a comment
  // may close past the point where a marker stops being trustworthy — and dropping less than this
  // would hand the *next* window bytes that have already been interpreted. That is not merely
  // wasteful: the tail of a skipped comment re-entering the scan as document text is a
  // commented-out `<mesh` becoming a real object boundary, which silently rebases every later
  // triangle index.
  let processedTo = 0

  for (;;) {
    let next = -1
    if (meshAt !== -1) next = meshAt
    if (vertexAt !== -1 && (next === -1 || vertexAt < next)) next = vertexAt
    if (triangleAt !== -1 && (next === -1 || triangleAt < next)) next = triangleAt
    if (commentAt !== -1 && (next === -1 || commentAt < next)) next = commentAt
    // Nothing left in this window, or nothing left that is far enough from its edge to be read
    // safely. Either way the bytes from here on are the next window's problem.
    if (next === -1) return { consumedTo: Math.max(limit, processedTo), enteredComment: false }
    if (next >= limit) return { consumedTo: next, enteredComment: false }

    if (next === commentAt) {
      const commentEnd = indexOfBytes(bytes, COMMENT_END, commentAt + COMMENT_START.bytes.length)
      if (commentEnd === -1) {
        if (final) throw new AppError('Validation', 'unterminated XML comment in 3MF model')
        return { consumedTo: commentAt, enteredComment: true }
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
      processedTo = past
      continue
    }

    if (next === meshAt) {
      onMesh()
      processedTo = meshAt + MESH_TAG.bytes.length
      meshAt = indexOfBytes(bytes, MESH_TAG, processedTo)
      continue
    }

    if (next === vertexAt) {
      const tagEnd = bytes.indexOf(GT, vertexAt)
      if (tagEnd === -1) {
        if (final) throw new AppError('Validation', 'unterminated <vertex> tag in 3MF model')
        return { consumedTo: vertexAt, enteredComment: false }
      }
      onVertex(vertexAt, tagEnd + 1)
      processedTo = tagEnd + 1
      vertexAt = indexOfTag(bytes, VERTEX_MARKER, tagEnd + 1)
      continue
    }

    // next === triangleAt
    const tagEnd = bytes.indexOf(GT, triangleAt)
    if (tagEnd === -1) {
      if (final) throw new AppError('Validation', 'unterminated <triangle> tag in 3MF model')
      return { consumedTo: triangleAt, enteredComment: false }
    }
    onTriangle(triangleAt, tagEnd + 1)
    processedTo = tagEnd + 1
    triangleAt = indexOfTag(bytes, TRIANGLE_MARKER, tagEnd + 1)
  }
}

type ScanVisitors = {
  /** The window the offsets handed to the visitors below refer to. Called before each scan. */
  onWindow: (bytes: Uint8Array) => void
  onMesh: () => void
  onVertex: TagVisitor
  onTriangle: TagVisitor
}

/**
 * Feeds `scanWindow` from a chunk stream, holding at most `WINDOW_BYTES` of the document.
 *
 * The carry-over is a copy, and deliberately so: `readZipEntryChunks` yields views into buffers
 * the inflater owns, each of which is `COMPRESSED_SLICE_BYTES × the entry's compression ratio`
 * (947 KB at the reference library's worst, 32 MiB on a 1029:1 archive), so retaining a chunk in
 * order to join it to the next one would pin something two orders of magnitude larger than the
 * bytes actually wanted. Copying into `buf` costs one pass over the entry and makes the bound
 * exact.
 *
 * Comments are the one construct that may legally run longer than the window, and they are skipped
 * *through* the stream rather than buffered: once the opening `<!--` is seen without its close, the
 * window is emptied down to the two bytes a straddling `-->` could need and refilled until the
 * close turns up. A 100 MB comment therefore costs 100 MB of scanning and no memory at all.
 */
function makeModelScanner(visitors: ScanVisitors): ChunkSink<void> {
  const buf = new Uint8Array(WINDOW_BYTES)
  let len = 0
  let inComment = false
  let commentFrom = 0

  const drop = (count: number): void => {
    if (count <= 0) return
    buf.copyWithin(0, count, len)
    len -= count
  }

  const drain = (final: boolean): void => {
    for (;;) {
      if (inComment) {
        const at = indexOfBytes(buf.subarray(0, len), COMMENT_END, commentFrom)
        if (at === -1) {
          if (final) throw new AppError('Validation', 'unterminated XML comment in 3MF model')
          drop(Math.max(0, len - (COMMENT_END.bytes.length - 1)))
          commentFrom = 0
          return
        }
        drop(at + COMMENT_END.bytes.length)
        inComment = false
        commentFrom = 0
      }

      const window = buf.subarray(0, len)
      visitors.onWindow(window)
      const scan = scanWindow(
        window,
        final,
        visitors.onMesh,
        visitors.onVertex,
        visitors.onTriangle,
      )
      drop(scan.consumedTo)
      if (scan.enteredComment) {
        inComment = true
        commentFrom = COMMENT_START.bytes.length
        continue
      }
      // A full window that the scan could not advance through at all means one tag is wider than
      // the whole window. Refusing beats growing: the buffer would otherwise become a function of
      // the document, which is the property this parser exists to not have.
      if (!final && len === buf.length) {
        throw new AppError(
          'Validation',
          `3MF model has a tag longer than the parser's ${WINDOW_BYTES}-byte window`,
          { windowBytes: WINDOW_BYTES },
        )
      }
      return
    }
  }

  return {
    push(chunk) {
      let at = 0
      while (at < chunk.byteLength) {
        const take = Math.min(chunk.byteLength - at, buf.length - len)
        buf.set(chunk.subarray(at, at + take), len)
        len += take
        at += take
        if (len === buf.length) drain(false)
      }
    },
    end() {
      drain(true)
    },
  }
}

/**
 * Parses the mesh geometry out of a 3MF file's `3D/3dmodel.model` entry, concatenating every
 * `<object>`'s mesh found in the document into one triangle soup. `<build>`/`<item>`
 * transforms are never read — the thumbnail only needs the shape, and the rasterizer fits its
 * own bounding box, so per-object placement on the build plate is irrelevant here.
 *
 * Runs the same scan twice: once to count vertices and triangles so `vertices` and the returned
 * `positions` can be allocated as exactly-sized typed arrays up front, then again to fill them.
 * Per the bounded-memory constraint, triangle data belongs in typed arrays, not a `number[]`
 * accumulator copied into a `Float32Array` only at the end — that copy is a second full-size
 * allocation alive at the same time as the first.
 *
 * **A second pass is a second stream, not a retained buffer**, and that is the trade this parser
 * makes. Measured against the buffered version on the two largest 3MFs in the reference library:
 * "Köln Pokal" 13.8 s against 10.6 s (+30%, 707 017 311 bytes of inflated model part) and "Baby
 * Groot" 10.3 s against 6.7 s (+55%). What it buys is those hundreds of megabytes leaving the
 * peak entirely; nothing in between holds more than `WINDOW_BYTES`. (STL and OBJ went the other
 * way — see `parseStlFile`.)
 *
 * **Asynchronous because the chunked reader is**, and no further than it has to be:
 * `readZipEntryChunks` is built on `DecompressionStream`, which is a `TransformStream` and
 * therefore cannot be pulled synchronously. The only caller is `readMesh`, whose only caller is
 * `MESH_HANDLER.run`, which already returns a `Promise` — so async travels exactly two frames and
 * stops at a boundary that was already asynchronous. `classify3mf` and `extractEmbeddedThumbnail`,
 * which read a few kilobytes of config XML out of the same archives, keep the synchronous
 * buffered reader and are untouched.
 */
export async function parse3mfMesh(absPath: string, limits?: MeshLimits): Promise<Mesh> {
  const entries = readZipEntries(absPath)
  const modelEntry = findZipEntry(entries, MODEL_ENTRY_NAME)
  if (!modelEntry) {
    throw new AppError('Validation', `3MF file has no ${MODEL_ENTRY_NAME} entry`)
  }
  // One pass over the entry: a fresh inflater and a fresh window, holding nothing from the last.
  const scan = (visitors: ScanVisitors): Promise<void> =>
    drainSink(
      makeModelScanner(visitors),
      readZipEntryChunks(absPath, modelEntry, { maxChunkBytes: ZIP_CHUNK_BYTES }),
    )
  const nothing = (): void => {}

  let vertexCount = 0
  let triangleCount = 0
  await scan({
    onWindow: nothing,
    onMesh: nothing,
    onVertex: () => {
      vertexCount++
    },
    onTriangle: () => {
      triangleCount++
    },
  })
  if (triangleCount === 0) {
    throw new AppError('Validation', '3MF model has no triangles')
  }
  // Before the allocation, not after it: at this point the process holds one 256 KB window and
  // nothing else that scales with the file.
  assertMeshFits(vertexCount, triangleCount, limits)

  const vertices = allocateMesh(vertexCount * 3, 'vertex table')
  const positions = allocateMesh(triangleCount * 9, 'triangles')
  let vertexWrite = 0
  let positionWrite = 0
  let vertexBase = 0 // where the current <mesh>'s vertices start, in vertex (not float) units
  let readTag: (start: number, end: number) => string = () => {
    throw new AppError('Internal', '3MF tag reader used before its window was set')
  }

  await scan({
    // Tag offsets are window-relative, so the reader is rebound whenever the window is. Its own
    // 8 KB decode window resets with it, which costs one extra decode per 256 KB of document.
    onWindow: (bytes) => {
      readTag = makeTagReader(bytes)
    },
    onMesh: () => {
      // A <triangle>'s v1/v2/v3 index into its *own* <mesh>'s <vertices> list, per the 3MF
      // spec, not a document-wide list — this is what keeps a second object's local index 0
      // from silently resolving to the first object's first vertex.
      vertexBase = vertexWrite / 3
    },
    onVertex: (start, end) => {
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
    onTriangle: (start, end) => {
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
  })

  // The two passes have to agree, and nothing else in this function would notice if they did not.
  // A typed array ignores a write past its end and reads back zero inside it, so a filling pass
  // that saw one tag more or fewer than the counting pass returns a mesh with a silently dropped
  // triangle or a zeroed tail at the origin — a plausible-looking picture, which is the one
  // failure this parser must not produce. `obj.ts` and `stl.ts` both carry the same check; this
  // is the traversal with the most ways to disagree with itself, so it is the last one that
  // should have been missing it. Reachable in practice when the file changes between the two
  // streams; reachable in principle from any window-boundary bug that survives the tests.
  if (vertexWrite !== vertices.length || positionWrite !== positions.length) {
    throw new AppError('Validation', '3MF model changed while it was being read', {
      countedVertexFloats: vertices.length,
      wroteVertexFloats: vertexWrite,
      countedPositionFloats: positions.length,
      wrotePositionFloats: positionWrite,
    })
  }

  return { positions, triangleCount }
}
