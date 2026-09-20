import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signIn } from './fixtures'

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

  // Wait for the post-login navigation to land before touching the nav. Since spec G 4 the
  // sidebar is not drawn on /login at all — the shell draws no chrome while the entry list is
  // empty — so this is what makes the Settings link exist; and it also still keeps a click from
  // starting a navigation while the login's own `router.navigate(['/projects'])` is in flight,
  // which the login one then wins, leaving the projects page under a /settings URL.
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

/**
 * The navigation, on one sign-in.
 *
 * Every test in this block needs a signed-in session and nothing else from a login, and the
 * server rate-limits `/api/auth/login` to ten attempts a minute per address (`AUTH_RATE_LIMIT`,
 * `packages/server/src/routes/auth.ts`). The whole suite runs inside one such window, so a spec
 * that logs in for its own convenience is spending a shared budget — measured, and it is exactly
 * what turned `viewer.spec.ts`'s `beforeAll` red when this block was three separate logins.
 *
 * The state is captured the way `viewer.spec.ts` captures its own, including the explicitly empty
 * `storageState` on the capturing context: the `browser` fixture inherits this block's `test.use`
 * default, so omitting it makes the capture try to read the file it is about to write.
 */
const NAV_AUTH_STATE = join(mkdtempSync(join(tmpdir(), 'spm-e2e-nav-')), 'nav.json')

