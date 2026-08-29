import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FileDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import {
  closeLibrary,
  createProject,
  ensureLocalUser,
  getProject,
  openLibrary,
  resolveFilePath,
  type Ctx,
  type Library,
} from '@spm/core'
import {
  BrowseDownloads,
  DOWNLOAD_RECORD_NAME,
  type BrowseDownloadItem,
  type BrowseDownloadRecord,
} from '../src/browse/downloads.ts'
import { BrowseLanding } from '../src/browse/land.ts'
import { BrowseNotices } from '../src/browse/notices.ts'
import type { DesktopSession } from '../src/library.ts'
import { RemoteHost } from '../src/remote.ts'
import { FILE_URL_BASE } from '../src/urls.ts'

/**
 * Landing a staged download into a project, in both modes, under plain `node --test`.
 *
 * **`BrowseDownloads` is the real class here and not a double**, which is the one design decision in
 * this file worth defending. `land`'s whole job is to obey a verdict somebody else reached: a double
 * of `find()` would be this suite's own opinion of when a download is landable, so every refusal
 * below would be asserting that the test double refuses — the shape of useless test this subsystem
 * has shipped before. So the staging directories are real, the bytes in them are real, the record is
 * read off disk by the code that reads records, and the verdict is the one the sweep computes.
 *
 * The library is real too, and so is `RemoteHost` — only its `fetch` is injected. What that buys is
 * that "the bytes in the project folder are byte-identical to the staged bytes" is a statement about
 * two files on a disk, and that the `content-length` assertion is made on the header a real
 * `RemoteHost` produced from `remoteUpload`'s `x-spm-content-length`.
 *
 * **Every refusal has an accept case beside it.** A `land` that refused everything would pass every
 * refusal test in this file, which is the second shape this project keeps meeting.
 */

let root: string
let lib: Library
let ctx: Ctx
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-browse-land-'))
  const libDir = join(root, 'library')
  mkdirSync(libDir, { recursive: true })
  lib = openLibrary(libDir)
  ctx = ensureLocalUser(lib)
})

