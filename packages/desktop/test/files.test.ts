import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { createDecorators } from '@spm/contract/decorate.ts'
import type { CoreFileDto } from '@spm/contract/dtos.ts'
import {
  closeLibrary,
  createProject,
  ensureLocalUser,
  openLibrary,
  uploadFile,
  SPM_DIR,
  type Ctx,
  type Library,
} from '@spm/core'
import { parseFileRequest, serveLibraryFile } from '../src/files.ts'
import { markPreviewReady } from './preview-fixture.ts'
import { navigationPolicy, FILE_URL_BASE, RESERVED_PATH_SEGMENT } from '../src/urls.ts'

/**
 * The file-bytes handler under plain Node, against a real library on disk.
 *
 * There is no Electron here on purpose — `files.ts` imports none — so everything except "does
 * Chromium actually paint it" is answerable in `deno task verify` rather than only in the
 * Playwright run. `files.spec.ts` covers the rest: pixels, a renderer-side `fetch`, and the two
 * messages the viewer shows.
 */

const STL = 'solid cube\nendsolid cube\n'

let dir: string
let lib: Library
let ctx: Ctx
let fileId: string
let projectId: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spm-files-'))
  lib = openLibrary(dir)
  ctx = ensureLocalUser(lib)
  projectId = createProject(lib, ctx, { name: 'Bytes' }).id
  fileId = (await put('cube.stl', STL)).id
})

after(() => {
  closeLibrary(lib)
  rmSync(dir, { recursive: true, force: true })
})

function put(name: string, contents: string | Uint8Array<ArrayBuffer>) {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
  return uploadFile(lib, ctx, projectId, name, {
    stream: new Blob([bytes]).stream(),
    sizeBytes: bytes.byteLength,
  })
}

function serve(pathname: string): Promise<Response> {
  const request = parseFileRequest(pathname)
  assert.ok(request, `expected ${pathname} to parse as a file request`)
  return serveLibraryFile(lib, ctx, request)
}

const under = (rest: string): string => `/${RESERVED_PATH_SEGMENT}/${rest}`

/* -------------------------------------------------------------------------------------------
 * parseFileRequest
 * ---------------------------------------------------------------------------------------- */

test('the URLs the decorators emit are exactly the URLs this parser accepts', () => {
  // The binding between two spellings of `/files/<id>/{raw,thumb}` — one in
  // `@spm/contract/decorate.ts`, one in `files.ts`. Neither can be derived from the other, so a
  // round trip is what keeps them from drifting; there is no shared constant to import.
  const core: CoreFileDto = {
    id: 'e5b9b8f2-0000-4000-8000-000000000001',
    name: 'cube.stl',
    kind: 'model',
    sizeBytes: 1,
    previewState: 'ready',
  }
  const decorated = createDecorators(FILE_URL_BASE).decorateFile(core)
  assert.ok(decorated.thumbUrl, 'a ready preview must claim a thumbUrl for this to prove anything')
  assert.deepEqual(parseFileRequest(new URL(decorated.rawUrl).pathname), {
    id: core.id,
    kind: 'raw',
  })
  assert.deepEqual(parseFileRequest(new URL(decorated.thumbUrl).pathname), {
    id: core.id,
    kind: 'thumb',
  })
})

test('nothing but the one canonical spelling is a file request', () => {
  // Everything here falls through to `resolveRendererFile`, which refuses the whole reserved
  // prefix — so `null` is "not mine", not "allowed". `shell.spec.ts` asserts the 404 these
  // actually produce over the real protocol; this only fixes where the boundary sits.
  const notFileRequests = [
    // Right shape, wrong prefix. The comparison is on the raw segment, so no encoding of `_spm`
    // reaches this parser, and neither does a case-folded or NTFS-aliased spelling of it.
    '/_SPM/files/abc/raw',
    '/%5f%73%70%6d/files/abc/raw',
    '/_spm./files/abc/raw',
    '/_spm%20/files/abc/raw',
    '/_spmx/files/abc/raw',
    '/x/..%2f_spm/files/abc/raw',
    '/x/..%5c_spm/files/abc/raw',
    // A NUL in the *prefix* rather than in the id: Win32 truncates at it, so `_spm%00` names the
    // reserved directory as surely as `_spm.` does. It is not the canonical spelling either way.
    '/_spm%00/files/abc/raw',
    '/_spm%00x/files/abc/raw',
    // Chromium does not collapse a double slash, so this stays six segments and never parses.
    '//_spm/files/abc/raw',
    // An encoded separator cannot invent a segment: this is four segments, not five.
    '/_spm%2ffiles/abc/raw',
    '/_spm/files%2fabc/raw',
    // Wrong middle segment, wrong verb, wrong depth.
    '/_spm/file/abc/raw',
    '/_spm/files/abc/RAW',
    '/_spm/files/abc/download',
    '/_spm/files/abc',
    '/_spm/files/abc/raw/extra',
    '/_spm/files//raw',
    '/_spm',
    '/',
    // Not decodable at all, and a NUL that Win32 path APIs would truncate at.
    '/_spm/files/%zz/raw',
    '/_spm/files/%00/raw',
    '/_spm/files/abc%00/raw',
  ]
  for (const pathname of notFileRequests) {
    assert.equal(parseFileRequest(pathname), null, pathname)
  }
})

