import { expect, test, type Page } from '@playwright/test'
import { asAdmin, expectHeading, open, sidebarNav, useServer } from './support'

/**
 * The shell: the brand and icon assets the server must serve, the navigation above and below the
 * one breakpoint, and the reduced-motion guard. Ported from the Angular app's smoke.spec.ts
 * ("the navigation" block). These are the things no unit test can reach, because they depend on
 * CSS and on the browser's own accessibility tree, and jsdom loads no CSS.
 */
const state = useServer()

test.beforeEach(async ({ page }) => {
  await asAdmin(page, state.server)
})

/** What a file's first bytes say it is, so a served index.html cannot pass as an image. */
function magicOf(body: Buffer): string {
  const hex = body.subarray(0, 4).toString('hex')
  if (hex.startsWith('89504e47')) return 'png'
  if (hex.startsWith('00000100')) return 'ico'
  if (hex.startsWith('3c3f786d') || hex.startsWith('3c737667')) return 'svg'
  if (hex.startsWith('3c21646f') || hex.startsWith('3c68746d')) return 'html'
  if (body[0] === 0x7b) return 'json'
  return hex
}

test('the brand names the app and the icon assets are served at the site root', async ({
  page,
}) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  const brand = page.getByRole('link', { name: 'Slicer Project Manager', exact: true })
  await expect(brand).toHaveCount(1)
  await expect(brand).toHaveAttribute('href', '/projects')
  // The mark is decorative: the link's own text names the app, so it must not add a second name.
  await expect(brand.locator('svg')).toHaveAttribute('aria-hidden', 'true')

  const responses = await Promise.all(
    [
      'favicon.ico',
      'favicon.svg',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'manifest.webmanifest',
    ].map(async (name) => {
      const response = await page.request.get(`${state.server.origin}/${name}`)
      const body = await response.body()
      return [name, response.status(), response.headers()['content-type'], magicOf(body)]
    }),
  )
  // The status alone would pass against the SPA fallback answering every unknown path with
  // index.html, which is exactly what a missing asset looks like. The last field is the file's own
  // magic bytes, so a served index.html reads as `html` in the diff instead of passing.
  expect(responses).toEqual([
    ['favicon.ico', 200, 'image/vnd.microsoft.icon', 'ico'],
    ['favicon.svg', 200, 'image/svg+xml', 'svg'],
    ['apple-touch-icon.png', 200, 'image/png', 'png'],
    ['icon-192.png', 200, 'image/png', 'png'],
    ['icon-512.png', 200, 'image/png', 'png'],
    ['manifest.webmanifest', 200, 'application/manifest+json', 'json'],
  ])
})

test('the page title and language are the app and the user', async ({ page }) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await expect(page).toHaveTitle('Slicer Project Manager')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
})

// Spec G 9.3, and the only place it can be asserted: every other spec runs above the breakpoint.
test.describe('below the breakpoint', () => {
  test.use({
    viewport: { width: 700, height: 900 },
    contextOptions: { reducedMotion: 'reduce' },
  })

  const drawer = (page: Page) => page.getByRole('dialog', { name: 'Slicer Project Manager' })

  test('there is no sidebar, and a hamburger opens a modal drawer that navigates and closes', async ({
    page,
  }) => {
    await open(page, state.server, '/projects')
    await expectHeading(page, 'Projects')

    // Rendered and hidden by the one media query, not absent: absent is what a broken gate looks
    // like.
    await expect(page.locator('aside')).toHaveCount(1)
    await expect(page.locator('aside')).toBeHidden()

    const hamburger = page.getByRole('button', { name: 'Open the navigation' })
    await expect(hamburger).toBeVisible()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')

    await hamburger.click()
    await expect(drawer(page)).toBeVisible()
    // Modal: the page behind it is inert for the keyboard, and Tab stays inside.
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
      ).toBe(true)
    }
    // The reduced-motion guard, read off the element the user would have watched slide in.
    const panel = drawer(page)
    expect(await panel.evaluate((element) => getComputedStyle(element).animationDuration)).toMatch(
      /^(0s|1e-05s)$/,
    )

    await panel.getByRole('link', { name: 'Settings', exact: true }).click()
    await expectHeading(page, 'Settings')
    await expect(drawer(page)).toBeHidden()
  })

  test('the drawer offers the same entries as the sidebar and closes on Escape', async ({
    page,
  }) => {
    await open(page, state.server, '/projects')
    await expectHeading(page, 'Projects')
    await page.getByRole('button', { name: 'Open the navigation' }).click()
    const links = await drawer(page).getByRole('link').allTextContents()
    expect(links).toEqual(['Projects', 'Settings', 'Users'])
    await expect(drawer(page).getByRole('button', { name: 'Sign out' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toBeHidden()
    // Focus is back on what opened it.
    await expect(page.getByRole('button', { name: 'Open the navigation' })).toBeFocused()
  })
})

// The other arm of the reduced-motion guard (spec G C6): the drawer's slide is covered above; the
// sidebar's width transition is covered here. They need two blocks because they sit on opposite
// sides of the breakpoint: the sidebar is display: none below it, so the element whose collapse
// would animate only exists above.
test.describe('with reduced motion asked for', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('the sidebar does not animate its collapse', async ({ page }) => {
    await open(page, state.server, '/projects')
    await expectHeading(page, 'Projects')
    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()
    // The duration, not the property: the rule shortens every transition to a hair rather than
    // removing it, and "0.01ms" computes to 1e-05s.
    const duration = await sidebar.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    )
    expect(Number.parseFloat(duration)).toBeLessThan(0.001)
  })
})

test('without a preference the sidebar does animate its width', async ({ page }) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  const duration = await page
    .locator('aside')
    .evaluate((element) => getComputedStyle(element).transitionDuration)
  // The control for the test above: it can only fail if the guard does something.
  expect(Number.parseFloat(duration)).toBeGreaterThan(0.01)
})

test('the navigation lists the entries of an administrator, in order', async ({ page }) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  const nav = sidebarNav(page)
  expect(await nav.getByRole('listitem').allTextContents()).toEqual([
    'Projects',
    'Settings',
    'Users',
    'Sign out',
  ])
})