after(() => {
  closeLibrary(lib)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/* -------------------------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------------------------- */

type Rig = {
  downloads: BrowseDownloads
  landing: BrowseLanding
  stagingDir: string
  /** Every request the injected `fetch` saw, in order. Empty in local mode. */
  outgoing: { url: string; init: RequestInit | undefined; body: Uint8Array | null }[]
  /** How many of those were an upload. The number the refusal tests assert is zero. */
  uploads(): number
}

/**
 * A landing over a real staging directory, in one mode or the other.
 *
 * In remote mode the server is a `RemoteHost` whose `fetch` records and answers; `answer` lets a
 * test make the upload fail. In local mode the same object is built with `isRemote: false` and a
 * session pointing at the one real library, so both arms are the same rig with one flag moved.
 */
function rig(options: { isRemote?: boolean; answer?: (url: string) => Response } = {}): Rig {
  seq += 1
  const stagingDir = join(root, `case-${seq}`, 'model-downloads')
  const outgoing: { url: string; init: RequestInit | undefined; body: Uint8Array | null }[] = []
  const isRemote = options.isRemote ?? false
  const remote = new RemoteHost('https://library.invalid', async (url, init) => {
    // **Drained here, which is what a transport does.** The body is a `createReadStream` wrapped to
    // the web, so it opens the file lazily: a recorder that only kept the stream would be holding a
    // handle on a directory `land` removes as soon as it returns, and the assertion that the right
    // bytes went would read an `ENOENT` instead. Draining in the fetch is also the only place the
    // bytes exist as one value, because `RemoteHost` hands the stream straight through.
    const body =
      init?.body === undefined || init.body === null
        ? null
        : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
    outgoing.push({ url, init, body })
    return (
      options.answer?.(url) ??
      new Response(
        JSON.stringify({
          id: 'remote-file-1',
          name: 'benchy.zip',
          kind: 'other',
          sizeBytes: 0,
          previewState: 'pending',
          rawUrl: '/api/files/remote-file-1/raw',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    )
  })
  const downloads = new BrowseDownloads({
    stagingDir,
    notices: new BrowseNotices({ notify: () => {} }),
    session: () => ({ lib, ctx }) as DesktopSession,
    isRemote: () => isRemote,
    remote: () => (isRemote ? remote : null),
    isViewAttached: () => true,
    now: () => 1_700_000_000_000,
    mintId: () => `dl-${seq}`,
  })
  const landing = new BrowseLanding({
    downloads,
    session: () => ({ lib, ctx }) as DesktopSession,
    isRemote: () => isRemote,
    remote: () => (isRemote ? remote : null),
  })
  return {
    downloads,
    landing,
    stagingDir,
    outgoing,
    uploads: () => outgoing.filter((call) => call.init?.method === 'POST').length,
  }
}

/** Builds a staging directory as a previous run of the app would have left it. */
function stage(
  stagingDir: string,
  downloadId: string,
  options: { record?: unknown; recordText?: string; fileName?: string; bytes?: Uint8Array } = {},
): string {
  const directory = join(stagingDir, downloadId)
  mkdirSync(directory, { recursive: true })
  if (options.fileName !== undefined && options.bytes !== undefined) {
    writeFileSync(join(directory, options.fileName), options.bytes)
  }
  if (options.recordText !== undefined) {
    writeFileSync(join(directory, DOWNLOAD_RECORD_NAME), options.recordText)
  } else if (options.record !== undefined) {
    writeFileSync(join(directory, DOWNLOAD_RECORD_NAME), JSON.stringify(options.record))
  }
  return directory
}

function completedRecord(overrides: Partial<BrowseDownloadRecord> = {}): BrowseDownloadRecord {
  return {
    downloadId: 'ignored',
    startedAt: 1_699_000_000_000,
    fileName: 'benchy.zip',
    sourceUrl: 'blob:https://www.thingiverse.com/ae5e',
    pageUrl: 'https://www.thingiverse.com/thing:1234',
    siteId: 'thingiverse',
    mimeType: 'application/zip',
    hadUserGesture: false,
    totalBytes: 2048,
    state: 'completed',
    receivedBytes: 2048,
    library: null,
    ...overrides,
  }
}

/** Recognisable bytes, so "byte-identical" is a comparison and not a length check. */
function archive(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + seed) % 251
  return bytes
}

function project(name: string): string {
  return createProject(lib, ctx, { name }).id
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the call to reject, and it resolved' })
}

/**
 * One download driven from `will-download` to `done`, as this process would watch it.
 *
 * The only way to produce the fifth verdict — a `totalBytes: 0` download that **is** landable —
 * because that relaxation rests on this process having observed the terminal transition. The bytes
 * are written at the save path the handler chose, which is what `done` measures against.
 */
function watched(rigged: Rig, fields: { fileName: string; bytes: Uint8Array }): string {
  const listeners = new Map<string, ((event: unknown, state: string) => void)[]>()
  let received = 0
  const item = {
    getFilename: () => fields.fileName,
    getURL: () => 'blob:https://www.thingiverse.com/ae5e',
    getMimeType: () => 'application/zip',
    // The measured no-`content-length` shape: nothing is known about the size up front.
    getTotalBytes: () => 0,
    getReceivedBytes: () => received,
    hasUserGesture: () => true,
    setSavePath: (path: string) => {
      writeFileSync(path, fields.bytes)
      received = fields.bytes.byteLength
    },
    on: (event: string, listener: (event: unknown, state: string) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    once: (event: string, listener: (event: unknown, state: string) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
  }
  rigged.downloads.handleWillDownload({ preventDefault: () => {} }, item as BrowseDownloadItem, {
    getURL: () => 'https://www.thingiverse.com/thing:1234',
  })
  for (const listener of listeners.get('done') ?? []) listener({}, 'completed')
  return `dl-${seq}`
}

/* -------------------------------------------------------------------------------------------
 * The refusal — constraint 14, and the assertion this whole subsystem is shaped around
 * ---------------------------------------------------------------------------------------- */

/**
 * **The one that matters most.** `land` refuses every record the sweep could not vouch for, and the
 * assertion is that **no upload was attempted** — not merely that something threw.
 *
 * The difference is the whole point. A `land` that streamed the file and then failed for some other
 * reason would satisfy "it threw"; what constraint 14 is about is that a truncated archive must not
 * reach the user's project, and the only way to say that is to count the uploads. Dropping the
 * `isVerifiable` check from `land` turns this red on all five, and the short-bytes case is the one
 * that then uploads clean: 2048 bytes of a file whose record says 4096, silently.
 *
 * The sixth directory is the control. Without it every assertion here is satisfied by a `land` that
 * refuses everything, which is a failure mode this project has shipped.
 */
test('land refuses all five unverifiable records without reading a byte, and lands the sixth', async () => {
  const rigged = rig({ isRemote: true })
  // 1. Bytes with no record at all.
  stage(rigged.stagingDir, 'no-record', { fileName: 'benchy.zip', bytes: archive(2048) })
  // 2. A record that cannot be parsed — the same verdict and the same sentence, because a record
  //    that cannot be read is a record that is not there.
  stage(rigged.stagingDir, 'unparseable', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    recordText: '{ this is not json',
  })
  // 3. A process that died mid-download: the record still says `progressing`.
  stage(rigged.stagingDir, 'progressing', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ state: 'progressing', receivedBytes: 2048 }),
  })
  // 4. The measured one, scaled down: a file at its final name, half the size it declared, with no
  //    marker of any kind. 26 214 400 of 41 943 040 bytes on Electron 44.
  stage(rigged.stagingDir, 'truncated', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 4096, receivedBytes: 4096 }),
  })
  // 5. A server that sent no length, found by a sweep: there is nothing to compare against, and an
  //    unknown is not a pass.
  stage(rigged.stagingDir, 'no-length', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 0, receivedBytes: 0 }),
  })
  // 6. The control: a record that does vouch for the bytes beside it.
  stage(rigged.stagingDir, 'landable', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  rigged.downloads.sweep()

  const expected: [string, RegExp][] = [
    ['no-record', /nothing beside these bytes/],
    ['unparseable', /nothing beside these bytes/],
    ['progressing', /ended as progressing/],
    ['truncated', /not the 4096 bytes it declared/],
    ['no-length', /declared no size/],
  ]
  for (const [downloadId, message] of expected) {
    const error = await rejection(rigged.landing.land(downloadId, 'p-1'))
    assert.equal(error.code, 'Conflict', downloadId)
    assert.match(error.message, message, downloadId)
    // Constraint 15: a refusal removes nothing. `discard` is the way out of one.
    assert.equal(existsSync(join(rigged.stagingDir, downloadId)), true, downloadId)
  }

  // **The assertion, and it is a count and not a boolean.** Nothing was posted at all: no stream was
  // opened, no length was declared, nothing reached the server.
  assert.equal(rigged.uploads(), 0, 'an unverifiable download reached the upload')

  // And the control lands, so none of the five above is passing because everything is refused.
  const landed = await rigged.landing.land('landable', 'p-1')
  assert.equal(landed.name, 'benchy.zip')
  assert.equal(rigged.uploads(), 1)
})

