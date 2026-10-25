import { expect, test } from '@playwright/test'
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './seed'
import { expectHeading, open, sidebarNav, signInThroughForm, useServer } from './support'

/**
 * The shortest path through the real app, signing in the way a person does (the other specs borrow
 * the admin's session instead, so this and `auth.spec.ts` are where the login form is exercised).
 * Ported from the Angular app's smoke.spec.ts: log in, create a project and see it; reach the
 * settings and the admin page from the navigation.
 */
const state = useServer()

test('an admin can log in, create a project and see it in the grid', async ({ page }) => {
  await signInThroughForm(page, state.server, ADMIN_USERNAME, ADMIN_PASSWORD)
  await expectHeading(page, 'Projects')
  // A new library: nothing yet, and the page says what to do.
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible()

  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByRole('dialog').getByLabel('Name').fill('Benchy')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expectHeading(page, 'Benchy')

  await page.getByRole('link', { name: 'Back to all projects' }).click()
  await expect(page.getByRole('heading', { name: 'Benchy', level: 2 })).toBeVisible()
})

test('the navigation reaches settings and, for an admin, the user list', async ({ page }) => {
  await signInThroughForm(page, state.server, ADMIN_USERNAME, ADMIN_PASSWORD)
  await expectHeading(page, 'Projects')
  const nav = sidebarNav(page)
  await expect(nav.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page')

  await nav.getByRole('link', { name: 'Settings' }).click()
  await expectHeading(page, 'Settings')
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')

  await nav.getByRole('link', { name: 'Users' }).click()
  await expectHeading(page, 'Users')
  // The user's own row: the username is what the row is about.
  await expect(page.locator('tr[data-username="admin"]')).toBeVisible()

  await nav.getByRole('link', { name: 'Projects' }).click()
  await expectHeading(page, 'Projects')
})

test('an unknown address shows the not-found page, with a way home', async ({ page }) => {
  await signInThroughForm(page, state.server, ADMIN_USERNAME, ADMIN_PASSWORD)
  await expectHeading(page, 'Projects')
  await open(page, state.server, '/this/is/not/a/page')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to projects' }).click()
  await expectHeading(page, 'Projects')
})
