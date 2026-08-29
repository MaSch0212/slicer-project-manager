import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createDecorators } from '@spm/contract/decorate.ts'
import type { FileDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema } from '@spm/contract/schemas.ts'
import { contentTypeFor, uploadFile } from '@spm/core'
import type { DesktopSession } from '../library.ts'
import { remoteUpload, requireRemote, type RemoteProxy } from '../slicers/remote-files.ts'
import { FILE_URL_BASE } from '../urls.ts'
import type { StagedDownload } from './downloads.ts'

/**
 * Turning a staged download into a file in one of the user's projects (spec E 5.4).
 *
 * ## Three properties, and each of them is structural rather than careful
 *
 * **The bytes never cross IPC.** They are already main-process side — `BrowseDownloads` put them
 * under `userData` — and the renderer names two ids. There is no argument on this path that could
 * carry a path, so C's constraint 4 and the parent's "bulk bytes never cross a JSON boundary" are
 * satisfied by the shape of the call and not by anything this file remembers to do.
 *
 * **The upload is `files.upload`'s own use case, in both modes.** Locally that is core's
 * `uploadFile` — so parent §5.6's quota check, the exclusive `open('wx')` and the `Conflict` on a
 * name that is taken all come free, and `packages/core` is not edited (constraint 2). Remotely it
 * is `remoteUpload`, which posts through `RemoteHost.proxy` with the session cookie, the
 * `UPLOAD_LENGTH_HEADER` the server's quota check needs and the percent-encoded name. Neither is
 * reimplemented here; what this file adds is which one, under which name, at which size.
 *
 * **A record that cannot vouch for its bytes is refused before anything is opened** (constraint 14).
 * That is the whole reason task 3 exists in the shape it does: with `setSavePath()` in use Chromium
 * writes straight to the final path, so a truncated download sits at its final name with no marker
 * of any kind — measured at 26 214 400 of 41 943 040 bytes. The verdict is `StagedDownload`'s, made
 * where the bytes were counted; this file reads it and never recomputes it, because a second copy of
 * `vouchesForTheBytes` here would be a second copy of the policy one edit away from disagreeing.
 *
 * ## What this file deliberately does not do
 *
 * **It does not auto-suffix a clashing name.** `uploadFile` throws `Conflict` when the name is taken
 * and that reaches the user unchanged (spec 5.4). `benchy-1.zip` beside `benchy.zip` hides the fact
 * that the user already has this model, which is precisely the thing they were trying to find out.
 * This is the opposite of D's returning-file rule, and the difference is whose name it is: there the
 * app produced the file, here the user chose it.
 *
 * **It does not re-verify the bytes at landing time**, and that is a judgement with a cost. The
 * verdict was reached when the download finished, or at the sweep that found it; a file truncated on
 * disk *after* that and before the user clicks Land would be uploaded at its new size. The cost of
 * closing it is a second implementation of the verdict — `vouchesForTheBytes` needs the
 * `observedTerminal` bit, which is the sweep's to know and not this file's — and the exposure is a
 * staging directory edited under a running app. `discard` is the way out, and `browse/downloads.ts`
 * records where that re-verification would go if a measurement ever justifies it.
 *
 * ## What is injected, and why
 *
 * Nothing here imports `electron`, and the remote half arrives as a `RemoteProxy` rather than as a
 * `RemoteHost`, exactly as `SlicerSessions` takes it — so `test/browse-land.test.ts` drives every
 * path under plain `node --test`, against a real library on disk, a real `BrowseDownloads` over a
 * real staging directory, and a real `RemoteHost` with its `fetch` injected.
 */

const { decorateFile } = createDecorators(FILE_URL_BASE)

/**
 * The part of `BrowseDownloads` this file uses, and all of it.
 *
 * Structural rather than the class, for the reason `RemoteProxy` is: a seam a real value cannot be
 * assigned to is a seam that only ever sees doubles. A real `BrowseDownloads` satisfies this
 * unchanged, and `app.ts` passes one — the tests pass one too, rather than a double, because a
 * double of `find` would be a second implementation of the verdict this file exists to obey.
 */
export type StagedDownloads = {
  find(downloadId: string): StagedDownload | null
  remove(downloadId: string): void
}

export type BrowseLandingOptions = {
  downloads: StagedDownloads
  /** The three halves of the shell, resolved **per call** — all of them change at runtime. */
  session(): DesktopSession | null
  isRemote(): boolean
  remote(): RemoteProxy | null
}

export class BrowseLanding {
  readonly #downloads: StagedDownloads
  readonly #session: () => DesktopSession | null
  readonly #isRemote: () => boolean
  readonly #remote: () => RemoteProxy | null

  constructor(options: BrowseLandingOptions) {
    this.#downloads = options.downloads
    this.#session = options.session
    this.#isRemote = options.isRemote
    this.#remote = options.remote
  }

  /**
   * Adds a staged download to a project as a new file, and removes the staging directory after.
   *
   * **In this order, and the order is the whole of the data-loss rule.** The refusal comes before
   * the name, the name before the `stat`, the `stat` before the upload, and the removal only once
   * the upload has *returned*. A failed upload leaves the directory exactly where it was, so the
   * user tries again rather than losing the download to an error — the same reasoning that makes
   * `SlicerSessions.resolve` sweep after the import and not before it.
   *
   * The id is never joined onto a path here. `find` looks it up in a map whose keys are directories
   * the main process enumerated or ids it minted, and answers `null` for anything else — so a
   * `downloadId` of `../../etc/passwd` is a `NotFound`, not a traversal, because there is no
   * arithmetic for it to traverse through.
   */
  async land(
    downloadId: string,
    projectId: string,
    opts: { name?: string } = {},
  ): Promise<FileDto> {
    const staged = this.#downloads.find(downloadId)
    if (staged === null) {
      throw new AppError('NotFound', 'there is no staged download with that id', { downloadId })
    }
    // **Constraint 14, and before anything is opened.** Not "before the upload": before the name is
    // resolved, before the file is statted and before a project is looked up, because every one of
    // those is a step that could fail for a different reason and hide this one.
    if (!staged.isVerifiable) {
      throw new AppError('Conflict', whyUnlandable(staged), { downloadId })
    }
    const name = nameFor(staged, opts.name)
    const sizeBytes = sizeOnDisk(staged.filePath)
    const landed = await this.#upload(projectId, name, staged.filePath, sizeBytes)
    // Only now, and only for an upload that returned. See the docblock above.
    this.#downloads.remove(downloadId)
    return landed
  }

