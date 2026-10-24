import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AppError } from '@spm/contract/errors.ts'
import type { BrowseDownloadDto } from '@spm/contract/dtos.ts'
import { NODE_IO, type JsonStoreIo } from '../src/json-store.ts'
import {
  BrowseDownloads,
  DOWNLOAD_RECORD_NAME,
  FALLBACK_DOWNLOAD_NAME,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_DOWNLOAD_BYTES,
  MAX_RECORDED_TEXT,
  MAX_STAGED_BYTES,
  stagedFileName,
  type BrowseDownloadItem,
  type BrowseDownloadRecord,
} from '../src/browse/downloads.ts'
import { BrowseNotices, type BrowseNotice } from '../src/browse/notices.ts'
import type { DesktopSession } from '../src/library.ts'

/**
 * Download interception, the staging record and the sweep, under plain `node --test`.
 *
 * **What the double below is, and what it deliberately is not.** `FakeItem` *records the calls this
 * module makes* — `setSavePath`, the listeners registered — and models **none** of Electron's
 * behaviour: it does not write bytes, it does not decide when `done` fires, and it does not know
 * what `preventDefault()` costs. A double that modelled those would be testing what its author
 * believed Electron does, which is the shape of useless test this subsystem is most exposed to.
 * Every property that is Electron's own — that `will-download` fires at all, that `setSavePath`
 * redirects the bytes, that a `blob:` download reaches the handler — is asserted against a real
 * Electron window in `browse.spec.ts` and is asserted nowhere else.
 *
 * The bytes on disk are written by the *tests*, at the size each case is about, because that is the
 * one fact the sweep reads and the whole point of the four refusals.
 */

/* -------------------------------------------------------------------------------------------
 * The recording doubles
 * ---------------------------------------------------------------------------------------- */

type Listener = (event: unknown, state: string) => void

type ItemFields = {
  filename: string
  url: string
  mimeType: string
  totalBytes: number
  userGesture: boolean
}

class FakeItem {
  readonly savePaths: string[] = []
  readonly listeners = new Map<string, Listener[]>()
  readonly fields: ItemFields
  received = 0

  constructor(fields: ItemFields) {
    this.fields = fields
  }

  getFilename(): string {
    return this.fields.filename
  }
  getURL(): string {
    return this.fields.url
  }
  getMimeType(): string {
    return this.fields.mimeType
  }
  getTotalBytes(): number {
    return this.fields.totalBytes
  }
  getReceivedBytes(): number {
    return this.received
  }
  hasUserGesture(): boolean {
    return this.fields.userGesture
  }
  setSavePath(path: string): void {
    this.savePaths.push(path)
  }
  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }
  once(event: string, listener: Listener): this {
    return this.on(event, listener)
  }

  /** Drives one of the listeners this module registered. */
  fire(event: string, state: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener({}, state)
  }
}

/** The `will-download` event, which carries exactly one thing this module uses. */
class FakeTrigger {
  prevented = 0
  preventDefault(): void {
    this.prevented += 1
  }
}

/** The session `attachTo` registers on. It records the registration; it raises nothing itself. */
class FakeSession {
  readonly listeners: string[] = []
  on(event: string, _listener: (...args: never[]) => void): this {
    this.listeners.push(event)
    return this
  }
}

/* -------------------------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------------------------- */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-browse-dl-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const GIB = 1024 * 1024 * 1024

type Rig = {
  downloads: BrowseDownloads
  stagingDir: string
  libraryDir: string
  notices: BrowseNotice[]
  attached: { value: boolean }
  clock: { at: number }
  ids: string[]
}

function rig(options: { io?: JsonStoreIo; isRemote?: boolean } = {}): Rig {
  seq += 1
  const stagingDir = join(root, `case-${seq}`, 'model-downloads')
  const libraryDir = join(root, `case-${seq}`, 'library')
  mkdirSync(libraryDir, { recursive: true })
  const notices: BrowseNotice[] = []
  const attached = { value: true }
  const clock = { at: 1_700_000_000_000 }
  const ids: string[] = []
  let minted = 0
  const downloads = new BrowseDownloads({
    stagingDir,
    notices: new BrowseNotices({ notify: (notice) => notices.push(notice) }),
    session: () => ({ lib: { dir: libraryDir }, ctx: {} }) as unknown as DesktopSession,
    isRemote: () => options.isRemote ?? false,
    remote: () => (options.isRemote ? { origin: 'https://models.invalid' } : null),
    isViewAttached: () => attached.value,
    now: () => clock.at,
    mintId: () => {
      minted += 1
      const id = `dl-${seq}-${minted}`
      ids.push(id)
      return id
    },
    io: options.io,
  })
  return { downloads, stagingDir, libraryDir, notices, attached, clock, ids }
}

/** One `will-download`, exactly as the session raises it. Answers what the handler did. */
function start(
  rigged: Rig,
  fields: Partial<ItemFields> = {},
  pageUrl: string | null = 'https://www.thingiverse.com/thing:1234',
): { item: FakeItem; trigger: FakeTrigger } {
  const item = new FakeItem({
    filename: 'benchy.zip',
    url: 'https://cdn.invalid/benchy.zip',
    mimeType: 'application/zip',
    totalBytes: 1024,
    userGesture: true,
    ...fields,
  })
  const trigger = new FakeTrigger()
  rigged.downloads.handleWillDownload(
    trigger,
    item as unknown as BrowseDownloadItem,
    pageUrl === null ? null : { getURL: () => pageUrl },
  )
  return { item, trigger }
}

