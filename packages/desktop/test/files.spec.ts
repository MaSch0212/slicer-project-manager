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

  test('an incoming Range is ignored, and the whole file comes back with a 200', async () => {
    // The other half of `accept-ranges: none`, and it has to live here rather than beside that
    // assertion in `files.test.ts`: `serveLibraryFile` takes a parsed id and no `Request`, so a
    // unit test has nowhere to put a header. Only a renderer can send one.
    //
    // Measured behaviour, now pinned: Chromium forwards the header, this handler ignores it, and
    // `fetch` neither synthesises a 206 nor slices the body — a caller that asked for six bytes
    // gets the file. A handler that grew partial-content support without saying so fails here.
    const cube = detail.files.find((file) => file.name === 'cube.stl')!
    expect(
      await page.evaluate(async (url) => {
        const response = await fetch(url, { headers: { Range: 'bytes=4-9' } })
        return {
          status: response.status,
          contentRange: response.headers.get('content-range'),
          length: (await response.arrayBuffer()).byteLength,
        }
      }, cube.rawUrl),
    ).toEqual({ status: 200, contentRange: null, length: CUBE.byteLength })
  })

  test('the document CSP still names no media-src, which is what makes no ranges safe', async () => {
    // `accept-ranges: none` is safe because nothing asks — and the one consumer that *would* ask,
    // a media element, cannot issue a request from the renderer at all. That rests on this
    // header, so the coupling is asserted rather than left in a comment: adding `media-src spm:`
    // to `CONTENT_SECURITY_POLICY` turns this line red, which is the point of it.
    //
    // Read off the served response rather than off the constant, because what protects the
    // document is the header that was actually sent.
    const csp = await page.evaluate(async () => {
      const response = await fetch('spm://app/')
      await response.body?.cancel()
      return response.headers.get('content-security-policy')
    })
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('media-src')
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
    // There was an `expect(MISSING_MESSAGE).not.toBe(FETCH_FAILED_MESSAGE)` here, and it is gone:
    // two string literals declared in this file cannot be made unequal by any production change,
    // so it was an assertion that could not fail. What catches the two sentences converging is
    // the line above matching the exact `en.json` copy against the rendered page, and
    // `messages: []` in the test before it.
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

/**
 * `viewer.missingFile`, straight out of `en.json`. Matched against the rendered page, so a change
 * to that copy fails here rather than silently matching less of it.
 *
 * There is no `FETCH_FAILED_MESSAGE` beside it any more, and the reason is worth the line: the
 * good case asserts `messages: []`, which excludes *every* message the viewer can render — the
 * fetch one, the parse one, the WebGL one — so naming a second string here bought nothing.
 */
const MISSING_MESSAGE =
  'This file is not part of this project any more. Go back to the project to see what it holds now.'

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

/**
 * The review's Important finding, measured and then pinned.
 *
 * File bytes are served into `spm://app` — the origin that holds `window.spm` — and the CSP is
 * attached on the renderer-asset branch alone, so an HTML document produced by the *file* branch
 * would execute with the IPC bridge and no policy at all. One user click reaches it:
 * `project-detail.page.ts` renders `<a [href]="file.rawUrl">{{ file.name }}</a>` for every file,
 * whatever it is.
 *
 * What was measured, before `nosniff` existed: `.html`, `.svg` and `.xhtml` all take core's
 * `application/octet-stream` fallback and Chromium **downloads** them rather than sniffing them
 * into markup. The navigation never commits, no script runs, and the app's own page is still
 * there afterwards. The one type that does render is `.txt`, as escaped text with the markup
 * visible — and that document reported `typeof window.spm === 'object'`, which is what makes the
 * hazard worth a header rather than a shrug.
 *
 * Its own launch: it writes three files into the library and drives the window through three
 * navigations, neither of which the shared block above should have to survive.
 */
test('a library file that looks like a web page downloads instead of becoming a document', async () => {
  const { app } = await launchApp([
    { name: 'Payloads', files: { 'real.stl': 'solid s endsolid s' } },
  ])
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => globalThis.spm.invoke('projects.rescan', []))

    const payload = '<!doctype html><title>PWNED</title><script>window.__pwned = true</script>'
    const uploaded = await page.evaluate(async (body: string) => {
      const listed = (await globalThis.spm.invoke('projects.list', [{}])) as {
        value: { id: string }[]
      }
      const projectId = listed.value[0]!.id
      const out: boolean[] = []
      for (const name of ['payload.html', 'payload.svg', 'payload.xhtml']) {
        const result = await globalThis.spm.invoke('files.upload', [
          projectId,
          name,
          { bytes: new TextEncoder().encode(body) },
        ])
        out.push(result.ok)
      }
      return out
    }, payload)
    expect(uploaded).toEqual([true, true, true])

    await app.evaluate(({ session }) => {
      const seen: string[] = []
      ;(globalThis as Record<string, unknown>)['__downloads'] = seen
      session.defaultSession.on('will-download', (_event, item) => {
        seen.push(`${item.getMimeType()} ${item.getFilename()}`)
        item.cancel()
      })
    })

    const files = (await page.evaluate(async () => {
      const listed = (await globalThis.spm.invoke('projects.list', [{}])) as {
        value: { id: string }[]
      }
      const detail = (await globalThis.spm.invoke('projects.get', [listed.value[0]!.id])) as {
        value: { files: { name: string; rawUrl: string }[] }
      }
      return detail.value.files
    })) as { name: string; rawUrl: string }[]

    const observed: Record<string, unknown> = {}
    for (const name of ['payload.html', 'payload.svg', 'payload.xhtml']) {
      const file = files.find((candidate) => candidate.name === name)!
      // The header the guarantee rests on, first.
      observed[`${name} headers`] = await page.evaluate(async (url: string) => {
        const response = await fetch(url)
        await response.body?.cancel()
        return `${response.headers.get('content-type')} / ${response.headers.get('x-content-type-options')}`
      }, file.rawUrl)
      // Then the navigation a user's click produces. Playwright reports a download as a failed
      // `goto`, which is already the answer; the assertions are on where the page ended up and on
      // what did not run, so it does not matter which way it is reported.
      await page.goto(file.rawUrl).catch(() => {})
      await page.waitForTimeout(400)
      observed[`${name} landed`] = await page.evaluate(() => ({
        origin: location.origin,
        pathname: location.pathname,
        executed: (globalThis as Record<string, unknown>)['__pwned'] ?? false,
      }))
      await page.goto('spm://app/projects')
    }

    // Still on the app's own page every time: the navigation became a download and the payload
    // never became a document. `executed` is the assertion that would go red if it ever did.
    const stayed = { origin: 'spm://app', pathname: '/projects', executed: false }
    expect(observed).toEqual({
      'payload.html headers': 'application/octet-stream / nosniff',
      'payload.svg headers': 'application/octet-stream / nosniff',
      'payload.xhtml headers': 'application/octet-stream / nosniff',
      'payload.html landed': stayed,
      'payload.svg landed': stayed,
      'payload.xhtml landed': stayed,
    })
    // And Chromium agreed each was a download rather than a page.
    expect(
      await app.evaluate(() => (globalThis as Record<string, unknown>)['__downloads']),
    ).toEqual([
      'application/octet-stream payload.html',
      'application/octet-stream payload.svg',
      'application/octet-stream payload.xhtml',
    ])
  } finally {
    await app.close()
  }
})

