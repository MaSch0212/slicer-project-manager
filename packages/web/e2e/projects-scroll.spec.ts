import { expect, test, type Page } from '@playwright/test'
import { seedBulkProjects } from './seed'
import { asAdmin, expectHeading, open, useServer } from './support'

/** More than two pages of 48, so scrolling has to load twice and the second page is a short one. */
const TOTAL = 110
const PAGE_SIZE = 48

const state = useServer(async (server) => {
  await seedBulkProjects(server, TOTAL)
})

test.beforeEach(async ({ page }) => {
  await state.server.request('PUT', '/api/account/settings', {
    sort: 'name',
    dir: 'asc',
    includeArchived: false,
    filterTags: [],
    viewMode: 'grid',
  })
  await asAdmin(page, state.server)
})

const cards = (page: Page) => page.locator('main ul > li h2')
const loadMore = (page: Page) => page.getByRole('button', { name: 'Load more' })

test('scrolling to the foot of the list loads the next page, twice, and then stops', async ({
  page,
}) => {
  await open(page, state.server, '/projects')
  await expectHeading(page, 'Projects')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)

  // The button's presence is the store saying a further page exists, and it is below the fold, so
  // there is genuinely something to scroll.
  await expect(loadMore(page)).toBeVisible()
  expect((await loadMore(page).boundingBox())!.y).toBeGreaterThan(page.viewportSize()!.height)

  // The scroll itself is all this does: nothing presses the button.
  await loadMore(page).scrollIntoViewIfNeeded()
  await expect(cards(page)).toHaveCount(PAGE_SIZE * 2)

  await loadMore(page).scrollIntoViewIfNeeded()
  await expect(cards(page)).toHaveCount(TOTAL)
  // The floor knows it is the floor now, rather than offering a page that is not there.
  await expect(loadMore(page)).toBeHidden()

  // No duplicates and no gaps: sorted A-Z, the names run Bulk 001 .. Bulk 110 in order.
  const names = await cards(page).allTextContents()
  expect(names).toEqual(
    Array.from({ length: TOTAL }, (_, index) => `Bulk ${String(index + 1).padStart(3, '0')}`),
  )
})

test('the button loads the next page for someone who never scrolls', async ({ page }) => {
  await open(page, state.server, '/projects')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)
  // Pressed in the DOM rather than with a real click or a focus: both would scroll it into view,
  // and arriving there loads pages by itself, which is the other path and not this one.
  await loadMore(page).evaluate((button: HTMLButtonElement) => button.click())
  await expect(cards(page)).toHaveCount(PAGE_SIZE * 2)
  await expect(loadMore(page)).toBeVisible()
})

test('search and the tag filter apply to the whole library, not to the pages loaded so far', async ({
  page,
}) => {
  await open(page, state.server, '/projects')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)

  // "Bulk 10" matches Bulk 100-109 only: none of them is on the first page (001-048), so a filter
  // applied to the loaded pages alone would find nothing.
  await page.getByRole('searchbox', { name: 'Search' }).fill('Bulk 10')
  await expect(cards(page)).toHaveCount(10)

  await page.getByRole('searchbox', { name: 'Search' }).fill('')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)
  await page.getByRole('button', { name: 'Tags' }).click()
  await page.getByRole('option', { name: 'fifth' }).click()
  // Every fifth project carries the tag.
  await expect(cards(page)).toHaveCount(TOTAL / 5)
  await expect(loadMore(page)).toBeHidden()
})

test('the sidebar runs the full height of a long page and stays in reach while it scrolls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await open(page, state.server, '/projects')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)
  await loadMore(page).scrollIntoViewIfNeeded()
  await expect(cards(page)).toHaveCount(PAGE_SIZE * 2)

  const geometry = () =>
    page.evaluate(() => {
      const aside = document.querySelector('aside')!.getBoundingClientRect()
      const panel = document.querySelector('aside > div')!.getBoundingClientRect()
      return {
        page: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
        scrollY: window.scrollY,
        asideHeight: aside.height,
        panelTop: panel.top,
        panelHeight: panel.height,
      }
    })

  const scrolled = await geometry()
  // Taller than the window, or this proves nothing.
  expect(scrolled.page).toBeGreaterThan(scrolled.viewport * 2)
  expect(scrolled.scrollY).toBeGreaterThan(0)
  // The column fills the page (its background reaches the foot), not just the first screenful...
  expect(Math.abs(scrolled.asideHeight - scrolled.page)).toBeLessThanOrEqual(1)
  // ...and the panel with the entries stays at the top of the window while the page scrolls.
  expect(scrolled.panelTop).toBeCloseTo(0, 0)
  expect(scrolled.panelHeight).toBeCloseTo(scrolled.viewport, 0)
  await expect(page.getByRole('link', { name: 'Slicer Project Manager' })).toBeInViewport()
})
