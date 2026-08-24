import { AppError } from '@spm/contract/errors.ts'
import { drainSink, feedSink, makeLineSink, openFile, type ChunkSink } from '../../files/chunks.ts'
import { allocateMesh, assertMeshFits, type MeshLimits } from './limits.ts'
import type { Mesh } from './mesh.ts'

const BINARY_HEADER_LENGTH = 84 // 80-byte free-form header + uint32 triangle count
const BINARY_RECORD_LENGTH = 50 // normal (12) + 3 vertices (36) + attribute byte count (2)

const UTF8_BOM = [0xef, 0xbb, 0xbf]

/**
 * How much of a file `parseStlFile` reads before deciding how to read the rest.
 *
 * Only the first 84 bytes decide anything — the header and the declared triangle count — but the
 * ASCII fallback skips a BOM and any leading whitespace before looking for the `solid` keyword,
 * and stopping at 84 would misjudge a file that opens with more than 76 bytes of blank lines. No
 * such file exists in the reference library; 4 KB makes it impossible rather than merely unlikely
 * while still being one read of one page.
 */
const SNIFF_BYTES = 4096

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c
}

/**
 * True if, after skipping a leading UTF-8 BOM and any leading ASCII whitespace, the file
 * spells the ASCII STL keyword "solid" (case-insensitive).
 *
 * Skipping the BOM/whitespace matters only for files at least `BINARY_HEADER_LENGTH` bytes
 * long: below that, `parseStl` falls back to the ASCII path unconditionally, so a real ASCII
 * STL with either prefix already parses fine. At or above that length, a strict "byte 0 is
 * 's'" check misrouted a genuine ASCII file into the "corrupt binary" branch.
 */
function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  let start = 0
  if (bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b)) start = 3
  while (start < bytes.length && isAsciiWhitespace(bytes[start]!)) start++
  return new TextDecoder().decode(bytes.subarray(start, start + 5)).toLowerCase() === 'solid'
}

type StlShape = { binary: true; triangleCount: number } | { binary: false }

/**
 * Decides which of the two encodings a file is, from its first bytes and its total length.
 *
 * Binary detection checks that the length matches `84 + 50 * triangleCount` exactly, rather than
 * sniffing the leading bytes for the ASCII "solid" keyword: binary STLs routinely start with that
 * word inside their free-form 80-byte header, so a prefix check alone misdetects them as ASCII.
 *
 * Pulled out of the parse because the streaming reader has to know the answer before it starts —
 * a binary file is walked as fixed-size records and a text one as lines, and the length is the
 * only thing that separates them. It is also the gate that makes a declared triangle count safe to
 * allocate against: a header claiming four billion triangles cannot match any real file's length.
 */
function detectStl(head: Uint8Array, totalBytes: number): StlShape {
  if (totalBytes >= BINARY_HEADER_LENGTH) {
    if (head.byteLength < BINARY_HEADER_LENGTH) {
      throw new AppError('Validation', 'STL file ended inside its header')
    }
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const triangleCount = view.getUint32(80, true)
    if (totalBytes === BINARY_HEADER_LENGTH + BINARY_RECORD_LENGTH * triangleCount) {
      return { binary: true, triangleCount }
    }
    if (!looksLikeAsciiStl(head)) {
      // Long enough to carry a binary header and its triangle count disagrees with the
      // file's length, but there is no ASCII "solid" keyword to fall back on either: not a
      // format this parser can recover, whichever of the two it was meant to be.
      throw new AppError(
        'Validation',
        'not a valid binary STL (triangle count does not match file length) and no ASCII "solid" keyword found',
      )
    }
  }
  return { binary: false }
}

/**
 * Reassembles the fixed-size records of a binary STL out of arbitrary chunks.
 *
 * The only state that crosses a chunk boundary is at most 49 bytes of a half-seen record, held in
 * `pending` — a record that arrives whole inside one chunk is read straight out of it with no copy
 * at all, which is the common case at any sane chunk size. Nothing here is a function of the
 * file's length except `positions`, which the header sized and `detectStl` proved honest.
 */
