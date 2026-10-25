import { expect, test, type Browser, type Page } from '@playwright/test'
import { asAdmin, expectHeading, open, sidebarNav, signInThroughForm, useServer } from './support'

const state = useServer()

const PASSWORD = 'a perfectly fine password'
const MIB = 1024 * 1024

test.beforeEach(async ({ page }) => {
  await asAdmin(page, state.server)
})

const usersPage = async (page: Page) => {
  await open(page, state.server, '/admin/users')
  await expectHeading(page, 'Users')
  await expect(page.getByRole('table')).toBeVisible()
}
const row = (page: Page, username: string) => page.locator(`tr[data-username="${username}"]`)

async function act(page: Page, username: string, item: string) {
  await row(page, username)
    .getByRole('button', { name: `Actions for ${username}` })
    .click()
  await page.getByRole('menuitem', { name: item }).click()
}

/** A user created through the API and activated, as if they had followed their link. */
async function activeUser(
  username: string,
  options: { isAdmin?: boolean; quotaBytes?: number | null } = {},
): Promise<string> {
  const created = await state.server.request<{ user: { id: string }; activationUrl: string }>(
    'POST',
    '/api/users',
    {
      username,
      displayName: username.toUpperCase(),
      isAdmin: options.isAdmin ?? false,
      quotaBytes: options.quotaBytes ?? null,
    },
  )
  const token = created.activationUrl.split('#')[1]!
  const response = await fetch(`${state.server.origin}/api/auth/activation/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, confirm: PASSWORD }),
  })
  expect(response.ok).toBe(true)
  return created.user.id
}

/** Opens a browser that has never been near this server and signs in as `username`. */
async function signedInAs(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInThroughForm(page, state.server, username, PASSWORD)
  await expectHeading(page, 'Projects')
  return page
}

// Ported from smoke.spec.ts ("the admin route is reachable for an admin and lists users"), and
// from users.page.spec.ts ("explains a last-active-admin refusal"). First in the file because it
// needs the installation to have exactly one administrator, which later tests change and restore.
test('the only administrator cannot be demoted, disabled or deleted, and the page says why', async ({
  page,
}) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await sidebarNav(page).getByRole('link', { name: 'Users' }).click()
  await expectHeading(page, 'Users')

  const me = row(page, 'admin')
  await expect(me).toBeVisible()
  await expect(me.getByText('Active', { exact: true })).toBeVisible()
  await expect(me.getByText('Administrator', { exact: true })).toBeVisible()
  await expect(me.getByText('you', { exact: true })).toBeVisible()
  await expect(me.getByText('Unlimited')).toBeVisible()

  const refusal = page.getByText('The last active administrator must remain')
  await act(page, 'admin', 'Remove administrator rights')
  await expect(refusal).toBeVisible()
  // The list says what is true: still an administrator, still active.
  await expect(me.getByText('Administrator', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(refusal).toHaveCount(0)

  await act(page, 'admin', 'Disable')
  await expect(refusal).toBeVisible()
  await expect(me.getByText('Active', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(refusal).toHaveCount(0)

  await act(page, 'admin', 'Delete user')
  const dialog = page.getByRole('dialog', { name: 'Delete admin?' })
  await dialog.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(refusal).toBeVisible()
  await expect(me).toBeVisible()
})

test('a created user follows their link, signs in, hits their quota, and the admin sees it', async ({
  page,
  browser,
}) => {
  await usersPage(page)
  await page.getByRole('button', { name: 'Create user' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a user' })
  await dialog.getByLabel('Username').fill('quota.user')
  await dialog.getByLabel('Display name').fill('Quota User')
  await dialog.getByLabel('Quota (MiB)').fill('1')
  await dialog.getByRole('button', { name: 'Create user' }).click()

  // The link is shown once, to copy. It is built from the server's own address.
  const linkDialog = page.getByRole('dialog', { name: 'Activation link' })
  const link = linkDialog.getByRole('textbox', { name: 'Link address' })
  await expect(link).toBeVisible()
  const url = await link.inputValue()
  expect(url).toMatch(new RegExp(`^${state.server.origin}/activate#[\\w-]{20,}$`))
  await linkDialog.getByRole('button', { name: 'Done' }).click()
  await expect(linkDialog).toBeHidden()

  await expect(row(page, 'quota.user').getByText('Pending')).toBeVisible()
  await expect(row(page, 'quota.user').getByText('1.0 MB')).toBeVisible()

  // A fresh browser follows the link, chooses a password and is signed in.
  const context = await browser.newContext()
  try {
    const user = await context.newPage()
    await user.goto(url)
    await expectHeading(user, 'Choose a password')
    await expect(user.getByText('quota.user', { exact: true })).toBeVisible()
    await user.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await user.getByLabel('Confirm password').fill(PASSWORD)
    await user.getByRole('button', { name: 'Activate account' }).click()
    await expectHeading(user, 'Projects')

    // Not an administrator: no user management in the navigation, and the route is closed.
    await expect(sidebarNav(user).getByRole('link', { name: 'Users' })).toHaveCount(0)
    await user.goto(`${state.server.origin}/admin/users`)
    await expect(user).toHaveURL(`${state.server.origin}/projects`)

    // Then sign out and in again, the way they will every day.
    await sidebarNav(user).getByRole('button', { name: 'Sign out' }).click()
    await expect(user).toHaveURL(`${state.server.origin}/login`)
    await user.getByLabel('Username').fill('quota.user')
    await user.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await user.getByRole('button', { name: 'Sign in' }).click()
    await expectHeading(user, 'Projects')

    // Their own library: create a project, add a file that fits, then one that does not.
    await user.getByRole('button', { name: 'New project' }).first().click()
    await user.getByRole('dialog').getByLabel('Name').fill('Quota Project')
    await user.getByRole('button', { name: 'Create project' }).click()
    await expectHeading(user, 'Quota Project')

    const choose = (name: string, buffer: Buffer) =>
      user.locator('input[type="file"]').setInputFiles([{ name, mimeType: 'text/plain', buffer }])
    await choose('small.txt', Buffer.alloc(100, 'a'))
    await expect(user.getByRole('heading', { name: 'small.txt', exact: true })).toBeVisible()

    await choose('big.bin', Buffer.alloc(Math.round(1.5 * MIB), 1))
    await expect(
      user.getByText(/This upload would exceed your quota \(100 B of 1\.0 MB used\)/),
    ).toBeVisible()
    await expect(user.getByRole('heading', { name: 'big.bin', exact: true })).toHaveCount(0)
    await expect(user.getByRole('button', { name: 'Try again' })).toBeVisible()
  } finally {
    await context.close()
  }

  // The admin's list now says active, with the usage against the quota.
  await page.reload()
  await expect(row(page, 'quota.user').getByText('Active', { exact: true })).toBeVisible()
  await expect(row(page, 'quota.user').getByText('100 B')).toBeVisible()
  await expect(row(page, 'quota.user').getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '0',
  )
})