/** The record on disk, parsed. Throws when there is none, which is what the caller wants to know. */
function recordOf(stagingDir: string, downloadId: string): BrowseDownloadRecord {
  return JSON.parse(
    readFileSync(join(stagingDir, downloadId, DOWNLOAD_RECORD_NAME), 'utf8'),
  ) as BrowseDownloadRecord
}

/** Builds a staging directory as a previous run of the app would have left it. */
function stage(
  stagingDir: string,
  downloadId: string,
  options: { record?: unknown; recordText?: string; fileName?: string; bytes?: number } = {},
): void {
  const directory = join(stagingDir, downloadId)
  mkdirSync(directory, { recursive: true })
  if (options.fileName !== undefined && options.bytes !== undefined) {
    writeFileSync(join(directory, options.fileName), Buffer.alloc(options.bytes, 7))
  }
  if (options.recordText !== undefined) {
    writeFileSync(join(directory, DOWNLOAD_RECORD_NAME), options.recordText)
  } else if (options.record !== undefined) {
    writeFileSync(join(directory, DOWNLOAD_RECORD_NAME), JSON.stringify(options.record))
  }
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

/** The most recent notice, asserted to exist rather than cast into existence. */
function lastNotice(rigged: Rig): BrowseNotice {
  const notice = rigged.notices[rigged.notices.length - 1]
  assert.ok(notice, 'expected a notice, and there was none')
  return notice
}

function only(list: BrowseDownloadDto[]): BrowseDownloadDto {
  assert.equal(list.length, 1, `expected exactly one staged download, got ${list.length}`)
  return list[0] as BrowseDownloadDto
}

function rejects(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, and it returned' })
}

/* -------------------------------------------------------------------------------------------
 * The sweep — the four refusals, the fifth, and the one that passes
 * ---------------------------------------------------------------------------------------- */

test('a staged directory with bytes and no download.json cannot be vouched for', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-a', { fileName: 'benchy.zip', bytes: 4096 })

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.isVerifiable, false)
  assert.equal(found.isOrphan, true)
  // Listed, and named by the bytes that are actually there — the user has to be able to see the
  // thing they are being asked to decide about.
  assert.equal(found.fileName, 'benchy.zip')
  assert.equal(found.downloadId, 'orphan-a')
})

test('a leftover record temp file is not the download the user is shown', () => {
  const { downloads, stagingDir } = rig()
  // `json-store.ts` writes `download.json.<pid>.tmp` and renames it, and says in as many words
  // that a kill or a failed rename leaves one behind and that nothing sweeps them — the "stubborn
  // io" test in this file produces one. It is bigger than the download here on purpose: skipping
  // only the final name makes the *temp file* the name shown for a record-less directory.
  stage(stagingDir, 'orphan-tmp', { fileName: 'benchy.zip', bytes: 2048 })
  writeFileSync(
    join(stagingDir, 'orphan-tmp', `${DOWNLOAD_RECORD_NAME}.4242.tmp`),
    Buffer.alloc(8192, 7),
  )

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.fileName, 'benchy.zip')
  assert.equal(found.receivedBytes, 2048)
  // The verdict was never in doubt — a directory with no record cannot be vouched for either way.
  // This is about the sentence the user reads before deciding.
  assert.equal(found.isVerifiable, false)
})

test('an unparseable download.json cannot be vouched for', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-b', {
    fileName: 'benchy.zip',
    bytes: 2048,
    recordText: '{"downloadId": "orphan-b", "state": "comp',
  })

  downloads.sweep()

  assert.equal(only(downloads.list()).isVerifiable, false)
})

test('a record that never reached a terminal state cannot be vouched for', () => {
  const { downloads, stagingDir } = rig()
  // The shape a kill mid-download leaves: the record says `progressing` because nothing was alive
  // to rewrite it, and the bytes beside it are however far Chromium had got.
  stage(stagingDir, 'orphan-c', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ state: 'progressing', receivedBytes: 2048, totalBytes: 4096 }),
  })

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.isVerifiable, false)
  assert.equal(found.state, 'progressing')
})

test('a record still saying progressing is refused even when its bytes add up', () => {
  const { downloads, stagingDir } = rig()
  // **The case that isolates the state rule from the size rule**, and it is not hypothetical: the
  // record is written before `setSavePath` and rewritten only on `done`, so a process killed in
  // between leaves `progressing` on disk next to bytes that may or may not be all of them. The
  // size agreeing proves nothing here — `totalBytes` is what the *server* announced, and a
  // truncated file whose server lied, or a resumed download, reaches the same arithmetic. Without
  // this case, deleting the `state !== 'completed'` arm entirely leaves the whole file green.
  stage(stagingDir, 'orphan-c2', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ state: 'progressing', receivedBytes: 2048, totalBytes: 2048 }),
  })

  downloads.sweep()

  assert.equal(only(downloads.list()).isVerifiable, false)
})

