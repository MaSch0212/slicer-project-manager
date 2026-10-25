import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { binaryStl, cube } from './fixtures'
import { seedLibrary, type SeedProject } from './seed'
import { asAdmin, expectHeading, open, settingsSaved, useServer } from './support'

const stl = (name: string) => ({ name, bytes: binaryStl(cube(10)) })

const PLAN: SeedProject[] = [
  { name: 'Benchy', tags: ['boats', 'calibration'], files: [stl('benchy.stl')] },
  { name: 'Calibration Cube', tags: ['calibration'], files: [stl('cube.stl')] },
  { name: 'Phone Stand', tags: ['gadgets', 'desk'], files: [stl('stand.stl')] },
  { name: 'Cable Clip', tags: ['gadgets'], files: [stl('clip.stl')] },
  { name: 'Retired Bracket', tags: ['printer-parts'], archived: true, files: [stl('bracket.stl')] },
  { name: 'Empty Project' },
]

const state = useServer((server) => seedLibrary(server, PLAN))

// Filters, sort and the view mode are remembered per user, i.e. on the one shared admin account:
// every test starts from the defaults, whatever the one before it did.
test.beforeEach(async ({ page }) => {
  await state.server.request('PUT', '/api/account/settings', {
    sort: 'updatedAt',
    dir: 'desc',
    includeArchived: false,
    filterTags: [],
    viewMode: 'grid',
  })
  await asAdmin(page, state.server)
})

const projectsPage = async (page: Page) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await expect(page.getByRole('heading', { name: 'Benchy', level: 2 })).toBeVisible()
}

const titles = (page: Page) => page.locator('main ul > li h2').allTextContents()
const card = (page: Page, name: string) =>
  page.locator('main ul > li').filter({ has: page.getByRole('heading', { name, exact: true }) })

test('lists the projects, hiding the archived ones until asked', async ({ page }) => {
  await projectsPage(page)
  await expect(card(page, 'Retired Bracket')).toHaveCount(0)
  expect((await titles(page)).sort()).toEqual([
    'Benchy',
    'Cable Clip',
    'Calibration Cube',
    'Empty Project',
    'Phone Stand',
  ])

  const saved = settingsSaved(page)
  await page.getByRole('button', { name: 'Show archived' }).click()
  await expect(page.getByRole('button', { name: 'Show archived' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(card(page, 'Retired Bracket')).toBeVisible()
  await expect(card(page, 'Retired Bracket').getByText('Archived', { exact: true })).toBeVisible()
  await saved

  // The choice is remembered: it is still on after a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show archived' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(card(page, 'Retired Bracket')).toBeVisible()
})

test('search narrows the list as you type, and says so when nothing matches', async ({ page }) => {
  await projectsPage(page)
  const search = page.getByRole('searchbox', { name: 'Search' })

  await search.fill('clip')
  await expect.poll(() => titles(page)).toEqual(['Cable Clip'])

  await search.fill('no such project anywhere')
  await expect(page.getByRole('heading', { name: 'No projects match your filter' })).toBeVisible()

  await search.fill('')
  await expect.poll(async () => (await titles(page)).length).toBe(5)
})

test('the tag filter lists the library tags, counts the chosen ones and narrows the list', async ({
  page,
}) => {
  await projectsPage(page)
  const tags = page.getByRole('button', { name: 'Tags' })
  await expect(tags).toHaveAttribute('aria-expanded', 'false')

  await tags.click()
  await expect(tags).toHaveAttribute('aria-expanded', 'true')
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  for (const name of ['boats', 'calibration', 'desk', 'gadgets']) {
    await expect(list.getByRole('option', { name })).toBeVisible()
  }

  const saved = settingsSaved(page)
  await list.getByRole('option', { name: 'gadgets' }).click()
  await expect(tags).toContainText('1')
  await expect.poll(async () => (await titles(page)).sort()).toEqual(['Cable Clip', 'Phone Stand'])
  await saved

  // Choosing it again clears it: the count follows the selection down as well as up.
  await list.getByRole('option', { name: 'gadgets' }).click()
  await expect(tags).not.toContainText('1')
  await page.keyboard.press('Escape')
  await expect(tags).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await titles(page)).length).toBe(5)
})

test('the sort order changes the list and is remembered', async ({ page }) => {
  await projectsPage(page)
  const sort = page.getByRole('combobox', { name: 'Sort by' })

  let saved = settingsSaved(page)
  await sort.selectOption({ label: 'A–Z' })
  await saved
  await expect
    .poll(() => titles(page))
    .toEqual(['Benchy', 'Cable Clip', 'Calibration Cube', 'Empty Project', 'Phone Stand'])

  saved = settingsSaved(page)
  await sort.selectOption({ label: 'Newest' })
  await saved
  // The last project created is first.
  await expect.poll(async () => (await titles(page))[0]).toBe('Empty Project')

  saved = settingsSaved(page)
  await sort.selectOption({ label: 'A–Z' })
  await saved
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('name:asc')
  await expect(page.getByRole('heading', { name: 'Benchy', level: 2 })).toBeVisible()
  expect((await titles(page))[0]).toBe('Benchy')
})

test('the view mode switches between grid and list and is remembered', async ({ page }) => {
  await projectsPage(page)
  const list = page.getByRole('radio', { name: 'List' })
  const grid = page.getByRole('radio', { name: 'Grid' })
  await expect(grid).toBeChecked()
  const tileHeight = (await card(page, 'Benchy').boundingBox())!.height

  const saved = settingsSaved(page)
  await list.check()
  await saved
  await expect(list).toBeChecked()
  // A list row sits beside its picture; a grid tile stacks it above, so the tile is much taller.
  await expect
    .poll(async () => (await card(page, 'Benchy').boundingBox())!.height)
    .toBeLessThan(tileHeight / 2)

  await page.reload()
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked()
})

test('a rescan adopts a folder dropped into the library', async ({ page }) => {
  // The folder this asserts on is created here, immediately before the rescan: otherwise the
  // assertion would pass on the literal word "Adopted" whether or not anything was adopted.
  const name = 'Dropped In'
  mkdirSync(join(state.server.libraryDir, state.server.username, name), { recursive: true })
  await projectsPage(page)

  await page.getByRole('button', { name: 'Rescan library' }).click()
  await expect(page.getByText('Adopted 1, 0 files added')).toBeVisible()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
})

test('a project is created with its details and tags', async ({ page }) => {
  await projectsPage(page)
  await page.getByRole('button', { name: 'New project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project' })

  // The name is required, the address must be one; nothing is sent until both are right.
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog.getByText('This field is required')).toBeVisible()
  await dialog.getByLabel('Name').fill('Wall Hook')
  await dialog.getByLabel('Source URL').fill('not an address')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog.getByText('Enter a full address, such as https://example.com')).toBeVisible()

  await dialog.getByLabel('Source URL').fill('https://example.com/hook')
  await dialog.getByLabel('Notes').fill('Holds one coat.')
  const tagBox = dialog.getByRole('textbox', { name: 'Tags' })
  await tagBox.fill('hooks')
  await tagBox.press('Enter')
  await tagBox.fill('wall')
  await tagBox.press('Enter')
  await dialog.getByRole('button', { name: 'Create project' }).click()

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
  await expectHeading(page, 'Wall Hook')
  await expect(page.getByRole('link', { name: 'https://example.com/hook' })).toBeVisible()
  await expect(page.getByText('Holds one coat.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove tag hooks' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove tag wall' })).toBeVisible()
  expect(existsSync(join(state.server.libraryDir, state.server.username, 'Wall Hook'))).toBe(true)

  await page.getByRole('link', { name: 'Back to all projects' }).click()
  await expect(page.getByRole('heading', { name: 'Wall Hook', level: 2 })).toBeVisible()
})

test('a project is edited: name, notes and tags', async ({ page }) => {
  const created = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Edit Me',
    notes: 'before',
  })
  await open(page, state.server, `/projects/${created.id}`)
  await expectHeading(page, 'Edit Me')

  await page.getByRole('button', { name: 'Edit project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit project' })
  await expect(dialog.getByLabel('Name')).toHaveValue('Edit Me')
  await dialog.getByLabel('Name').fill('Edited')
  await dialog.getByLabel('Notes').fill('after')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expectHeading(page, 'Edited')
  await expect(page.getByText('after', { exact: true })).toBeVisible()

  // Tags are edited in place, each change its own request.
  const tagBox = page.getByRole('textbox', { name: 'Add tag' })
  await tagBox.fill('fresh')
  await tagBox.press('Enter')
  await expect(page.getByRole('button', { name: 'Remove tag fresh' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Remove tag fresh' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove tag fresh' }).click()
  await expect(page.getByRole('button', { name: 'Remove tag fresh' })).toHaveCount(0)
})

