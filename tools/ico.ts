/**
 * A minimal ICO reader and writer, because nothing in this toolchain can make one.
 *
 * The repo has no image library and is not getting one: `sharp`, ImageMagick and friends are
 * native dependencies, and the whole point of `generate-icons.ts` is that it leans on the
 * Chromium that `@playwright/test` already ships. Chromium renders PNGs; it does not package an
 * ICO. So this module does, and the container is small enough that writing it is cheaper than
 * arguing about a dependency.
 *
 * **Every payload here is a PNG, not a BMP.** The original ICO format carried DIBs, and a
 * PNG-in-ICO is the Vista-era extension. That is a real constraint and it was checked rather than
 * assumed — the three decoders these files actually meet all accept it: Chromium (the browser
 * favicon and the `<img>` decode in `icons.test.ts`), Electron's `nativeImage` (the Windows window
 * icon), and the Windows shell, which has read PNG-compressed icon entries since Vista. If a
 * consumer that predates that ever matters, this module is where a BMP branch would go, and it
 * would be a much larger file.
 *
 * The layout, which is the whole format:
 *
 * | offset      | size | field                                            |
 * | ----------- | ---- | ------------------------------------------------ |
 * | 0           | 2    | reserved, always 0                               |
 * | 2           | 2    | type: 1 = icon, 2 = cursor                       |
 * | 4           | 2    | image count                                      |
 * | 6 + 16*n    | 16   | one directory entry per image (below)            |
 * | ...         | ...  | the payloads, in the order the entries point at  |
 *
 * And an entry:
 *
 * | offset | size | field                                                          |
 * | ------ | ---- | -------------------------------------------------------------- |
 * | 0      | 1    | width in pixels, **0 meaning 256**                              |
 * | 1      | 1    | height in pixels, 0 meaning 256                                 |
 * | 2      | 1    | palette size, 0 when the image is not paletted                  |
 * | 3      | 1    | reserved, always 0                                              |
 * | 4      | 2    | colour planes                                                   |
 * | 6      | 2    | bits per pixel                                                  |
 * | 8      | 4    | payload length in bytes                                         |
 * | 12     | 4    | payload offset from the start of the file                       |
 *
 * All multi-byte fields are little-endian. The `0 means 256` rule in the first two bytes is the
 * one thing here that silently produces a broken file if you miss it: a 256-pixel image written
 * as `256 & 0xff` is a zero either way, so the bug is invisible in the bytes and shows up as a
 * decoder reporting a 0×0 image.
 */

/** One image inside an icon file: its declared pixel size, and the PNG bytes for it. */
export type IcoImage = { readonly size: number; readonly png: Uint8Array }

/** What `decodeIco` reads back out — the directory entry as written, plus its payload. */
export type IcoEntry = {
  /** As stored, with the format's `0` already translated back to 256. */
  readonly width: number
  readonly height: number
  readonly bitCount: number
  readonly payload: Uint8Array
}

const HEADER_BYTES = 6
const ENTRY_BYTES = 16

export function encodeIco(images: readonly IcoImage[]): Uint8Array {
  if (images.length === 0) throw new Error('an .ico with no images is not a file any decoder wants')
  for (const { size } of images) {
    // Not defensive: the field is one byte wide, so anything past 256 would be written modulo 256
    // and name a completely different image size. Fail here rather than emit that.
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`ICO image sizes must be 1..256, got ${size}`)
    }
  }
  const directoryEnd = HEADER_BYTES + ENTRY_BYTES * images.length
  const total = images.reduce((sum, image) => sum + image.png.byteLength, directoryEnd)
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)
  let offset = directoryEnd
  images.forEach((image, index) => {
    const entry = HEADER_BYTES + ENTRY_BYTES * index
    bytes[entry] = image.size === 256 ? 0 : image.size
    bytes[entry + 1] = image.size === 256 ? 0 : image.size
    bytes[entry + 2] = 0
    bytes[entry + 3] = 0
    view.setUint16(entry + 4, 1, true)
    view.setUint16(entry + 6, 32, true)
    view.setUint32(entry + 8, image.png.byteLength, true)
    view.setUint32(entry + 12, offset, true)
    bytes.set(image.png, offset)
    offset += image.png.byteLength
  })
  return bytes
}

/**
 * Reads an icon file back. Throws on anything malformed rather than returning a partial list,
 * because the caller is a test whose entire job is to notice that.
 */
export function decodeIco(bytes: Uint8Array): IcoEntry[] {
  if (bytes.byteLength < HEADER_BYTES) throw new Error('too short to hold an ICO header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== 0) throw new Error('ICO reserved field is not 0')
  if (view.getUint16(2, true) !== 1) throw new Error('not an icon file (type != 1)')
  const count = view.getUint16(4, true)
  if (count === 0) throw new Error('ICO declares no images')
  if (bytes.byteLength < HEADER_BYTES + ENTRY_BYTES * count) {
    throw new Error('ICO directory runs past the end of the file')
  }
  const entries: IcoEntry[] = []
  for (let index = 0; index < count; index++) {
    const entry = HEADER_BYTES + ENTRY_BYTES * index
    const length = view.getUint32(entry + 8, true)
    const offset = view.getUint32(entry + 12, true)
    if (offset + length > bytes.byteLength) {
      throw new Error(`ICO entry ${index} points past the end of the file`)
    }
    entries.push({
      width: bytes[entry] === 0 ? 256 : bytes[entry],
      height: bytes[entry + 1] === 0 ? 256 : bytes[entry + 1],
      bitCount: view.getUint16(entry + 6, true),
      payload: bytes.subarray(offset, offset + length),
    })
  }
  return entries
}
