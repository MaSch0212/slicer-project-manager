import { AppError } from '@spm/contract/errors.ts'
import type { Mesh } from './mesh.ts'

const BINARY_HEADER_LENGTH = 84 // 80-byte free-form header + uint32 triangle count
const BINARY_RECORD_LENGTH = 50 // normal (12) + 3 vertices (36) + attribute byte count (2)

const UTF8_BOM = [0xef, 0xbb, 0xbf]

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c
}

/**
 * True if, after skipping a leading UTF-8 BOM and any leading ASCII whitespace, the file
 * spells the ASCII STL keyword "solid" (case-insensitive).
 *
 * Skipping the BOM/whitespace matters only for files at least `BINARY_HEADER_LENGTH` bytes
 * long: below that, `parseStl` falls back to `parseAscii` unconditionally, so a real ASCII
 * STL with either prefix already parses fine. At or above that length, a strict "byte 0 is
 * 's'" check misrouted a genuine ASCII file into the "corrupt binary" branch.
 */
function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  let start = 0
  if (bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b)) start = 3
  while (start < bytes.length && isAsciiWhitespace(bytes[start]!)) start++
  return new TextDecoder().decode(bytes.subarray(start, start + 5)).toLowerCase() === 'solid'
}

function parseBinary(bytes: Uint8Array, triangleCount: number): Mesh {
  if (triangleCount === 0) throw new AppError('Validation', 'STL file has zero triangles')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const positions = new Float32Array(triangleCount * 9)
  let offset = BINARY_HEADER_LENGTH
  for (let t = 0; t < triangleCount; t++) {
    offset += 12 // skip the facet normal; the rasterizer recomputes shading from geometry
    for (let i = 0; i < 9; i++) {
      const value = view.getFloat32(offset, true)
      // The ASCII path already rejects NaN/Infinity coordinates (below); a binary file with
      // the same problem must fail the same way rather than handing a NaN bounding box to
      // the rasterizer.
      if (!Number.isFinite(value)) {
        throw new AppError('Validation', 'binary STL contains a non-finite vertex coordinate', {
          triangleIndex: t,
        })
      }
      positions[t * 9 + i] = value
      offset += 4
    }
    offset += 2 // attribute byte count
  }
  return { positions, triangleCount }
}

// Matches a "vertex" keyword followed by three whitespace-separated tokens. Anchored on the
// literal keyword rather than splitting the whole file into tokens, so a large ASCII file
// (which, being text, is often larger than its binary equivalent) does not need every
// "facet normal" / "outer loop" / "endloop" token held in memory at once.
const VERTEX_RE = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g

function parseAscii(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes)
  const values: number[] = []
  for (const match of text.matchAll(VERTEX_RE)) {
    const x = Number(match[1])
    const y = Number(match[2])
    const z = Number(match[3])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new AppError('Validation', 'malformed vertex line in ASCII STL', { line: match[0] })
    }
    values.push(x, y, z)
  }
  if (values.length === 0) throw new AppError('Validation', 'STL file has zero triangles')
  if (values.length % 9 !== 0) {
    throw new AppError('Validation', 'ASCII STL vertex count is not a multiple of 3 per facet')
  }
  return { positions: Float32Array.from(values), triangleCount: values.length / 9 }
}

/**
 * Parses either STL encoding into triangle soup.
 *
 * Binary detection checks that the file length matches `84 + 50 * triangleCount` exactly,
 * rather than sniffing the leading bytes for the ASCII "solid" keyword: binary STLs
 * routinely start with that word inside their free-form 80-byte header, so a prefix check
 * alone misdetects them as ASCII.
 */
export function parseStl(bytes: Uint8Array): Mesh {
  if (bytes.length >= BINARY_HEADER_LENGTH) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const triangleCount = view.getUint32(80, true)
    if (bytes.length === BINARY_HEADER_LENGTH + BINARY_RECORD_LENGTH * triangleCount) {
      return parseBinary(bytes, triangleCount)
    }
    if (!looksLikeAsciiStl(bytes)) {
      // Long enough to carry a binary header and its triangle count disagrees with the
      // file's length, but there is no ASCII "solid" keyword to fall back on either: not a
      // format this parser can recover, whichever of the two it was meant to be.
      throw new AppError(
        'Validation',
        'not a valid binary STL (triangle count does not match file length) and no ASCII "solid" keyword found',
      )
    }
  }
  return parseAscii(bytes)
}
