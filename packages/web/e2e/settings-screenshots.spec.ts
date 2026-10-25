import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { binaryStl, cube } from './fixtures'
import { applySession, seedLibrary, startServer, WEB_DIST, type SeededServer } from './seed'

/**
 * The visual check for the settings and admin pages (and the shell around them), against a real
 * seeded `spm-server` serving the built bundle. Not an assertion suite: it runs only when
 * SPM_SHOTS_DIR names a directory, and needs `pnpm --filter @spm/web build` first.
 *
 *   SPM_SHOTS_DIR=/some/dir pnpm --filter @spm/web exec playwright test settings-screenshots
 */
const dir = process.env['SPM_SHOTS_DIR']
const SIZES = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } }
const PASSWORD = 'a perfectly fine password'

test.describe('settings and admin screenshots', () => {
  test.skip(!dir, 'set SPM_SHOTS_DIR to take screenshots')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  let server: SeededServer

  test.beforeAll(async () => {
    test.setTimeout(420_000)
    if (!existsSync(WEB_DIST))
      throw new Error('build the web bundle first: pnpm --filter @spm/web build')
    server = await startServer()
    await seedLibrary(server, [
      {
        name: 'Benchy',
        tags: ['boats'],
        files: [{ name: 'benchy.stl', bytes: binaryStl(cube(20)) }],
      },
    ])
    // A pending user, an active one with a quota and some usage, a disabled one, a second admin.
    const create = (body: object) =>
      server.request<{ user: { id: string }; activationUrl: string }>('POST', '/api/users', body)
    await create({
      username: 'anna.k',
      displayName: 'Anna Keller',
      isAdmin: false,
      quotaBytes: null,
    })
    const ben = await create({
      username: 'ben',
      displayName: 'Ben Okafor',
      isAdmin: false,
      quotaBytes: 5 * 1024 * 1024,
    })
    const cara = await create({
      username: 'cara',
      displayName: 'Cara Lindqvist',
      isAdmin: true,
      quotaBytes: null,
    })
    for (const created of [ben, cara]) {
      const token = created.activationUrl.split('#')[1]!
      await fetch(`${server.origin}/api/auth/activation/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, confirm: PASSWORD }),
      })
    }
    const dave = await create({
      username: 'dave',
      displayName: 'Dave Ruiz',
      isAdmin: false,
      quotaBytes: 1024 * 1024 * 1024,
    })
    const token = dave.activationUrl.split('#')[1]!
    await fetch(`${server.origin}/api/auth/activation/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, confirm: PASSWORD }),
    })
    await server.request('PATCH', `/api/users/${dave.user.id}`, { isDisabled: true })
    // Ben's usage: log in as Ben and upload a file, so the usage bar has something in it.
    const login = await fetch(`${server.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ben', password: PASSWORD }),
    })
    const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0]!
    const project = (await (
      await fetch(`${server.origin}/api/projects`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ben Project' }),
      })
    ).json()) as { id: string }
    await fetch(`${server.origin}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: { cookie, 'x-spm-file-name': 'big.bin' },
      body: new Uint8Array(3.2 * 1024 * 1024),
    })
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  for (const scheme of ['light', 'dark'] as const) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      const shot = (name: string) => `${dir}/${name}-${scheme}-${size}.png`

      test.describe(`${scheme} ${size}`, () => {
        test.beforeEach(async ({ page }) => {
          await page.setViewportSize(viewport)
          await page.emulateMedia({ colorScheme: scheme })
          await applySession(page.context(), server)
        })

        test('settings', async ({ page }) => {
          await page.goto(`${server.origin}/settings`)
          await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle')
          await page.screenshot({ path: shot('settings'), fullPage: true })
        })

        test('admin users', async ({ page }) => {
          await page.goto(`${server.origin}/admin/users`)
          await expect(page.getByRole('table')).toBeVisible()
          await expect(page.locator('tr[data-username="ben"]')).toContainText('3.2 MB')
          await page.waitForLoadState('networkidle')
          await page.screenshot({ path: shot('admin-users'), fullPage: true })
        })

        test('admin: create dialog, row menu, activation link', async ({ page }) => {
          await page.goto(`${server.origin}/admin/users`)
          await expect(page.getByRole('table')).toBeVisible()
          await page.getByRole('button', { name: 'Create user' }).first().click()
          const dialog = page.getByRole('dialog', { name: 'Create a user' })
          await dialog.getByLabel('Username').fill(`new.${scheme}.${size}`)
          await dialog.getByLabel('Display name').fill('New Person')
          await page.waitForTimeout(300) // the dialog's pop-in
          await page.screenshot({ path: shot('admin-create') })
          await dialog.getByRole('button', { name: 'Create user' }).click()
          await expect(page.getByRole('dialog', { name: 'Activation link' })).toBeVisible()
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('admin-link') })
          await page.getByRole('button', { name: 'Done' }).click()
          await page.getByRole('button', { name: 'Actions for anna.k' }).click()
          await expect(page.getByRole('menuitem', { name: 'Re-issue invite' })).toBeVisible()
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('admin-menu') })
        })

        test('phone drawer and shell', async ({ page }) => {
          await page.goto(`${server.origin}/settings`)
          await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
          const hamburger = page.getByRole('button', { name: 'Open the navigation' })
          if (await hamburger.isVisible()) {
            await hamburger.click()
            await expect(page.getByRole('dialog')).toBeVisible()
            await page.waitForTimeout(300)
            await page.screenshot({ path: shot('drawer') })
          } else {
            await page.screenshot({ path: shot('shell') })
          }
        })
      })
    }
  }
})
