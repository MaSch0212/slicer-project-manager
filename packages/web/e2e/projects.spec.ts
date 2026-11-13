import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { binaryStl, cube } from './fixtures'
import { seedLibrary, type SeedProject } from './seed'
import {
  asAdmin,
  detailPanel,
  expectHeading,
  expectPanel,
  filtersButton,
  open,
  openFilters,
  searchProjects,
  settingsSaved,
  sidebarNav,
  sortBy,
  useServer,
} from './support'

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
    views: [],
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
  const filters = await openFilters(page)
  await filters.getByText('Show archived', { exact: true }).click()
  await expect(filters.getByRole('switch', { name: 'Show archived' })).toBeChecked()
  await page.keyboard.press('Escape')
  // The funnel counts it, so a list with archived projects in it never looks like the default.
  await expect(filtersButton(page)).toHaveAccessibleName('Filters, 1 active')
  await expect(card(page, 'Retired Bracket')).toBeVisible()
  await expect(card(page, 'Retired Bracket').getByText('Archived', { exact: true })).toBeVisible()
  await saved

  // The choice is remembered: it is still on after a reload.
  await page.reload()
  await expect(filtersButton(page)).toHaveAccessibleName('Filters, 1 active')
  await expect(card(page, 'Retired Bracket')).toBeVisible()
})

test('search narrows the list as you type, and says so when nothing matches', async ({ page }) => {
  await projectsPage(page)

  await searchProjects(page, 'clip')
  await expect.poll(() => titles(page)).toEqual(['Cable Clip'])

  await searchProjects(page, 'no such project anywhere')
  await expect(page.getByRole('heading', { name: 'No projects match your filter' })).toBeVisible()

  await searchProjects(page, '')
  await expect.poll(async () => (await titles(page)).length).toBe(5)
})

