import { expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PASSWORD = 'e2e test password'

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Land on /projects before touching the nav: the shell header is already rendered on
  // /login, so clicking a link while the login's own navigation is still in flight starts a
  // navigation the login one then wins.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
}

/** Drops a project folder holding one file into the library, as a file manager would. */
export function dropModelIntoLibrary(project: string, fileName: string, bytes: Uint8Array): void {
  const libraryDir = process.env['SPM_E2E_LIBRARY']
  if (!libraryDir) throw new Error('SPM_E2E_LIBRARY is not set; playwright.config.ts sets it')
  const dir = join(libraryDir, 'admin', project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), bytes)
}

const CORNERS: [number, number, number][] = [
  [-10, -10, -10],
  [10, -10, -10],
  [10, 10, -10],
  [-10, 10, -10],
  [-10, -10, 10],
  [10, -10, 10],
  [10, 10, 10],
  [-10, 10, 10],
]

const FACES: [number, number, number, number][] = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [1, 2, 6, 5],
  [3, 0, 4, 7],
]

/**
 * A real binary STL of a 20 mm cube, built here rather than checked in as a binary fixture, for
 * the same reason `import.spec.ts` builds its zip inline: what the test puts on disk is readable
 * in the diff. It has to be genuinely parseable — the preview spec asserts the server renders a
 * thumbnail of it and the viewer spec asserts the browser draws it, and a placeholder like
 * `solid cube` would only prove that both can fail.
 *
 * A cube and not something prettier because of what the viewer spec reads off the canvas: an
 * axis-aligned box shows exactly three faces to the isometric camera, at three separate
 * shades, which is what makes "the lit face" and "the shadowed face" well-defined pixels to
 * measure a contrast ratio between.
 *
 * 84 + 12 × 50 = 684 bytes, which is also the point of it: every spec that uses it pays a
 * millisecond, and the e2e job's twenty-minute budget goes on the assertions instead.
 */
export function binaryStlCube(): Uint8Array {
  const triangles: number[][] = []
  for (const [a, b, c, d] of FACES) {
    for (const face of [
      [a, b, c],
      [a, c, d],
    ]) {
      triangles.push(face.flatMap((i) => CORNERS[i]!))
    }
  }
  const out = new Uint8Array(84 + triangles.length * 50)
  const view = new DataView(out.buffer)
  view.setUint32(80, triangles.length, true)
  let offset = 84
  for (const triangle of triangles) {
    offset += 12 // facet normal left zero; the rasterizer recomputes shading from the geometry
    for (const value of triangle) {
      view.setFloat32(offset, value, true)
      offset += 4
    }
    offset += 2 // attribute byte count
  }
  return out
}

/**
 * The same cube as an OBJ, padded with comment lines until the file is at least `minimumBytes`.
 *
 * It exists for one assertion: the viewer's size gate reads `FileDto.sizeBytes` and refuses to
 * open anything past its format's line, so the only way to see the gate — and the collapsed
 * stage behind it — is a file that is genuinely that large on disk. The padding is comments
 * rather than geometry because `OBJLoader` drops a `#` line on its first character, so what
 * comes back after "Load it anyway" is still the twelve-triangle cube: the gate is exercised at
 * full size while the parse, the fit and the draw stay as cheap as every other test here.
 *
 * OBJ, of the three formats, on a balance of two costs. `.stl` does not trip until 37.9 MB, which
 * is a download this suite should not spend its budget on. `.3mf` trips at 2.2 MB, five times
 * smaller, but it would have to be a real zip built here as well, and its padding could not be
 * inert — a 3MF is priced at four times an OBJ per byte precisely because every entry is inflated
 * and turned into a DOM, so the fixture would cost the browser real memory rather than a string
 * the loader skips. OBJ is the one where a large file on disk stays a small parse.
 */
export function paddedObjCube(minimumBytes: number): Uint8Array {
  const lines = CORNERS.map(([x, y, z]) => `v ${x} ${y} ${z}`)
  // OBJ vertex indices are 1-based, and a quad face is fanned into triangles by the loader.
  lines.push(...FACES.map((face) => `f ${face.map((i) => i + 1).join(' ')}`))
  const mesh = `${lines.join('\n')}\n`

  // Long lines rather than many short ones: the loader splits the whole file on '\n' and holds
  // every slice, so a megabyte of two-character comments would cost far more to open than a
  // megabyte of file has any business costing.
  const filler = `# ${'padding '.repeat(120)}\n`
  const parts = [mesh]
  for (let size = mesh.length; size < minimumBytes; size += filler.length) parts.push(filler)
  return new TextEncoder().encode(parts.join(''))
}
