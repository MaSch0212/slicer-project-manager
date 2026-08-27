import { expect, test, type Page } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeLibrary, ensureLocalUser, openLibrary, rescan } from '@spm/core'
import { curaProject } from '../../core/test/fixtures/make-3mf.ts'
import {
  firstWindowOf,
  launchWithUserData,
  newUserDataDir,
  pickerCalls,
  seedLibrary,
  stubFolderPicker,
} from './fixtures.ts'
import { PREVIEW_HEIGHT, PREVIEW_RGB, PREVIEW_WIDTH, previewPng } from './preview-fixture.ts'

/**
 * Local folder mode, through the real app: the picker, the remembered folder, the switch control
 * and the preview queue.
 *
 * The native dialog is replaced in the main process before the app can reach it (see
 * `stubFolderPicker`), which is the only way any of this is drivable — a real folder chooser has
 * no automation surface. Everything either side of that one function is production code: the
 * options it was called with are the ones `folderPickerOptions` built, and the folder it answers
 * goes through `LibraryHost.open`, `openLibrary`, `ensureLocalUser` and the protocol handler
 * exactly as a user's choice would.
 *
 * The exhaustive cases — a corrupt state file, a remembered path that is now a file, an
 * environment override, a switch during a preview run — are in `test/library.test.ts`, where they
 * cost milliseconds instead of an Electron launch each.
 */

const STL = 'solid part\nendsolid part\n'

/** A library folder with one project in it, and no `.spm` — the app has to adopt it. */
function seededFolder(project: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spm-library-'))
  seedLibrary(dir, [{ name: project, files: { 'part.stl': STL } }])
  return dir
}

/**
 * A library folder that is already a library: opened, migrated, rescanned and closed again, by
 * this process and before the app has ever seen it.
 *
 * It exists so one test can assert that the *shell* reloaded the window — a folder the app has to
 * rescan first would need a reload from the test to show anything, and that reload would hide the
 * one the shell owes the renderer.
 */
async function adoptedFolder(project: string): Promise<string> {
  const dir = seededFolder(project)
  const lib = openLibrary(dir)
  try {
    const result = await rescan(lib, ensureLocalUser(lib))
    expect(result.adopted).toBe(1)
  } finally {
    closeLibrary(lib)
  }
  return dir
}

function rememberedDir(userDataDir: string): unknown {
  const state = JSON.parse(readFileSync(join(userDataDir, 'state.json'), 'utf8')) as {
    libraryDir?: unknown
  }
  return state.libraryDir
}

/**
 * The project grid, asserted with a retrying locator rather than a snapshot of it.
 *
 * The list is fetched after the document loads, so a one-shot `allTextContents()` reads an empty
 * grid that is about to fill — measured, and it failed exactly once that way before this helper
 * existed. `toHaveText` on the whole locator also pins the *count*, so a second project appearing
 * is a failure rather than a coincidence.
 */
async function expectProjects(page: Page, titles: string[]): Promise<void> {
  // A generous timeout because this is now waiting on the whole chain ruling C-16 put in front of
  // it: open, rescan the folder, reload the window, re-fetch the list.
  await expect(page.locator('.spm-projects .spm-project-title')).toHaveText(titles, {
    timeout: 20_000,
  })
}

test('first run asks for a folder, opens what it is given, and reopens it next launch', async () => {
  const userDataDir = newUserDataDir()
  const libraryDir = seededFolder('Widget A')

  const first = await launchWithUserData(userDataDir, libraryDir)
  let page = await firstWindowOf(first)
  await page.waitForLoadState('domcontentloaded')

  // The picker, with the two properties the plan names. Asserted on the options the *shell*
  // passed, not on a constant this file also owns.
  await expect.poll(async () => (await pickerCalls(first)).length).toBe(1)
  const [options] = await pickerCalls(first)
  expect(options).toMatchObject({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a library folder',
  })

  // A real library was created in the folder that was chosen: migrated, with its single local
  // user, and — ruling C-16 — the projects that were on disk before the app existed, adopted
  // because the folder was picked. Nothing in this test asks for a rescan.
  await expectProjects(page, ['Widget A'])
  expect(existsSync(join(libraryDir, '.spm', 'app.db'))).toBe(true)
  expect(rememberedDir(userDataDir)).toBe(libraryDir)

  // No login screen, ever: local mode has no accounts, and a shell that asked for one would be
  // asking about a library it opened off the user's own disk.
  expect(page.url()).toBe('spm://app/projects')
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await first.close()

  // Second launch, same userData, and a picker that fails the test if it is opened at all.
  const second = await launchWithUserData(userDataDir, null)
  page = await firstWindowOf(second)
  await page.waitForLoadState('domcontentloaded')
  await expectProjects(page, ['Widget A'])
  expect(await pickerCalls(second)).toEqual([])
  await second.close()
})