test('a project is archived and restored', async ({ page }) => {
  const created = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Archive Me',
  })
  await open(page, state.server, `/projects/${created.id}`)
  await expectHeading(page, 'Archive Me')

  await page.getByRole('button', { name: 'Archive this project' }).click()
  await expect(page.getByText('Archived', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Restore this project from the archive' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Restore this project from the archive' }).click()
  await expect(page.getByText('Archived', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive this project' })).toBeVisible()
})

test('deleting a project asks first, and keeps or erases the files as chosen', async ({ page }) => {
  const folder = (name: string) => join(state.server.libraryDir, state.server.username, name)
  const keep = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Delete Keep Files',
  })
  const erase = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Delete Erase Files',
  })

  // Cancelling leaves everything as it was.
  await open(page, state.server, `/projects/${keep.id}`)
  await page.getByRole('button', { name: 'Delete project' }).click()
  let dialog = page.getByRole('dialog', { name: 'Delete this project?' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expectHeading(page, 'Delete Keep Files')

  // Plain delete: the project goes, its folder stays.
  await page.getByRole('button', { name: 'Delete project' }).click()
  dialog = page.getByRole('dialog', { name: 'Delete this project?' })
  await expect(dialog).toContainText('the files stay on disk')
  await dialog.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(page).toHaveURL(`${state.server.origin}/projects`)
  expect(existsSync(folder('Delete Keep Files'))).toBe(true)

  // With the checkbox: the folder goes too.
  await open(page, state.server, `/projects/${erase.id}`)
  await page.getByRole('button', { name: 'Delete project' }).click()
  dialog = page.getByRole('dialog', { name: 'Delete this project?' })
  // The input itself is visually hidden behind the styled box; its label is what a person clicks.
  await dialog.getByText('Also delete the files on disk').click()
  await expect(
    dialog.getByRole('checkbox', { name: 'Also delete the files on disk' }),
  ).toBeChecked()
  await expect(dialog).toContainText('cannot be undone')
  await dialog.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(page).toHaveURL(`${state.server.origin}/projects`)
  await expect.poll(() => existsSync(folder('Delete Erase Files'))).toBe(false)

  await expect(page.getByRole('heading', { name: 'Delete Keep Files', level: 2 })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Delete Erase Files', level: 2 })).toHaveCount(0)
})
