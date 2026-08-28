import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { decodeIco, encodeIco } from './ico.ts'
import { decodePng, pngSize } from './png.ts'

/**
 * What `deno task icons` produced, checked against what the app claims about it.
 *
 * These files are generated, committed, and then never opened by anyone. That is the whole risk:
 * a regenerate that half-wrote a file, a manifest edited to name an icon nobody made, an .ico
 * whose directory does not line up — none of it breaks a build, none of it fails a type check,
 * and all of it ships as a missing or broken icon that the developer who caused it cannot see,
 * because their browser still has the old one cached.
 *
 * So nothing here asserts that a file exists. Every icon named by `manifest.webmanifest` or by
 * `index.html` is read, decoded — `decodePng` inflates the pixel data, it does not read a
 * header — and checked to be exactly the size it was declared to be. The two `.ico` files are
 * taken apart entry by entry and every payload inside them is decoded the same way.
 *
 * `deno task verify` runs this. `deno task icons` does not need to have been run first: its
 * output is tracked in git.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceDir = join(repoRoot, 'assets', 'icons')
const webPublic = join(repoRoot, 'packages', 'web', 'public')
const desktopIcons = join(repoRoot, 'packages', 'desktop', 'icons')
const indexHtml = readFileSync(join(repoRoot, 'packages', 'web', 'src', 'index.html'), 'utf8')

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string }
type Manifest = {
  name: string
  short_name: string
  start_url: string
  display: string
  theme_color: string
  background_color: string
  icons: ManifestIcon[]
}

function readManifest(): Manifest {
  // Read and parsed rather than imported: a JSON import would be validated by the module loader
  // and this test would then be asserting on something the loader already accepted. The failure
  // being guarded against is a hand-edited manifest with a trailing comma, which browsers refuse
  // silently and which is the single most likely way this file breaks.
  return JSON.parse(readFileSync(join(webPublic, 'manifest.webmanifest'), 'utf8')) as Manifest
}

/** Every `href` in the head, by `rel`. A crude parse, and checked to have found something. */
function linkHrefs(rel: string): string[] {
  const hrefs = [...indexHtml.matchAll(/<link\s+rel="([^"]+)"[^>]*href="([^"]+)"/g)]
    .filter(([, found]) => found === rel)
    .map(([, , href]) => href)
  assert.ok(hrefs.length > 0, `index.html has no <link rel="${rel}">`)
  return hrefs
}

describe('the generated icons', () => {
  test('the manifest parses, and every icon in it is a real image of its declared size', () => {
    const manifest = readManifest()
    assert.equal(manifest.name, 'Slicer Project Manager')
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.display, 'standalone')
    // The two sizes Chrome looks for on Android: 192 is the launcher icon, 512 the splash.
    assert.deepEqual(
      manifest.icons.map((icon) => icon.sizes),
      ['192x192', '512x512'],
    )
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number)
      const bytes = new Uint8Array(readFileSync(join(webPublic, icon.src)))
      // Inflated, not sniffed. A file truncated at 100 bytes still has a valid IHDR saying
      // 512x512, and this is the assertion that would notice.
      const { header } = decodePng(bytes)
      assert.deepEqual(
        { width: header.width, height: header.height },
        { width, height },
        `${icon.src} is ${header.width}x${header.height}, but the manifest says ${icon.sizes}`,
      )
      assert.equal(icon.type, 'image/png')
    }
  })

  test('no icon is declared maskable, because the artwork would be cropped', () => {
    // Not a stylistic preference and not an oversight — a measurement. `assets/icons/app.svg` is
    // a full-bleed tile: its opaque pixels run 0..511 on both axes, and the mark inside it reaches
    // the top and bottom edges exactly (bounds measured by rendering it to a 512 canvas and
    // reading the alpha channel).
    //
    // Android's maskable contract is that everything outside a circle of 80% diameter may be
    // clipped away by the launcher's shape. A mark that touches y=0 and y=511 loses its top and
    // bottom to that crop on every device that applies one. `purpose: "any"` is therefore the
    // honest declaration: the launcher shows the tile as drawn.
    //
    // A maskable variant is a real thing worth having and it is a change to the *artwork* — the
    // mark scaled to about two thirds on the same gradient — not something to manufacture by
    // padding someone's icon in a build script.
    for (const icon of readManifest().icons) {
      assert.equal(icon.purpose, 'any', `${icon.src} must not be maskable`)
    }
    assert.ok(
      !readFileSync(join(webPublic, 'manifest.webmanifest'), 'utf8').includes('maskable'),
      'the manifest mentions maskable somewhere this test does not look',
    )
  })

  test('index.html and the manifest agree, and name only files that exist and decode', () => {
    const manifest = readManifest()
    // One brand colour in two files. They drift the moment someone edits one of them, and the
    // symptom — an Android address bar that does not match the splash screen — is invisible on
    // every desktop browser.
    const themeColour = /<meta name="theme-color" content="([^"]+)"/.exec(indexHtml)?.[1]
    assert.equal(themeColour, manifest.theme_color)
    assert.equal(manifest.background_color, manifest.theme_color)
    // The gradient stops in `assets/icons/app.svg`, which is where this colour comes from.
    assert.equal(manifest.theme_color, '#0229bf')

    assert.deepEqual(linkHrefs('manifest'), ['manifest.webmanifest'])
    // The .ico first and the SVG second: a browser that ignores `type="image/svg+xml"` has to
    // still find something it can parse. Ordering, not just membership.
    assert.deepEqual(linkHrefs('icon'), ['favicon.ico', 'favicon.svg'])
    assert.deepEqual(linkHrefs('apple-touch-icon'), ['apple-touch-icon.png'])

    for (const href of [...linkHrefs('icon'), ...linkHrefs('apple-touch-icon')]) {
      const bytes = new Uint8Array(readFileSync(join(webPublic, href)))
      if (href.endsWith('.png')) assert.equal(decodePng(bytes).header.width, 180)
      else if (href.endsWith('.ico')) assert.ok(decodeIco(bytes).length > 0)
      else assert.ok(bytes.byteLength > 0 && href.endsWith('.svg'))
    }
  })

  test('favicon.svg in the build root is the source SVG, byte for byte', () => {
    // `packages/web/public/favicon.svg` is a copy, and a copy is a chance to disagree. This is
    // what makes `assets/icons/favicon.svg` the single source: change it, run `deno task icons`,
    // or this fails.
    assert.deepEqual(
      readFileSync(join(webPublic, 'favicon.svg')),
      readFileSync(join(sourceDir, 'favicon.svg')),
    )
  })

  test('favicon.ico carries 16, 32 and 48, and each frame decodes at that size', () => {
    const entries = decodeIco(new Uint8Array(readFileSync(join(webPublic, 'favicon.ico'))))
    assert.deepEqual(
      entries.map((entry) => entry.width),
      [16, 32, 48],
    )
    for (const entry of entries) {
      const { header } = decodePng(entry.payload)
      assert.deepEqual(
        [header.width, header.height, entry.height],
        [entry.width, entry.width, entry.width],
      )
    }
  })

  test('the desktop window icon carries every frame Windows asks for, and all of them decode', () => {
    const entries = decodeIco(new Uint8Array(readFileSync(join(desktopIcons, 'icon.ico'))))
    assert.deepEqual(
      entries.map((entry) => entry.width),
      [16, 24, 32, 48, 64, 128, 256],
    )
    for (const entry of entries) {
      assert.equal(decodePng(entry.payload).header.width, entry.width)
    }
    // 256 is the one size the format cannot store directly — the field is a byte and 256 is
    // written as 0. A writer that missed that produces a file whose largest frame reports 0x0,
    // and the assertion above is what catches it.
    assert.equal(entries.at(-1)?.width, 256)

    assert.equal(
      decodePng(new Uint8Array(readFileSync(join(desktopIcons, 'icon.png')))).header.width,
      512,
    )
  })
})

