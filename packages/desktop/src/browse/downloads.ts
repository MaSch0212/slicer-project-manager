import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from 'electron'
import type { BrowseDownloadDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema } from '@spm/contract/schemas.ts'
import { safeJoin } from '@spm/core'
import { NODE_IO, writeJsonFile, type JsonStoreIo } from '../json-store.ts'
import type { DesktopSession } from '../library.ts'
import { libraryKeyOf } from '../slicers/launch.ts'
import type { BrowseNotices } from './notices.ts'
import { siteForUrl } from './registry.ts'

/**
 * Catching the downloads that browsing produces, and staging them so a user can decide later.
 *
 * ## The handler makes exactly one decision, synchronously
 *
 * Two measured facts remove every alternative design, and they are the reason this file is shaped
 * the way it is (`.superpowers/spikes/2026-08-28-model-browser-facts.md`):
 *
 * - **The URL may be a `blob:`.** Thingiverse's was — `getURL()` and the whole `getURLChain()` were
 *   one `blob:` URL. A design that captured the URL and re-fetched it from the main process, or
 *   handed it to the OS, would fail on that site specifically. `setSavePath()` inside the handler
 *   is the only mechanism that works.
 * - **Refusal is all-or-nothing and synchronous.** `preventDefault()` wrote nothing anywhere and
 *   the item was destroyed by the next tick — `getState()` afterwards threw `DownloadItem used
 *   after being destroyed`. So there is no "ask the user first" inside the handler, because there is
 *   no await that leaves an item alive.
 *
 * **Default: accept and stage.** A staged file is inert: it is under `userData`, it is in no
 * project, no `files` row exists for it, and nothing has been uploaded. The user decides afterwards,
 * with time.
 *
 * ## The record beside the bytes is not optional
 *
 * `<userData>/model-downloads/<downloadId>/` holds two files: the bytes, and `download.json` beside
 * them. Two independent reasons, and the second is the serious one.
 *
 * **One: nothing in `BrowseDownloadDto` is recoverable from a directory listing.** `sourceUrl`,
 * `pageUrl`, `siteId`, `mimeType`, `totalBytes`, `hadUserGesture`, `startedAt` and the terminal
 * `state` are all known only to the process that saw the download start, and `browse.downloads()`
 * has to answer for a directory found at the next app start.
 *
 * **Two: with `setSavePath()` in use there is no marker distinguishing a truncated file from a
 * complete one.** Measured on Electron 44: Chromium writes **straight to the final path** — no
 * `.crdownload`, no partial suffix, no sidecar of its own. Destroying the owning view mid-download
 * left a file at **26 214 400 of 41 943 040 bytes**, sitting at its final name, byte-for-byte
 * indistinguishable from a completed download of a 26 MB file. A sweep with nothing but a directory
 * listing enumerates it, offers it, and `land` uploads a truncated archive into the user's project
 * silently.
 *
 * The record is written through `json-store.ts`'s atomic writer **before `setSavePath()` returns**,
 * so a kill one millisecond later still leaves a directory that explains itself, and **rewritten
 * exactly once, on `done`**. Not per `updated` tick: that is five writes and five fsyncs on a 21 MB
 * download for a number the poll already has in memory. **No `version` key** (E decision 6),
 * following `SlicerLaunchRecord`'s reasoning: it is written once and only ever read, so a reader
 * that does not understand a record can say so from the fields it finds.
 *
 * ## Nothing here may use `getETag()` or `getLastModifiedTime()`
 *
 * Both came back **empty on every download measured**. No caching, no "have I downloaded this
 * before", and in particular no integrity check. `totalBytes` is the only integrity signal there is,
 * which is why {@link vouchesForTheBytes} leans on it and why a `0` there is treated as ignorance.
 *
 * ## The sweep surfaces and never deletes
 *
 * A staged download from a previous run is a decision the user has not made yet, not litter.
 * {@link BrowseDownloads.discard} is the only thing that removes one, and (task 4) a landed
 * download's directory goes only after the upload has returned. That is D's rule, and the reason it
 * is D's rule is that deletion has to be justified by *recoverability* rather than by knowledge —
 * nothing here can recreate a download, so nothing here deletes one.
 *
 * ## What is injected, and why
 *
 * Everything Electron-shaped: the `DownloadItem` surface, the `will-download` event and the
 * `webContents` the download came from are all structural types this file declares. `electron` is
 * imported for the `Session` **type** only, which is erased. So `test/browse-downloads.test.ts`
 * drives the caps, the record, the terminal transition and all five sweep verdicts under plain
 * `node --test` against a real temporary directory.
 */

