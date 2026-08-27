import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { binaryStl, cubeMesh } from '../../core/test/fixtures/make-mesh.ts'
import {
  launchApp,
  launchWithoutLibrary,
  SOFTWARE_WEBGL_ARGS,
  type SeedProject,
} from './fixtures.ts'
import { markPreviewReady, PREVIEW_HEIGHT, PREVIEW_RGB, PREVIEW_WIDTH } from './preview-fixture.ts'

/**
 * File bytes over `spm://`, observed from inside the running app.
 *
 * `files.test.ts` already proves the handler answers the right bytes with the right headers, and
 * it does it under plain Node in `deno task verify`. What only a real Electron can say is here:
 * that Chromium *decoded* the thumbnail rather than merely receiving it, that a renderer `fetch`
 * of `rawUrl` gets the file, that a traversal is refused over the real protocol, and — the
 * finding this task carried in from task 2's review — that the viewer no longer tells a user
 * their intact model is gone.
 */

const CUBE = binaryStl(cubeMesh())
const NOTES = 'hand notes'

const SEED: SeedProject[] = [
  { name: 'Models', files: { 'cube.stl': CUBE, 'notes.txt': NOTES, 'ghost.stl': CUBE } },
]

type Detail = {
  id: string
  coverThumbUrl?: string
  files: { id: string; name: string; rawUrl: string; thumbUrl?: string }[]
}

async function readDetail(page: Page): Promise<Detail> {
  const listed = (await page.evaluate(() => globalThis.spm.invoke('projects.list', [{}]))) as {
    value: { id: string }[]
  }
  const detail = (await page.evaluate(
    (id) => globalThis.spm.invoke('projects.get', [id]),
    listed.value[0]!.id,
  )) as { value: Detail }
  return detail.value
}

