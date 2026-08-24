import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PASSWORD = 'e2e test password'

/**
 * Names nothing else in the suite uses. Every spec drives the same server against the same
 * library on disk (see the note in playwright.config.ts), so a shared name would make two
 * specs' assertions depend on the order they happen to run in.
 */
const PROJECT = 'Rasterized Cube'

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
 * A real binary STL of a cube, built here rather than checked in as a binary fixture, for the
 * same reason `import.spec.ts` builds its zip inline: what the test puts on disk is readable in
 * the diff. It has to be genuinely parseable — the whole point of this spec is that the server
 * renders it, and a placeholder like `solid cube` would only prove the queue can fail.
 */
function binaryStlCube(): Uint8Array {
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

/** Drops a project folder holding one model file into the library, as a file manager would. */
function dropModelIntoLibrary(project: string, fileName: string, bytes: Uint8Array): void {
  const libraryDir = process.env['SPM_E2E_LIBRARY']
  if (!libraryDir) throw new Error('SPM_E2E_LIBRARY is not set; playwright.config.ts sets it')
  const dir = join(libraryDir, 'admin', project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), bytes)
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
}

/**
 * The end of the chain the whole rasterizer subsystem exists for, and the plan's definition of
 * done in one sentence: a library holding a plain STL shows a thumbnail in the projects grid
 * rather than "Preview pending".
 *
 * Only the real thing can make this pass. An STL carries no embedded thumbnail, so the picture
 * on the card can only come from `main.ts` handing `MESH_HANDLER` to `runPreviewQueue`, the
 * rasterizer drawing it, the PNG encoder writing it and the thumb route serving it. Nothing
 * else in the suite covers `main.ts` at all.
 */
test('a plain STL gets a rendered thumbnail in the projects grid', async ({ page }) => {
  dropModelIntoLibrary(PROJECT, 'cube.stl', binaryStlCube())

  await signIn(page)
  await page.getByRole('button', { name: 'Rescan library' }).click()
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible()

  // The grid is fetched once per page load and the queue runs on its own interval (which
  // playwright.config.ts sets low for exactly this), so reload until the cover appears rather
  // than waiting a fixed time. Comfortably inside Playwright's 30-second per-test timeout, so
  // that a genuine failure reports *this* budget running out and names the missing thumbnail,
  // rather than the test being killed from outside with a less specific message.
  const thumb = page.getByRole('img', { name: PROJECT })
  await expect(async () => {
    await page.reload()
    await expect(thumb).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })

  await expect(thumb).toHaveAttribute('src', /^\/api\/files\/[0-9a-f-]+\/thumb$/)

  // Displayed, not merely present: `naturalWidth` is the decoded intrinsic size, so it is 0 for
  // an <img> whose bytes never arrived or did not parse as an image. 256 is what the rasterizer
  // renders, which makes this the one assertion that the bytes on the card are a real PNG the
  // browser could actually draw.
  const decoded = await thumb.evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    width: element.naturalWidth,
    height: element.naturalHeight,
  }))
  expect(decoded).toEqual({ complete: true, width: 256, height: 256 })

  // And the card is no longer showing the placeholder this subsystem exists to replace.
  const card = page.locator('li.spm-project').filter({ hasText: PROJECT })
  await expect(card).toHaveCount(1)
  await expect(card.getByText('Preview pending')).toHaveCount(0)
})
