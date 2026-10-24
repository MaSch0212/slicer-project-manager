import { deflateSync } from 'node:zlib'
import { AppError } from '@spm/contract/errors.ts'

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Reads width/height from IHDR, which the format requires to be the first chunk. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

// Hand-written per the PNG spec (Annex D) rather than pulled from a package: constraint 2
// forbids a new dependency for one table lookup.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, typeBytes.length)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/**
 * Encodes 8-bit truecolour (no alpha, no interlace) RGB pixels as a PNG.
 *
 * `rgb` is row-major, three bytes per pixel, no padding — exactly what the rasterizer (spec
 * 7.2) produces. Each scanline gets filter byte 0 (`None`): the rasterizer's output has no
 * structure a PNG filter would exploit, so paying deflate's cost without a filter's benefit
 * is not worth the extra code.
 */
export function encodePng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    // Checked ahead of the length product below: e.g. width=-2, height=-2 multiplies to a
    // positive 4 that could pass a length check, then writes a nonsense (4294967294 x
    // 4294967294) IHDR — negative dimensions must be rejected before they get anywhere near
    // that arithmetic, not after.
    throw new AppError('Validation', 'width and height must be positive integers', {
      width,
      height,
    })
  }
  if (rgb.length !== width * height * 3) {
    throw new AppError('Validation', 'rgb buffer length does not match width * height * 3', {
      width,
      height,
      length: rgb.length,
    })
  }

  const stride = width * 3
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // bytes 10-12 (compression, filter, interlace methods) are already zero.

  // deflateSync is deterministic within a runtime for a fixed input and fixed options (no
  // level/strategy/window size varies here), which is what gives the "across runs" half of
  // constraint 3. The compressed bytes themselves are a zlib-binding detail, not something
  // this function controls: Node and Deno measurably emit different deflate output for the
  // same input. The "across runtimes" half of the guarantee is on what IDAT decompresses to
  // — the raw filtered scanlines above — not on IDAT's bytes.
  const idat = new Uint8Array(deflateSync(raw))

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(SIGNATURE.length + chunks.reduce((n, c) => n + c.length, 0))
  out.set(SIGNATURE, 0)
  let at = SIGNATURE.length
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