/* -------------------------------------------------------------------------------------------
 * The numbers, and which of them are judgements
 * ---------------------------------------------------------------------------------------- */

/** Under `app.getPath('userData')`, beside `state.json`, `slicers.json` and `browse.json`. */
export const MODEL_DOWNLOADS_DIR = 'model-downloads'

/** The record, beside the bytes it describes. D's per-launch shape, both halves of it. */
export const DOWNLOAD_RECORD_NAME = 'download.json'

/*
 * **The three caps are judgements, and are labelled as such rather than presented as measured.**
 *
 * Nothing in the spike bears on any of them. They are chosen against the one real download there
 * is — **21 060 699 bytes**, Thingiverse's "Download all files", measured end to end — so that the
 * honest case is nowhere near the limit and a page that wants to fill a disk hits one quickly. If a
 * real library ever pushes against them, that is a measurement and these move with it.
 *
 * They are constants **in one place**, and not settings: a user has no basis for choosing them, and
 * a UI for them would imply the app knows what the right answer is.
 */

/** Four models started before landing any is plausible; forty is not a user. A judgement. */
export const MAX_CONCURRENT_DOWNLOADS = 4

/** ~200 Thingiverse-sized archives sitting undecided. A judgement. */
export const MAX_STAGED_BYTES = 4 * 1024 * 1024 * 1024

/**
 * Above any observed model archive, below a staging directory becoming a problem. A judgement.
 *
 * The one real download is 0.98% of this.
 */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

/**
 * What a download is called when the server's own name cannot be used.
 *
 * Deliberately extension-less. Guessing one from `getMimeType()` would be this file inventing a
 * fact about the bytes, and the name is a display detail the user renames at `land` time anyway.
 */
export const FALLBACK_DOWNLOAD_NAME = 'download'

/* -------------------------------------------------------------------------------------------
 * The record, and the Electron surfaces this file will touch
 * ---------------------------------------------------------------------------------------- */

export type BrowseDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

/** `download.json`, in full. **The handover to task 4**, and the shape the sweep reads back. */
export type BrowseDownloadRecord = {
  /** The directory name, minted by the main process. */
  downloadId: string
  startedAt: number
  /** The sanitised basename beside this file. See {@link stagedFileName}. */
  fileName: string
  /** `item.getURL()` — may be a `blob:`. For display and attribution only. */
  sourceUrl: string
  /** The page the view was on when it started. **This is what matching runs on.** */
  pageUrl: string | null
  /** The registry row for `pageUrl`, or null. */
  siteId: string | null
  mimeType: string
  /** Recorded, never acted on. */
  hadUserGesture: boolean
  /** `getTotalBytes()` at `will-download`; 0 when the server sent no length. */
  totalBytes: number
  state: BrowseDownloadState
  /** Last observed; rewritten on the terminal transition, not per tick. */
  receivedBytes: number
  /** Which library this was staged against — D's `libraryKeyOf`, same reason. */
  library: string | null
}

