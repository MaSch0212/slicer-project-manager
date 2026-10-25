import { expect, test } from '@playwright/test'

const BG = { light: 'rgb(247, 247, 248)', dark: 'rgb(12, 13, 15)' }

for (const scheme of ['light', 'dark'] as const) {
  test(`the UI gallery renders in ${scheme} mode`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/_ui')

    await expect(page.getByRole('heading', { name: 'UI gallery', level: 1 })).toBeVisible()
    // One component from each family is on the page.
    await expect(page.getByRole('button', { name: 'Default' }).first()).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Collapse the navigation' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible()
    // The system preference reached the tokens with no data-theme set.
    await expect(page.locator('body')).toHaveCSS('background-color', BG[scheme])
    expect(errors).toEqual([])
  })
}

test('data-theme pins a scheme against the system preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/_ui')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await expect(page.locator('body')).toHaveCSS('background-color', BG.dark)
})