test('a username that is taken is refused next to the field, and bad input never leaves the dialog', async ({
  page,
}) => {
  await usersPage(page)
  await page.getByRole('button', { name: 'Create user' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a user' })

  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByText('This field is required').first()).toBeVisible()
  await dialog.getByLabel('Username').fill('has space')
  await dialog.getByLabel('Display name').fill('Someone')
  await dialog.getByLabel('Quota (MiB)').fill('0')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: '2 to 32 characters' })).toBeVisible()
  await expect(dialog.getByRole('alert').filter({ hasText: 'whole number of MiB' })).toBeVisible()

  await dialog.getByLabel('Username').fill('admin')
  await dialog.getByLabel('Quota (MiB)').fill('')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByText('That username is already taken')).toBeVisible()
  // Still open, with what was typed.
  await expect(dialog.getByLabel('Display name')).toHaveValue('Someone')
})

test('a pending user is re-invited: the old link dies, the new one works', async ({
  page,
  browser,
}) => {
  const created = await state.server.request<{ activationUrl: string }>('POST', '/api/users', {
    username: 'reinvite',
    displayName: 'Re Invite',
    isAdmin: false,
    quotaBytes: null,
  })
  await usersPage(page)
  await act(page, 'reinvite', 'Re-issue invite')
  const link = page.getByRole('dialog', { name: 'Activation link' }).getByRole('textbox', {
    name: 'Link address',
  })
  const fresh = await link.inputValue()
  expect(fresh).not.toBe(created.activationUrl)

  const context = await browser.newContext()
  try {
    const visitor = await context.newPage()
    await visitor.goto(created.activationUrl)
    await expect(visitor.getByRole('alert')).toContainText('not valid or has expired')
    await visitor.goto(fresh)
    await expectHeading(visitor, 'Choose a password')
  } finally {
    await context.close()
  }
})

