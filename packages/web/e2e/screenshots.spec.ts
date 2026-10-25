import { test } from '@playwright/test'

/**
 * The visual check: screenshots of the gallery, the login page and the shell, light and dark, at
 * desktop and phone widths. Not an assertion suite: it runs only when SPM_SHOTS_DIR names a
 * directory to write into, so a normal test run stays deterministic and writes nothing.
 *
 *   SPM_SHOTS_DIR=/some/dir pnpm --filter @spm/web exec playwright test screenshots
 */
const dir = process.env['SPM_SHOTS_DIR']
const SIZES = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } }

// A signed-in session for the shell, without a server: just enough of the API.
const USER = {
  id: 'u1',
  username: 'marc',
  displayName: 'Marc',
  isAdmin: true,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}
const CAPS = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

test.describe('screenshots', () => {
  test.skip(!dir, 'set SPM_SHOTS_DIR to take screenshots')

  for (const scheme of ['light', 'dark'] as const) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      const name = (page: string) => `${dir}/${page}-${scheme}-${size}.png`

      test(`gallery ${scheme} ${size}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto('/_ui')
        await page.getByRole('heading', { name: 'UI gallery', level: 1 }).waitFor()
        await page.screenshot({ path: name('gallery'), fullPage: true })
      })

      test(`login ${scheme} ${size}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto('/login')
        await page.getByRole('heading', { name: 'Sign in' }).waitFor()
        await page.screenshot({ path: name('login') })
      })

      test(`overlays ${scheme} ${size}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto('/_ui')
        await page.getByRole('button', { name: 'Open dialog' }).click()
        await page.getByRole('dialog').waitFor()
        await page.waitForTimeout(300) // past the 120ms entrance animation
        await page.screenshot({ path: name('dialog') })
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Actions' }).click()
        await page.getByRole('menu').waitFor()
        await page.waitForTimeout(300)
        await page.screenshot({ path: name('menu') })
      })

      test(`shell ${scheme} ${size}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: scheme })
        await page.route('**/api/capabilities', (route) => route.fulfill({ json: CAPS }))
        await page.route('**/api/account', (route) => route.fulfill({ json: USER }))
        await page.route('**/api/account/settings', (route) =>
          route.fulfill({
            json: {
              theme: 'system',
              language: 'en',
              viewMode: 'grid',
              sort: 'updatedAt',
              dir: 'desc',
              navCollapsed: false,
              includeArchived: false,
              filterTags: [],
            },
          }),
        )
        await page.goto('/projects')
        await page.getByRole('heading', { name: 'Projects' }).waitFor()
        await page.screenshot({ path: name('shell') })
      })
    }
  }
})
