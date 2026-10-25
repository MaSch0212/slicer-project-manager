import { expect, test, type Page } from '@playwright/test'
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './seed'
import {
  asAdmin,
  expectHeading,
  open,
  settingsSaved,
  sidebarNav,
  signInThroughForm,
  useServer,
} from './support'

const state = useServer()

const BG = { light: 'rgb(247, 247, 248)', dark: 'rgb(12, 13, 15)' }

// Settings are per user, i.e. on the one shared admin account: every test starts from the defaults.
test.beforeEach(async ({ page }) => {
  await state.server.request('PUT', '/api/account/settings', {
    theme: 'system',
    language: 'en',
    viewMode: 'grid',
    navCollapsed: false,
  })
  await asAdmin(page, state.server)
})

const settingsPage = async (page: Page) => {
  await open(page, state.server, '/settings')
  await expectHeading(page, 'Settings')
}

// Ported from smoke.spec.ts: the language switch takes effect without a reload, in both directions,
// and (new) it is still there after one.
test('the language switch takes effect at once, in both directions, and survives a reload', async ({
  page,
}) => {
  await settingsPage(page)
  let saved = settingsSaved(page)
  await page.getByRole('combobox', { name: 'Language' }).selectOption({ label: 'Deutsch' })
  await expectHeading(page, 'Einstellungen')
  await saved
  // The whole shell followed, not just the page.
  await expect(
    page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Projekte' }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('de')

  await page.reload()
  await expectHeading(page, 'Einstellungen')
  await expect(page.getByRole('combobox', { name: 'Sprache' })).toHaveValue('de')

  saved = settingsSaved(page)
  await page.getByRole('combobox', { name: 'Sprache' }).selectOption({ label: 'English' })
  await expectHeading(page, 'Settings')
  await saved
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
})

test('the theme switch applies at once, in both schemes, and survives a reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await settingsPage(page)
  await expect(page.locator('body')).toHaveCSS('background-color', BG.light)

  let saved = settingsSaved(page)
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true })
  await saved
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('body')).toHaveCSS('background-color', BG.dark)

  await page.reload()
  await expectHeading(page, 'Settings')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked()
  await expect(page.locator('body')).toHaveCSS('background-color', BG.dark)

  // "System" hands the choice back to the OS: it follows the emulated preference again.
  saved = settingsSaved(page)
  await page.getByRole('radio', { name: 'System' }).check({ force: true })
  await saved
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
  await expect(page.locator('body')).toHaveCSS('background-color', BG.light)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('body')).toHaveCSS('background-color', BG.dark)

  saved = settingsSaved(page)
  await page.getByRole('radio', { name: 'Light' }).check({ force: true })
  await saved
  await expect(page.locator('body')).toHaveCSS('background-color', BG.light)
})

test('the theme menu in the sidebar changes the same setting', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await page.getByRole('button', { name: 'Theme' }).click()
  const saved = settingsSaved(page)
  await page.getByRole('menuitem', { name: 'Dark' }).click()
  await saved
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await settingsPage(page)
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked()
})

test('the default project view is a setting and the projects page follows it', async ({ page }) => {
  await settingsPage(page)
  const saved = settingsSaved(page)
  await page.getByRole('radio', { name: 'List' }).check({ force: true })
  await saved
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked()

  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked()
})

// Ported from smoke.spec.ts: the collapsed sidebar keeps its names, and a collapse is still there
// after the window reloads (spec G 9.2) -- from the sidebar's own toggle and from the settings page.
test('collapsing the navigation keeps every name, and survives a reload', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Collapse or expand the navigation' })
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  const width = async () => (await page.locator('aside').boundingBox())!.width
  const expanded = await width()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  const saved = settingsSaved(page)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await saved
  await expect.poll(width).toBeLessThan(expanded / 2)
  // Same names, with no visible text: an icon with no name is the failure this guards against.
  await expect(page.getByRole('link', { name: 'Slicer Project Manager', exact: true })).toHaveCount(
    1,
  )
  await expect(sidebarNav(page).getByRole('link', { name: 'Projects', exact: true })).toHaveCount(1)

  await page.reload()
  await expectHeading(page, 'Projects')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(width).toBeLessThan(expanded / 2)

  // The setting on the settings page is the same state.
  await settingsPage(page)
  const sw = page.getByRole('switch', { name: 'Collapse the navigation' })
  await expect(sw).toBeChecked()
  const restored = settingsSaved(page)
  await sw.uncheck({ force: true })
  await restored
  await expect(sw).not.toBeChecked()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(width).toBe(expanded)
})

test('the web build has no Slicers tab, and its route sends you back to the projects', async ({
  page,
}) => {
  await settingsPage(page)
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Slicers' })).toHaveCount(0)
  // Desktop-only sections are not drawn for a browser either.
  await expect(page.getByText('Where your library is')).toHaveCount(0)

  await open(page, state.server, '/settings/slicers')
  await expect(page).toHaveURL(`${state.server.origin}/projects`)
})

test('the display name is saved and is still there after a reload', async ({ page }) => {
  await settingsPage(page)
  const name = page.getByLabel('Display name')
  await expect(name).toHaveValue('Administrator')
  await expect(page.getByLabel('Username')).toHaveValue(ADMIN_USERNAME)
  await expect(page.getByLabel('Username')).toHaveJSProperty('readOnly', true)

  await name.fill('')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('This field is required')).toBeVisible()

  await name.fill('Site Admin')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('Your name was saved')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Display name')).toHaveValue('Site Admin')
  // The same name is what the user list says.
  await open(page, state.server, '/admin/users')
  await expect(page.getByRole('row', { name: /Site Admin/ })).toBeVisible()
})

test('the password is changed: a wrong current one is refused, the new one signs in, the old one does not', async ({
  page,
  browser,
}) => {
  const NEW_PASSWORD = 'a different long password'
  await settingsPage(page)
  const fill = async (current: string, next: string, confirm: string) => {
    await page.getByLabel('Current password').fill(current)
    await page.getByLabel('New password').fill(next)
    await page.getByLabel('Confirm password').fill(confirm)
    await page.getByRole('button', { name: 'Change password' }).click()
  }

  // The rules that need no server: short, and not confirmed.
  await fill(ADMIN_PASSWORD, 'short', 'other')
  await expect(
    page.getByRole('alert').filter({ hasText: 'Use at least 10 characters' }),
  ).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: 'The passwords do not match' }),
  ).toBeVisible()

  await fill('not my password', NEW_PASSWORD, NEW_PASSWORD)
  await expect(page.getByText('The current password is not correct')).toBeVisible()

  await fill(ADMIN_PASSWORD, NEW_PASSWORD, NEW_PASSWORD)
  await expect(page.getByText('Your password was changed')).toBeVisible()
  await expect(page.getByLabel('Current password')).toHaveValue('')

  // A new browser: the new password works and the old one does not.
  const fresh = await browser.newContext()
  try {
    const other = await fresh.newPage()
    await signInThroughForm(other, state.server, ADMIN_USERNAME, ADMIN_PASSWORD)
    await expect(other.getByRole('alert')).toContainText('Username or password is not correct')
    await other.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD)
    await other.getByRole('button', { name: 'Sign in' }).click()
    await expectHeading(other, 'Projects')
  } finally {
    await fresh.close()
  }
})
