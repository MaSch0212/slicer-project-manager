import { inflateSync } from 'node:zlib'
import type { AppError } from '@spm/contract/errors.ts'
import { encodePng, readPngSize } from '../src/previews/png.ts'
import { assert, test } from './harness.ts'
import { crc32 } from './fixtures/make-3mf.ts'

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/** width*height*3 bytes, three distinct colours so a real image round-trips meaningfully. */
function sampleRgb(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = (i * 37) & 0xff
    rgb[i * 3 + 1] = (i * 53) & 0xff
    rgb[i * 3 + 2] = (i * 91) & 0xff
  }
  return rgb
}

test('encodePng output is readable by readPngSize', () => {
  const png = encodePng(sampleRgb(5, 3), 5, 3)
  assert.deepEqual(readPngSize(png), { width: 5, height: 3 })
})

test('encodePng chunk layout is byte-exact for a 2x2 fixture, derived from the spec', () => {
  const rgb = sampleRgb(2, 2)
  const png = encodePng(rgb, 2, 2)

  // Signature: the eight fixed bytes the PNG spec (§5.2) mandates.
  assert.deepEqual(png.subarray(0, 8), SIGNATURE)

  // IHDR is fully determined by width/height for this encoding (8-bit truecolour, no
  // interlace), so its whole 25-byte chunk (length + type + 13 data bytes + crc) can be
  // built by hand here rather than trusting whatever encodePng happened to emit.
  const ihdrData = new Uint8Array(13)
  const ihdrView = new DataView(ihdrData.buffer)
  ihdrView.setUint32(0, 2) // width
  ihdrView.setUint32(4, 2) // height
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // colour type: truecolour
  // compression, filter, interlace methods: 0
  const ihdrType = new TextEncoder().encode('IHDR')
  const expectedIhdr = new Uint8Array(25)
  new DataView(expectedIhdr.buffer).setUint32(0, ihdrData.length)
  expectedIhdr.set(ihdrType, 4)
  expectedIhdr.set(ihdrData, 8)
  new DataView(expectedIhdr.buffer).setUint32(
    21,
    crc32(Uint8Array.from([...ihdrType, ...ihdrData])),
  )
  assert.deepEqual(png.subarray(8, 33), expectedIhdr)

  // IEND is always these exact 12 bytes: zero-length data, fixed type, and a CRC over just
  // the type bytes (crc32 here is the zip-fixture's implementation, not png.ts's — same
  // table construction as png.ts, so not a fully independent derivation on its own).
  const iendType = new TextEncoder().encode('IEND')
  const expectedIend = new Uint8Array(12)
  new DataView(expectedIend.buffer).setUint32(0, 0)
  expectedIend.set(iendType, 4)
  new DataView(expectedIend.buffer).setUint32(8, crc32(iendType))
  assert.deepEqual(png.subarray(png.length - 12), expectedIend)

  // A literal golden, independent of any crc32 implementation: the PNG spec (§5.6, and the
  // worked example in Annex D) publishes IEND's encoding as exactly these 12 bytes, since its
  // data is always empty and its type is always "IEND". Pasted from the spec, not computed.
  const SPEC_IEND = Uint8Array.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  assert.deepEqual(png.subarray(png.length - 12), SPEC_IEND)

  // Everything between IHDR and IEND is exactly one IDAT chunk: length + 'IDAT' + data + crc.
  const idatLength = new DataView(png.buffer, png.byteOffset + 33, 4).getUint32(0)
  assert.equal(png.length, 33 + 12 + idatLength + 12)
  assert.equal(new TextDecoder().decode(png.subarray(37, 41)), 'IDAT')
  const idatData = png.subarray(41, 41 + idatLength)
  const idatCrc = new DataView(png.buffer, png.byteOffset + 41 + idatLength, 4).getUint32(0)
  assert.equal(idatCrc, crc32(Uint8Array.from([...new TextEncoder().encode('IDAT'), ...idatData])))

  // The compressed payload is opaque (deflate's exact bytes are implementation-defined), but
  // what it decompresses to is spec-mandated: filter byte 0 then the raw RGB bytes, per row.
  const stride = 2 * 3
  const expectedRaw = new Uint8Array((stride + 1) * 2)
  for (let y = 0; y < 2; y++) {
    expectedRaw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  assert.deepEqual(new Uint8Array(inflateSync(idatData)), expectedRaw)
})

test('encodePng rejects an rgb buffer of the wrong length', () => {
  assert.throws(
    () => encodePng(new Uint8Array(10), 2, 2),
    (e: unknown) => (e as AppError).code === 'Validation',
  )
})

const validation = (e: unknown): boolean => (e as AppError).code === 'Validation'

test('encodePng rejects negative dimensions', () => {
  // -2 * -2 * 3 = 12, a length the buffer-length check alone would accept, which is exactly
  // why the dimension guard has to run before it.
  assert.throws(() => encodePng(new Uint8Array(12), -2, -2), validation)
})

test('encodePng rejects a zero dimension', () => {
  assert.throws(() => encodePng(new Uint8Array(0), 0, 5), validation)
})

test('encodePng rejects a fractional dimension', () => {
  assert.throws(() => encodePng(new Uint8Array(9), 1.5, 2), validation)
})

test('encodePng is deterministic across runs in the same process', () => {
  const rgb = sampleRgb(9, 7)
  assert.deepEqual(encodePng(rgb, 9, 7), encodePng(rgb, 9, 7))
})