test('a user is disabled and cannot sign in, then enabled and can', async ({ page, browser }) => {
  await activeUser('toggle.me')
  await usersPage(page)
  await expect(row(page, 'toggle.me').getByText('Active', { exact: true })).toBeVisible()

  await act(page, 'toggle.me', 'Disable')
  await expect(row(page, 'toggle.me').getByText('Disabled', { exact: true })).toBeVisible()

  const context = await browser.newContext()
  try {
    const visitor = await context.newPage()
    await signInThroughForm(visitor, state.server, 'toggle.me', PASSWORD)
    await expect(visitor.getByRole('alert')).toContainText('Username or password is not correct')
  } finally {
    await context.close()
  }

  await act(page, 'toggle.me', 'Enable')
  await expect(row(page, 'toggle.me').getByText('Active', { exact: true })).toBeVisible()
  const signedIn = await signedInAs(browser, 'toggle.me')
  await signedIn.context().close()
})

test('a user is promoted and demoted, and the quota is set and cleared', async ({ page }) => {
  await activeUser('promote.me')
  await usersPage(page)
  const target = row(page, 'promote.me')
  await expect(target.getByText('Administrator', { exact: true })).toHaveCount(0)

  await act(page, 'promote.me', 'Make administrator')
  await expect(target.getByText('Administrator', { exact: true })).toBeVisible()
  await act(page, 'promote.me', 'Remove administrator rights')
  await expect(target.getByText('Administrator', { exact: true })).toHaveCount(0)

  await act(page, 'promote.me', 'Set quota')
  const dialog = page.getByRole('dialog', { name: 'Quota for promote.me' })
  const field = dialog.getByLabel('Quota (MiB)')
  await expect(field).toHaveValue('')
  await field.fill('0')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog.getByText(/whole number of MiB/)).toBeVisible()
  await field.fill('5')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await expect(target.getByText('5.0 MB')).toBeVisible()
  await expect(target.getByText('Unlimited')).toHaveCount(0)

  await act(page, 'promote.me', 'Set quota')
  await expect(page.getByLabel('Quota (MiB)')).toHaveValue('5')
  await page.getByLabel('Quota (MiB)').fill('')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(target.getByText('Unlimited')).toBeVisible()
})

test('a user is deleted only after the confirmation', async ({ page }) => {
  await activeUser('delete.me')
  await usersPage(page)

  await act(page, 'delete.me', 'Delete user')
  let dialog = page.getByRole('dialog', { name: 'Delete delete.me?' })
  await expect(dialog).toContainText('Their folder stays on disk')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, 'delete.me')).toBeVisible()

  await act(page, 'delete.me', 'Delete user')
  dialog = page.getByRole('dialog', { name: 'Delete delete.me?' })
  await dialog.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(row(page, 'delete.me')).toHaveCount(0)
})

// A table wider than a phone scrolls inside its own frame; the page must not scroll sideways with
// it. (It did once: a visually hidden header cell is absolutely positioned, and without a
// positioned frame around the table it escaped the frame's clipping and widened the document.)
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the user table scrolls inside its frame and the page stays as wide as the screen', async ({
    page,
  }) => {
    await usersPage(page)
    const widths = () =>
      page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        window: window.innerWidth,
        frame: document.querySelector('table')!.parentElement!.scrollWidth,
        frameBox: document.querySelector('table')!.parentElement!.clientWidth,
      }))
    const measured = await widths()
    expect(measured.document).toBe(measured.window)
    // The table really is wider than the screen, so this proves the frame is doing the scrolling.
    expect(measured.frame).toBeGreaterThan(measured.frameBox)
  })
})
