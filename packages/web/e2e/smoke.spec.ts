import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PASSWORD = 'e2e test password'

/**
 * Creates a project folder directly on disk, the way a user dropping a folder into their
 * library with the file manager does. `admin`'s `library_dir` is its own username (see
 * `ensureBootstrapAdmin`), so the folder belongs one level under the library root. The
 * library directory itself is the one playwright.config.ts seeded and handed to the server.
 */
function dropFolderIntoLibrary(name: string): void {
  const libraryDir = process.env['SPM_E2E_LIBRARY']
  if (!libraryDir) throw new Error('SPM_E2E_LIBRARY is not set; playwright.config.ts sets it')
  mkdirSync(join(libraryDir, 'admin', name), { recursive: true })
}

test('an admin can log in, create a project and see it in the grid', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.getByLabel('Name').fill('Benchy')
  await page.getByRole('button', { name: 'New project' }).click()

  await expect(page.getByRole('heading', { name: 'Benchy' })).toBeVisible()
})

test('a rescan adopts a folder dropped into the library', async ({ page }) => {
  // Self-sufficient rather than leaning on what the previous test left behind: the folder
  // this asserts on is created here, in the admin's library root, immediately before the
  // rescan. Without it the assertion would pass on the literal word "Adopted" in the
  // summary line regardless of whether anything was actually adopted.
  dropFolderIntoLibrary('Dropped In')

  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('button', { name: 'Rescan library' }).click()
  // The rescan summary specifically, not any role="status". A rescan reloads the project list,
  // and `jig-spinner` carries `role="status"` too, so while that reload is in flight there are
  // two of them and Playwright's strict mode fails the locator rather than the assertion:
  // "strict mode violation: getByRole('status') resolved to 2 elements". It only shows up on a
  // slow runner -- green here, red on CI -- and it is a race in the locator, not in the app.
  await expect(page.locator('jig-message[role="status"]')).toContainText('Adopted 1')
  await expect(page.getByRole('heading', { name: 'Dropped In' })).toBeVisible()
})

test('the language switch takes effect without a reload', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Wait for the post-login navigation to land before touching the nav. The Settings link
  // lives in the shell header, so it is already clickable on /login: clicking it while the
  // login's own `router.navigate(['/projects'])` is still in flight starts a navigation that
  // the login one then wins, leaving the projects page rendered under a /settings URL.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()

  // jig-select is a combobox over a listbox popover, not a native <select>, so this opens
  // it and picks the option rather than calling selectOption.
  await page.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: 'Deutsch' }).click()

  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()

  // The language is persisted server-side and re-applied on every bootstrap (app.config.ts),
  // so leaving it on German would rename the nav for every later test in the file. Switching
  // back is also the other half of the assertion: the swap is reactive in both directions.
  await page.getByRole('combobox', { name: 'Sprache' }).click()
  await page.getByRole('option', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
})

test('the admin route is reachable for an admin and lists users', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Same reason as the language test: land on /projects first. (The Users link is itself
  // only rendered for an authenticated admin, so this one is belt and braces — but the two
  // tests should not differ in whether they wait.)
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.getByRole('link', { name: 'Users' }).click()
  // `exact` because the row's other cells contain "admin" as a substring — the
  // "Administrator" checkbox and the "Delete user admin" button both do — and a substring
  // match would be ambiguous. The cell being asserted on is the username cell.
  await expect(page.getByRole('cell', { name: 'admin', exact: true })).toBeVisible()
})
