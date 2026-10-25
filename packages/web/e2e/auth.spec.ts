import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, ADMIN_USERNAME, launchServer, type LaunchedServer } from './seed'
import { expectHeading, sidebarNav } from './support'

/**
 * The first-run story from a server nobody has signed in to: the activation link the server
 * prints, choosing a password, signing out and in again, and what a signed-out visitor is shown.
 * One server, and the tests run in order because each leaves the account as the next expects it.
 */
test.describe.configure({ mode: 'serial' })

let server: LaunchedServer
test.beforeAll(async () => {
  test.setTimeout(420_000)
  server = await launchServer()
})
test.afterAll(async () => {
  await server?.stop()
})

const url = (path: string) => `${server.origin}${path}`

test('a signed-out visitor is sent to the login page from every guarded route', async ({
  page,
}) => {
  for (const path of ['/projects', '/settings', '/admin/users', '/import']) {
    await page.goto(url(path))
    await expect(page).toHaveURL(url('/login'))
    await expectHeading(page, 'Sign in')
  }
  // No chrome while there is nowhere to go: the navigation only exists for a signed-in user.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0)
})

test('the activation link chooses the admin password and signs in', async ({ page }) => {
  await page.goto(url(`/activate#${server.activationToken}`))
  await expectHeading(page, 'Choose a password')
  await expect(page.getByText(ADMIN_USERNAME, { exact: true })).toBeVisible()

  // The password rules come before the network: a short one and a mismatch are refused here.
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('Confirm password').fill('different')
  await page.getByRole('button', { name: 'Activate account' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Use at least 10 characters' }),
  ).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: 'The passwords do not match' }),
  ).toBeVisible()

  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByLabel('Confirm password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Activate account' }).click()

  await expect(page).toHaveURL(url('/projects'))
  await expectHeading(page, 'Projects')
  await expect(sidebarNav(page).getByRole('link', { name: 'Users' })).toBeVisible()
})

test('a used activation link is dead', async ({ page }) => {
  await page.goto(url(`/activate#${server.activationToken}`))
  await expect(page.getByRole('alert')).toContainText('not valid or has expired')
})

test('sign in with a wrong password says so, the right one lands on the projects', async ({
  page,
}) => {
  await page.goto(url('/login'))
  await page.getByLabel('Username').fill(ADMIN_USERNAME)
  await page.getByLabel('Password', { exact: true }).fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Username or password is not correct')
  await expect(page).toHaveURL(url('/login'))

  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(url('/projects'))
  await expectHeading(page, 'Projects')
})

test('signing out ends the session and the guarded routes close again', async ({ page }) => {
  await page.goto(url('/login'))
  await page.getByLabel('Username').fill(ADMIN_USERNAME)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectHeading(page, 'Projects')

  await sidebarNav(page).getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(url('/login'))

  // The cookie is gone with the session: a reload of a guarded page does not bring it back.
  await page.goto(url('/projects'))
  await expect(page).toHaveURL(url('/login'))
  // And a signed-in visitor of the login page is sent on to the projects, not shown a form.
  await page.goto(url('/login'))
  await page.getByLabel('Username').fill(ADMIN_USERNAME)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectHeading(page, 'Projects')
  await page.goto(url('/login'))
  await expect(page).toHaveURL(url('/projects'))
})
