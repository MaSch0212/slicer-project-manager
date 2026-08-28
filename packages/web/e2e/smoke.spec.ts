import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

  // Wait for the post-login navigation to land before touching the nav. The Settings link
  // lives in the shell header, so it is already clickable on /login: clicking it while the
  // login's own `router.navigate(['/projects'])` is still in flight starts a navigation that
  // the login one then wins, leaving the projects page rendered under a /settings URL.
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

test('the brand mark and the icon assets are served at the site root', async ({ page }) => {
  // The browser half of what `packages/desktop/test/shell.spec.ts` asserts for the Electron
  // renderer. The two are not the same risk: these files reach the browser through Angular's
  // `assets` copy of `packages/web/public`, and reach the desktop renderer through that *plus*
  // the `spm://` handler's content-type map. A change to angular.json's assets glob breaks this
  // one and nothing else.
  await page.goto('/login')

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