describe('the ICO writer', () => {
  const png = () => new Uint8Array(readFileSync(join(desktopIcons, 'icon.png')))

  test('round-trips sizes, including the 256-means-zero rule', () => {
    const entries = decodeIco(
      encodeIco([
        { size: 16, png: png() },
        { size: 256, png: png() },
      ]),
    )
    assert.deepEqual(
      entries.map((entry) => [entry.width, entry.height, entry.bitCount]),
      [
        [16, 16, 32],
        [256, 256, 32],
      ],
    )
    // The payloads have to come back untouched, or the round-trip above proves only that the
    // directory is self-consistent.
    assert.deepEqual(Buffer.from(entries[1].payload), Buffer.from(png()))
  })

  test('refuses a size the directory entry cannot express', () => {
    assert.throws(() => encodeIco([{ size: 512, png: png() }]), /1\.\.256/)
    assert.throws(() => encodeIco([]), /no images/)
  })

  test('rejects a file that is not an icon', () => {
    const ico = encodeIco([{ size: 32, png: png() }])
    assert.throws(() => decodeIco(ico.subarray(0, 4)), /too short/)
    const wrongType = Uint8Array.from(ico)
    wrongType[2] = 2
    assert.throws(() => decodeIco(wrongType), /not an icon file/)
    const truncated = ico.subarray(0, ico.byteLength - 10)
    assert.throws(() => decodeIco(truncated), /past the end/)
  })
})

describe('the PNG decoder these assertions rest on', () => {
  // Without these, every assertion above could be passing against a decoder that accepts
  // anything — which is exactly the shape of failure a generated-asset test falls into.
  const good = () => new Uint8Array(readFileSync(join(desktopIcons, 'icon.png')))

  test('accepts a real PNG and reports its header', () => {
    const { header, pixelBytes } = decodePng(good())
    assert.deepEqual(
      { width: header.width, height: header.height, interlaced: header.interlaced },
      { width: 512, height: 512, interlaced: false },
    )
    // RGBA at 8 bits, plus one filter byte per row.
    assert.equal(pixelBytes, 512 * (1 + 512 * 4))
  })

  test('rejects a truncated file, corrupt pixel data and a non-PNG', () => {
    const bytes = good()
    assert.throws(() => decodePng(bytes.subarray(0, 2000)), /IEND|past the end/)
    const flipped = Uint8Array.from(bytes)
    // Well past IHDR, so the header still reads 512x512 and only the CRC and the inflate know.
    flipped[1000] ^= 0xff
    assert.throws(() => decodePng(flipped), /bad CRC/)
    assert.throws(() => decodePng(new Uint8Array(64)), /not a PNG|too short/)
    assert.throws(() => pngSize(new Uint8Array(64)), /not a PNG|too short/)
  })
})