test.describe('file bytes over spm://', () => {
  let app: ElectronApplication
  let page: Page
  let libraryDir: string
  let detail: Detail

  test.beforeAll(async () => {
    // The viewer tests at the bottom need a WebGL context, and the CI runner has no GPU.
    ;({ app, libraryDir } = await launchApp(SEED, SOFTWARE_WEBGL_ARGS))
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => globalThis.spm.invoke('projects.rescan', []))
    detail = await readDetail(page)

    // The thumbnail this task serves. Task 4 owns the queue that would normally produce one, so
    // the fixture writes a real PNG to the real path and sets the real `ready` row — nothing
    // about `resolvePreviewPath` is stubbed. Written with a second connection while the app
    // holds the library open, which is what the library's busy_timeout exists for.
    const cube = detail.files.find((file) => file.name === 'cube.stl')!
    const db = new DatabaseSync(join(libraryDir, '.spm', 'app.db'))
    try {
      markPreviewReady(db, libraryDir, cube.id)
    } finally {
      db.close()
    }
    await page.reload()
    await expect.poll(() => page.url()).toBe('spm://app/projects')
    detail = await readDetail(page)
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('the thumbnail is decoded and painted, not merely requested', async () => {
    // B2 shipped an `<img>` that existed and showed nothing, so nothing here asks whether the
    // element is present. `decode()` resolves only for bytes Chromium could turn into an image,
    // `naturalWidth`/`naturalHeight` are the *decoded* dimensions, and the pixel is read back
    // off a canvas the image was drawn into. A 404, an HTML body served as `image/png`, and a
    // truncated stream all fail on the first of those three.
    await page.locator('.spm-project-link').first().click()
    await expect(page.locator('h1')).toHaveText('Models')

    const painted = await page
      .locator('.spm-file', { hasText: 'cube.stl' })
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
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          // Not `.src`: what matters is the URL Chromium actually resolved and fetched.
          resolved: image.currentSrc,
          pixel: [r, g, b, a],
        }
      })

    expect(painted.width).toBe(PREVIEW_WIDTH)
    expect(painted.height).toBe(PREVIEW_HEIGHT)
    expect(painted.pixel).toEqual([...PREVIEW_RGB, 255])
    expect(painted.resolved).toMatch(/^spm:\/\/app\/_spm\/files\/[^/]+\/thumb$/)

    // And the file with no ready preview claims no `thumbUrl`, so there is no `<img>` at all
    // rather than a broken one. Without this the locator above could be matching anything in
    // the list, and `decorateFile`'s absent-key branch would have no end-to-end cover.
    const notes = page.locator('.spm-file', { hasText: 'notes.txt' })
    await expect(notes.locator('img')).toHaveCount(0)
    await expect(notes.locator('.spm-file-thumb')).toHaveText('Preview pending')
  })

  test('the project card shows the same thumbnail through coverThumbUrl', async () => {
    // A second surface, and a different DTO field: `decorateProject` puts `coverThumbUrl` on the
    // project rather than on a file, and nothing else in the desktop suite ever fetches it.
    // Navigated rather than `goBack()`: this must not depend on where the test above left the
    // shared page, and the tests in this block share one Electron process on purpose.
    await page.goto('spm://app/projects')
    await expect(page.locator('h1')).toHaveText('Projects')
    expect(detail.coverThumbUrl).toBeDefined()

    const cover = page.locator('.spm-project img').first()
    await expect(cover).toBeVisible()
    expect(
      await cover.evaluate(async (element) => {
        const image = element as HTMLImageElement
        await image.decode()
        return { width: image.naturalWidth, src: image.currentSrc }
      }),
    ).toEqual({ width: PREVIEW_WIDTH, src: detail.coverThumbUrl })
  })

  test('a renderer fetch of rawUrl gets the file, byte for byte', async () => {
    // The call B2's viewer makes, made the same way: a plain same-origin `fetch` for the exact
    // `rawUrl` string the DTO carries. The bytes are compared whole rather than by length —
    // a handler that answered the wrong file, or the same file twice over, has the right length.
    const cube = detail.files.find((file) => file.name === 'cube.stl')!
    const got = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        acceptRanges: response.headers.get('accept-ranges'),
        bytes: [...bytes],
      }
    }, cube.rawUrl)

    expect(got.status).toBe(200)
    expect(got.contentType).toBe('model/stl')
    expect(got.contentLength).toBe(String(CUBE.byteLength))
    expect(got.acceptRanges).toBe('none')
    expect(got.bytes).toEqual([...CUBE])
  })

  test('a traversal is refused over the real protocol, encoded or not', async () => {
    // The brief asks for a percent-encoded traversal, and that is a floor. Each of these names
    // a file that really exists — `app.db` is the library's own database, and reading it back
    // over `spm://` would be the arbitrary-read primitive task 2's review measured through the
    // upload path. None of them builds a path: the id is a bind parameter, so an escape reaches
    // `WHERE f.id = ?` and selects nothing. The bodies are asserted too, because a 404 whose
    // body is 135 kB of SQLite would still be a 404.
    const answers = await page.evaluate(async (urls: string[]) => {
      const out: Record<string, string> = {}
      for (const url of urls) {
        try {
          const response = await fetch(url)
          out[url] = `${response.status} ${(await response.text()).slice(0, 20)}`
        } catch (error) {
          out[url] = `threw ${String(error)}`
        }
      }
      return out
    }, TRAVERSALS)

    expect(answers).toEqual(Object.fromEntries(TRAVERSALS.map((url) => [url, '404 not found'])))
  })

  test('the viewer opens a model whose bytes are there', async () => {
    // The whole point of the task, seen from where a user sees it. Until this handler existed,
    // `rawUrl` 404d and this page said the model was gone.
    const cube = detail.files.find((file) => file.name === 'cube.stl')!
    await page.goto(`spm://app/projects/${detail.id}/view/${cube.id}`)

    // The whole settled page in one object, rather than four separate locator assertions.
    // `roleImg` is bound to `showsModel()` — `initError() === null && state().status === 'ready'`
    // — so it is 1 only once the bytes arrived, parsed into a non-empty mesh and reached the
    // scene. Measured by mutation: a `canvas` visibility check is *not* enough, because the
    // viewport element is in the DOM while loading and while failing too, and it stayed green
    // with `raw` forced to 404.
    //
    // Read as one object because the *failure output* is what has to be readable: this page has
    // three ways to say nothing is on screen (a WebGL init error, a load failure, a gate), and
    // an `element(s) not found` on the success locator tells you which of them happened —
    // nothing. `messages` is every `jig-message` on the page, so a red run quotes the sentence
    // the user would have read.
    expect(await settledViewer(page)).toEqual({ roleImg: 1, messages: [] })
  })

  test('and says something different about a model whose bytes are really gone', async () => {
    // Task 2's review left this open deliberately: with the reserved prefix failing closed, the
    // viewer showed *this* sentence for a perfectly intact file. The two states must not share
    // one wrong sentence, so both are asserted in the same run — the test above is half of this
    // one. The row survives; only the bytes go, which is exactly what rescan's `missing` state
    // and a file deleted underneath the app both look like.
    const ghost = detail.files.find((file) => file.name === 'ghost.stl')!
    rmSync(join(libraryDir, 'Models', 'ghost.stl'))

    await page.goto(`spm://app/projects/${detail.id}/view/${ghost.id}`)
    expect(await settledViewer(page)).toEqual({
      roleImg: 0,
      messages: [`error: ${MISSING_MESSAGE}`],
    })
    // Not the sentence the other half of this pair must never show.
    expect(MISSING_MESSAGE).not.toBe(FETCH_FAILED_MESSAGE)
  })
})