test.describe('the navigation', () => {
  test.use({ storageState: NAV_AUTH_STATE })

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await signIn(page)
    await context.storageState({ path: NAV_AUTH_STATE })
    await context.close()
  })

  test('the brand mark and the icon assets are served at the site root', async ({ page }) => {
    // The browser half of what `packages/desktop/test/shell.spec.ts` asserts for the Electron
    // renderer. The two are not the same risk: these files reach the browser through Angular's
    // `assets` copy of `packages/web/public`, and reach the desktop renderer through that *plus*
    // the `spm://` handler's content-type map. A change to angular.json's assets glob breaks this
    // one and nothing else.
    // On a page that has a sidebar, not on /login: the brand moved into the sidebar (spec G 4.2),
    // and the sidebar is not drawn while the navigation has no entries — which on /login it has not.
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

    const mark = page.locator('.spm-brand-mark')
    await expect(mark).toBeVisible()
    // `naturalWidth`, because a broken image is still visible, still in the DOM, and still reports
    // `complete === true`. This is the only property that separates "loaded" from "404".
    expect(await mark.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    // Decorative: the link's own text names the app, so the image must not add a second name.
    expect(await mark.getAttribute('alt')).toBe('')

    const responses = await Promise.all(
      [
        'favicon.ico',
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'manifest.webmanifest',
      ].map(async (name) => {
        const response = await page.request.get(`/${name}`)
        const body = await response.body()
        return [name, response.status(), response.headers()['content-type'], magicOf(body)]
      }),
    )
    // The status alone would pass against the SPA fallback answering every unknown path with
    // index.html, which is exactly what a missing asset looks like. The fourth field is the file's
    // own magic bytes, so a served index.html reads as `html` in the diff instead of passing.
    //
    // A byte count was the first version of this, and it was wrong in a way worth keeping: the
    // manifest is 464 bytes, so `byteLength > 500` failed on the one file whose type mattered most.
    expect(responses).toEqual([
      ['favicon.ico', 200, 'image/vnd.microsoft.icon', 'ico'],
      ['favicon.svg', 200, 'image/svg+xml', 'svg'],
      ['apple-touch-icon.png', 200, 'image/png', 'png'],
      ['icon-192.png', 200, 'image/png', 'png'],
      ['icon-512.png', 200, 'image/png', 'png'],
      ['manifest.webmanifest', 200, 'application/manifest+json', 'json'],
    ])
  })

  const APP_TITLE = 'Slicer Project Manager'
  const NAV_TOGGLE = 'Collapse or expand the navigation'

  /**
   * The collapsed sidebar's accessible names, which no `ng test` assertion can reach.
   *
   * Both of the things this asserts depend on CSS, and jsdom loads none: `styles.css` is what hides
   * the labels, and whether it hides them with the clip pattern or with `display: none` is the
   * difference between a named control and an unnamed one. Playwright's role queries read the real
   * accessibility tree, so they are the only place the difference shows.
   *
   * The brand link is the one that bit: its image is `alt=""` and `aria-hidden` on purpose, so the
   * label span is its *only* name, and it is the first thing a keyboard user reaches in a collapsed
   * sidebar.
   */
  test('the collapsed sidebar keeps the names it had when expanded', async ({ page }) => {
    await page.goto('/projects')

    const brand = page.getByRole('link', { name: APP_TITLE, exact: true })
    const projects = page.getByRole('link', { name: 'Projects', exact: true })
    await expect(brand).toHaveCount(1)
    await expect(projects).toHaveCount(1)

    await page.getByRole('button', { name: NAV_TOGGLE }).click()
    await expect(page.locator('.spm-sidebar--collapsed')).toHaveCount(1)

    // Same names, with no visible text anywhere in the sidebar.
    await expect(brand).toHaveCount(1)
    await expect(projects).toHaveCount(1)
    // And the control that got the user here is still called what it was called, so a screen
    // reader announces one control in two states rather than two controls.
    await expect(page.getByRole('button', { name: NAV_TOGGLE })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // `navCollapsed` is persisted server-side against the shared admin account, so leaving it
    // collapsed would change the layout every later test in this suite runs against. Putting it
    // back is also the other half of the assertion: the toggle works in both directions.
    await page.getByRole('button', { name: NAV_TOGGLE }).click()
    await expect(page.locator('.spm-sidebar--collapsed')).toHaveCount(0)
  })

  /**
   * Spec G §9 acceptance criterion 2, end to end: collapse it, reload the window, find it still
   * collapsed.
   *
   * Everything the criterion needs was covered *separately* — the store's round trip in
   * `packages/core/test/account.test.ts`, the `patch` call in `app.spec.ts`, the collapse itself
   * in the test above — and the claim followed by composing the three. Composition is where this
   * project keeps finding defects; nothing asserted that a reload actually comes back collapsed,
   * so a `navCollapsed` the shell wrote and never read on start-up would have passed all three.
   *
   * In this block and not in a spec of its own **because of the login budget**: the server allows
   * ten `POST /api/auth/login` a minute per address (`AUTH_RATE_LIMIT`), the suite runs inside one
   * window and already spends eight, and the eleventh login to execute fails in whichever file
   * happens to hold it. This test reuses the block's captured `storageState` and costs nothing.
   *
   * The PUT is awaited before the reload rather than the click alone: `SettingsStore.patch` is
   * optimistic, so the class lands on the element before the request does, and a reload racing it
   * would flake in the direction that looks like a persistence bug.
   */
  test('a collapsed sidebar is still collapsed after the window reloads', async ({ page }) => {
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/account/settings') &&
        response.request().method() === 'PUT' &&
        response.ok(),
    )
    await page.getByRole('button', { name: NAV_TOGGLE }).click()
    await expect(page.locator('.spm-sidebar--collapsed')).toHaveCount(1)
    await saved

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

    // The whole criterion: nothing in this window did the collapsing, so the state came back
    // from `user_settings` over the wire.
    await expect(page.locator('.spm-sidebar--collapsed')).toHaveCount(1)
    await expect(page.getByRole('button', { name: NAV_TOGGLE })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    // Put it back, for the same reason the test above does: the setting is stored against the
    // shared admin account and would otherwise change the layout every later test runs against.
    const restored = page.waitForResponse(
      (response) =>
        response.url().includes('/api/account/settings') &&
        response.request().method() === 'PUT' &&
        response.ok(),
    )
    await page.getByRole('button', { name: NAV_TOGGLE }).click()
    await expect(page.locator('.spm-sidebar--collapsed')).toHaveCount(0)
    await restored
  })

  /**
   * The filter bar's two requirements that no `ng test` assertion can reach (spec H §7.2, §7.4).
   *
   * **Why not a unit test.** jsdom 28 implements no part of the Popover API — `togglePopover`
   * appears nowhere in the package — so under `ng test` the tags button opens nothing, the sort
   * popup never renders, and jig's call lands in a `requestAnimationFrame` as an unhandled error
   * rather than a failed assertion. jsdom also loads no CSS, so neither width criterion means
   * anything there. Chromium has both, which makes this the only runner where any of it is
   * observable. Fix round 1, findings 1 and 2.
   *
   * **In this block, so it logs in zero times.** The block's captured `storageState` is reused;
   * the server rate-limits `/api/auth/login` to ten a minute per address and the suite already
   * spends eight, which is the same reason the reload test above lives here.
   *
   * **What it composes.** Each half of the tag dropdown is covered by a unit test — the badge
   * against a seeded selection, an option click against the store — but the composition the user
   * actually performs (press the button, pick a tag, read the count) was covered by neither, and
   * composition is where this project keeps finding defects. `aria-expanded` in particular was
   * only ever asserted in its `false` state, which is the state a disclosure that never opens
   * also reports.
   */
  test('the filter bar sizes its sort control and popup, and counts the tags chosen in its dropdown', async ({
    page,
  }) => {
    // Self-sufficient rather than leaning on a tag some other spec's library happens to hold:
    // `createProjectSchema` takes tags, so one request gives this test the tag it filters on.
    const TAG = 'e2e-filter-bar'
    const created = await page.request.post('/api/projects', {
      data: { name: 'Filter Bar Fixture', tags: [TAG] },
    })
    expect(created.ok()).toBe(true)
    const project = (await created.json()) as { id: string }

    // Everything below writes `sort` and `filterTags` on the SHARED admin account, and both are
    // restored through the UI further down as the other half of their own assertions. The
    // try/finally is what makes that survive a failure: an assertion that throws in between skips
    // every line after it, and `playwright.config.ts` runs one worker with `fullyParallel: false`
    // -- so a tag filter left set would hide the fixtures of every spec that runs after this one
    // and fail them for a reason nothing in their own file explains.
    try {
      await page.goto('/projects')
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

      // §7.2, first half: "a minimum width, so the label is not cut off". What is asserted is the
      // floor, not the absence of an ellipsis — measured, the trigger is shrink-to-fit and so
      // reports no overflow at any width this layout produces, which would have made a
      // `scrollWidth <= clientWidth` assertion unable to fail. The floor is what actually delivers
      // the requirement, and it is read off the page rather than written here as a number: a
      // throwaway element resolves `--spm-sort-min-width` to pixels, so the assertion follows the
      // stylesheet instead of pinning a literal against a copy of itself.
      const sort = page.getByRole('combobox', { name: 'Sort by' })
      await expect(sort).toBeVisible()
      const floor = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.width = 'var(--spm-sort-min-width)'
        document.body.append(probe)
        const width = probe.getBoundingClientRect().width
        probe.remove()
        return width
      })
      expect(floor).toBeGreaterThan(0)
      const field = page.locator('.spm-sort')
      expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(floor)

      // §7.2, second half: "the dropdown is wrapping 'Recently updated', make the popup wide enough
      // so all entries fit horizontally".
      //
      // **The short option is selected first, and that is what makes this able to fail.** jig sizes
      // the popup to its anchor by default, and the anchor is the trigger — which, while the
      // longest option is the selected one, is already wide enough for it. Measured: with the
      // override removed the popup still fits, because the trigger was showing the very string
      // being measured. Selecting "Newest" shrinks the trigger to a short label and leaves the
      // popup to carry the long one, which is the situation the user actually reported.
      //
      // Height against a SHORT option rather than a hard-coded pixel count: a wrapped two-line
      // entry is about twice the height of a one-line one, whatever the theme's line height is.
      const sorted = settingsSaved(page)
      await sort.click()
      await page.getByRole('option', { name: 'Newest' }).click()
      await sorted

      await sort.click()
      const longest = page.getByRole('option', { name: 'Recently updated' })
      await expect(longest).toBeVisible()
      const longestBox = await longest.boundingBox()
      const shortestBox = await page.getByRole('option', { name: 'Newest' }).boundingBox()
      expect(longestBox!.height).toBeLessThan(shortestBox!.height * 1.5)

      // And the popup is never narrower than the control it hangs off. This is the half of
      // `sortPopover` that a mutation can actually turn red: `width: 'max-content'` sizes the popup
      // to its longest entry, which at this font is NARROWER than the trigger, so without the
      // matching `minWidth` the list would sit under a wider control looking like a rendering
      // fault. The one-line assertion above cannot distinguish the two; this can.
      //
      // Measured on the element the constraint is applied to — the popover itself, the one carrying
      // the `popover` attribute while it is open — rather than on the list box inside it, which
      // sits a border's width narrower.
      const popupWidth = await longest.evaluate(
        (option) => option.closest('[popover]')!.getBoundingClientRect().width,
      )
      expect(popupWidth).toBeGreaterThanOrEqual(floor)

      // Put the sort back: it is persisted against the shared admin account, so leaving it on
      // "Newest" would reorder the list every later test runs against.
      const restored = settingsSaved(page)
      await longest.click()
      await restored
      await expect(longest).toBeHidden()

      // §7.4: the disclosure, the list box behind it, and the count.
      const tags = page.getByRole('button', { name: 'Tags' })
      await expect(tags).toHaveAttribute('aria-expanded', 'false')
      await expect(tags.locator('jig-badge-indicator')).toHaveCount(0)

      await tags.click()

      await expect(tags).toHaveAttribute('aria-expanded', 'true')
      const list = page.getByRole('listbox', { name: 'Tags' })
      await expect(list).toBeVisible()
      // The button says which list it controls, and this is where that can be followed: the id has
      // to resolve to the element that actually opened.
      expect(await tags.getAttribute('aria-controls')).toBe(await list.getAttribute('id'))

      // The filter is persisted against the shared admin account, so both the selection and its
      // undo are awaited — an optimistic write that had not landed before the next test navigated
      // would leave the library filtered for everything that follows.
      const saved = settingsSaved(page)
      await list.getByRole('option', { name: TAG }).click()
      await expect(tags.locator('jig-badge-indicator')).toHaveText('1')
      await saved

      // And back, which is also the other half of the assertion: the count follows the selection
      // down as well as up, so it is a count rather than a flag that was switched on once.
      const cleared = settingsSaved(page)
      await list.getByRole('option', { name: TAG }).click()
      await expect(tags.locator('jig-badge-indicator')).toHaveCount(0)
      await cleared

      await page.keyboard.press('Escape')
      await expect(tags).toHaveAttribute('aria-expanded', 'false')
    } finally {
      // The defaults, written straight to the API rather than through the controls: a restore
      // that has to drive the UI cannot run when the UI is the thing that just failed. The
      // fixture goes the same way -- a project left behind carrying `e2e-filter-bar` is the other
      // thing a later spec would trip over. Both are idempotent and assert nothing: a failure
      // here would replace the real diagnosis with its own.
      await page.request.put('/api/account/settings', {
        data: { sort: 'updatedAt', dir: 'desc', filterTags: [] },
      })
      await page.request.delete(`/api/projects/${project.id}?deleteFiles=true`)
    }
  })

  /**
   * Spec H §7.5 and acceptance criterion 2: a library larger than one page grows as it is
   * scrolled, with no press of the button that does the same thing.
   *
   * **Only a browser can answer this.** The trigger is a distance in pixels between a scroll
   * position and a content height, and jsdom has neither -- every geometry it reports is zero,
   * which makes "at the end of the list" indistinguishable from "at the start of an empty one".
   * The page therefore switches the trigger off when it cannot find a scrolling ancestor, so
   * under `ng test` there is nothing to observe at all.
   *
   * **In this block, so it logs in zero times** (constraint C8) -- the same login budget the
   * tests above it live here for.
   *
   * **What keeps it able to fail.** Three things, each of which a scroll-blind version of this
   * test would pass without:
   *   1. The fixture is deliberately just over one page, and the count before scrolling is
   *      asserted to be UNDER the total. A list that was already whole would reach the final
   *      count without the trigger ever mattering.
   *   2. The foot of the list is asserted to be below the fold first, so there is genuinely
   *      something to scroll. Measured: 48 cards do not fit 720px.
   *   3. The search box is what narrows the list to this fixture. It is the one filter the store
   *      does not persist, so unlike the sort or the tags it leaves nothing behind for the specs
   *      that run after this one.
   */
  test('scrolling to the foot of the list loads the next page', async ({ page }) => {
    // Just over `PROJECTS_PAGE_SIZE`, which is 48 (`projects.store.ts`). Not imported: that
    // module is an Angular injectable and pulling it into a Playwright spec drags the framework
    // in with it. The count below is what catches a page size that outgrows this number -- it
    // asserts the first page is SHORTER than the fixture, so a size of 50 or more fails here
    // rather than passing with the trigger doing nothing.
    const TOTAL = 50
    const PREFIX = 'e2e-scroll-'
    const created: string[] = []
    try {
      for (let index = 0; index < TOTAL; index += 1) {
        const response = await page.request.post('/api/projects', {
          data: { name: `${PREFIX}${String(index).padStart(2, '0')}` },
        })
        expect(response.ok()).toBe(true)
        created.push(((await response.json()) as { id: string }).id)
      }

      await page.goto('/projects')
      await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
      // Armed before the keystroke, because the answer can be back before the next line runs.
      const searched = page.waitForResponse(
        (response) =>
          response.url().includes('/api/projects?') &&
          response.url().includes('search=') &&
          response.ok(),
      )
      await page.getByRole('searchbox', { name: 'Search' }).fill(PREFIX)
      await searched

      // **Wait for the SEARCH to have landed, not merely for a full page** -- and this is the
      // second version of that wait, because the first one was itself the bug.
      //
      // The box is debounced, so for a quarter of a second after the last keystroke the grid is
      // still the whole library, which also holds more than one page: the button and a 48-card
      // count are already true of the wrong list. Scrolling there starts a page for the old query,
      // the debounce fires mid-flight, and the store discards it exactly as it is supposed to --
      // leaving the list at 48 for a reason that has nothing to do with the trigger. Measured: it
      // failed that way in the full suite while passing on its own.
      //
      // "No card lacks the prefix" looked like the condition and is NOT: while the store is
      // loading, the template renders a spinner INSTEAD of the grid, so there are no cards, so
      // nothing lacks anything and the assertion passes on an empty page. It has to be a single
      // observation that the list is non-empty AND entirely ours, which is why this reads every
      // title in one call rather than composing two locators that can be true at different
      // instants.
      const cards = page.locator('.spm-project')
      await expect
        .poll(async () => {
          const titles = await page.locator('.spm-project-title').allTextContents()
          return titles.length > 0 && titles.every((title) => title.includes(PREFIX))
        })
        .toBe(true)

      // The button's presence IS the store saying a further page exists.
      const loadMore = page.getByRole('button', { name: 'Load more' })
      await expect(loadMore).toBeVisible()

      const firstPage = await cards.count()
      expect(firstPage).toBeGreaterThan(0)
      expect(firstPage).toBeLessThan(TOTAL)

      const footer = page.locator('.spm-list-footer')
      const box = await footer.boundingBox()
      expect(box!.y).toBeGreaterThan(page.viewportSize()!.height)

      // The scroll itself, and the only thing this test does to the page. Nothing presses the
      // button: `scrollIntoViewIfNeeded` moves whichever ancestor has to move and clicks nothing.
      await footer.scrollIntoViewIfNeeded()

      await expect(cards).toHaveCount(TOTAL)
      // Still only ours: the second page answers the same query the first one did, rather than
      // the library at an offset into a list nobody asked for.
      await expect(cards.filter({ hasNotText: PREFIX })).toHaveCount(0)
      // And the floor knows it is the floor now, rather than offering a page that is not there.
      await expect(loadMore).toBeHidden()
    } finally {
      // `deleteFiles`, so the folders each create put in the library go with them: a rescan in a
      // later run would otherwise adopt fifty of them. In a `finally` because an assertion above
      // that throws would otherwise leave the library fifty projects heavier for every spec that
      // follows -- `playwright.config.ts` runs one worker with `fullyParallel: false`, so
      // "later" means every test after this one.
      for (const id of created) {
        await page.request.delete(`/api/projects/${id}?deleteFiles=true`)
      }
    }
  })

  /**
   * Spec G §9 acceptance criterion 3, and the only place it can be asserted.
   *
   * `playwright.config.ts` pins no viewport, so every other spec in this suite runs at Chromium's
   * 1280x720 default and never crosses the breakpoint. This block moves below it. `reducedMotion`
   * is emulated at the same time because the motion guard is the other half of the same stylesheet
   * and the drawer is the thing it guards.
   */
  test.describe('below the breakpoint', () => {
    // `reducedMotion` through `contextOptions` and not as a `use` key of its own: this Playwright
    // (1.62) exposes it on `BrowserContextOptions`, and the flat form is a type error here.
    test.use({
      viewport: { width: 700, height: 900 },
      contextOptions: { reducedMotion: 'reduce' },
    })

    test('there is no sidebar, and a hamburger opens a modal drawer that navigates and closes', async ({
      page,
    }) => {
      await page.goto('/projects')

      // Rendered, and hidden by the one media query — not absent, which is what a broken
      // capability gate would look like instead.
      await expect(page.locator('.spm-sidebar')).toHaveCount(1)
      await expect(page.locator('.spm-sidebar')).toBeHidden()

      const hamburger = page.getByRole('button', { name: 'Open the navigation' })
      await expect(hamburger).toBeVisible()
      await expect(hamburger).toHaveAttribute('aria-expanded', 'false')

      await hamburger.click()

      const drawer = page.getByRole('dialog')
      await expect(drawer).toBeVisible()
      await expect(drawer).toHaveAttribute('aria-modal', 'true')
      // The reduced-motion guard, read off the element the user would have watched slide in.
      // `styles.css` is unlayered and jig's animation is inside its own cascade layer, which is
      // what lets a plain rule win here with no !important.
      expect(await drawer.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        'none',
      )

      await drawer.getByRole('link', { name: 'Settings', exact: true }).click()

      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await expect(drawer).toBeHidden()
    })
  })

  /**
   * The other arm of the reduced-motion guard (spec G C6).
   *
   * `styles.css` turns off two things for a reader who asks for less motion: the drawer's slide,
   * covered in the block above, and the sidebar's width transition, covered here. They need two
   * blocks because they are on opposite sides of the breakpoint — the sidebar is `display: none`
   * below it, so the element whose collapse would animate only exists above.
   */
  test.describe('with reduced motion asked for', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } })

    test('the sidebar does not animate its collapse', async ({ page }) => {
      await page.goto('/projects')

      const sidebar = page.locator('.spm-sidebar')
      await expect(sidebar).toBeVisible()

      // `transitionProperty` rather than the `transition` shorthand: the shorthand serialises to
      // "all 0s ease 0s" when nothing is transitioning, which reads the same whether the rule is
      // there or the rule was never written. The longhand says `none` or it says `width`.
      expect(
        await sidebar.evaluate((element) => getComputedStyle(element).transitionProperty),
      ).toBe('none')
    })
  })
})

/**
 * Resolves when the next successful settings PUT lands.
 *
 * `SettingsStore.patch` is optimistic, so the UI moves before the request does; anything that
 * navigates or reloads without waiting races a write against the shared admin account.
 */
function settingsSaved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.url().includes('/api/account/settings') &&
      response.request().method() === 'PUT' &&
      response.ok(),
  )
}

/** What a file's first four bytes say it is, so a served index.html cannot pass as an image. */
function magicOf(body: Buffer): string {
  const hex = body.subarray(0, 4).toString('hex')
  if (hex.startsWith('89504e47')) return 'png'
  if (hex.startsWith('00000100')) return 'ico'
  if (hex.startsWith('3c3f786d')) return 'svg'
  if (hex.startsWith('3c21646f')) return 'html'
  if (body[0] === 0x7b) return 'json'
  return hex
}