/**
 * The part of Electron's `DownloadItem` this file uses, and all of it.
 *
 * Declared with method syntax so a real `DownloadItem` — whose `on`/`once` are overloaded and whose
 * listener parameters are wider than these — assigns to it. **That assignment is made, unchecked by
 * any cast, in `attachTo` below**, which is what turns the previous sentence from a hope into
 * something `deno task typecheck` enforces: probed by adding a method Electron does not have, which
 * fails with *"Property 'getNotAThing' is missing in type 'DownloadItem'"*. `BrowseDownloadTrigger`
 * and `BrowseDownloadSource` are checked at the same call, against Electron's `Event` and
 * `WebContents`.
 *
 * **`getETag`, `getLastModifiedTime` and `getContentDisposition` are deliberately absent**: all three
 * were measured empty, and a surface that does not name them is a surface nobody can quietly start
 * believing. Electron does have all three — adding `getETag(): string` here typechecks clean — so
 * their absence is a rule this file keeps and not one the platform enforces.
 */
export type BrowseDownloadItem = {
  getFilename(): string
  getURL(): string
  getMimeType(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  hasUserGesture(): boolean
  setSavePath(path: string): void
  on(event: 'updated', listener: (event: unknown, state: string) => void): unknown
  once(event: 'done', listener: (event: unknown, state: string) => void): unknown
}

/** The `will-download` event. One method, which is all a synchronous all-or-nothing refusal needs. */
export type BrowseDownloadTrigger = { preventDefault(): void }

/** The `webContents` the download came from — read for `pageUrl` and nothing else. */
export type BrowseDownloadSource = { getURL(): string }

/** One staged download as this process holds it. `find` hands this to task 4's `land`. */
export type StagedDownload = {
  record: BrowseDownloadRecord
  directory: string
  /** The bytes. `''` for `fileName` means a record-less directory whose bytes were not found. */
  filePath: string
  isOrphan: boolean
  isVerifiable: boolean
}

/* -------------------------------------------------------------------------------------------
 * The two rules that are worth being functions
 * ---------------------------------------------------------------------------------------- */

/**
 * The staged basename for a name a **remote server** chose.
 *
 * `item.getFilename()` and **not `Content-Disposition`**: `getContentDisposition()` was an empty
 * string on the one real download measured, while `getFilename()` was populated and sane in every
 * case. So the name arrives from a stranger and is about to become a path this process writes to —
 * which is the situation `slicers/launch.ts` already meets for a name arriving from a remote
 * server, and it is answered the same way: `fileNameSchema`, the schema `files.upload` accepts
 * names under, which refuses separators, traversal, the Windows-reserved set, the reserved device
 * names, a leading dot and anything past 255 characters.
 *
 * A name it refuses becomes {@link FALLBACK_DOWNLOAD_NAME} rather than refusing the download: the
 * caps are the one refusal (spec 5.2), and a badly named archive is still an archive the user
 * wanted. The path is then built with core's `safeJoin`, which is the check that actually holds —
 * this function chooses a name, and `safeJoin` is what makes a wrong choice impossible to act on.
 *
 * **`download.json` is the one legal name that is still refused**, for the reason
 * `SlicerLaunchRecord` gives about `launch.json`: the record is written into that directory a
 * moment earlier, so a file of that name would be handed the record's own path.
 */
export function stagedFileName(raw: string): string {
  const parsed = fileNameSchema.safeParse(raw)
  if (!parsed.success) return FALLBACK_DOWNLOAD_NAME
  return parsed.data.toLowerCase() === DOWNLOAD_RECORD_NAME ? FALLBACK_DOWNLOAD_NAME : parsed.data
}

/**
 * Whether a record vouches for the bytes beside it (E constraint 14).
 *
 * `observedTerminal` is the one input that separates a download **this process watched from
 * `will-download` to `done`** from one a sweep found lying in a directory, and it is the whole of
 * the difference between them:
 *
 * - A record that is not `completed` never vouches. One still saying `progressing` is a process
 *   that died mid-download; `cancelled` and `interrupted` say so themselves.
 * - With a `totalBytes` to check against, the bytes on disk must equal it. This is the assertion
 *   the 26 214 400-of-41 943 040 measurement exists for.
 * - **With `totalBytes: 0` there is nothing to check**, so a swept record does not pass — an
 *   unknown is not a pass, and nothing else can stand in: `getETag()` and `getLastModifiedTime()`
 *   were empty on every download measured. A download this process *saw complete* passes anyway,
 *   because watching the terminal transition is the vouching a sweep cannot manufacture. A server
 *   that sends no `content-length` is otherwise a server nothing from this app can ever land.
 */
export function vouchesForTheBytes(
  record: BrowseDownloadRecord,
  bytesOnDisk: number,
  observedTerminal: boolean,
): boolean {
  if (record.state !== 'completed') return false
  if (record.totalBytes === 0) return observedTerminal
  return bytesOnDisk === record.totalBytes
}

/* -------------------------------------------------------------------------------------------
 * The class
 * ---------------------------------------------------------------------------------------- */

export type BrowseDownloadsOptions = {
  /** `<userData>/model-downloads`. Built by `app.ts`; this file never asks Electron for a path. */
  stagingDir: string
  /** Where a refusal, and a completion nobody was watching, are recorded and announced. */
  notices: BrowseNotices
  /** The three halves of D's `libraryKeyOf`, resolved **per call** — both can change at runtime. */
  session(): DesktopSession | null
  isRemote(): boolean
  remote(): { readonly origin: string } | null
  /**
   * Whether a browse view is on screen right now.
   *
   * Only one thing reads it: a `done` that arrives while nothing is polling `browse.downloads()` is
   * a finished download the user would never be told about.
   */
  isViewAttached(): boolean
  now?(): number
  mintId?(): string
  /** `json-store.ts`'s seam, so the write sequence — and a write that fails — are assertable. */
  io?: JsonStoreIo
}

type Entry = {
  record: BrowseDownloadRecord
  isOrphan: boolean
  isVerifiable: boolean
  /** What is actually on disk, as last measured. The staged-bytes ceiling is computed from it. */
  bytesOnDisk: number
}

export class BrowseDownloads {
  readonly #stagingDir: string
  readonly #notices: BrowseNotices
  readonly #session: () => DesktopSession | null
  readonly #isRemote: () => boolean
  readonly #remote: () => { readonly origin: string } | null
  readonly #isViewAttached: () => boolean
  readonly #now: () => number
  readonly #mintId: () => string
  readonly #io: JsonStoreIo

  /** Everything staged, this run's and previous runs', in the order it became known. */
  readonly #staged = new Map<string, Entry>()
  #registered = false

  constructor(options: BrowseDownloadsOptions) {
    this.#stagingDir = options.stagingDir
    this.#notices = options.notices
    this.#session = options.session
    this.#isRemote = options.isRemote
    this.#remote = options.remote
    this.#isViewAttached = options.isViewAttached
    this.#now = options.now ?? Date.now
    this.#mintId = options.mintId ?? (() => crypto.randomUUID())
    this.#io = options.io ?? NODE_IO
  }

  /**
   * Puts the `will-download` listener on the browse session, **once, for the life of the process**
   * (E decision 4).
   *
   * Measured: destroying the owning `WebContentsView` mid-download does **not** cancel an `http`
   * download — the `DownloadItem` lives on the *session*, `updated` went on firing and the bytes
   * went on landing. A view-lifetime listener would be removed by `detach`, so a download that
   * started before it and finished after would lose its `done` handler and its record would never
   * reach a terminal state — which is exactly the shape the sweep then has to refuse.
   *
   * Idempotent, because two listeners would stage every download twice.
   */
  attachTo(session: Session): void {
    if (this.#registered) return
    this.#registered = true
    // **No cast.** Electron's `DownloadItem`, `Event` and `WebContents` are handed straight to the
    // structural types above, so the compiler is what checks that this file only ever asks the item
    // for the seven things it declares.
    session.on('will-download', (event, item, webContents) => {
      this.handleWillDownload(event, item, webContents ?? null)
    })
  }

  /**
   * The one decision, made synchronously, on information this handler has right now.
   *
   * Public because it is what `test/browse-downloads.test.ts` drives: the session's own event
   * plumbing is Electron's and is asserted against a real window in `browse.spec.ts`.
   */
  handleWillDownload(
    event: BrowseDownloadTrigger,
    item: BrowseDownloadItem,
    source: BrowseDownloadSource | null,
  ): void {
    const totalBytes = item.getTotalBytes()
    const capped = this.#capRefusal(totalBytes)
    if (capped !== null) {
      event.preventDefault()
      this.#notices.add('refused', item.getFilename(), capped)
      return
    }

    const downloadId = this.#mintId()
    const directory = join(this.#stagingDir, downloadId)
    const fileName = stagedFileName(item.getFilename())
    // The name has already been through `fileNameSchema`; this is the check that holds, and it is
    // core's own — the same one `files.upload` assembles a library path with.
    const savePath = safeJoin(directory, fileName)
    // The empty string is what `getURL()` answers for a `webContents` that has not committed a
    // document. It is not a URL and must not be recorded as one.
    const pageUrl = source === null || source.getURL() === '' ? null : source.getURL()
    const record: BrowseDownloadRecord = {
      downloadId,
      startedAt: this.#now(),
      fileName,
      sourceUrl: item.getURL(),
      pageUrl,
      siteId: siteForUrl(pageUrl ?? '')?.id ?? null,
      mimeType: item.getMimeType(),
      // Recorded and shown, never acted on. The flag distinguishes `webContents.downloadURL()`
      // from a real click, but a click driven by `executeJavaScript` also reports `false` — so it
      // is evidence about how a download started and not a verdict, and refusing on it would break
      // sites whose download button is a scripted `blob:` construction. Which is Thingiverse's,
      // the one download that was actually measured.
      hadUserGesture: item.hasUserGesture(),
      totalBytes,
      state: 'progressing',
      receivedBytes: 0,
      library: libraryKeyOf(this.#isRemote(), this.#session(), this.#remote()),
    }

    // **Before `setSavePath`, and that ordering is the guarantee** — a kill one millisecond later
    // leaves a directory that explains itself. It also creates the directory, which `setSavePath`
    // needs, so the two cannot be reordered without noticing.
    if (!this.#writeRecord(directory, record)) {
      // Not a policy refusal — the caps are the only one of those — but staging bytes with nothing
      // to explain them is precisely the unlandable, indistinguishable-from-truncated file
      // constraint 14 is about. Refusing is the better of the two outcomes, and the user is told.
      event.preventDefault()
      this.#notices.add(
        'refused',
        item.getFilename(),
        'this download could not be recorded, so it was not started',
      )
      this.#removeIfEmpty(directory)
      return
    }

    this.#staged.set(downloadId, { record, isOrphan: false, isVerifiable: false, bytesOnDisk: 0 })
    item.setSavePath(savePath)

    // In memory only. `updated` fires repeatedly with `getReceivedBytes()` populated, and the
    // `/browse` page polls `browse.downloads()` — a record rewrite per tick is five fsyncs on a
    // 21 MB download for a number this object already has.
    item.on('updated', () => {
      record.receivedBytes = item.getReceivedBytes()
    })

    item.once('done', (_event, state) => {
      record.state = isDownloadState(state) ? state : 'interrupted'
      record.receivedBytes = item.getReceivedBytes()
      const entry = this.#staged.get(downloadId)
      if (entry) {
        entry.bytesOnDisk = sizeOf(savePath)
        // `true`: this process watched the terminal transition, which is the one thing a sweep
        // cannot do. See `vouchesForTheBytes`.
        entry.isVerifiable = vouchesForTheBytes(record, entry.bytesOnDisk, true)
      }
      // The rewrite, exactly once.
      this.#writeRecord(directory, record)
      if (record.state === 'completed' && !this.#isViewAttached()) {
        this.#notices.add('completed', record.fileName, 'this download finished in the background')
      }
    })
  }

  /**
   * Enumerates `model-downloads/` at start and **deletes nothing** (E constraint 15).
   *
   * A directory here is a decision the user has not made yet. What this adds over a listing is the
   * verdict: a record that does not vouch for the bytes beside it makes the download unlandable,
   * because a truncated file sits at its final name with no marker of any kind — 26 214 400 of
   * 41 943 040 bytes, measured, byte-for-byte indistinguishable from a complete 26 MB download.
   *
   * A directory this run already knows about is left alone, so a sweep can never overwrite a live
   * download's in-memory record with the `progressing` one on disk.
   */
  sweep(): void {
    let entries: string[]
    try {
      entries = readdirSync(this.#stagingDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      // First run, or a `userData` that has just been wiped. Anything else is worth a word.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`desktop: could not read ${MODEL_DOWNLOADS_DIR}`, error)
      }
      return
    }
    for (const downloadId of entries) {
      if (this.#staged.has(downloadId)) continue
      this.#staged.set(downloadId, this.#sweepOne(downloadId))
    }
  }

  /** Everything staged, this run's and previous runs', in the order it became known. */
  list(): BrowseDownloadDto[] {
    return [...this.#staged.values()].map((entry) => ({
      downloadId: entry.record.downloadId,
      fileName: entry.record.fileName,
      sourceUrl: entry.record.sourceUrl,
      pageUrl: entry.record.pageUrl,
      siteId: entry.record.siteId,
      mimeType: entry.record.mimeType,
      state: entry.record.state,
      receivedBytes: entry.record.receivedBytes,
      totalBytes: entry.record.totalBytes,
      hadUserGesture: entry.record.hadUserGesture,
      startedAt: entry.record.startedAt,
      isOrphan: entry.isOrphan,
      isVerifiable: entry.isVerifiable,
    }))
  }

  /**
   * One staged download, resolved.
   *
   * **The handover to task 4, stated as the contract it is rather than as a description of code
   * that exists.** Nothing calls this yet. `land` is to read `filePath`, and it is to refuse any
   * record whose `isVerifiable` is false *before* it opens a project — because a `false` there means
   * the bytes are byte-for-byte indistinguishable from a truncated download, and the upload is the
   * step after which nothing can be undone.
   */
  find(downloadId: string): StagedDownload | null {
    const entry = this.#staged.get(downloadId)
    if (!entry) return null
    const directory = join(this.#stagingDir, entry.record.downloadId)
    return {
      record: { ...entry.record },
      directory,
      filePath: entry.record.fileName === '' ? '' : join(directory, entry.record.fileName),
      isOrphan: entry.isOrphan,
      isVerifiable: entry.isVerifiable,
    }
  }

  /**
   * The user's answer, and **the only thing that removes a staged download** (E constraint 15).
   *
   * An unverifiable one is discardable — that is the way out of it, and the reason the sweep lists
   * it rather than hiding it. A download **this process is still writing** is refused instead:
   * removing the directory would not stop Chromium writing to the path it was given, and the
   * terminal rewrite would put `download.json` straight back, so the "discard" would silently not
   * discard. The user waits for it to finish, or the app closes.
   */
  discard(downloadId: string): void {
    const entry = this.#staged.get(downloadId)
    if (!entry) {
      throw new AppError('NotFound', 'there is no staged download with that id', { downloadId })
    }
    if (!entry.isOrphan && entry.record.state === 'progressing') {
      throw new AppError('Conflict', 'that download is still running', { downloadId })
    }
    this.remove(downloadId)
  }

  /**
   * Removes a staged directory unconditionally.
   *
   * `discard` is the only caller today. Task 4's `land` is to be the second, and only **after the
   * upload has returned** — a failed upload leaves the directory where it is, so the user can try
   * again rather than losing the download to an error.
   *
   * The id is matched against the map first, whose keys are directories this process enumerated or
   * ids it minted, so the join below is on a value of its own making. `safeJoin` is a second bound
   * on that rather than the guard — the map lookup is the guard.
   */
  remove(downloadId: string): void {
    const entry = this.#staged.get(downloadId)
    if (!entry) return
    rmSync(safeJoin(this.#stagingDir, entry.record.downloadId), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
    this.#staged.delete(downloadId)
  }

  /* ---------------------------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------------------------ */

  /**
   * Which cap this download hits, as the sentence the user is told, or null for "stage it".
   *
   * **`totalBytes: 0` is worth one honest sentence.** A server that sends no `content-length`
   * reserves nothing at the moment it is admitted, because the only number available at
   * `will-download` is the one the server gave — so one download of unknown size can carry the
   * staging directory past 4 GiB before anything notices. What bounds it after that is real rather
   * than declared: {@link BrowseDownloads.#stagedBytes} counts a download in flight at the larger of
   * what it announced and what it has actually received, and `updated` keeps the second number
   * current — so the *next* download meets a ceiling that already includes the bytes this one has
   * landed. The concurrency cap is what bounds how many can be doing that at once.
   */
  #capRefusal(totalBytes: number): string | null {
    const inFlight = [...this.#staged.values()].filter(
      (entry) => !entry.isOrphan && entry.record.state === 'progressing',
    ).length
    if (inFlight >= MAX_CONCURRENT_DOWNLOADS) {
      return `${MAX_CONCURRENT_DOWNLOADS} downloads are already running; wait for one to finish`
    }
    if (totalBytes > MAX_DOWNLOAD_BYTES) {
      return `this download is larger than the 2 GiB limit for a single file (${totalBytes} bytes)`
    }
    if (this.#stagedBytes() + totalBytes > MAX_STAGED_BYTES) {
      return 'staged downloads would go past the 4 GiB limit; discard some to make room'
    }
    return null
  }

  /**
   * What the staging directory is holding, or is about to.
   *
   * A download in flight counts what it *will* be — the whole point of the ceiling is that it is
   * checked before the bytes arrive — and a finished one counts what is actually there.
   */
  #stagedBytes(): number {
    let total = 0
    for (const entry of this.#staged.values()) {
      total +=
        entry.record.state === 'progressing' && !entry.isOrphan
          ? Math.max(entry.record.totalBytes, entry.record.receivedBytes)
          : entry.bytesOnDisk
    }
    return total
  }

  /** True when the record is on disk. A write failure is reported, never thrown at Chromium. */
  #writeRecord(directory: string, record: BrowseDownloadRecord): boolean {
    try {
      writeJsonFile(join(directory, DOWNLOAD_RECORD_NAME), record, this.#io)
      return true
    } catch (error) {
      console.warn(`desktop: could not write ${DOWNLOAD_RECORD_NAME} for a staged download`, error)
      return false
    }
  }

  /**
   * Removes a directory **only when it holds nothing**.
   *
   * The one deletion in this file that is not the user's answer, and it is bounded to a directory
   * this process created microseconds earlier and failed to write into. Nothing that could be a
   * user's bytes is inside it — the emptiness check is what says so, rather than the timing.
   */
  #removeIfEmpty(directory: string): void {
    try {
      if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true, force: true })
    } catch {
      // Not there, or not readable. Either way there is nothing to tidy and nothing to report:
      // this is cleanup after a failure that has already been reported to the user.
    }
  }

  /** One directory, read back and judged. See {@link vouchesForTheBytes}. */
  #sweepOne(downloadId: string): Entry {
    const directory = join(this.#stagingDir, downloadId)
    const record = readRecord(directory, downloadId)
    if (record === null) {
      const found = bytesBeside(directory)
      return {
        record: unrecordedDownload(downloadId, directory, found),
        isOrphan: true,
        isVerifiable: false,
        bytesOnDisk: found.size,
      }
    }
    const bytesOnDisk = sizeOf(join(directory, record.fileName))
    return {
      record,
      isOrphan: true,
      // `false` for `observedTerminal`: this process did not see this download happen, which is
      // the entire reason the sweep exists and the entire reason `totalBytes: 0` fails here.
      isVerifiable: vouchesForTheBytes(record, bytesOnDisk, false),
      bytesOnDisk,
    }
  }
}