/**
 * The viewer once it has stopped changing: how many elements claim to be showing a model, and
 * every message it is displaying, colour included.
 *
 * Polled to a *stable* reading rather than waited on with a locator, because both outcomes this
 * file asserts are "the page settled on exactly this", and one of them is an empty message list —
 * which any locator would satisfy the instant the page was blank.
 */
async function settledViewer(page: Page): Promise<{ roleImg: number; messages: string[] }> {
  const read = () =>
    page.evaluate(() => ({
      roleImg: document.querySelectorAll('[role="img"]').length,
      messages: [...document.querySelectorAll('jig-message')].map(
        (element) =>
          `${element.getAttribute('color')}: ${(element.textContent ?? '').replace(/\s+/g, ' ').trim()}`,
      ),
    }))
  let previous = JSON.stringify(await read())
  for (let attempt = 0; attempt < 60; attempt++) {
    await page.waitForTimeout(250)
    const current = await read()
    const serialised = JSON.stringify(current)
    // Two identical readings a quarter-second apart, and not merely "no longer loading": the
    // progress region and the message swap in the same change detection pass.
    if (serialised === previous && (current.roleImg > 0 || current.messages.length > 0)) {
      return current
    }
    previous = serialised
  }
  throw new Error(`the viewer never settled; last reading was ${previous}`)
}

/** Straight out of `en.json`; if the copy moves, this fails rather than silently matching less. */
const MISSING_MESSAGE =
  'This file is not part of this project any more. Go back to the project to see what it holds now.'
const FETCH_FAILED_MESSAGE =
  'The model could not be downloaded. Check your connection, then reload the page to try again.'

const TRAVERSALS = [
  // One level up from a project folder is the library root, where `.spm/app.db` lives — the
  // shortest real escape, and the one a naive `join(projectDir, id)` would answer with 135 kB
  // of SQLite. Two levels up is above the library entirely.
  'spm://app/_spm/files/..%2f.spm%2fapp.db/raw',
  'spm://app/_spm/files/%2e%2e%2f.spm%2fapp.db/raw',
  'spm://app/_spm/files/..%5c.spm%5capp.db/raw',
  'spm://app/_spm/files/..%2f.spm%2fapp.db/thumb',
  'spm://app/_spm/files/..%2f..%2f.spm%2fapp.db/raw',
  'spm://app/_spm/files/..%5c..%5c.spm%5capp.db/raw',
  'spm://app/_spm/files/%2e%2e%2f%2e%2e%2f.spm%2fapp.db/raw',
  'spm://app/_spm/files/..%2f..%2f.spm%2fapp.db/thumb',
  'spm://app/_spm/files/%2e%2e%2f%2e%2e%2f.spm%2fapp.db/thumb',
  // No library folder is named at all; the id is the only input, and it is not a path.
  'spm://app/_spm/files/no-such-file/raw',
  'spm://app/_spm/files/no-such-file/thumb',
]

/**
 * The one thing the shared block above cannot show: what happens with no library open.
 *
 * Its own launch, with `SPM_LIBRARY_DIR` unset, because every other test in this file needs one.
 * Task 4 makes this state reachable with a page already loaded — a folder picker that has not
 * been used yet, and a switch between folders — so the answer matters before then.
 */
test('a file request with no library open is a plain 404', async () => {
  const app = await launchWithoutLibrary()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // The renderer still boots — the shell answers `capabilities` out of itself — so the fetch
    // below really is going through the loaded document and not into a dead window.
    await expect(page.locator('app-root .spm-brand')).toBeVisible()

    const answers = await page.evaluate(async () => {
      const out: Record<string, string> = {}
      for (const kind of ['raw', 'thumb']) {
        const response = await fetch(`spm://app/_spm/files/anything/${kind}`)
        out[kind] = `${response.status} ${await response.text()}`
      }
      return out
    })
    expect(answers).toEqual({ raw: '404 not found', thumb: '404 not found' })
  } finally {
    await app.close()
  }
})