test('the tag filter lists the library tags, counts the chosen ones and narrows the list', async ({
  page,
}) => {
  await projectsPage(page)
  await expect(filtersButton(page)).toHaveAccessibleName('Filters')

  const panel = await openFilters(page)
  const list = panel.getByRole('group', { name: 'Tags' })
  for (const name of ['boats', 'calibration', 'desk', 'gadgets']) {
    await expect(list.getByRole('checkbox', { name })).toBeVisible()
  }

  const saved = settingsSaved(page)
  await list.getByRole('checkbox', { name: 'gadgets' }).click()
  await expect(list.getByRole('checkbox', { name: 'gadgets' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(filtersButton(page)).toHaveAccessibleName('Filters, 1 active')
  await expect.poll(async () => (await titles(page)).sort()).toEqual(['Cable Clip', 'Phone Stand'])
  await saved

  // The field narrows the list of tags itself.
  await panel.getByRole('searchbox', { name: 'Find a tag' }).fill('cal')
  await expect(list.getByRole('checkbox')).toHaveCount(1)
  await panel.getByRole('searchbox', { name: 'Find a tag' }).fill('')

  // Choosing it again clears it: the count follows the selection down as well as up.
  await list.getByRole('checkbox', { name: 'gadgets' }).click()
  await expect(filtersButton(page)).toHaveAccessibleName('Filters')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect.poll(async () => (await titles(page)).length).toBe(5)
})

test('the sort order changes the list and is remembered', async ({ page }) => {
  await projectsPage(page)

  let saved = settingsSaved(page)
  await sortBy(page, 'Name')
  await saved
  await expect
    .poll(() => titles(page))
    .toEqual(['Benchy', 'Cable Clip', 'Calibration Cube', 'Empty Project', 'Phone Stand'])

  saved = settingsSaved(page)
  await sortBy(page, 'Descending')
  await saved
  await expect.poll(async () => (await titles(page))[0]).toBe('Phone Stand')

  saved = settingsSaved(page)
  await sortBy(page, 'Created')
  await saved
  // The last project created is first: a date reads newest first.
  await expect.poll(async () => (await titles(page))[0]).toBe('Empty Project')

  saved = settingsSaved(page)
  await sortBy(page, 'Name')
  await saved
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sort: Name, Ascending' })).toBeVisible()
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
  await expectPanel(page, 'Wall Hook')
  // The site, not the whole address; the link still goes to all of it.
  const site = detailPanel(page).getByRole('link', { name: 'example.com' })
  await expect(site).toHaveAttribute('href', 'https://example.com/hook')
  await expect(page.getByText('Holds one coat.')).toBeVisible()
  await expect(detailPanel(page).getByText('hooks', { exact: true })).toBeVisible()
  await expect(detailPanel(page).getByText('wall', { exact: true })).toBeVisible()
  expect(existsSync(join(state.server.libraryDir, state.server.username, 'Wall Hook'))).toBe(true)

  await detailPanel(page).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('heading', { name: 'Wall Hook', level: 2 })).toBeVisible()
})

test('a project is edited: name, notes and tags', async ({ page }) => {
  const created = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Edit Me',
    notes: 'before',
  })
  await open(page, state.server, `/projects/${created.id}`)
  await expectPanel(page, 'Edit Me')

  await page.getByRole('button', { name: 'Edit project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit project' })
  await expect(dialog.getByLabel('Name')).toHaveValue('Edit Me')
  await dialog.getByLabel('Name').fill('Edited')
  await dialog.getByLabel('Notes').fill('after')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expectPanel(page, 'Edited')
  await expect(page.getByText('after', { exact: true })).toBeVisible()

  // Tags are picked from a list with a checkmark on each, and a new one is typed into its field;
  // each change is its own request.
  const chip = detailPanel(page).getByText('fresh', { exact: true })
  await detailPanel(page).getByRole('button', { name: 'Choose tags' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose tags' })
  await picker.getByRole('searchbox', { name: 'Find or add a tag' }).fill('fresh')
  await picker.getByRole('searchbox', { name: 'Find or add a tag' }).press('Enter')
  await expect(picker.getByRole('checkbox', { name: 'fresh' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('Escape')
  await expect(chip).toBeVisible()
  await page.reload()
  await expect(chip).toBeVisible()
  await detailPanel(page).getByRole('button', { name: 'Choose tags' }).click()
  await picker.getByRole('checkbox', { name: 'fresh' }).click()
  await page.keyboard.press('Escape')
  await expect(chip).toHaveCount(0)
})

test('a project is archived and restored', async ({ page }) => {
  const created = await state.server.request<{ id: string }>('POST', '/api/projects', {
    name: 'Archive Me',
  })
  await open(page, state.server, `/projects/${created.id}`)
  await expectPanel(page, 'Archive Me')

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
  await expectPanel(page, 'Delete Keep Files')

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

/**
 * Saved views, end to end: the thing no unit test reaches is that picking one in the *shell*
 * reaches a projects page that is already mounted, through the settings and nothing else.
 */
test('a view keeps what the list is showing and brings it back from the sidebar', async ({
  page,
}) => {
  await projectsPage(page)

  let saved = settingsSaved(page)
  await sortBy(page, 'Name')
  await saved
  saved = settingsSaved(page)
  let panel = await openFilters(page)
  await panel.getByRole('checkbox', { name: 'gadgets' }).click()
  await saved
  await page.keyboard.press('Escape')
  await expect.poll(() => titles(page)).toEqual(['Cable Clip', 'Phone Stand'])

  saved = settingsSaved(page)
  await sidebarNav(page).getByRole('button', { name: 'Save this view…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Gadgets')
  await dialog.getByRole('radio', { name: 'Printer' }).click()
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await saved
  await expect(dialog).toBeHidden()

  const row = sidebarNav(page).getByRole('button', { name: /^Gadgets/ })
  await expect(row).toHaveAttribute('aria-current', 'page')

  // Changing a filter by hand keeps the view current and marks it as changed, with a way back
  // and a way to keep the change — Questkeep's draft.
  saved = settingsSaved(page)
  panel = await openFilters(page)
  await panel.getByRole('checkbox', { name: 'gadgets' }).click()
  await saved
  await page.keyboard.press('Escape')
  // Not a count: tests before this one in the file add and remove projects of their own.
  await expect(page.getByRole('heading', { name: 'Benchy', level: 2 })).toBeVisible()
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(row).toContainText('Changed since it was saved')
  const changes = page.getByRole('group', { name: 'Unsaved changes to Gadgets' })
  await expect(changes).toBeVisible()

  // Reset puts every part of it back on the page that is already open.
  saved = settingsSaved(page)
  await changes.getByRole('button', { name: 'Reset to Gadgets' }).click()
  await saved
  await expect.poll(() => titles(page)).toEqual(['Cable Clip', 'Phone Stand'])
  await expect(filtersButton(page)).toHaveAccessibleName('Filters, 1 active')
  await expect(page.getByRole('button', { name: 'Sort: Name, Ascending' })).toBeVisible()
  await expect(changes).toBeHidden()
  await expect(row).not.toContainText('Changed since it was saved')

  // It lives on the account, so a reload still has it.
  await page.reload()
  await expect(sidebarNav(page).getByRole('button', { name: /^Gadgets/ })).toHaveAttribute(
    'aria-current',
    'page',
  )
})