/**
 * The window stays on the renderer's origin, and the bridge does not travel.
 *
 * The measurement this exists for, taken with no policy in place: `location.href =
 * 'https://example.com/'` written from the renderer's own main world navigated the app's window
 * there, and the page that arrived reported `typeof window.spm === 'object'` with keys
 * `canStreamFromDisk,invoke`. `window.open` was worse — a second `BrowserWindow` at that origin,
 * also holding the bridge. A preload belongs to a webContents, not to a document, so it follows
 * the webContents wherever it goes.
 *
 * `example.com` and not a local stub, deliberately: a policy that only refuses unreachable hosts
 * refuses nothing. If the switch were removed and the runner had no network, the assertion below
 * would still fail — the URL would leave `spm://app` either way.
 *
 * `shell.openExternal` is replaced with a recorder rather than left to fire. The alternative is a
 * test that opens a browser tab on whoever runs it, and the thing worth asserting is the
 * decision, not that Windows can launch Edge.
 */
test('the renderer cannot navigate the window off its own origin, or open a second one', async () => {
  const { app } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.url()).toBe('spm://app/projects')

    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as Record<string, unknown>)['__external'] = opened
      // Patched on the module object the bundle holds a reference to, since `electron` is
      // external to it. Restored by the process exiting with the test.
      ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = (
        url: string,
      ) => {
        opened.push(url)
        return Promise.resolve()
      }
    })

    const attempts = [
      'https://example.com/',
      'http://example.com/',
      'file:///C:/Windows/win.ini',
      'data:text/html,<script>window.__pwned=true</script>',
    ]
    for (const url of attempts) {
      await page.evaluate((target: string) => {
        location.href = target
      }, url)
      await page.waitForTimeout(500)
    }
    // Every one of them refused: the document is still the app's, on its own origin, and the
    // bridge is still only reachable from there.
    expect(
      await page.evaluate(() => ({
        origin: location.origin,
        pathname: location.pathname,
        hasBridge: typeof globalThis.spm,
        pwned: (globalThis as Record<string, unknown>)['__pwned'] ?? false,
      })),
    ).toEqual({
      origin: 'spm://app',
      pathname: '/projects',
      hasBridge: 'object',
      pwned: false,
    })

    // `window.open` is the other hook, and it sees none of the traffic above. The project website
    // link is `target="_blank"`, which is exactly this path.
    //
    // `_self` is here because the two hooks split by target, not by API: measured, `_blank`
    // reaches `setWindowOpenHandler` alone and `_self` reaches `will-navigate` alone. A policy
    // wired to only one of them would let the other through, and `_self` is the arm an earlier
    // version of the comment in `app.ts` said could not happen.
    await page.evaluate(() => {
      window.open('https://example.com/', '_blank')
      window.open('file:///C:/Windows/win.ini', '_blank')
      window.open('https://example.com/self', '_self')
    })
    await page.waitForTimeout(1200)
    // Neither target moved the app off its own page.
    expect(await page.evaluate(() => location.href)).toBe('spm://app/projects')
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
      ),
    ).toEqual(['spm://app/projects'])

    // http(s) went to the user's browser; nothing else was handed to the OS at all. `file:` and
    // `data:` in that list would be vulnerabilities of their own, which is why the policy answers
    // three values rather than a boolean — and this list being non-empty is also what says the
    // `openExternal` patch above took, since an unpatched one would leave it `[]`.
    expect(await app.evaluate(() => (globalThis as Record<string, unknown>)['__external'])).toEqual(
      [
        // The four `location.href` attempts: only the two http(s) ones reach the OS.
        'https://example.com/',
        'http://example.com/',
        // `window.open(..., '_blank')` — the `file:` sibling is absent, as it must be.
        'https://example.com/',
        // `window.open(..., '_self')`, which arrives through `will-navigate` rather than the
        // window-open hook. Its presence here is the assertion that the other hook covers it.
        'https://example.com/self',
      ],
    )
  } finally {
    await app.close()
  }
})