test('a completed record whose bytes are short cannot be vouched for', () => {
  const { downloads, stagingDir } = rig()
  // **The case the record exists for.** 26 214 400 of 41 943 040 bytes was the measurement; the
  // shape is the same at 2048 of 4096. With `setSavePath()` in use Chromium writes straight to the
  // final path — no `.crdownload`, no partial suffix, no sidecar — so this file is byte-for-byte
  // indistinguishable from a complete download of a 2 KiB file. A sweep that trusted the directory
  // listing offers it, and `land` uploads a truncated archive into the user's project silently.
  stage(stagingDir, 'orphan-d', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 4096, receivedBytes: 4096 }),
  })

  downloads.sweep()

  assert.equal(only(downloads.list()).isVerifiable, false)
})

test('a completed record with totalBytes 0 cannot be vouched for, because an unknown is not a pass', () => {
  const { downloads, stagingDir } = rig()
  // A server that sent no `content-length`. The size cannot be checked at all, and nothing else
  // can check it either: `getETag()` and `getLastModifiedTime()` were empty on every download
  // measured, so `totalBytes` is the only integrity signal there is.
  stage(stagingDir, 'orphan-e', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 0, receivedBytes: 2048 }),
  })

  downloads.sweep()

  assert.equal(only(downloads.list()).isVerifiable, false)
})

test('a completed record whose bytes agree is an ordinary staged download from a previous run', () => {
  const { downloads, stagingDir } = rig()
  // The other side of the boundary, and the reason the five above are not satisfied by a sweep
  // that refuses everything it finds.
  stage(stagingDir, 'orphan-f', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.isVerifiable, true)
  assert.equal(found.isOrphan, true)
  assert.equal(found.state, 'completed')
  assert.equal(found.siteId, 'thingiverse')
  assert.equal(found.pageUrl, 'https://www.thingiverse.com/thing:1234')
  assert.equal(found.sourceUrl, 'blob:https://www.thingiverse.com/ae5e')
})

test('the sweep surfaces and never deletes', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-g', { fileName: 'benchy.zip', bytes: 2048 })
  stage(stagingDir, 'orphan-h', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })

  downloads.sweep()

  // Both halves, because either alone can pass for the wrong reason: a sweep that deleted the
  // directories could still list them from memory, and a sweep that listed nothing would leave the
  // directories exactly where they are.
  assert.deepEqual(readdirSync(stagingDir).sort(), ['orphan-g', 'orphan-h'])
  assert.deepEqual(
    downloads
      .list()
      .map((download) => download.downloadId)
      .sort(),
    ['orphan-g', 'orphan-h'],
  )
  assert.ok(existsSync(join(stagingDir, 'orphan-g', 'benchy.zip')))
})

test('a staging directory that is not there yet is a first run, not a failure', () => {
  const { downloads } = rig()
  downloads.sweep()
  assert.deepEqual(downloads.list(), [])
})

/* -------------------------------------------------------------------------------------------
 * Discard — the only thing that removes a directory
 * ---------------------------------------------------------------------------------------- */

test('discard is the only thing that removes a staged directory', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-i', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  downloads.sweep()
  assert.ok(existsSync(join(stagingDir, 'orphan-i')))

  downloads.discard('orphan-i')

  assert.equal(existsSync(join(stagingDir, 'orphan-i')), false)
  assert.deepEqual(downloads.list(), [])
})

test('an unverifiable download can still be discarded, because that is the way out', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-j', { fileName: 'benchy.zip', bytes: 2048 })
  downloads.sweep()

  downloads.discard('orphan-j')

  assert.equal(existsSync(join(stagingDir, 'orphan-j')), false)
})

test('discard refuses an id it did not enumerate or mint', () => {
  const { downloads } = rig()
  downloads.sweep()
  assert.equal(rejects(() => downloads.discard('../../etc')).code, 'NotFound')
  assert.equal(rejects(() => downloads.discard('nothing-here')).code, 'NotFound')
})

test('discard refuses a download this process is still writing', () => {
  const rigged = rig()
  const { item } = start(rigged)
  const id = rigged.ids[0] as string

  const error = rejects(() => rigged.downloads.discard(id))
  assert.equal(error.code, 'Conflict')
  // Still there, which is the point: removing the directory under a live `DownloadItem` would not
  // stop Chromium writing to the path, and the terminal rewrite would put the record back.
  assert.ok(existsSync(join(rigged.stagingDir, id)))

  item.fire('done', 'completed')
  rigged.downloads.discard(id)
  assert.equal(existsSync(join(rigged.stagingDir, id)), false)
})

/* -------------------------------------------------------------------------------------------
 * Staging: the record, and when it is written
 * ---------------------------------------------------------------------------------------- */

