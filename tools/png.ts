import { inflateSync } from 'node:zlib'

/**
 * Enough of the PNG format to prove a file this repo generated is really an image.
 *
 * The point of this module is the difference between two things that look the same in a test
 * report. `pngSize` reads IHDR and tells you what the file *claims*; `decodePng` inflates the
 * pixel data and checks it is the size those dimensions require. A truncated write, a corrupt
 * IDAT, an .ico directory entry pointing four bytes off — all of them leave IHDR intact and all
 * of them are broken images. `deno task icons` writes ten of these files and nobody looks at most
 * of them, so "it has a PNG header" is not a standard worth holding them to.
 *
 * `node:zlib` and no dependency: PNG's compression *is* zlib, so the decode that matters is one
 * `inflateSync` away. What is deliberately not here is the unfiltering and colour conversion —
 * this never produces pixels, only proof that the right number of them are in there.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bytes per pixel for each PNG colour type, at 8 bits per channel. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export type PngHeader = {
  width: number
  height: number
  bitDepth: number
  colourType: number
  interlaced: boolean
}

/**
 * The pixel dimensions and colour format a PNG *claims*, read straight out of IHDR.
 *
 * A header read, not a decode — see `decodePng`, which is what the tests actually assert on.
 */
export function pngSize(bytes: Uint8Array): PngHeader {
  if (bytes.byteLength < 33) throw new Error('too short to be a PNG')
  for (const [index, byte] of SIGNATURE.entries()) {
    if (bytes[index] !== byte) throw new Error('not a PNG (bad signature)')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The first chunk of a PNG must be IHDR: a 4-byte length, the 4-byte type, then the fields.
  const type = String.fromCharCode(...bytes.subarray(12, 16))
  if (type !== 'IHDR') throw new Error(`first PNG chunk is ${type}, not IHDR`)
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    bitDepth: bytes[24],
    colourType: bytes[25],
    interlaced: bytes[28] !== 0,
  }
}

/**
 * Walks every chunk, checks every CRC, inflates the image data and confirms it unpacks to exactly
 * the number of bytes IHDR's dimensions call for. Throws with the reason on anything else.
 *
 * The returned `header` is the same one `pngSize` reads — returned from here so a caller that has
 * decoded a file has no reason to also trust the unverified read.
 */
export function decodePng(bytes: Uint8Array): { header: PngHeader; pixelBytes: number } {
  const header = pngSize(bytes)
  const channels = CHANNELS[header.colourType]
  if (channels === undefined) throw new Error(`unknown PNG colour type ${header.colourType}`)
  if (header.interlaced) {
    // Adam7 splits the image into seven passes with their own row widths, so the length check
    // below would be wrong rather than merely unimplemented. Chromium never emits one from a
    // screenshot, so this is a refusal rather than a gap: if it ever fires, something other than
    // `generate-icons.ts` wrote the file.
    throw new Error('interlaced PNG: this decoder does not model Adam7 pass sizes')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const data: Uint8Array[] = []
  let offset = 8
  let sawEnd = false
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const end = offset + 8 + length
    if (end + 4 > bytes.byteLength) throw new Error(`PNG chunk ${type} runs past the end`)
    const expected = view.getUint32(end, false)
    const actual = crc32(bytes.subarray(offset + 4, end))
    if (expected !== actual) throw new Error(`PNG chunk ${type} has a bad CRC`)
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, end))
    if (type === 'IEND') sawEnd = true
    offset = end + 4
  }
  if (!sawEnd) throw new Error('PNG has no IEND chunk')
  if (offset !== bytes.byteLength) throw new Error('trailing bytes after the last PNG chunk')
  if (data.length === 0) throw new Error('PNG has no IDAT chunks')
  const inflated = inflateSync(Buffer.concat(data))
  // One filter byte per row, then the row's samples. This is the whole reason to inflate: it is
  // the only number in the file that a truncated or corrupt image cannot fake.
  const bytesPerRow = Math.ceil((header.width * channels * header.bitDepth) / 8)
  const wanted = header.height * (1 + bytesPerRow)
  if (inflated.byteLength !== wanted) {
    throw new Error(`PNG unpacked to ${inflated.byteLength} bytes, wanted ${wanted}`)
  }
  return { header, pixelBytes: inflated.byteLength }
}

/** PNG's CRC-32, computed on the fly rather than from a table this file would have to carry. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
