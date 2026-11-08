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

test('the page scrolls inside the frame, and the sidebar does not move with it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await open(page, state.server, '/projects')
  await expect(cards(page)).toHaveCount(PAGE_SIZE)
  await loadMore(page).scrollIntoViewIfNeeded()
  await expect(cards(page)).toHaveCount(PAGE_SIZE * 2)

  const geometry = () =>
    page.evaluate(() => {
      // Whichever element actually scrolls: the page decides that, not this test.
      let scroller: HTMLElement | null = document.querySelector('main ul')
      while (scroller && scroller.scrollHeight - scroller.clientHeight < 2) {
        scroller = scroller.parentElement
      }
      const aside = document.querySelector('aside')!.getBoundingClientRect()
      return {
        documentScroll: document.documentElement.scrollHeight - window.innerHeight,
        windowScrollY: window.scrollY,
        scrollerTop: scroller?.scrollTop ?? 0,
        scrollerOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
        asideTop: aside.top,
        asideHeight: aside.height,
        viewport: window.innerHeight,
      }
    })

  const scrolled = await geometry()
  // The content is what scrolled, and it is genuinely longer than the frame...
  expect(scrolled.scrollerOverflow).toBeGreaterThan(scrolled.viewport)
  expect(scrolled.scrollerTop).toBeGreaterThan(0)
  // ...while the document itself does not scroll at all, which is what keeps the scrollbar out
  // of the window bar. A `sr-only` line is `position: absolute`, so without a positioned
  // ancestor it lands at the foot of the *document* and gives the window a scrollbar of its own:
  // this is the assertion that catches that.
  expect(scrolled.documentScroll).toBe(0)
  expect(scrolled.windowScrollY).toBe(0)
  // The sidebar is beside the scroller, not inside it: it never moves and never grows past the
  // frame, so the navigation is always in reach.
  expect(scrolled.asideTop).toBeLessThanOrEqual(1)
  expect(scrolled.asideHeight).toBeLessThanOrEqual(scrolled.viewport + 1)
  await expect(page.getByRole('link', { name: 'Projects' })).toBeInViewport()
})