test('the record is on disk saying progressing before setSavePath returns', () => {
  const rigged = rig()
  const recordsAtSetSavePath: (BrowseDownloadRecord | null)[] = []
  const item = new FakeItem({
    filename: 'benchy.zip',
    url: 'blob:https://www.thingiverse.com/ae5e',
    mimeType: 'application/zip',
    totalBytes: 21_060_699,
    userGesture: false,
  })
  // **Ordering, not the file merely existing at the end.** The record is read from inside
  // `setSavePath` itself, so a module that wrote it afterwards fails here while every other
  // assertion in this file stays green — and a kill one millisecond after `setSavePath` is exactly
  // the case the ordering is for.
  item.setSavePath = (path: string): void => {
    item.savePaths.push(path)
    const beside = join(path, '..', DOWNLOAD_RECORD_NAME)
    recordsAtSetSavePath.push(
      existsSync(beside)
        ? (JSON.parse(readFileSync(beside, 'utf8')) as BrowseDownloadRecord)
        : null,
    )
  }
  rigged.downloads.handleWillDownload(new FakeTrigger(), item as unknown as BrowseDownloadItem, {
    getURL: () => 'https://www.thingiverse.com/thing:1234',
  })

  // **Every observation, and the first one especially.** Reading only the last would be green for a
  // module that called `setSavePath` first and wrote the record afterwards, so long as it called
  // `setSavePath` again at the end — which is a mutation that was actually run.
  assert.equal(recordsAtSetSavePath.length, 1)
  const first = recordsAtSetSavePath[0]
  assert.ok(first, 'download.json was not on disk when setSavePath ran')
  assert.equal(first.state, 'progressing')
  assert.equal(first.totalBytes, 21_060_699)
})

test('the staged path is <staging>/<downloadId>/<fileName>, and that is the handover', () => {
  const rigged = rig()
  const { item } = start(rigged)
  const id = rigged.ids[0] as string

  assert.deepEqual(item.savePaths, [join(rigged.stagingDir, id, 'benchy.zip')])
  assert.ok(existsSync(join(rigged.stagingDir, id, DOWNLOAD_RECORD_NAME)))
})

test('the record carries every field task 4 was promised', () => {
  const rigged = rig()
  rigged.clock.at = 1_700_000_000_123
  const { item } = start(
    rigged,
    {
      filename: 'benchy.zip',
      url: 'blob:https://www.thingiverse.com/ae5e-9d1c',
      mimeType: 'application/zip',
      totalBytes: 21_060_699,
      userGesture: false,
    },
    'https://www.thingiverse.com/thing:1234',
  )
  const id = rigged.ids[0] as string

  assert.deepEqual(recordOf(rigged.stagingDir, id), {
    downloadId: id,
    startedAt: 1_700_000_000_123,
    fileName: 'benchy.zip',
    sourceUrl: 'blob:https://www.thingiverse.com/ae5e-9d1c',
    pageUrl: 'https://www.thingiverse.com/thing:1234',
    siteId: 'thingiverse',
    mimeType: 'application/zip',
    hadUserGesture: false,
    totalBytes: 21_060_699,
    state: 'progressing',
    receivedBytes: 0,
    library: `local:${realpathSync.native(rigged.libraryDir)}`,
  })
  // No `version` key (E decision 6), asserted rather than assumed: this is written once and only
  // ever read, and a reader that does not understand a record says so from the fields it finds.
  assert.equal(Object.hasOwn(recordOf(rigged.stagingDir, id), 'version'), false)
  assert.equal(item.savePaths.length, 1)
})

test('pageUrl is the view URL and not item.getURL() when the two differ', () => {
  const rigged = rig()
  // The measured Thingiverse shape: the download URL is a `blob:` that identifies nothing and
  // matches nothing, while the page the user is on is the model page. Conflating the two is the
  // defect this pair of fields exists to prevent, and the obvious field to match on is the wrong
  // one.
  start(
    rigged,
    { url: 'blob:https://www.thingiverse.com/ae5e-9d1c' },
    'https://www.printables.com/model/2093108-dji-neo-2',
  )
  const record = recordOf(rigged.stagingDir, rigged.ids[0] as string)

  assert.equal(record.pageUrl, 'https://www.printables.com/model/2093108-dji-neo-2')
  assert.equal(record.sourceUrl, 'blob:https://www.thingiverse.com/ae5e-9d1c')
  // And `siteId` is the registry match for **`pageUrl`** — a `blob:` matches no row at all, so a
  // module that keyed on `sourceUrl` would answer null here rather than Printables.
  assert.equal(record.siteId, 'printables')
})

test('the strings a stranger chose are bounded on the way onto the record', () => {
  const rigged = rig()
  // A `data:` URL download, which is the case that makes this matter: `getURL()` *is* the payload,
  // so an unbounded `sourceUrl` puts the whole file into `download.json` — written twice and
  // fsynced — and into every `browse.downloads()` poll response for as long as it is staged.
  const huge = `data:application/zip;base64,${'A'.repeat(50_000)}`
  start(rigged, { url: huge, mimeType: `application/zip;${'x'.repeat(50_000)}` }, huge)
  const record = recordOf(rigged.stagingDir, rigged.ids[0] as string)

  assert.equal(record.sourceUrl.length, MAX_RECORDED_TEXT)
  assert.equal(record.pageUrl?.length, MAX_RECORDED_TEXT)
  assert.equal(record.mimeType.length, MAX_RECORDED_TEXT)
  // The prefix, not only the length: a bound that replaced the value would also be shorter.
  assert.ok(record.sourceUrl.startsWith('data:application/zip;base64,AAA'))
  // And the DTO the renderer polls carries the same bounded strings, because it is a copy of them.
  const listed = only(rigged.downloads.list())
  assert.equal(listed.sourceUrl.length, MAX_RECORDED_TEXT)
  assert.equal(listed.pageUrl?.length, MAX_RECORDED_TEXT)
})

