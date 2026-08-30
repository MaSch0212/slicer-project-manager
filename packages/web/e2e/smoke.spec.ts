import { expect, test } from '@playwright/test'
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
