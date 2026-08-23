import { deflateSync } from 'node:zlib'
import { concatBytes, crc32 } from './make-3mf.ts'

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(concatBytes([typeBytes, data])))
  return out
}

/**
 * A valid all-black 8-bit RGB PNG of the requested size.
 *
 * Deliberately not built on top of `encodePng`: this fixture predates it and is used by
 * tests (`previews.test.ts`, `embedded.ts`'s tests) that exercise the *reading* side
 * (`readPngSize`, zip/thumbnail extraction). Routing it through `encodePng` would make those
 * tests pass or fail together with the encoder instead of independently of it, which is the
 * opposite of what a fixture is for.
 */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // Each scanline is one filter byte followed by width RGB triples; zeros are fine.
  const raw = new Uint8Array((width * 3 + 1) * height)
  return concatBytes([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ])
}