  /**
   * The two implementations of one operation, chosen per call.
   *
   * Both stream off disk and both land on the same core use case with the same quota check —
   * `SlicerSessions.#upload` is the same pair for the same reason, and this is deliberately shaped
   * like it rather than sharing an abstraction with it: the two differ in which directory the bytes
   * are in and what the name is derived from, which is all of what either of them is.
   */
  async #upload(
    projectId: string,
    name: string,
    path: string,
    sizeBytes: number,
  ): Promise<FileDto> {
    // The caller builds the stream: `remoteUpload` takes a `ReadableStream` and a size and does not
    // read a directory. `createReadStream` is chunked, so a 2 GiB archive costs a 64 KiB buffer.
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
    if (this.#isRemote()) {
      return await remoteUpload(
        requireRemote(this.#remote()),
        projectId,
        name,
        stream,
        sizeBytes,
        contentTypeFor(name),
      )
    }
    const session = this.#session()
    if (session === null) {
      throw new AppError('Conflict', 'no library folder is open')
    }
    return decorateFile(
      await uploadFile(session.lib, session.ctx, projectId, name, { stream, sizeBytes }),
    )
  }
}

/**
 * Which of constraint 14's four cases refused this download, as the sentence the user is told.
 *
 * **This function decides nothing.** `isVerifiable` is the verdict and it was reached where the
 * bytes were counted; every branch below returns a refusal, so a bug here can make the message
 * wrong and can never make an unlandable download land.
 *
 * The four are the four `vouchesForTheBytes` and the sweep produce, in the order they are reached:
 * **no record that could be read** — which is one sentence for two directories, one with no
 * `download.json` beside the bytes at all and one whose `download.json` is unparseable or not the
 * shape it claims, and it is phrased about the *reading* because that is the only one of the two
 * this side can tell, and it is true of both; a record that never reached `completed`; a
 * `completed` record whose server declared no size, which a sweep has nothing to check against; and
 * a `completed` record whose bytes are not the size it declared.
 *
 * `hasRecord` is read rather than `state`, and that is the reason it exists: `unrecordedDownload`
 * fills in `state: 'interrupted'` as a stand-in and says in as many words that nothing may branch on
 * it, so "this download did not finish" about a directory that never had a record would be a
 * sentence with no reading behind it.
 *
 * **Nothing a stranger wrote is interpolated into any of these** (constraint 13). The only values
 * that reach the text are `state`, one of four literals, and `totalBytes`, a number — not
 * `fileName`, not `sourceUrl` and not `pageUrl`, all three of which are a website's strings and are
 * the renderer's to truncate and render as text. An `AppError`'s message is shown by whatever
 * catches it, and this one has no reason to carry them: the caller already knows which download it
 * asked about.
 */
function whyUnlandable(staged: StagedDownload): string {
  if (!staged.hasRecord) {
    return 'no record of this download could be read, so nothing can say whether these bytes are complete'
  }
  if (staged.record.state !== 'completed') {
    return `that download ended as ${staged.record.state}, so its bytes are not the whole file`
  }
  if (staged.record.totalBytes === 0) {
    return 'that download declared no size and this app did not watch it finish, so nothing can vouch for its bytes'
  }
  return `that download is not the ${staged.record.totalBytes} bytes it declared, so it is not the whole file`
}

/**
 * The name the file lands under: the user's, or the one the download arrived with.
 *
 * Validated here as well as in `dispatch.ts`, and the two are not the same check. That one is the
 * IPC boundary's, on a string the renderer sent; this one also covers `record.fileName`, which comes
 * off a file under `userData` that a person can edit. `readRecord` refuses a record whose `fileName`
 * is not already what `stagedFileName` would produce — so this is the second of two, and it is here
 * because `land` is callable from the main process without going through either.
 */
function nameFor(staged: StagedDownload, requested: string | undefined): string {
  const parsed = fileNameSchema.safeParse(requested ?? staged.record.fileName)
  if (!parsed.success) {
    throw new AppError('Validation', 'that is not a name a file can have', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

/**
 * The size to declare, **read off the file and never off the record**.
 *
 * `totalBytes` is `0` for every server that sent no `content-length`, and a download with one of
 * those is landable — task 3's relaxation admits it after comparing the bytes Chromium counted
 * against the bytes at the path. Declaring `0` for it would send the whole archive under a
 * `content-length: 0`, which the server's quota check would wave through and undici would then
 * either truncate or reject.
 *
 * A file that is no longer there is a `NotFound` rather than an `ENOENT` normalised to `Internal`:
 * the verdict was reached at the sweep or at `done`, and a user who deleted the staging directory
 * by hand since then has done something ordinary that the UI can say a sentence about.
 */
function sizeOnDisk(path: string): number {
  try {
    return statSync(path).size
  } catch {
    throw new AppError('NotFound', 'the bytes of that download are no longer where it staged them')
  }
}