function makeBinaryStlSink(triangleCount: number, limits: MeshLimits | undefined): ChunkSink<Mesh> {
  if (triangleCount === 0) throw new AppError('Validation', 'STL file has zero triangles')
  assertMeshFits(0, triangleCount, limits)

  const positions = allocateMesh(triangleCount * 9, 'triangles')
  const pending = new Uint8Array(BINARY_RECORD_LENGTH)
  const pendingView = new DataView(pending.buffer)
  let pendingLength = 0
  let skip = BINARY_HEADER_LENGTH
  let written = 0

  const emit = (view: DataView, base: number): void => {
    const triangleIndex = written / 9
    if (written === positions.length) {
      throw new AppError('Validation', 'binary STL holds more triangles than its header declares')
    }
    // base + 0..11 is the facet normal, skipped: the rasterizer recomputes shading from geometry.
    for (let i = 0; i < 9; i++) {
      const value = view.getFloat32(base + 12 + i * 4, true)
      // The ASCII path already rejects NaN/Infinity coordinates; a binary file with the same
      // problem must fail the same way rather than handing a NaN bounding box to the rasterizer.
      if (!Number.isFinite(value)) {
        throw new AppError('Validation', 'binary STL contains a non-finite vertex coordinate', {
          triangleIndex,
        })
      }
      positions[written++] = value
    }
  }

  return {
    push(chunk) {
      let at = 0
      if (skip > 0) {
        const n = Math.min(skip, chunk.byteLength)
        skip -= n
        at = n
      }
      if (at >= chunk.byteLength) return
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      while (at < chunk.byteLength) {
        if (pendingLength === 0 && chunk.byteLength - at >= BINARY_RECORD_LENGTH) {
          emit(view, at)
          at += BINARY_RECORD_LENGTH
          continue
        }
        const n = Math.min(BINARY_RECORD_LENGTH - pendingLength, chunk.byteLength - at)
        pending.set(chunk.subarray(at, at + n), pendingLength)
        pendingLength += n
        at += n
        if (pendingLength === BINARY_RECORD_LENGTH) {
          emit(pendingView, 0)
          pendingLength = 0
        }
      }
    },
    end() {
      // Only reachable if the file shrank between the length check and the read; the buffered
      // caller cannot get here at all. Still an AppError rather than a short mesh full of zeroes.
      if (skip > 0 || pendingLength > 0 || written !== positions.length) {
        throw new AppError('Validation', 'binary STL ended before its declared triangle count', {
          declaredTriangles: triangleCount,
          readTriangles: Math.floor(written / 9),
        })
      }
      return { positions, triangleCount }
    },
  }
}

// Matches a "vertex" keyword followed by three whitespace-separated tokens, applied one logical
// line at a time. Anchored on the literal keyword rather than splitting the file into tokens, so a
// large ASCII file (which, being text, is often larger than its binary equivalent) does not need
// every "facet normal" / "outer loop" / "endloop" token held in memory at once.
//
// Per line, rather than over the whole text, because the whole text is exactly what no longer
// exists: the reader carries one incomplete line between chunks. The STL grammar is line-oriented
// (`vertex v1 v2 v3`, one per line) and every producer writes it that way, so this loses nothing
// real — but the way it *would* lose it is the problem, and `VERTEX_START_RE` below is the answer.
const VERTEX_RE = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g

/**
 * Every place a vertex record could begin: the keyword, followed by whitespace or the end of the
 * line.
 *
 * The count of these has to equal the count of `VERTEX_RE` matches on the same line, and that
 * equality is the whole reason this exists. Reading per line means a record whose three numbers
 * are not all on it — `vertex 1 2` with the `3` on the next line, or a truncated `vertex 1 2` at
 * the end of a file — simply does not match, and a non-match is *silent*: both passes drop it
 * identically, so `written === positions.length` still holds and the "multiple of 3 per facet"
 * check still passes whenever the number of dropped records happens to be a multiple of three.
 * The result would be a mesh quietly missing whole facets. Counting the starts turns that into a
 * refusal.
 *
 * The whitespace-or-end-of-line requirement is what keeps it from firing on ordinary text: a
 * `solid vertexcube` header contains "vertex" and is not a record, and the old whole-document
 * regex did not treat it as one either. A solid whose name *ends* in "vertex" is refused. At the
 * top of a file (`solid my_vertex`) it already was, since the old regex ran past the newline and
 * read the next line's `facet normal 0` as coordinates, producing NaN; at the bottom
 * (`endsolid my_vertex`) the refusal is new, because there was no next line for the old regex to
 * consume. Both quote the offending line, which is the point: loud and wrong beats quiet and
 * short.
 */
const VERTEX_START_RE = /vertex(?:\s|$)/g

function countMatches(re: RegExp, line: string): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(line) !== null) n++
  return n
}

/**
 * Pass one: how many coordinate values the fill pass is going to produce — and a refusal if any
 * line holds a `vertex` keyword it cannot read three numbers out of.
 *
 * The refusal belongs here rather than in the filling pass because this pass runs before anything
 * is allocated, and because a caller that never reaches pass two (the count is zero, or the cap
 * refuses) must still not be told the file was fine.
 */