test('land answers NotFound for an id it never staged, and joins it onto nothing', async () => {
  const rigged = rig()
  stage(rigged.stagingDir, 'real-one', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  rigged.downloads.sweep()

  // A path, a traversal and an id that is simply not there all answer the same way, because they
  // are all the same thing to a map lookup — which is what `find` is, and the reason `land` can
  // take an id from the renderer at all. Nothing here reaches `safeJoin`, let alone a `stat`.
  for (const id of ['no-such-download', '../../../../etc/passwd', '/home/someone/.ssh/id_rsa']) {
    const error = await rejection(rigged.landing.land(id, 'p-1'))
    assert.equal(error.code, 'NotFound', id)
  }
  // The control again: the same rig lands the id it does know.
  assert.equal((await rigged.landing.land('real-one', project('Found'))).name, 'benchy.zip')
})

/* -------------------------------------------------------------------------------------------
 * Local mode
 * ---------------------------------------------------------------------------------------- */

test('a staged file lands as a new file, byte-identical, and the staging directory goes', async () => {
  const rigged = rig()
  const bytes = archive(9001, 7)
  const directory = stage(rigged.stagingDir, 'local-1', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()
  const projectId = project('Landing')

  const landed = await rigged.landing.land('local-1', projectId)

  assert.equal(landed.name, 'benchy.zip')
  assert.equal(landed.sizeBytes, bytes.byteLength)
  // Classified from the name by core, like any other upload: an archive is `other` (spec 5.5).
  assert.equal(landed.kind, 'other')

  // The bytes in the project folder, read back off the disk core wrote them to. A length comparison
  // would pass for a file of the right size full of zeroes.
  const resolved = resolveFilePath(lib, ctx, landed.id)
  assert.deepEqual(new Uint8Array(readFileSync(resolved.absPath)), bytes)

  // The file is in the project the caller named, and the staging directory is gone — but only
  // because the upload returned. The next test is the other half of that.
  const detail = getProject(lib, ctx, projectId)
  assert.deepEqual(
    detail.files.map((file) => file.name),
    ['benchy.zip'],
  )
  assert.equal(existsSync(directory), false, 'the staging directory outlived the upload')
  assert.equal(rigged.downloads.list().length, 0, 'the landed download is still listed')
})

test('a name clash is reported, and leaves the staging directory and the project alone', async () => {
  const rigged = rig()
  const bytes = archive(2048)
  const directory = stage(rigged.stagingDir, 'clash-1', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()
  const projectId = project('Clash')
  // The file the user already has, put there the ordinary way. This is the thing they were trying
  // to find out — see spec 5.4 on why nothing auto-suffixes it away.
  const first = await rigged.landing.land('clash-1', projectId)
  assert.equal(first.name, 'benchy.zip')

  // Stage the same download again and land it into the same project.
  stage(rigged.stagingDir, 'clash-2', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()

  const error = await rejection(rigged.landing.land('clash-2', projectId))
  assert.equal(error.code, 'Conflict')
  assert.match(error.message, /already exists/)
  // No second file, and no `benchy-1.zip` either.
  assert.deepEqual(
    getProject(lib, ctx, projectId).files.map((file) => file.name),
    ['benchy.zip'],
  )
  // **The failed upload leaves the download where it was**, so the user can rename and try again.
  assert.equal(existsSync(join(rigged.stagingDir, 'clash-2')), true)
  assert.equal(
    rigged.downloads
      .list()
      .map((download) => download.downloadId)
      .join(),
    'clash-2',
    'a failed landing discarded the download',
  )
  assert.equal(existsSync(directory), false)

  // And renaming is the way out, which is what makes reporting the clash a usable answer.
  const renamed = await rigged.landing.land('clash-2', projectId, { name: 'benchy (2).zip' })
  assert.equal(renamed.name, 'benchy (2).zip')
})

test('the name is the record’s unless the caller gives one, and is a file name either way', async () => {
  const rigged = rig()
  const bytes = archive(1024)
  for (const id of ['named-1', 'named-2']) {
    stage(rigged.stagingDir, id, {
      fileName: 'benchy.zip',
      bytes,
      record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
    })
  }
  rigged.downloads.sweep()
  const projectId = project('Names')

  // Validated here as well as at the IPC boundary, because `land` is callable from the main process
  // without going through one — `app.ts` reaches it directly.
  for (const name of ['../escaped.zip', 'CON.zip', 'a/b.zip', '']) {
    const error = await rejection(rigged.landing.land('named-1', projectId, { name }))
    assert.equal(error.code, 'Validation', name)
    assert.equal(existsSync(join(rigged.stagingDir, 'named-1')), true, name)
  }
  assert.equal(getProject(lib, ctx, projectId).files.length, 0)

  assert.equal((await rigged.landing.land('named-1', projectId)).name, 'benchy.zip')
  assert.equal(
    (await rigged.landing.land('named-2', projectId, { name: 'clip.zip' })).name,
    'clip.zip',
  )
})

test('a staged file that has gone since the verdict is a NotFound, not a shorter upload', async () => {
  const rigged = rig()
  const bytes = archive(4096)
  stage(rigged.stagingDir, 'vanished', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()
  const projectId = project('Vanished')
  // The verdict was reached at the sweep; the user emptied the directory afterwards. That is an
  // ordinary thing to have done and the UI has to be able to say a sentence about it — without it,
  // this is an `ENOENT` normalised to `Internal`.
  rmSync(join(rigged.stagingDir, 'vanished', 'benchy.zip'), { force: true })

  const error = await rejection(rigged.landing.land('vanished', projectId))

  assert.equal(error.code, 'NotFound')
  assert.equal(getProject(lib, ctx, projectId).files.length, 0)
})

test('local mode with no library open refuses rather than dereferencing a null session', async () => {
  const rigged = rig()
  stage(rigged.stagingDir, 'no-lib', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  rigged.downloads.sweep()
  // Not the rig's landing: this is the one accessor that can answer null, and `browse.land` is a
  // `shellCall`, so nothing above it refuses a null session on this route's behalf.
  const landing = new BrowseLanding({
    downloads: rigged.downloads,
    session: () => null,
    isRemote: () => false,
    remote: () => null,
  })

  const error = await rejection(landing.land('no-lib', 'p-1'))

  assert.equal(error.code, 'Conflict')
  assert.match(error.message, /no library folder is open/)
  assert.equal(existsSync(join(rigged.stagingDir, 'no-lib')), true)
})

/* -------------------------------------------------------------------------------------------
 * Remote mode
 * ---------------------------------------------------------------------------------------- */

/**
 * The upload the server actually receives, through a real `RemoteHost`.
 *
 * **The size is asserted against the file on disk and never against the record**, and the download
 * this runs on is the case that makes the difference visible: a watched download whose server sent
 * no `content-length`, so its `totalBytes` is `0`. Passing `record.totalBytes` here would declare
 * `content-length: 0` for a 3 KiB archive — the server's quota check would wave it through and the
 * body would be truncated or rejected — and this assertion is what turns that red.
 *
 * `content-length` and not `x-spm-content-length`: `RemoteHost.#send` is what turns the second into
 * the first, because a plain `content-length` on a `Request` is a forbidden header name and is
 * dropped before the proxy ever sees it. Asserting the header the *server* would see is the only
 * version of this assertion worth making.
 */
test('a remote landing posts to the project with the real size on disk and the encoded name', async () => {
  const rigged = rig({ isRemote: true })
  const bytes = archive(3072, 3)
  const downloadId = watched(rigged, { fileName: 'benchy (v2).zip', bytes })
  const staged = rigged.downloads.find(downloadId)
  assert.equal(staged?.isVerifiable, true, 'the watched download was not landable to begin with')
  assert.equal(staged?.record.totalBytes, 0, 'the no-content-length case is what this test needs')

  const landed = await rigged.landing.land(downloadId, 'p-7')

  assert.equal(landed.id, 'remote-file-1')
  const upload = rigged.outgoing.find((call) => call.init?.method === 'POST')
  assert.ok(upload, 'nothing was posted')
  assert.equal(upload.url, 'https://library.invalid/api/projects/p-7/files')
  const headers = new Headers(upload.init?.headers)
  assert.equal(headers.get('content-length'), String(bytes.byteLength))
  // Percent-encoded, because a header value is Latin-1 by the HTTP grammar and a file name is not.
  assert.equal(headers.get('x-spm-file-name'), 'benchy%20(v2).zip')
  // Core's own `contentTypeFor`, which has no entry for `.zip` and says so honestly rather than
  // guessing. The server takes the name from the header above, not from this.
  assert.equal(headers.get('content-type'), 'application/octet-stream')
  // The staging directory goes once the upload has returned, in this mode too.
  assert.equal(existsSync(join(rigged.stagingDir, downloadId)), false)
})

test('a remote landing keeps the staging directory when the server refuses', async () => {
  const rigged = rig({
    isRemote: true,
    answer: () =>
      new Response(JSON.stringify({ error: { code: 'QuotaExceeded', message: 'no room' } }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
  })
  const bytes = archive(2048, 11)
  stage(rigged.stagingDir, 'remote-fail', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()

  const error = await rejection(rigged.landing.land('remote-fail', 'p-9'))

  // The server's own code survives the boundary (constraint 5) rather than becoming `Internal`.
  assert.equal(error.code, 'QuotaExceeded')
  assert.equal(error.message, 'no room')
  assert.equal(existsSync(join(rigged.stagingDir, 'remote-fail')), true)
  assert.equal(rigged.downloads.list().length, 1)
})

test('the bytes on the wire are the staged bytes, read off the request the proxy sent', async () => {
  const rigged = rig({ isRemote: true })
  const bytes = archive(5000, 5)
  stage(rigged.stagingDir, 'remote-bytes', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()

  await rigged.landing.land('remote-bytes', 'p-3')

  const upload = rigged.outgoing.find((call) => call.init?.method === 'POST')
  assert.ok(upload, 'nothing was posted')
  // The bytes the transport drained off the request, compared value by value. A declared length
  // that matched a body that did not is the one failure the header assertion cannot see, and a
  // length comparison here would pass for 5000 zeroes.
  assert.deepEqual(upload.body, bytes)
})

/* -------------------------------------------------------------------------------------------
 * The handover, asserted from this side
 * ---------------------------------------------------------------------------------------- */

test('find reports whether a record was read, which is what names the refusal', () => {
  const rigged = rig()
  stage(rigged.stagingDir, 'has-record', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  stage(rigged.stagingDir, 'no-record', { fileName: 'benchy.zip', bytes: archive(2048) })
  stage(rigged.stagingDir, 'bad-record', {
    fileName: 'benchy.zip',
    bytes: archive(2048),
    recordText: '{ not json',
  })
  rigged.downloads.sweep()

  assert.equal(rigged.downloads.find('has-record')?.hasRecord, true)
  // Both of these arrive with the stand-in `state: 'interrupted'` that `unrecordedDownload` fills
  // in, which is exactly why `land` may not read it: an unparseable record is not a download that
  // was interrupted, and saying so would be a sentence with no reading behind it.
  assert.equal(rigged.downloads.find('no-record')?.hasRecord, false)
  assert.equal(rigged.downloads.find('no-record')?.record.state, 'interrupted')
  assert.equal(rigged.downloads.find('bad-record')?.hasRecord, false)
})

/**
 * A `FileDto` and not a core row: the URLs the renderer follows are the decorator's.
 *
 * `FILE_URL_BASE` is imported rather than written out, so this asserts that the landing uses the
 * shell's own base — the reserved `spm://app/_spm` path, not the `/api` one the server serves on —
 * and not that somebody typed the same string twice.
 */
test('a local landing answers a decorated FileDto, with the spm:// url the renderer uses', async () => {
  const rigged = rig()
  const bytes = archive(2048)
  stage(rigged.stagingDir, 'decorated', {
    fileName: 'benchy.zip',
    bytes,
    record: completedRecord({ totalBytes: bytes.byteLength, receivedBytes: bytes.byteLength }),
  })
  rigged.downloads.sweep()

  const landed: FileDto = await rigged.landing.land('decorated', project('Decorated'))

  assert.equal(landed.rawUrl, `${FILE_URL_BASE}/files/${landed.id}/raw`)
})
