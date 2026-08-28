import { chromium, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeIco, encodeIco, type IcoImage } from './ico.ts'
import { pngSize } from './png.ts'

/**
 * Rasterises `assets/icons/*.svg` into every derived icon the web app and the desktop shell ship.
 *
 * Run it by hand with `deno task icons`, after changing one of the three SVGs, and commit what it
 * writes. **The build does not run it and must not**: `deno task build:ui`, `build:desktop` and
 * every CI job stay free of a browser download, and the derived files are tracked in git like any
 * other source. `tools/icons.test.ts` is what keeps them honest — it is in `deno task verify`, and
 * it re-decodes every file this script writes.
 *
 * ## Why Chromium, and why this way
 *
 * There is no image library in this repo and adding one would mean a native dependency (`sharp`,
 * ImageMagick) on a Deno + Node toolchain that has none. `@playwright/test` is already a
 * dependency of three packages and its Chromium is already installed for the e2e and desktop
 * suites, so the renderer is free. `page.setContent()` with the SVG inlined and an explicit
 * `width`/`height` on the element, then `locator.screenshot({ omitBackground: true })`, is what
 * preserves the transparent background — a page screenshot would composite the artwork onto
 * Chromium's white default and every "transparent" icon would ship with a white square behind it.
 *
 * `deviceScaleFactor: 1` is load-bearing for the same reason the CSS size is: with a scale factor
 * the screenshot comes back at `size * dpr` pixels and every file would be silently wrong.
 *
 * ## What the three sources are
 *
 * All three are 512×512 and all three are, inside the SVG wrapper, a single embedded raster —
 * `<use>` pointing at a base64 `<image>`. That is worth knowing before anyone reaches for
 * "it's vector, just scale it": `favicon.svg` ships as an SVG to browsers, but the pixels in it
 * are a 454×512 PNG, so the 16-pixel favicon below is a downscale either way and the browser does
 * the same downscale this script does.
 *
 * Measured alpha bounds in the 512 box, which is what decided the sizes and the `purpose` field
 * in `manifest.webmanifest`:
 *
 * | source        | opaque bounds (x, y) | coverage | background  |
 * | ------------- | -------------------- | -------- | ----------- |
 * | `favicon.svg` | 29..482, 0..511      | 55%      | transparent |
 * | `desktop.svg` | 57..454, 32..479     | 43%      | transparent |
 * | `app.svg`     | 0..511, 0..511       | 100%     | blue gradient, full bleed |
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sourceDir = join(repoRoot, 'assets', 'icons')
const webPublic = join(repoRoot, 'packages', 'web', 'public')
const desktopIcons = join(repoRoot, 'packages', 'desktop', 'icons')

/**
 * The sizes, and the reason for each one. None of these is "the usual set" copied from somewhere.
 *
 * **`favicon.ico` — 16, 32, 48.** 16 is the tab and the bookmark bar; 32 is the same at 2× and the
 * Windows taskbar's small icon; 48 is what the Windows shell asks for in list views. Bigger frames
 * would only pad the file: `favicon.svg` is linked first and every browser that would want a
 * 256-pixel favicon prefers the SVG.
 *
 * **Home-screen PNGs — 192 and 512.** The two sizes the web app manifest spec's own examples use
 * and the two Chrome checks for on Android: 192 is the launcher icon, 512 the splash screen.
 *
 * **`apple-touch-icon.png` — 180.** iOS ignores the manifest for the home-screen icon and reads
 * this file by name. 180 is the iPhone 3× size and the largest iOS asks for; it downsamples the
 * rest itself.
 *
 * **`icon.ico` — 16 through 256.** This is the Windows window icon, and Windows genuinely picks
 * different frames for different chrome: 16 for the title bar, 32 for the taskbar at 100%, 48 and
 * 64 as that scales, 256 for Explorer's extra-large view and the Alt-Tab switcher. An .ico missing
 * a frame does not fail — Windows scales the nearest one, badly — so this is the one list where
 * being generous costs a few KB and saves a blurry title bar.
 *
 * **`icon.png` — 512.** Linux, where `BrowserWindow`'s `icon` takes an image rather than an icon
 * container and the window manager scales it down. macOS is not here: it ignores
 * `BrowserWindow.icon` entirely and takes the dock icon from the bundle's `.icns`, which
 * `package-app.ts` does not build (see its Scope note).
 */
const FAVICON_ICO_SIZES = [16, 32, 48]
const WINDOW_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const HOME_SCREEN_SIZES = [192, 512]
const APPLE_TOUCH_SIZE = 180
const LINUX_WINDOW_SIZE = 512

/** The largest thing rendered, so the element always fits without the page scrolling. */
const VIEWPORT = 600