/* -------------------------------------------------------------------------------------------
 * Reading a directory back
 * ---------------------------------------------------------------------------------------- */

function isDownloadState(value: string): value is BrowseDownloadState {
  return (
    value === 'progressing' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'interrupted'
  )
}

/** The file's size, or 0 for a file that is not there. 0 never vouches for anything. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * `download.json`, or null for a file that is missing, unparseable, or not the shape it claims.
 *
 * Every one of those is the same verdict — unverifiable — so they are one return value. The field
 * checks are not paranoia about a file this app wrote: `userData` is a directory a person can edit,
 * and the alternative to checking is a `land` that reads `fileName` out of an object and joins it
 * onto a path.
 */
function readRecord(directory: string, downloadId: string): BrowseDownloadRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(directory, DOWNLOAD_RECORD_NAME), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as Record<string, unknown>
  const state = value['state']
  const fileName = value['fileName']
  if (typeof state !== 'string' || !isDownloadState(state)) return null
  // Re-sanitised on the way *in*, not only on the way out: this string becomes a path a moment
  // later, and the file it came from is one a person can edit.
  if (typeof fileName !== 'string' || stagedFileName(fileName) !== fileName) return null
  return {
    // The directory is the identity. A record naming a different id is a record that has been
    // moved or edited, and the directory is the thing that actually holds the bytes.
    downloadId,
    startedAt: numberOr(value['startedAt'], 0),
    fileName,
    sourceUrl: stringOr(value['sourceUrl'], ''),
    pageUrl: typeof value['pageUrl'] === 'string' ? value['pageUrl'] : null,
    siteId: typeof value['siteId'] === 'string' ? value['siteId'] : null,
    mimeType: stringOr(value['mimeType'], ''),
    hadUserGesture: value['hadUserGesture'] === true,
    totalBytes: numberOr(value['totalBytes'], 0),
    state,
    receivedBytes: numberOr(value['receivedBytes'], 0),
    library: typeof value['library'] === 'string' ? value['library'] : null,
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** The largest file in the directory that is not the record, for a directory that has no record. */
function bytesBeside(directory: string): { name: string; size: number } {
  let best = { name: '', size: 0 }
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return best
  }
  for (const name of entries.sort()) {
    if (name === DOWNLOAD_RECORD_NAME) continue
    const size = sizeOf(join(directory, name))
    if (best.name === '' || size > best.size) best = { name, size }
  }
  return best
}

/**
 * A record for a directory that has none — so that the user can be shown the thing they are being
 * asked to decide about.
 *
 * **Three of these fields are stand-ins and are not readings of anything**, said plainly rather
 * than left to be discovered: `state: 'interrupted'` is the DTO's nearest non-success value and not
 * a state anything observed; `startedAt` is the directory's own mtime, which is when it was last
 * written and not when a download started; and `receivedBytes` is what is on disk now. Nothing may
 * branch on any of them. **`isVerifiable: false` is the field that carries the verdict**, and it is
 * what `land` refuses on.
 */
function unrecordedDownload(
  downloadId: string,
  directory: string,
  found: { name: string; size: number },
): BrowseDownloadRecord {
  return {
    downloadId,
    startedAt: Math.round(mtimeOf(directory)),
    fileName: found.name,
    sourceUrl: '',
    pageUrl: null,
    siteId: null,
    mimeType: '',
    hadUserGesture: false,
    totalBytes: 0,
    state: 'interrupted',
    receivedBytes: found.size,
    library: null,
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
