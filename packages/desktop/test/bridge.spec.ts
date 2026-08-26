import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { launchApp, type SeedProject } from './fixtures.ts'

/**
 * The bridge, end to end: a real preload, a real `ipcMain.handle`, a real library on disk, and
 * assertions on what the Angular app painted.
 *
 * Everything here is deliberately observed from the renderer's side. The dispatch table's own
 * behaviour is covered exhaustively in `dispatch.test.ts` under plain Node; what this file exists
 * to prove is the part that only a running Electron can prove — that the channel carries values
 * and failures across intact, and that the app therefore gets past the login page it was stuck on
 * at the end of task 1.
 */

/** Two folders and their files, written before the app is launched and before any database. */
const SEED: SeedProject[] = [
  { name: 'Widget A', files: { 'part.stl': 'solid a\nendsolid a\n', 'notes.txt': 'hand notes' } },
  { name: 'Bracket', files: { 'model.3mf': 'not a real 3mf' } },
]

declare global {
  // The preload's bridge, as the renderer sees it. Declared here so `page.evaluate` bodies are
  // type-checked by `deno task typecheck:desktop` rather than being `any`.
  var spm: {
    invoke(
      path: string,
      args: unknown[],
    ): Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
    >
  }
}

test.describe('the IPC bridge', () => {
  let app: ElectronApplication
  let page: Page
  let libraryDir: string

  test.beforeAll(async () => {
    ;({ app, libraryDir } = await launchApp(SEED))
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('capabilities cross the bridge whole, and the app is past /login', async () => {
    // Task 1 settled at spm://app/login: with no bridge, CapabilitiesStore fell back to its
    // offline defaults where requiresAuth is true, AuthStore had no user, and the guard —
    // `!requiresAuth || isAuthenticated()` — redirected.
    //
    // Both arms are now satisfied, and it is worth being exact about which does the work,
    // because the ruling this task carried in said it was the capability alone. Measured, by
    // mutation: flip DESKTOP_CAPABILITIES.requiresAuth to true and the app still lands here,
    // because account.me() now answers; make account.me() throw instead and it still lands here,
    // because requiresAuth is false. Either arm is sufficient on its own. So the URL below is
    // evidence that *the bridge* works, not evidence about one flag — the flag is asserted
    // separately, on the value, immediately after.
    await expect.poll(() => page.url()).toBe('spm://app/projects')

    const capabilities = await page.evaluate(() => globalThis.spm.invoke('capabilities', []))
    expect(capabilities).toEqual({
      ok: true,
      value: {
        requiresAuth: false,
        canManageUsers: false,
        canPickLocalFolder: false,
        canLaunchSlicer: false,
        canConfigureSlicers: false,
        canBrowseModelSites: false,
      },
    })
  })

  test('the project list renders the library that was on disk before the app started', async () => {
    // Nothing inserted these rows: the folders were written to a temp directory, the app opened
    // and migrated an empty database over them, and a rescan over the bridge adopted them. The
    // page is then reloaded so the list is read back out of the library rather than out of the
    // store's memory.
    const rescan = await page.evaluate(() => globalThis.spm.invoke('projects.rescan', []))
    expect(rescan).toMatchObject({ ok: true, value: { adopted: 2 } })

    await page.reload()
    await expect.poll(() => page.url()).toBe('spm://app/projects')

    const titles = page.locator('.spm-projects .spm-project-title')
    await expect(titles).toHaveCount(2)
    expect((await titles.allTextContents()).sort()).toEqual(['Bracket', 'Widget A'])

    // The card body renders `model / slicerProject / other` from fileCounts, so this says the
    // DTO arrived whole rather than as a bag of names. Widget A holds part.stl and notes.txt.
    const widget = page.locator('.spm-project', { hasText: 'Widget A' })
    await expect(widget.locator('.spm-muted')).toHaveText('1 / 0 / 1')

    // The empty state and the error banner are both absent — either of them rendering would mean
    // the list came back empty or the call failed, and a count assertion alone would not say so
    // if the locator were wrong.
    await expect(page.locator('.spm-empty')).toHaveCount(0)
    await expect(page.locator('jig-message[color="error"]')).toHaveCount(0)
  })

  test('a value written through the bridge is on disk, and comes back on the next load', async () => {
    const created = await page.evaluate(() =>
      globalThis.spm.invoke('projects.create', [{ name: 'Made In The Renderer' }]),
    )
    expect(created).toMatchObject({ ok: true, value: { name: 'Made In The Renderer' } })

    // Read with a second connection, so this is the library file and not the app's memory.
    const db = new DatabaseSync(join(libraryDir, '.spm', 'app.db'), { readOnly: true })
    try {
      const rows = db.prepare('SELECT name FROM projects ORDER BY name').all()
      expect(rows).toEqual([
        { name: 'Bracket' },
        { name: 'Made In The Renderer' },
        { name: 'Widget A' },
      ])
    } finally {
      db.close()
    }

    await page.reload()
    await expect(page.locator('.spm-projects .spm-project-title')).toHaveCount(3)
  })

  test('a failure keeps its AppError code across the boundary', async () => {
    // The measurement this replaces: an Error *thrown* out of an ipcMain.handle callback reaches
    // the renderer as a plain Error whose message is "Error invoking remote method 'spm:invoke':
    // Error: <message>" and whose Object.keys() is empty — the code is gone. So the handler
    // returns a tagged value instead, and this asserts the code on it rather than asserting that
    // something failed. `rejected` is captured too: if the handler ever goes back to throwing,
    // this line is what says so instead of the test merely losing a property.
    const results = await page.evaluate(async () => {
      const call = async (path: string, args: unknown[]) => {
        try {
          return { rejected: false, result: await globalThis.spm.invoke(path, args) }
        } catch (error) {
          return { rejected: true, result: String(error) }
        }
      }
      return {
        // The same schema, and so the same code, the server rejects an empty name with.
        emptyName: await call('projects.create', [{ name: '' }]),
        missing: await call('projects.get', ['no-such-project-id']),
        adminOnly: await call('users.list', []),
        unknownPath: await call('projects.duplicate', []),
        // A compromised renderer must not be able to reach Object.prototype through the table.
        prototypeKey: await call('__proto__', []),
      }
    })

    expect(results.emptyName).toMatchObject({
      rejected: false,
      result: { ok: false, error: { code: 'Validation' } },
    })
    expect(results.missing).toMatchObject({
      rejected: false,
      result: { ok: false, error: { code: 'NotFound' } },
    })
    expect(results.adminOnly).toMatchObject({
      rejected: false,
      result: { ok: false, error: { code: 'Forbidden' } },
    })
    expect(results.unknownPath).toMatchObject({
      rejected: false,
      result: { ok: false, error: { code: 'NotFound' } },
    })
    expect(results.prototypeKey).toMatchObject({
      rejected: false,
      result: { ok: false, error: { code: 'NotFound' } },
    })
  })
})

/**
 * The code *and* the details, observed in painted DOM rather than in a returned object.
 *
 * `project-detail.page.ts` renders one of three messages for a failed upload: the interpolated
 * quota sentence when `error.code === 'QuotaExceeded'` **and** `error.details` is present, a
 * different sentence for `NotFound`, and a generic one otherwise. So the exact text on the page
 * is a statement about what survived the boundary and was rebuilt into a real `AppError` by
 * `IpcApiClient` — a bare string, a dropped `code` or dropped `details` all land on "Something
 * went wrong".
 *
 * Its own launch, because it writes a quota into the library the block above is reading.
 */
test('an AppError arrives in the UI with its code and its details intact', async () => {
  const { app, libraryDir } = await launchApp([
    { name: 'Quota Project', files: { 'small.stl': 'solid s endsolid s' } },
  ])
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => globalThis.spm.invoke('projects.rescan', []))

    // A quota the app cannot possibly satisfy. Written with a second connection while the app
    // holds the file open, which is what the library's busy_timeout exists for.
    const db = new DatabaseSync(join(libraryDir, '.spm', 'app.db'))
    try {
      db.prepare('UPDATE users SET quota_bytes = ? WHERE username = ?').run(1024, 'local')
    } finally {
      db.close()
    }

    await page.reload()
    await page.locator('.spm-project-link').first().click()
    await expect(page.locator('h1')).toHaveText('Quota Project')

    await page.locator('input[type="file"]').setInputFiles({
      name: 'too-big.stl',
      mimeType: 'model/stl',
      buffer: Buffer.alloc(4096, 0x61),
    })

    const alert = page.locator('jig-message[color="error"]')
    // Not `toContainText('quota')`: the generic message would fail that too only by luck, and
    // the numbers are the part that proves `details` crossed. `usage` and `quota` are rendered
    // through formatBytes, so "18 B" and "1.0 kB".
    await expect(alert).toHaveText(
      /^This upload would exceed your quota \(\d+ B of 1\.0 kB used\)$/,
    )

    // And the file really was refused, rather than written and then complained about.
    await expect(page.locator('.spm-file')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