test('a percent-encoded id is decoded, so a traversal reaches the lookup as a traversal', () => {
  // Not because anything should ever send one, but because the two spellings must land in the
  // same place: `WHERE f.id = ?` with a value that matches no row. Decoding here is what stops
  // `%2e%2e%2f` and `../` from being two different ids with two different answers.
  assert.deepEqual(parseFileRequest(under('files/%2e%2e%2f%2e%2e%2fapp.db/raw')), {
    id: '../../app.db',
    kind: 'raw',
  })
  assert.deepEqual(parseFileRequest(under('files/a%20b/thumb')), { id: 'a b', kind: 'thumb' })
})

/* -------------------------------------------------------------------------------------------
 * serveLibraryFile
 * ---------------------------------------------------------------------------------------- */

test('raw answers the exact bytes on disk, with the headers the server sends', async () => {
  const response = await serve(under(`files/${fileId}/raw`))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), STL)
  assert.equal(response.headers.get('content-type'), 'model/stl')
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(STL)))
  assert.equal(response.headers.get('content-disposition'), "inline; filename*=UTF-8''cube.stl")
  // Measured, not assumed — see the table in `app.ts`. Nothing the app can do sends a Range.
  assert.equal(response.headers.get('accept-ranges'), 'none')
})

test('nothing core can name a file resolves to a type Chromium would execute', async () => {
  /*
   * These bytes are served into `spm://app` — the origin that holds `window.spm` — and the CSP is
   * attached on the renderer-asset branch alone, so a document produced *here* would have the
   * bridge and no policy. Measured through a real navigation (see `files.spec.ts` and the header
   * comment in `files.ts`): today Chromium downloads all three of these rather than sniffing.
   *
   * What is actually holding that line is core's ten-entry content-type map happening to contain
   * nothing renderable as active content, and one line added to
   * `packages/core/src/files/usecases.ts` would change it silently. This is that line's alarm.
   * It is a list and not a proof — the same standing as every other normalisation list in this
   * subsystem — but it covers every extension a browser will execute.
   */
  for (const extension of ['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'js', 'mjs']) {
    const file = await put(`payload.${extension}`, '<script>alert(1)</script>')
    const response = await serve(under(`files/${file.id}/raw`))
    const type = response.headers.get('content-type')
    await response.body?.cancel()
    // The equality and nothing else. A first version also checked the value against a list of
    // active-content types, which could never be reached in a failing state — the equality is
    // strictly stronger, so the list was documentation wearing an assertion's clothes. Measured:
    // every extension in the list above takes the fallback today, so any entry added to core's
    // map turns this red, even a harmless-looking one. That is the intended sensitivity: the decision should be made
    // deliberately, here, rather than inherited.
    assert.equal(type, 'application/octet-stream', `.${extension}`)
  }
})

test('every file response carries nosniff, on both routes', async () => {
  // The guarantee behind the paragraph above: whatever the content type says, Chromium is
  // forbidden from deciding otherwise. `thumb` too — it is the one route that has to stay
  // `inline`, since an `<img>` is how it is consumed.
  const raw = await serve(under(`files/${fileId}/raw`))
  await raw.body?.cancel()
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')

  // Its own file, not the shared one: the test below asserts that file's thumb is a 404 until a
  // preview is ready, and marking it ready here would decide that test's outcome from up here.
  const withPreview = await put('has-preview.stl', STL)
  markPreviewReady(lib.db, dir, withPreview.id)
  const thumb = await serve(under(`files/${withPreview.id}/thumb`))
  await thumb.body?.cancel()
  assert.equal(thumb.headers.get('x-content-type-options'), 'nosniff')
})

test('a body larger than one stream chunk arrives whole and in order', async () => {
  // 3 MB, so the read is many chunks rather than one: a handler that answered only the first
  // chunk, or that closed the descriptor early, passes every assertion on the 25-byte file above.
  const big = new Uint8Array(3 * 1024 * 1024)
  for (let i = 0; i < big.length; i++) big[i] = i % 251
  const file = await put('big.bin', big)

  const response = await serve(under(`files/${file.id}/raw`))
  const got = new Uint8Array(await response.arrayBuffer())
  assert.equal(got.byteLength, big.byteLength)
  // Not `deepEqual` over three megabytes: the failure output is unreadable and the check is the
  // same one. Both ends and four sampled offsets catch truncation, duplication and reordering.
  assert.deepEqual([...got.subarray(0, 8)], [...big.subarray(0, 8)])
  assert.deepEqual([...got.subarray(-8)], [...big.subarray(-8)])
  for (const at of [1, 999_999, 1_048_576, 2_500_000]) assert.equal(got[at], big[at], `at ${at}`)
})

test('thumb answers the preview PNG, and 404s until one is ready', async () => {
  const pending = await serve(under(`files/${fileId}/thumb`))
  assert.equal(pending.status, 404)
  assert.equal(await pending.text(), 'not found')

  const png = markPreviewReady(lib.db, dir, fileId)
  const response = await serve(under(`files/${fileId}/thumb`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'private, max-age=60')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png)
})

test('an id that names nothing is a 404, however it is spelled', async () => {
  // The containment test the brief asks for, and the point is *where* it is enforced: not one of
  // these builds a path. `requireOwnedFile` binds the id into `WHERE f.id = ?`, and a value that
  // is not an id selects no row — so the escape never reaches a path join at all.
  const escapes = [
    'no-such-id',
    '../../app.db',
    '..\\..\\app.db',
    `../${SPM_DIR}/app.db`,
    '/etc/passwd',
    'C:\\Windows\\win.ini',
  ]
  for (const id of escapes) {
    for (const kind of ['raw', 'thumb'] as const) {
      const response = await serveLibraryFile(lib, ctx, { id, kind })
      assert.equal(response.status, 404, `${kind} ${id}`)
      assert.equal(await response.text(), 'not found', `${kind} ${id}`)
    }
  }
})

test('a row whose bytes are gone is a 404, not a 200 with a torn body', async () => {
  // `createReadStream` over a missing path fails *after* a 200 has already gone out, which the
  // renderer sees as a truncated model rather than as a missing one. Opening first is what makes
  // this answerable — and rescan really does leave rows whose bytes are gone.
  const file = await put('vanishes.stl', STL)
  rmSync(join(dir, 'Bytes', 'vanishes.stl'))
  const response = await serve(under(`files/${file.id}/raw`))
  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'not found')
})

