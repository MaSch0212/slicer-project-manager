import { expect, test } from '@playwright/test'
import { curaManagerArchive } from './fixtures'
import { asAdmin, expectHeading, open, openFilters, sidebarNav, useServer } from './support'

const state = useServer()

test.beforeEach(async ({ page }) => {
  await asAdmin(page, state.server)
})

const zipFile = (name: string, suffix: string) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(curaManagerArchive(suffix)),
})

// Ported from import.spec.ts: a zipped CuraManager library is uploaded, imported and shows up as
// projects. Importing lives in the settings page now (spec G 6.2), so the test goes that way.
test('a zipped CuraManager library is imported from the settings page and shows up as projects', async ({
  page,
}) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await sidebarNav(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Import a library' })).toBeVisible()

  // Names nothing else in the suite uses, so this cannot collide with other specs' projects.
  await page.locator('input[type="file"]').setInputFiles(zipFile('curamanager.zip', ' settings'))

  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 })
  const result = page.getByRole('status').filter({ hasText: 'Import finished' })
  await expect(result).toContainText('2 projects and 4 files imported, 3 tags applied')
  // The single wrapping folder is detected and stripped rather than becoming a project.
  await expect(result).toContainText('CuraLibrary')
  // The loose file at the library root is skipped, and the report says so.
  await expect(result).toContainText('1 item was skipped')

  await page.getByRole('link', { name: 'View projects' }).click()
  const alpha = page
    .locator('main ul > li')
    .filter({ has: page.getByRole('heading', { name: 'Zip Import Alpha settings', exact: true }) })
  await expect(alpha).toBeVisible()
  // The sidecar's tags came across with it, which is the point of importing over copying folders.
  await expect(alpha.getByText('zip-imported')).toBeVisible()
  await expect(alpha.getByText('cura', { exact: true })).toBeVisible()

  // The sidecar said the second project is archived: it is there, behind "Show archived".
  await expect(page.getByRole('heading', { name: 'Zip Import Beta settings' })).toHaveCount(0)
  let filters = await openFilters(page)
  await filters.getByText('Show archived', { exact: true }).click()
  await page.keyboard.press('Escape')
  const beta = page
    .locator('main ul > li')
    .filter({ has: page.getByRole('heading', { name: 'Zip Import Beta settings', exact: true }) })
  await expect(beta).toBeVisible()
  await expect(beta.getByText('Archived', { exact: true })).toBeVisible()
  // Put the shared account's filter back for whatever runs after this in the file.
  filters = await openFilters(page)
  await filters.getByText('Show archived', { exact: true }).click()
  await page.keyboard.press('Escape')
})

test('/import still works on its own, and the projects page no longer offers it', async ({
  page,
}) => {
  // An import is done once, so it lives in settings; the list's toolbar is for the list.
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await expect(page.getByRole('link', { name: 'Import', exact: true })).toHaveCount(0)

  // Links and bookmarks to the old page still land somewhere that works.
  await open(page, state.server, '/import')
  await expectHeading(page, 'Import a CuraManager library')

  await page.locator('input[type="file"]').setInputFiles(zipFile('standalone.zip', ' route'))
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Import another archive' }).waitFor()
})

test('a file that is not a zip, and a zip that is broken, change nothing and say so', async ({
  page,
}) => {
  const countProjects = async () =>
    (await state.server.request<unknown[]>('GET', '/api/projects?includeArchived=true')).length
  const before = await countProjects()
  await open(page, state.server, '/import')
  const input = page.locator('input[type="file"]')

  await input.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an archive'),
  })
  await expect(page.getByRole('alert')).toContainText('That is not a .zip archive.')

  await input.setInputFiles({
    name: 'broken.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('PK this is not really a zip file'),
  })
  // A refused archive shows the server's own sentence about it (see `importErrorMessage`).
  await expect(page.getByRole('alert')).toContainText('zip')
  await expect(page.getByText('Import finished')).toHaveCount(0)
  // Nothing was imported: the library holds exactly the projects it held before.
  expect(await countProjects()).toBe(before)
})
