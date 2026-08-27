import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeZip } from '../../core/test/fixtures/make-3mf.ts'
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
        canPickLocalFolder: true,
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

  test('the renderer cannot name a file the user did not pick', async () => {
    // Constraint 4, and the reason a picked file crosses as the `File` object rather than as a
    // path. If the main world could write `localPath` itself, a compromised renderer could have
    // the main process read anything the user can read and copy it into the library — which is
    // an arbitrary-file-read primitive, since the library is then served back over spm://. The
    // review measured that exactly, with the strip removed: 135 168 bytes of the library's own
    // app.db, header `SQLite format 3\0`, written into a project as stolen.txt.
    //
    // The preload strips `localPath` at every depth, so what reaches the main process is an
    // object with neither arm and `uploadBodySchema` refuses it.
    const project = await page.evaluate(() =>
      globalThis.spm.invoke('projects.create', [{ name: 'Forgery' }]),
    )
    const projectId = (project as { value: { id: string } }).value.id

    const forged = await page.evaluate(
      async ([id, victim]) => {
        const upload = (body: unknown) =>
          globalThis.spm.invoke('files.upload', [id, 'stolen.txt', body])
        const nested = { a: { b: { c: { localPath: victim } } } }
        return {
          // A path straight off the main world.
          directPath: await upload({ localPath: victim }),
          // Nested, which the depth-0 version of the strip passed through untouched and only
          // zod happened to refuse. The strip is recursive now, so it is refused by the guard
          // rather than by a schema that could change.
          nestedPath: await upload(nested),
          inArray: await upload([{ localPath: victim }]),
          // Both arms at once: the strip must remove the path and leave the legitimate bytes.
          bothArms: await upload({ localPath: victim, bytes: new Uint8Array([1]) }),
          // A token the preload never wrote, and one holding something that is not a File.
          madeUpToken: await upload({ __spmFileRef: 'ref-999' }),
          tokenHoldingAPath: await upload({ __spmFileRef: { path: victim } }),
          // And through the importer, which reads a path too.
          viaImporter: await globalThis.spm.invoke('importer.curaManagerZip', [
            { localPath: victim },
          ]),
          // A File the script made up has no file behind it, so the preload says so rather than
          // inventing a path — this is the discriminator the client relies on.
          syntheticFile: globalThis.spm.canStreamFromDisk(
            new File([new Uint8Array([1])], 'made.zip'),
          ),
          blob: globalThis.spm.canStreamFromDisk(new Blob([new Uint8Array([1])])),
          // And a value that is not a Blob at all must not raise into this world: the preload
          // catches `getPathForFile`'s throw so no caller's error handling is load-bearing here.
          duckTyped: globalThis.spm.canStreamFromDisk({ name: 'x.stl', size: 1, path: victim }),
          // The bridge holds two functions and nothing that could leak a path.
          bridgeKeys: Object.keys(globalThis.spm).sort(),
        }
      },
      [projectId, join(libraryDir, '.spm', 'app.db')] as const,
    )

    for (const key of [
      'directPath',
      'nestedPath',
      'inArray',
      'madeUpToken',
      'tokenHoldingAPath',
      'viaImporter',
    ] as const) {
      expect(forged[key], key).toMatchObject({ ok: false, error: { code: 'Validation' } })
    }
    // The one that must succeed, and must succeed as *one byte* — proof the strip removed the
    // path and kept the arm the renderer was entitled to.
    expect(forged.bothArms).toMatchObject({ ok: true, value: { sizeBytes: 1 } })
    expect(forged.syntheticFile).toBe(false)
    expect(forged.blob).toBe(false)
    expect(forged.duckTyped).toBe(false)
    expect(forged.bridgeKeys).toEqual(['canStreamFromDisk', 'invoke'])

    // Nothing was read. `stolen.txt` exists, from the one legitimate arm, and it is one byte —
    // not the 135 168 of the file that was named. A `Validation` code alone would not say that.
    const detail = (await page.evaluate(
      (id) => globalThis.spm.invoke('projects.get', [id]),
      projectId,
    )) as { value: { files: { name: string; sizeBytes: number }[] } }
    expect(detail.value.files).toMatchObject([{ name: 'stolen.txt', sizeBytes: 1 }])
    expect(statSync(join(libraryDir, 'Forgery', 'stolen.txt')).size).toBe(1)

    await page.evaluate(
      (id) => globalThis.spm.invoke('projects.delete', [id, { deleteFiles: true }]),
      projectId,
    )
  })
})