test('a record read back from disk is bounded too, because userData is editable', () => {
  const { downloads, stagingDir } = rig()
  // Not paranoia about a file this app wrote: a record written before the bound existed is the
  // ordinary case, and `userData` is a directory a person can edit.
  stage(stagingDir, 'orphan-url', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({
      totalBytes: 2048,
      receivedBytes: 2048,
      sourceUrl: `data:application/zip;base64,${'A'.repeat(50_000)}`,
      pageUrl: `https://www.thingiverse.com/thing:1234?${'q'.repeat(50_000)}`,
      mimeType: 'x'.repeat(50_000),
    }),
  })

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.sourceUrl.length, MAX_RECORDED_TEXT)
  assert.equal(found.pageUrl?.length, MAX_RECORDED_TEXT)
  assert.equal(found.mimeType.length, MAX_RECORDED_TEXT)
  // Truncation is not a refusal: the download is still the one the user has to decide about, and
  // `siteId` was matched on the hostname, which no bound at this length can reach.
  assert.equal(found.isVerifiable, true)
  assert.equal(found.siteId, 'thingiverse')
})

/**
 * The fourth string on that list, which the test above does not reach.
 *
 * `siteId` is the one field that is a registry match at mint time and a **file's contents** on the
 * way back in, which is why `readRecord` bounds it and why the `MAX_RECORDED_TEXT` docblock names
 * it separately. Every other test in this file reads a record back with the short literal
 * `'thingiverse'` in it, so deleting `bounded()` from that one line turned nothing red — found by
 * task 3's re-review, closed here because task 4's `land` is the first code to re-read a record
 * from disk in anger.
 *
 * The verdict is asserted beside it for the reason the test above gives: truncating a display
 * string is not a refusal, and a test that only checked the length would be satisfied by a
 * `readRecord` that had started rejecting the record outright.
 */
test('a siteId read back from disk is bounded like every other stranger string', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-site', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({
      totalBytes: 2048,
      receivedBytes: 2048,
      siteId: 's'.repeat(50_000),
    }),
  })

  downloads.sweep()

  const found = only(downloads.list())
  assert.equal(found.siteId?.length, MAX_RECORDED_TEXT)
  assert.equal(found.isVerifiable, true)
})

test('a webContents that has not committed a document yet is no page at all', () => {
  const rigged = rig()
  start(rigged, {}, '')
  const record = recordOf(rigged.stagingDir, rigged.ids[0] as string)

  // The empty string is what `getURL()` answers before a document commits. It is not a URL and
  // must not be recorded as one.
  assert.equal(record.pageUrl, null)
  assert.equal(record.siteId, null)
})

test('hadUserGesture is recorded and never acted on', () => {
  const rigged = rig()
  const { item, trigger } = start(rigged, { userGesture: false })

  // Thingiverse's own download button is a scripted `blob:` construction, and a click driven by
  // `executeJavaScript` reports **whichever the driver asked for** — `executeJavaScript(source,
  // userGesture)` is what decides the flag, measured in `browse.spec.ts:665-672`. So it is
  // evidence about how a download started, it can be made to say either thing, and it is never a
  // verdict.
  assert.equal(trigger.prevented, 0)
  assert.equal(item.savePaths.length, 1)
  assert.equal(recordOf(rigged.stagingDir, rigged.ids[0] as string).hadUserGesture, false)
})

test('the file name is getFilename(), sanitised through the rules files.upload applies', () => {
  // Not `Content-Disposition`: `getContentDisposition()` was an empty string on the one real
  // download measured, while `getFilename()` was populated and sane in every case. So the name
  // comes from a remote server, and it is validated on the way in exactly as a name arriving from
  // a remote *server* is in `slicers/launch.ts`.
  assert.equal(stagedFileName('benchy.zip'), 'benchy.zip')
  assert.equal(stagedFileName('a model (v2).3mf'), 'a model (v2).3mf')
  for (const hostile of [
    '../../evil.zip',
    'a/b.zip',
    'a\\b.zip',
    '',
    '.',
    '..',
    '.hidden',
    'CON.zip',
    'x'.repeat(300),
  ]) {
    assert.equal(stagedFileName(hostile), FALLBACK_DOWNLOAD_NAME, `not sanitised: ${hostile}`)
  }
  // The one name that is legal and still cannot be used: the record is written into the same
  // directory a moment earlier, so a file of that name would be the record's own bytes.
  assert.equal(stagedFileName(DOWNLOAD_RECORD_NAME), FALLBACK_DOWNLOAD_NAME)
})

test('a hostile file name never reaches the staged path', () => {
  const rigged = rig()
  const { item } = start(rigged, { filename: '../../../evil.zip' })
  const id = rigged.ids[0] as string

  assert.deepEqual(item.savePaths, [join(rigged.stagingDir, id, FALLBACK_DOWNLOAD_NAME)])
  assert.equal(recordOf(rigged.stagingDir, id).fileName, FALLBACK_DOWNLOAD_NAME)
})