async function rasterise(page: Page, svg: string, size: number): Promise<Uint8Array> {
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;background:transparent}` +
      `svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  )
  const shot = await page.locator('svg').screenshot({ omitBackground: true })
  const bytes = new Uint8Array(shot)
  // The screenshot is the only step here that can quietly produce the wrong thing — a stale
  // viewport, a scale factor, an SVG whose own width attribute wins. Checked every time rather
  // than once, because it costs a header read.
  const actual = pngSize(bytes)
  if (actual.width !== size || actual.height !== size) {
    throw new Error(`rasterised ${actual.width}x${actual.height}, wanted ${size}x${size}`)
  }
  return bytes
}

/**
 * Decodes a file the way its consumers will, and reports what came back.
 *
 * `pngSize` reads a header; this runs Chromium's actual image decoder over the bytes, which is
 * the thing that would embarrass us. An `.ico` whose directory is subtly wrong parses fine with
 * `decodeIco` — it is our own writer read back by our own reader — and then fails in every
 * browser. `createImageBitmap` on a real `Blob` is the shortest path to a genuine decode of both
 * formats, and it rejects rather than guessing.
 */
async function decodeInChromium(
  page: Page,
  bytes: Uint8Array,
  mime: string,
): Promise<{ width: number; height: number }> {
  const base64 = Buffer.from(bytes).toString('base64')
  return await page.evaluate(
    async ([data, type]) => {
      const binary = atob(data)
      const buffer = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) buffer[index] = binary.charCodeAt(index)
      const bitmap = await createImageBitmap(new Blob([buffer], { type }))
      return { width: bitmap.width, height: bitmap.height }
    },
    [base64, mime] as const,
  )
}

const written: string[] = []

async function emit(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  written.push(`${file.slice(repoRoot.length + 1).replaceAll('\\', '/')} (${bytes.byteLength} B)`)
}

async function icoFrom(page: Page, svg: string, sizes: number[]): Promise<Uint8Array> {
  const images: IcoImage[] = []
  for (const size of sizes) images.push({ size, png: await rasterise(page, svg, size) })
  const ico = encodeIco(images)
  // Round-trip immediately: our writer read back by our reader catches an offset or a length
  // that does not line up, and the Chromium decode below catches everything that pair agrees on
  // and the world does not.
  const entries = decodeIco(ico)
  if (entries.length !== sizes.length) throw new Error('ICO round-trip lost an entry')
  entries.forEach((entry, index) => {
    const declared = pngSize(entry.payload)
    if (entry.width !== sizes[index] || declared.width !== sizes[index]) {
      throw new Error(
        `ICO entry ${index} is ${entry.width}/${declared.width}, wanted ${sizes[index]}`,
      )
    }
  })
  const decoded = await decodeInChromium(page, ico, 'image/x-icon')
  if (!sizes.includes(decoded.width)) {
    throw new Error(`Chromium decoded the .ico as ${decoded.width}px, which is not a frame in it`)
  }
  return ico
}

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: VIEWPORT, height: VIEWPORT },
  deviceScaleFactor: 1,
})

const faviconSvg = await readFile(join(sourceDir, 'favicon.svg'), 'utf8')
const appSvg = await readFile(join(sourceDir, 'app.svg'), 'utf8')
const desktopSvg = await readFile(join(sourceDir, 'desktop.svg'), 'utf8')

// The browser gets the SVG itself, byte for byte. Copied rather than referenced across packages
// because `packages/web/public` is what the Angular build copies to the site root, and a build
// that reached up into `assets/` would be a second way for these to disagree.
await emit(
  join(webPublic, 'favicon.svg'),
  new Uint8Array(await readFile(join(sourceDir, 'favicon.svg'))),
)
await emit(join(webPublic, 'favicon.ico'), await icoFrom(page, faviconSvg, FAVICON_ICO_SIZES))

for (const size of HOME_SCREEN_SIZES) {
  await emit(join(webPublic, `icon-${size}.png`), await rasterise(page, appSvg, size))
}
await emit(join(webPublic, 'apple-touch-icon.png'), await rasterise(page, appSvg, APPLE_TOUCH_SIZE))

await emit(join(desktopIcons, 'icon.png'), await rasterise(page, desktopSvg, LINUX_WINDOW_SIZE))
await emit(join(desktopIcons, 'icon.ico'), await icoFrom(page, desktopSvg, WINDOW_ICO_SIZES))

// Every PNG this run produced, put back through Chromium's decoder from the bytes on disk rather
// than from the ones in memory — so a truncated write is caught here and not by a user.
for (const size of HOME_SCREEN_SIZES) {
  const file = join(webPublic, `icon-${size}.png`)
  const decoded = await decodeInChromium(page, new Uint8Array(await readFile(file)), 'image/png')
  if (decoded.width !== size) throw new Error(`${file} decoded as ${decoded.width}px`)
}

await browser.close()
console.log(`icons: wrote ${written.length} files\n  ${written.join('\n  ')}`)