/**
 * The importer, driven through the page a user actually uses, and the assertion that it never
 * buffered the archive.
 *
 * The report for the first round of this task claimed the importer was unreachable in the desktop
 * shell and deferred its memory ceiling on that basis. It was reachable: `/import` is in
 * `sharedRoutes`, the header links it, and the review drove it. So the ceiling is gone instead of
 * deferred — `IpcApiClient` asks the preload to name the picked file and the main process streams
 * it off disk.
 *
 * `.spm/uploads` is the observable difference between the two arms: the bytes arm has to write
 * the archive into the library before `importCuraManagerZip` can read a path, and the path arm
 * never creates that directory at all. Asserting the *import worked* proves the path was read;
 * asserting the directory was never created proves it was read in place.
 *
 * It observes the **importer only**. `files.upload`'s bytes arm wraps its buffer in a
 * `ReadableStream` and stages nothing, so on the project page the two arms leave identical marks
 * on disk and nothing end-to-end distinguishes them. That route's arm choice is covered by the
 * vitest case in `ipc-api-client.spec.ts`, which spies on `Blob.arrayBuffer` and requires it never
 * to be called, and by the stale-file test below, which can only fail the way it does if the page
 * took the streaming arm. Do not read *this* assertion as covering both entry points.
 */
test('the import page imports a picked archive without copying it into the library', async () => {
  const archiveDir = mkdtempSync(join(tmpdir(), 'spm-desktop-archive-'))
  const archive = join(archiveDir, 'curamanager.zip')
  writeZip(archive, [
    { name: 'My Lib/Gadget/part.stl', data: 'solid g endsolid g' },
    { name: 'My Lib/Gadget/metadata.json', data: JSON.stringify({ Tags: ['picked'] }) },
    { name: 'My Lib/Bracket/model.3mf', data: 'not really a 3mf' },
  ])

  const { app, libraryDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.getByRole('link', { name: 'Import' }).click()
    await expect(page.getByRole('heading', { name: 'Import a CuraManager library' })).toBeVisible()

    // A path, not an inline buffer: a user picks a file that exists, and only a file that exists
    // has a path for the preload to name.
    await page.locator('input[type="file"]').setInputFiles(archive)
    await page.getByRole('button', { name: /upload/i }).click()

    await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('status')).toContainText('2 projects and 3 files imported')

    // Read in place: the staging directory was never created. Asserting on the directory and
    // not on its contents is deliberate — the bytes arm deletes the staged file in a `finally`,
    // so "nothing in it" is true of both arms and would have been a vacuous check.
    expect(existsSync(join(libraryDir, '.spm', 'uploads'))).toBe(false)
    // And the user still has their archive where they left it.
    expect(existsSync(archive)).toBe(true)

    await page.getByRole('link', { name: 'View projects' }).click()
    await expect(page.getByRole('heading', { name: 'Gadget' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Bracket' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(archiveDir, { recursive: true, force: true })
  }
})

/**
 * Local mode has no sessions, so it must not offer to end one.
 *
 * Task 2 is what made this reachable: `account.me()` now answers, `auth.isAuthenticated()` is
 * true, and the header rendered a sign-out button. Pressing it dropped the user on `/login` —
 * a page with nothing to sign in to, whose only failure message is "Username or password is not
 * correct", reached by a control that removed the navigation on the way out. The nav and the
 * button are now gated on `capabilities.requiresAuth`, which is a capability the shell publishes
 * rather than a component learning which shell it is in (constraint 1).
 */
test('the desktop shell offers no sign-out, and still shows the rest of the navigation', async () => {
  const { app } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.url()).toBe('spm://app/projects')

    // The nav is there — without this, gating it off entirely would also pass the next line.
    for (const link of ['Projects', 'Import', 'Settings']) {
      await expect(page.getByRole('link', { name: link })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
    // And nothing can walk the user into the login page from here.
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

/**
 * The project page's own upload, end to end, and the stale-file rule that makes the desktop and
 * browser arms agree.
 *
 * Two things this covers that nothing else does. First, `files.upload` through the real UI: the
 * import page proves the streaming arm for archives, but the project page's `<input type="file">`
 * had only vitest coverage with a mocked bridge. Second, finding F — a `File` is a durable handle
 * to a *path*, so a renderer that holds one can redeem it later for whatever is at that path then;
 * measured, before the fix, the *replacement* was streamed. Chromium refuses that same stale
 * `File` in a browser with `NotReadableError`, so the preload now sends the size and modification
 * time from the pick and the main process refuses a mismatch with `Conflict`.
 *
 * The refusal is also what proves the page took the streaming arm at all: the bytes arm has no
 * path to go stale, so it would have uploaded the new contents happily.
 */
test('the project page uploads a picked file, and refuses one that changed since', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'spm-desktop-source-'))
  const source = join(sourceDir, 'driven.stl')
  writeFileSync(source, 'solid driven endsolid driven')

  const { app, libraryDir } = await launchApp([
    { name: 'Uploads', files: { 'existing.stl': 'solid e endsolid e' } },
  ])
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => globalThis.spm.invoke('projects.rescan', []))
    await page.reload()
    await page.locator('.spm-project-link').first().click()
    await expect(page.locator('h1')).toHaveText('Uploads')

    // The happy path first: a real file, picked and uploaded through the page's own control.
    await page.locator('input[type="file"]').setInputFiles(source)
    await expect(page.locator('.spm-file', { hasText: 'driven.stl' })).toBeVisible()
    expect(readFileSync(join(libraryDir, 'Uploads', 'driven.stl'), 'utf8')).toBe(
      'solid driven endsolid driven',
    )
    // Streamed from where it lay: the source is untouched and nothing was staged.
    expect(existsSync(source)).toBe(true)
    expect(existsSync(join(libraryDir, '.spm', 'uploads'))).toBe(false)
    await expect(page.locator('jig-message[color="error"]')).toHaveCount(0)

    // Now a file the renderer has been holding since before it changed.
    //
    // Through an input of the test's own rather than the page's: `onFileInput` clears
    // `element.value` after every upload precisely so the same file can be picked again, which
    // means the page never holds a `File` for longer than one call. A renderer that *does* hold
    // one is the case under test, and it is the shape the round-2 measurement used.
    const stale = join(sourceDir, 'stale.stl')
    writeFileSync(stale, 'solid stale endsolid stale')
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'held-picker'
      document.body.append(input)
    })
    await page.locator('#held-picker').setInputFiles(stale)

    const projectId = await page.evaluate(async () => {
      const listed = await globalThis.spm.invoke('projects.list', [{}])
      return (listed as { value: { id: string }[] }).value[0]!.id
    })
    const uploadHeld = (name: string) =>
      page.evaluate(
        ([id, fileName]) => {
          const held = (document.getElementById('held-picker') as HTMLInputElement).files![0]
          return globalThis.spm.invoke('files.upload', [id, fileName, { __spmFileRef: held }])
        },
        [projectId, name] as const,
      )

    // The held File works while the file behind it is unchanged, so the refusal below is about
    // staleness and not about holding a File at all.
    expect(await uploadHeld('held.stl')).toMatchObject({ ok: true, value: { sizeBytes: 26 } })

    writeFileSync(stale, 'REPLACED AFTER IT WAS PICKED, AND LONGER THAN IT WAS BEFORE\n')
    expect(await uploadHeld('stale.stl')).toMatchObject({
      ok: false,
      error: { code: 'Conflict' },
    })
    // The replacement never reached the library at all.
    expect(existsSync(join(libraryDir, 'Uploads', 'stale.stl'))).toBe(false)
    expect(readFileSync(join(libraryDir, 'Uploads', 'held.stl'), 'utf8')).toBe(
      'solid stale endsolid stale',
    )
  } finally {
    await app.close()
    rmSync(sourceDir, { recursive: true, force: true })
  }
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