test('library is the remote origin in remote mode, and libraryKeyOf is what says so', () => {
  const rigged = rig({ isRemote: true })
  start(rigged)

  assert.equal(
    recordOf(rigged.stagingDir, rigged.ids[0] as string).library,
    'remote:https://models.invalid',
  )
})

/* -------------------------------------------------------------------------------------------
 * The terminal transition
 * ---------------------------------------------------------------------------------------- */

test('done rewrites the record exactly once, and an updated tick writes nothing', () => {
  // Counted at the **rename**, which is the moment `writeJsonFile` replaces the real file — so a
  // write that failed halfway is not counted as one that happened.
  const writes: string[] = []
  const watched: JsonStoreIo = {
    ...NODE_IO,
    renameSync: (from, to) => {
      writes.push(to)
      NODE_IO.renameSync(from, to)
    },
  }
  const counted = rig({ io: watched })

  const { item } = start(counted)
  const id = counted.ids[0] as string
  assert.equal(writes.length, 1)

  item.received = 512
  item.fire('updated', 'progressing')
  item.received = 1024
  item.fire('updated', 'progressing')
  // Five writes and five fsyncs on a 21 MB download, for a number the poll already has in memory.
  assert.equal(writes.length, 1)
  assert.equal(only(counted.downloads.list()).receivedBytes, 1024)

  writeFileSync(join(counted.stagingDir, id, 'benchy.zip'), Buffer.alloc(1024, 7))
  item.fire('done', 'completed')
  assert.equal(writes.length, 2)
  assert.equal(recordOf(counted.stagingDir, id).state, 'completed')
  assert.equal(recordOf(counted.stagingDir, id).receivedBytes, 1024)
})

test('a download this process watched to completion is landable, even with no content-length', () => {
  const rigged = rig()
  const { item } = start(rigged, { totalBytes: 0 })
  const id = rigged.ids[0] as string
  item.received = 4096
  writeFileSync(join(rigged.stagingDir, id, 'benchy.zip'), Buffer.alloc(4096, 7))

  item.fire('done', 'completed')

  // **This is where a live download and a swept one part company, and it is deliberate.** The
  // sweep treats `totalBytes: 0` as unverifiable because it has nothing to check against and did
  // not see the download happen. This process *watched the terminal transition itself*, which is
  // the vouching the sweep cannot manufacture.
  const found = only(rigged.downloads.list())
  assert.equal(found.isVerifiable, true)
  assert.equal(found.isOrphan, false)
  assert.equal(found.state, 'completed')
})

test('with no content-length, a watched download whose bytes are not there is still refused', () => {
  // **The other side of the test above, and the pair is the point.** The relaxation exists so that
  // a server sending no `content-length` is not a server nothing can ever land — it is not a
  // licence to skip looking at the bytes. `completed` alone is weakest evidence in exactly this
  // case: a truncated chunked stream, and any HTTP/2 or HTTP/3 body, arrives as `interrupted`, so
  // the residue `completed` has to carry here is HTTP/1.1 framed by connection close, where a
  // mid-stream FIN is indistinguishable from a clean end. What is checked instead is that the
  // bytes Chromium counted are the bytes at the staged path.
  for (const arm of [
    { name: 'nothing was written at all', bytes: null },
    { name: 'the file is short', bytes: 1024 },
  ]) {
    const rigged = rig()
    const { item } = start(rigged, { totalBytes: 0 })
    const id = rigged.ids[0] as string
    item.received = 4096
    if (arm.bytes !== null) {
      writeFileSync(join(rigged.stagingDir, id, 'benchy.zip'), Buffer.alloc(arm.bytes, 7))
    }

    item.fire('done', 'completed')

    const found = only(rigged.downloads.list())
    assert.equal(found.state, 'completed', arm.name)
    // Handing this to `land` is the one outcome constraint 14 exists to prevent: a file that is
    // absent or short, under its final name, with nothing on it that says so.
    assert.equal(found.isVerifiable, false, arm.name)
  }
})

test('a download that ends anywhere but completed is not landable', () => {
  for (const ending of ['cancelled', 'interrupted'] as const) {
    const rigged = rig()
    const { item } = start(rigged)
    item.fire('done', ending)

    const found = only(rigged.downloads.list())
    assert.equal(found.state, ending)
    assert.equal(found.isVerifiable, false)
  }
})

test('a completed download that arrives while no view is attached raises one notice', () => {
  const rigged = rig()
  rigged.attached.value = false
  const { item } = start(rigged)
  const id = rigged.ids[0] as string
  writeFileSync(join(rigged.stagingDir, id, 'benchy.zip'), Buffer.alloc(1024, 7))
  item.received = 1024

  item.fire('done', 'completed')

  assert.equal(rigged.notices.length, 1)
  assert.equal(rigged.notices[0]?.kind, 'completed')
  assert.equal(rigged.notices[0]?.fileName, 'benchy.zip')
})

test('a completed download with the view still on screen interrupts nobody', () => {
  const rigged = rig()
  rigged.attached.value = true
  const { item } = start(rigged)
  item.fire('done', 'completed')

  // The other side of the boundary: without this the test above passes for a module that notifies
  // unconditionally, which would put an OS notification on screen for every download the user is
  // watching happen.
  assert.deepEqual(rigged.notices, [])
})