test('the switch control opens another folder without a restart, and lets go of the old one', async () => {
  const userDataDir = newUserDataDir()
  const before = seededFolder('Widget A')
  // The second folder is a library already: opened, migrated and rescanned by this test process,
  // then closed. Nothing after the click reloads the page, so what appears in the grid can only
  // have come from the shell reloading the window on a library it swapped underneath it.
  const after = await adoptedFolder('Bracket')

  const app = await launchWithUserData(userDataDir, before)
  const page = await firstWindowOf(app)
  await page.waitForLoadState('domcontentloaded')
  await expectProjects(page, ['Widget A'])

  // The control exists because `canPickLocalFolder` is true, and it is found the way a screen
  // reader finds it — through the tooltip's aria label, with no test hook in the markup.
  const control = page.getByRole('button', { name: 'Change library folder' })
  await expect(control).toHaveCount(1)

  await stubFolderPicker(app, after)
  await control.click()

  await expectProjects(page, ['Bracket'])
  expect(rememberedDir(userDataDir)).toBe(after)
  expect(existsSync(join(after, '.spm', 'app.db'))).toBe(true)

  // Two dialogs: this launch started with an empty userData, so the first run asked as well.
  const calls = await pickerCalls(app)
  expect(calls).toHaveLength(2)
  expect(calls[1]).toMatchObject({
    properties: ['openDirectory', 'createDirectory'],
    // The user asked for this one, so there is nothing to explain.
    title: 'Choose a library folder',
  })

  // The folder that was left is really released, which on Windows means it can be renamed —
  // measured: `EPERM` while a library is open, and success once it is closed. The release waits
  // for that library's own work — a preview batch of up to `PREVIEW_BATCH_LIMIT` jobs, and the
  // rescan opening it started — so this polls rather than asserting once. On Linux a rename
  // succeeds with an open handle too, so there this only says the directory is still there;
  // `library.test.ts` asserts the close itself, on the database.
  await expect
    .poll(
      () => {
        try {
          renameSync(before, `${before}-moved`)
          return true
        } catch {
          return false
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true)

  await app.close()
})

test('a remembered folder that has gone returns to the picker, saying which one', async () => {
  const userDataDir = newUserDataDir()
  const gone = seededFolder('Widget A')
  renameSync(gone, `${gone}-taken-away`)
  writeFileSync(join(userDataDir, 'state.json'), JSON.stringify({ libraryDir: gone }))
  const replacement = seededFolder('Bracket')

  const app = await launchWithUserData(userDataDir, replacement)
  const page = await firstWindowOf(app)
  await page.waitForLoadState('domcontentloaded')

  await expect.poll(async () => (await pickerCalls(app)).length).toBe(1)
  const [options] = await pickerCalls(app)
  // The explanation, in the picker's own title — and it names the folder, because "your library
  // is gone" without saying which folder is not an explanation.
  expect(String(options!['title'])).toContain(gone)
  expect(String(options!['title'])).toMatch(/no longer there/)

  // It degraded rather than crashed: the window is up, the app routed itself past the guard with
  // no library at all, and the folder the user chose instead is now the library. Polled, because
  // the router redirects after bootstrap and the shell reloads the window once the pick lands.
  await expect.poll(() => page.url()).toBe('spm://app/projects')
  await expectProjects(page, ['Bracket'])
  expect(rememberedDir(userDataDir)).toBe(replacement)

  await app.close()
})

test('a cancelled picker leaves a usable window, not a login screen or a dead app', async () => {
  const userDataDir = newUserDataDir()
  const app = await launchWithUserData(userDataDir, null)
  const page = await firstWindowOf(app)
  await page.waitForLoadState('domcontentloaded')

  await expect.poll(async () => (await pickerCalls(app)).length).toBe(1)
  // No library open, and still no login screen: `requiresAuth` is false whether or not a folder
  // was chosen, so the guard lets the app through to its own route instead of /login.
  await expect.poll(() => page.url()).toBe('spm://app/projects')
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  expect(existsSync(join(userDataDir, 'state.json'))).toBe(false)

  // And the way back in is the same control, which is offered because the capability says the
  // shell can open a folder — not because anything checked whether one is open.
  const chosen = seededFolder('Widget A')
  await stubFolderPicker(app, chosen)
  await page.getByRole('button', { name: 'Change library folder' }).click()

  await expectProjects(page, ['Widget A'])
  expect(rememberedDir(userDataDir)).toBe(chosen)

  await app.close()
})

test('the app renders a thumbnail the queue produced, from a folder that had none', async () => {
  const userDataDir = newUserDataDir()
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-library-'))
  mkdirSync(join(libraryDir, 'Widget A'), { recursive: true })
  // A slicer project with a thumbnail inside it, and nothing else. No preview row, no png on
  // disk, no `.spm` at all — everything below is the shell's own queue doing the work that the
  // Deno server's interval does in the browser arm.
  curaProject(join(libraryDir, 'Widget A', 'widget.3mf'), previewPng())

  const app = await launchWithUserData(userDataDir, libraryDir)
  const page = await firstWindowOf(app)
  await page.waitForLoadState('domcontentloaded')

  // Opening the folder adopts it, which is what queues the preview row (ruling C-16) — so the
  // grid filling is also the signal that the database is there to be read.
  await expectProjects(page, ['Widget A'])

  // The queue ticks on its own; nothing here asks it to.
  const db = new DatabaseSync(join(libraryDir, '.spm', 'app.db'), { readOnly: true })
  try {
    await expect
      .poll(
        () =>
          (db.prepare('SELECT state, source FROM previews').all() as Record<string, unknown>[]).map(
            (row) => ({ state: row['state'], source: row['source'] }),
          ),
        { timeout: 30_000 },
      )
      .toEqual([{ state: 'ready', source: 'embedded' }])
  } finally {
    db.close()
  }
  await page.locator('.spm-project-link').first().click()
  await expect(page.locator('h1')).toHaveText('Widget A')

  // Decoded and painted, not merely requested: a 404 or an HTML body served as image/png fails
  // at `decode()`, and the pixel says these are the bytes that were inside the 3MF.
  const painted = await page
    .locator('.spm-file', { hasText: 'widget.3mf' })
    .locator('img')
    .evaluate(async (element) => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const [r, g, b, a] = context.getImageData(1, 1, 1, 1).data
      return { width: image.naturalWidth, height: image.naturalHeight, pixel: [r, g, b, a] }
    })

  expect(painted.width).toBe(PREVIEW_WIDTH)
  expect(painted.height).toBe(PREVIEW_HEIGHT)
  expect(painted.pixel).toEqual([...PREVIEW_RGB, 255])

  await app.close()
})