test('a file owned by someone else is a 404, and not a 403', async () => {
  // Local mode has one user, but `requireOwnedFile`'s join is the whole of this handler's
  // authorisation, so a suite that never exercises it proves nothing about it. 404 and not 403
  // is core's answer and the server's, and it is the right one: a 403 would confirm the id.
  const stranger: Ctx = { userId: 'someone-else', isAdmin: false }
  for (const kind of ['raw', 'thumb'] as const) {
    const response = await serveLibraryFile(lib, stranger, { id: fileId, kind })
    assert.equal(response.status, 404, kind)
  }
})

test('core refusing a path escape comes back as a 403, not as a crash', async () => {
  // `safeJoin` is the containment boundary for the path core builds out of the row, and it
  // throws `Forbidden`. The only way to reach it is a poisoned `rel_path`, which nothing writes
  // — so this writes one, because an error mapping with no test is a 500 waiting to happen.
  const file = await put('poison.stl', STL)
  const outside = resolve(dir, '..', 'spm-files-outside.stl')
  writeFileSync(outside, 'OUTSIDE')
  try {
    lib.db.prepare('UPDATE files SET rel_path = ? WHERE id = ?').run('../..', file.id)
    const response = await serveLibraryFile(lib, ctx, { id: file.id, kind: 'raw' })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'forbidden')
  } finally {
    rmSync(outside, { force: true })
    lib.db.prepare('DELETE FROM files WHERE id = ?').run(file.id)
  }
})

/* -------------------------------------------------------------------------------------------
 * navigationPolicy
 * ---------------------------------------------------------------------------------------- */

test('navigationPolicy allows the renderer origin, externalises http(s), blocks the rest', () => {
  /*
   * The exhaustive half of the review's Important finding. The GUI half is in `files.spec.ts`;
   * this is where the schemes get enumerated, because each one costs nothing here and two
   * seconds of Electron there.
   *
   * The measurement that made this necessary: with no policy at all, a `location.href` written
   * from the renderer's own main world took the app's window to `https://example.com/`, and the
   * page that arrived reported `typeof window.spm === 'object'` with `canStreamFromDisk,invoke`.
   */
  for (const url of [
    'spm://app/',
    'spm://app/projects',
    `${FILE_URL_BASE}/files/abc/raw`,
    'spm://app/_spm/files/abc/thumb',
    'spm://app/index.html?x=1#y',
    // Chromium canonicalises a standard scheme's host, so this really is the same origin.
    'spm://APP/projects',
  ]) {
    assert.equal(navigationPolicy(url), 'allow', url)
  }

  for (const url of ['http://example.com/', 'https://example.com/a?b#c', 'HTTPS://EXAMPLE.COM/']) {
    assert.equal(navigationPolicy(url), 'external', url)
  }

  for (const url of [
    // A different host under the same scheme is a different origin, whatever it is named.
    'spm://file/abc/raw',
    'spm://evil/',
    'spm://app.evil.com/',
    'file:///C:/Windows/win.ini',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'blob:spm://app/1234',
    'ws://example.com/',
    'about:blank',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'mailto:someone@example.com',
    // Not a URL at all. `new URL` throws, and the answer to that is not "allow".
    'not a url',
    '',
    '//example.com/',
  ]) {
    assert.equal(navigationPolicy(url), 'block', url)
  }
})