/* -------------------------------------------------------------------------------------------
 * The three caps
 * ---------------------------------------------------------------------------------------- */

test('the fourth concurrent download is staged and the fifth is refused', () => {
  const rigged = rig()
  const staged: FakeItem[] = []
  for (let index = 0; index < MAX_CONCURRENT_DOWNLOADS; index += 1) {
    staged.push(start(rigged).item)
  }
  // The accept side, on the boundary: without it every assertion below is satisfied by a module
  // that refuses everything.
  assert.deepEqual(
    staged.map((item) => item.savePaths.length),
    [1, 1, 1, 1],
  )

  const fifth = start(rigged)

  assert.equal(fifth.trigger.prevented, 1)
  // **The call count, not only that the event was prevented.** A handler that called
  // `setSavePath` and *then* refused would leave Chromium a path it had been given.
  assert.deepEqual(fifth.item.savePaths, [])
  assert.equal(rigged.downloads.list().length, MAX_CONCURRENT_DOWNLOADS)

  // And a slot freed by a download reaching its terminal state is a slot again — the cap counts
  // downloads in flight, which is what its name says.
  ;(staged[0] as FakeItem).fire('done', 'completed')
  assert.equal(start(rigged).item.savePaths.length, 1)
})

test('a single download over the 2 GiB cap is refused, and one exactly on it is staged', () => {
  const rigged = rig()
  const onIt = start(rigged, { totalBytes: MAX_DOWNLOAD_BYTES })
  assert.equal(onIt.item.savePaths.length, 1)
  assert.equal(onIt.trigger.prevented, 0)

  const over = start(rigged, { totalBytes: MAX_DOWNLOAD_BYTES + 1 })
  assert.equal(over.trigger.prevented, 1)
  assert.deepEqual(over.item.savePaths, [])
})

test('a download that would push total staged bytes past 4 GiB is refused', () => {
  const rigged = rig()
  assert.equal(MAX_STAGED_BYTES, 4 * GIB)
  const first = start(rigged, { totalBytes: 2 * GIB })
  // Exactly on the ceiling is staged; only *past* it is refused.
  const second = start(rigged, { totalBytes: 2 * GIB })
  assert.equal(first.item.savePaths.length, 1)
  assert.equal(second.item.savePaths.length, 1)

  const third = start(rigged, { totalBytes: 1 })

  assert.equal(third.trigger.prevented, 1)
  assert.deepEqual(third.item.savePaths, [])
})

test('each refusal appends exactly one notice naming the download and the cap it hit', () => {
  const rigged = rig()
  start(rigged, { totalBytes: MAX_DOWNLOAD_BYTES + 1, filename: 'huge.zip' })

  assert.equal(rigged.notices.length, 1)
  const notice = lastNotice(rigged)
  assert.equal(notice.kind, 'refused')
  assert.equal(notice.fileName, 'huge.zip')
  // Which cap, and what it is — a refusal the user cannot act on is the silence this notice
  // exists to end, and "a download was refused" is not something anyone can act on.
  assert.match(notice.detail, /2 GiB/)

  const concurrent = rig()
  for (let index = 0; index < MAX_CONCURRENT_DOWNLOADS; index += 1) start(concurrent)
  // Nothing was said about the four that were staged: a notice is an interruption, and four
  // downloads starting normally is not one.
  assert.equal(concurrent.notices.length, 0)
  start(concurrent, { filename: 'fifth.zip' })
  assert.equal(concurrent.notices.length, 1)
  assert.match(lastNotice(concurrent).detail, /4 downloads/)

  const total = rig()
  start(total, { totalBytes: 2 * GIB })
  start(total, { totalBytes: 2 * GIB })
  assert.equal(total.notices.length, 0)
  start(total, { totalBytes: 1, filename: 'one-byte-too-many.zip' })
  assert.equal(total.notices.length, 1)
  assert.match(lastNotice(total).detail, /4 GiB/)
})

test('a refused download leaves no directory behind at all', () => {
  const rigged = rig()
  start(rigged, { totalBytes: MAX_DOWNLOAD_BYTES + 1 })

  // `preventDefault()` wrote nothing anywhere; neither did this module, which means there is
  // nothing for the next sweep to find and offer.
  assert.equal(existsSync(rigged.stagingDir) && readdirSync(rigged.stagingDir).length > 0, false)
})

/* -------------------------------------------------------------------------------------------
 * The write that fails
 * ---------------------------------------------------------------------------------------- */

test('a record that cannot be written refuses the download rather than staging bytes alone', () => {
  const broken: JsonStoreIo = {
    ...NODE_IO,
    openSync: () => {
      throw new Error('disk full')
    },
  }
  const rigged = rig({ io: broken })

  const { item, trigger } = start(rigged)

  // Constraint 14 from the other end: a staged file with no record is exactly the truncation case
  // the record exists to prevent, so staging one is worse than refusing.
  assert.equal(trigger.prevented, 1)
  assert.deepEqual(item.savePaths, [])
  assert.equal(rigged.notices.length, 1)
  assert.equal(rigged.notices[0]?.kind, 'refused')
  assert.deepEqual(rigged.downloads.list(), [])
  // And the empty directory `writeJsonFile`'s own `mkdirSync` made is not left for the next sweep
  // to offer as a mystery. Only an *empty* one is removed — nothing that could be a user's bytes.
  assert.equal(existsSync(rigged.stagingDir) && readdirSync(rigged.stagingDir).length > 0, false)
})