function makeAsciiCounter(): { visit: (line: string) => void; count: () => number } {
  let values = 0
  return {
    // `exec` in a loop rather than `matchAll`: counting needs no capture groups, and this pass
    // runs over every line of the file. `lastIndex` is reset per line because the regex is shared.
    visit: (line) => {
      const records = countMatches(VERTEX_RE, line)
      if (records !== countMatches(VERTEX_START_RE, line)) {
        throw new AppError(
          'Validation',
          'ASCII STL has a vertex record that is not three numbers on one line',
          { line },
        )
      }
      values += records * 3
    },
    count: () => values,
  }
}

/** Pass two: the same matches, validated and written into the array pass one sized. */
function makeAsciiFiller(positions: Float32Array): {
  visit: (line: string) => void
  written: () => number
} {
  let write = 0
  return {
    visit: (line) => {
      for (const match of line.matchAll(VERTEX_RE)) {
        const x = Number(match[1])
        const y = Number(match[2])
        const z = Number(match[3])
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new AppError('Validation', 'malformed vertex line in ASCII STL', { line: match[0] })
        }
        if (write + 3 > positions.length) {
          throw new AppError('Validation', 'ASCII STL grew while it was being read')
        }
        positions[write++] = x
        positions[write++] = y
        positions[write++] = z
      }
    },
    written: () => write,
  }
}

/** What pass one proved, turned into the allocation pass two fills — or a refusal. */
function asciiPositionsFor(values: number, limits: MeshLimits | undefined): Float32Array {
  if (values === 0) throw new AppError('Validation', 'STL file has zero triangles')
  if (values % 9 !== 0) {
    throw new AppError('Validation', 'ASCII STL vertex count is not a multiple of 3 per facet')
  }
  assertMeshFits(0, values / 9, limits)
  return allocateMesh(values, 'triangles')
}

function asciiMesh(positions: Float32Array, written: number): Mesh {
  if (written !== positions.length) {
    throw new AppError('Validation', 'ASCII STL shrank while it was being read')
  }
  return { positions, triangleCount: positions.length / 9 }
}

/**
 * Parses either STL encoding out of a buffer the caller already holds.
 *
 * Kept synchronous, and kept as the *only* place the format logic lives: `parseStlFile` below runs
 * the identical sinks over a chunk stream instead of over one array, so there is no second parser
 * to disagree with this one. Callers that have a whole file in memory anyway — tests, and anything
 * handed bytes rather than a path — keep the simpler shape.
 */
export function parseStl(bytes: Uint8Array, limits?: MeshLimits): Mesh {
  const shape = detectStl(bytes, bytes.byteLength)
  if (shape.binary) return feedSink(makeBinaryStlSink(shape.triangleCount, limits), bytes)

  const counter = makeAsciiCounter()
  feedSink(makeLineSink(counter.visit), bytes)
  const positions = asciiPositionsFor(counter.count(), limits)
  const filler = makeAsciiFiller(positions)
  feedSink(makeLineSink(filler.visit), bytes)
  return asciiMesh(positions, filler.written())
}

/**
 * Parses an STL from disk without ever holding it whole.
 *
 * The reference library's largest model is a 164 MB binary STL, and `readFileSync` charged all
 * 164 MB against the peak on top of the 118.7 MB of `positions` it actually needed. Here the file
 * passes through a 256 KB buffer.
 *
 * **Faster, not slower**, which is not what streaming usually costs: 76 ms against 112 ms on that
 * 164 MB file, −32%. `readFileSync` has to allocate and fill 164 MB of fresh pages before the
 * parse begins; reading it 256 KB at a time touches one page repeatedly instead, and the records
 * are read straight out of it.
 *
 * ASCII costs two reads because the vertex count is not knowable without one: the alternative is a
 * `number[]` that grows by `push` and is copied into a `Float32Array` at the end, which is both a
 * second full-size allocation and the boxed-number representation next to the typed one. Binary
 * needs one read — its count is in the header.
 */
export async function parseStlFile(absPath: string, limits?: MeshLimits): Promise<Mesh> {
  // One descriptor for the sniff, the size and both passes. It used to be one per read — three on
  // an ASCII file — which is nothing against the four huge models and is most of the cost on the
  // 1 300 small ones, where the parse is a fraction of a millisecond and the syscalls are not.
  const file = openFile(absPath)
  try {
    const shape = detectStl(file.head(SNIFF_BYTES), file.size())
    if (shape.binary) {
      return await drainSink(makeBinaryStlSink(shape.triangleCount, limits), file.chunks())
    }

    const counter = makeAsciiCounter()
    await drainSink(makeLineSink(counter.visit), file.chunks())
    const positions = asciiPositionsFor(counter.count(), limits)
    const filler = makeAsciiFiller(positions)
    await drainSink(makeLineSink(filler.visit), file.chunks())
    return asciiMesh(positions, filler.written())
  } finally {
    file.close()
  }
}
