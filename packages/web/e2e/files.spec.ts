import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { binaryStl, cube, cylinder, obj, threeMf } from './fixtures'
import { asAdmin, expectHeading, open, useServer } from './support'

const state = useServer()

test.beforeEach(async ({ page }) => {
  await asAdmin(page, state.server)
})

async function newProject(name: string): Promise<string> {
  const created = await state.server.request<{ id: string }>('POST', '/api/projects', { name })
  return created.id
}
const folder = (project: string) => join(state.server.libraryDir, state.server.username, project)

const fileCard = (page: Page, name: string) =>
  page.locator('main ul > li').filter({ has: page.getByRole('heading', { name, exact: true }) })

const choose = (page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) =>
  page.locator('input[type="file"]').setInputFiles(files)

test('an uploaded model shows up, gets a rendered thumbnail, and can be downloaded', async ({
  page,
}) => {
  const id = await newProject('Upload Cube')
  await open(page, state.server, `/projects/${id}`)
  await expectHeading(page, 'Upload Cube')
  await expect(page.getByRole('heading', { name: 'This project has no files yet' })).toBeVisible()

  const bytes = Buffer.from(binaryStl(cube(20)))
  await choose(page, [{ name: 'cube.stl', mimeType: 'model/stl', buffer: bytes }])

  // The queue says it is done, and the file is in the list with its kind and size.
  await expect(page.getByText('Added', { exact: true })).toBeVisible()
  const card = fileCard(page, 'cube.stl')
  await expect(card).toBeVisible()
  await expect(card.getByText('Model', { exact: true })).toBeVisible()
  expect(existsSync(join(folder('Upload Cube'), 'cube.stl'))).toBe(true)

  // The preview is made in the background and the page refetches while one is pending, so the
  // picture arrives by itself. `naturalWidth` is the decoded size: 0 for bytes that are no image.
  const thumb = card.locator('img')
  await expect(thumb).toBeVisible({ timeout: 25_000 })
  await expect(thumb).toHaveAttribute('src', /^\/api\/files\/[0-9a-f-]+\/thumb/)
  expect(
    await thumb.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
  ).toEqual([256, 256])
  await expect(card.getByText('Preview pending')).toHaveCount(0)

  // Download serves the bytes that went in.
  const href = await card.getByRole('link', { name: 'Download: cube.stl' }).getAttribute('href')
  const response = await page.request.get(`${state.server.origin}${href}`)
  expect(response.ok()).toBe(true)
  expect((await response.body()).equals(bytes)).toBe(true)
})

test('every kind of file is classified, and only a model is offered the viewer', async ({
  page,
}) => {
  const id = await newProject('Upload Kinds')
  await open(page, state.server, `/projects/${id}`)
  await expectHeading(page, 'Upload Kinds')

  await choose(page, [
    { name: 'a.stl', mimeType: 'model/stl', buffer: Buffer.from(binaryStl(cube(8))) },
    { name: 'b.obj', mimeType: 'text/plain', buffer: Buffer.from(obj(cube(8))) },
    { name: 'c.3mf', mimeType: 'model/3mf', buffer: Buffer.from(threeMf(cube(8))) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('print at 0.2 mm\n') },
  ])
  for (const name of ['a.stl', 'b.obj', 'c.3mf', 'notes.txt']) {
    await expect(fileCard(page, name)).toBeVisible()
  }
  await expect(fileCard(page, 'notes.txt').getByText('Other file')).toBeVisible()
  await expect(fileCard(page, 'notes.txt').getByText('No preview')).toBeVisible()
  await expect(fileCard(page, 'notes.txt').getByRole('link', { name: /^View in 3D/ })).toHaveCount(
    0,
  )
  for (const name of ['a.stl', 'b.obj', 'c.3mf']) {
    await expect(
      fileCard(page, name).getByRole('link', { name: `View in 3D: ${name}` }),
    ).toBeVisible()
  }
})

test('a file is renamed, and a name that cannot be a file name is refused', async ({ page }) => {
  const id = await newProject('Rename File')
  await state.server.upload(id, 'before.stl', binaryStl(cube(8)))
  await open(page, state.server, `/projects/${id}`)
  const menu = page.getByRole('button', { name: 'Actions for before.stl' })
  await menu.click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()

  const dialog = page.getByRole('dialog', { name: 'Rename file' })
  const name = dialog.getByLabel('New file name')
  await expect(name).toHaveValue('before.stl')
  await name.fill('a/b.stl')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog.getByText('That file name is not allowed')).toBeVisible()

  await name.fill('after.stl')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(fileCard(page, 'after.stl')).toBeVisible()
  await expect(fileCard(page, 'before.stl')).toHaveCount(0)
  expect(existsSync(join(folder('Rename File'), 'after.stl'))).toBe(true)
  expect(existsSync(join(folder('Rename File'), 'before.stl'))).toBe(false)

  // The new name is what the server has, not only what the page shows.
  await page.reload()
  await expect(fileCard(page, 'after.stl')).toBeVisible()
})

test('a file is deleted only after the confirmation, and leaves the disk', async ({ page }) => {
  const id = await newProject('Delete File')
  await state.server.upload(id, 'doomed.stl', binaryStl(cube(8)))
  await state.server.upload(id, 'kept.stl', binaryStl(cylinder(4, 8)))
  await open(page, state.server, `/projects/${id}`)
  await expect(fileCard(page, 'doomed.stl')).toBeVisible()

  await page.getByRole('button', { name: 'Actions for doomed.stl' }).click()
  await page.getByRole('menuitem', { name: 'Delete file' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this file?' })
  await expect(dialog).toContainText('Delete doomed.stl?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(fileCard(page, 'doomed.stl')).toBeVisible()

  await page.getByRole('button', { name: 'Actions for doomed.stl' }).click()
  await page.getByRole('menuitem', { name: 'Delete file' }).click()
  await page
    .getByRole('dialog', { name: 'Delete this file?' })
    .getByRole('button', { name: 'Yes, delete' })
    .click()
  await expect(fileCard(page, 'doomed.stl')).toHaveCount(0)
  await expect(fileCard(page, 'kept.stl')).toBeVisible()
  expect(existsSync(join(folder('Delete File'), 'doomed.stl'))).toBe(false)
  expect(existsSync(join(folder('Delete File'), 'kept.stl'))).toBe(true)
})

// Ported from preview.spec.ts: the end of the chain the rasterizer exists for. A library holding a
// plain STL shows a rendered thumbnail on the project's card instead of "Preview pending". An STL
// carries no embedded picture, so only the real preview queue can have produced the one on screen.
test('a plain STL gets a rendered thumbnail in the projects grid', async ({ page }) => {
  const project = 'Rasterized Cube'
  const id = await newProject(project)
  const file = await state.server.upload(id, 'cube.stl', binaryStl(cube(20)))
  await state.server.waitForPreviews()

  await open(page, state.server, '/projects')
  const card = page
    .locator('main ul > li')
    .filter({ has: page.getByRole('heading', { name: project, exact: true }) })
  const thumb = card.locator('img')
  await expect(thumb).toBeVisible()
  await expect(thumb).toHaveAttribute('src', `/api/files/${file.id}/thumb`)

  // Displayed, not merely present: 256 is what the rasterizer renders, so this is the one
  // assertion that the bytes on the card are a PNG the browser could actually draw.
  await expect
    .poll(() =>
      thumb.evaluate((image: HTMLImageElement) => ({
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
      })),
    )
    .toEqual({ complete: true, width: 256, height: 256 })
  await expect(card.getByText('Preview pending')).toHaveCount(0)
})