test('a setSavePath that throws holds neither cap, and leaves the directory for the sweep', () => {
  // Electron throws `DownloadItem used after being destroyed` on an item whose view went away
  // between `will-download` and this call, and that is the whole of the reachable case. The defect
  // it produces is not the failed download — it is the **entry that can never be removed**: staged
  // as `progressing`, with no `done` listener ever registered, and `discard` refuses a non-orphan
  // `progressing` entry. It would hold one of the four slots and its declared bytes against the
  // 4 GiB ceiling until the app restarted, which is the "discard some to make room" way out being
  // consumed by the failure it exists for.
  const rigged = rig()
  const item = new FakeItem({
    filename: 'benchy.zip',
    url: 'https://cdn.invalid/benchy.zip',
    mimeType: 'application/zip',
    totalBytes: 2 * GIB,
    userGesture: true,
  })
  item.setSavePath = (): void => {
    throw new Error('DownloadItem used after being destroyed')
  }
  const trigger = new FakeTrigger()

  rigged.downloads.handleWillDownload(trigger, item as unknown as BrowseDownloadItem, {
    getURL: () => 'https://www.thingiverse.com/thing:1234',
  })

  // Nothing staged, so nothing to discard and nothing holding either cap. The four slots and the
  // 4 GiB are proved free by using them: four more downloads of 1 GiB each is both caps at once,
  // and a module that kept the failed entry refuses the fourth on concurrency and the third on
  // bytes.
  assert.deepEqual(rigged.downloads.list(), [])
  assert.equal(trigger.prevented, 1)
  assert.equal(lastNotice(rigged).kind, 'refused')
  for (let index = 0; index < MAX_CONCURRENT_DOWNLOADS; index += 1) {
    assert.equal(start(rigged, { totalBytes: GIB }).item.savePaths.length, 1, `slot ${index}`)
  }

  // And the record written a moment earlier is still on disk (constraint 15): this process no
  // longer knows what became of the bytes, so the next run surfaces the directory as unverifiable
  // and the user decides. Deleting it here would be a deletion justified by timing.
  const id = rigged.ids[0] as string
  assert.equal(recordOf(rigged.stagingDir, id).state, 'progressing')
})

test('the cleanup after a failed record write removes only an empty directory', () => {
  // The other half of the sentence above, and the mutation it exists for: a cleanup that removed
  // the directory unconditionally would be a deletion justified by timing rather than by what is
  // inside it, which is the reasoning constraint 15 refuses.
  //
  // The reachable way to have something in there is `writeJsonFile`'s own temp file outliving the
  // failure — its `renameSync` throws and its cleanup `rmSync` does not run. `json-store.ts` says
  // in as many words that a temp file can be left behind and that nothing sweeps those.
  const stubborn: JsonStoreIo = {
    ...NODE_IO,
    renameSync: () => {
      throw new Error('EPERM: the antivirus has the file open')
    },
    rmSync: () => {},
  }
  const rigged = rig({ io: stubborn })

  const { item, trigger } = start(rigged)
  const id = rigged.ids[0] as string

  assert.equal(trigger.prevented, 1)
  assert.deepEqual(item.savePaths, [])
  // Left where it is, temp file and all. It is surfaced by the next sweep as unverifiable and the
  // user can discard it; it is not something this process quietly throws away.
  assert.ok(existsSync(join(rigged.stagingDir, id)))
  assert.equal(readdirSync(join(rigged.stagingDir, id)).length, 1)
})

/* -------------------------------------------------------------------------------------------
 * The registration
 * ---------------------------------------------------------------------------------------- */

test('will-download is registered on the session once, however often attachTo is called', () => {
  const { downloads } = rig()
  const session = new FakeSession()

  downloads.attachTo(session as unknown as Parameters<BrowseDownloads['attachTo']>[0])
  downloads.attachTo(session as unknown as Parameters<BrowseDownloads['attachTo']>[0])

  // The item lives on the session and outlives every view, which is why this goes on once for the
  // life of the process and never per `attach`. Two listeners would stage every download twice.
  assert.deepEqual(session.listeners, ['will-download'])
})

/* -------------------------------------------------------------------------------------------
 * find(), the handover to task 4
 * ---------------------------------------------------------------------------------------- */

test('find answers the path and the verdict, and nothing for an id it does not know', () => {
  const { downloads, stagingDir } = rig()
  stage(stagingDir, 'orphan-k', {
    fileName: 'benchy.zip',
    bytes: 2048,
    record: completedRecord({ totalBytes: 2048, receivedBytes: 2048 }),
  })
  downloads.sweep()

  const found = downloads.find('orphan-k')
  assert.equal(found?.filePath, join(stagingDir, 'orphan-k', 'benchy.zip'))
  assert.equal(found?.isVerifiable, true)
  assert.equal(downloads.find('no-such-download'), null)
})
