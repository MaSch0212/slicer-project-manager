import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { FileDto, SlicerId, SlicerSessionDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema } from '@spm/contract/schemas.ts'
import { createDecorators } from '@spm/contract/decorate.ts'
import {
  classifyFile,
  contentTypeFor,
  diffDigests,
  entryDigests,
  entryHash,
  getProject,
  readsAsZip,
  uploadFile,
  type EntryDiff,
} from '@spm/core'
import { writeJsonFile } from '../json-store.ts'
import type { DesktopSession } from '../library.ts'
import { FILE_URL_BASE } from '../urls.ts'
import { LAUNCH_RECORD_NAME, type LaunchedSession, type SlicerLaunchRecord } from './launch.ts'
import { isSlicerId } from './registry.ts'
import { remoteProject, remoteUpload, requireRemote, type RemoteProxy } from './remote-files.ts'

/**
 * What became of the files this app handed to slicers — the watch, the comparison, the sweeps and
 * the reconcile (spec D 6.3 and 7.2–7.4).
 *
 * ## The one rule everything here is arranged around
 *
 * **Nothing is deleted that the app has not compared and the user has not seen** (constraint 10).
 * There is no dependable "slicer closed" signal and no sweep can manufacture one: with
 * `single_instance` on, the process this app spawned hands the file over and exits while the
 * slicer stays open, so an exit is a reason to start watching a clock and never a conclusion. Two
 * rules replace the tempting third:
 *
 * 1. **Only the user's answer, or an observed-and-settled exit, removes a file.** The exit sweep
 *    may delete only a file that is *still byte-identical to what this app itself wrote there*
 *    after a settle period — so what it deletes is a copy whose every byte the app can reproduce,
 *    and the user loses nothing even when the slicer really was still open. **The sweep at next
 *    start surfaces and deletes nothing at all.**
 * 2. **A file with no record is an unfinished session, not litter.** Whatever the app deletes, the
 *    next Ctrl+S can put back complete at the same path — measured — so a file found here with
 *    nothing to explain it is offered to the user rather than swept. That is what makes rule 1
 *    survivable rather than merely optimistic.
 *
 * And `launch.json` outlives the file it describes, gaining a `sweptAt`, for {@link
 * SWEPT_RECORD_TTL_MS}. A file recreated at that path then lands beside a record naming its
 * project, its source file and its slicer, and the reconcile is fully informed instead of asking
 * the user to remember.
 *
 * ## The watch is an optimisation; the comparison is the mechanism of record
 *
 * `fs.watch` and the poll below do exactly one thing that matters: they make the answer *ready*.
 * What decides whether anything came back is {@link entryHash} over the decompressed entries, and
 * `list()` recomputes it from disk every single time. A missed watch event therefore costs
 * promptness and never correctness — which is the property worth having, because `fs.watch` on a
 * network-backed `userData` is unmeasured (spec open question 6), and because Orca's save was
 * invisible to a 40 ms poll except as a completed change.
 *
 * **The poll is not redundant with the watch and must not be removed as such.** Open question 6
 * says so in as many words: the poll is the mechanism of record's scheduler, and the watch is the
 * thing that makes it feel instant.
 *
 * mtime is used in exactly one place — deciding whether a poll tick should bother hashing — and
 * never as an answer. It fails in both directions: the four in-place savers skip the write when
 * nothing is dirty, and Cura's re-save of unchanged content moved it.
 *
 * ## Two modes, one loop
 *
 * A launch directory holds a real local file whichever mode the library is in, so everything above
 * is mode-blind. Only the *ends* differ: remote mode downloaded the file through
 * `RemoteHost.proxy` (see `launch.ts`), and an import pushes it back the same way instead of
 * calling core. Both are streamed main-process side; the bytes never round-trip through the
 * window.
 *
 * Nothing here imports `electron`, so `test/slicers-sessions.test.ts` drives every path — the
 * sweeps, the settle window, the diff and both uploads — under plain `node --test`.
 */

/* -------------------------------------------------------------------------------------------
 * The numbers, and which of them are measurements
 * ---------------------------------------------------------------------------------------- */

/**
 * How long a `launch.json` outlives the file it describes. **A judgement, not a measurement**,
 * written down here so a later change knows it was chosen.
 *
 * What it buys: a file recreated at the launch path — which row 20 says the next Ctrl+S will do —
 * lands beside something that still says which project and which source file it came from. What
 * it costs: a few hundred bytes per launch. The record is the only thing that makes an orphan
 * actionable, so the balance is not close.
 */
export const SWEPT_RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * After this long with no activity a session is *listed as stale* — listed, never deleted.
 * **Also a judgement, not a measurement.**
 *
 * The renderer applies it, because the only thing it needs is `startedAt`, which every session
 * carries. It is exported so the one number has one home.
 */
export const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a file may go on being unreadable before the app says so rather than waiting.
 *
 * **The scale is Cura's non-atomic write**: measured at 0 bytes and an exclusive lock for at least
 * six seconds (spike row 12). Sixty seconds is an order of magnitude past the only measurement
 * there is, which is the right side to err on — the cost of waiting too long is a stale label, and
 * the cost of giving up too early is reporting a live save as a broken file.
 */
export const SETTLE_WINDOW_MS = 60_000

/** How often the settle loop re-reads a file that is mid-write. */
export const SETTLE_INTERVAL_MS = 500

/**
 * How long after the spawned process exits the exit sweep waits before comparing.
 *
 * **A judgement chosen against Cura's six-second lock, not a measurement.** Even at the end of it
 * the comparison is not proof the slicer has finished — see rule 1 in the module docblock for what
 * actually makes the deletion safe.
 */
export const EXIT_SETTLE_MS = 10_000

/** The low-frequency poll, while a session is live. Deliberately slow: it is a backstop. */
export const POLL_INTERVAL_MS = 5_000

/**
 * How long after an `fs.watch` event the first comparison runs.
 *
 * A slicer writing an archive produces a burst of events, and comparing on the first of them is
 * guaranteed to read a partial file. This is not the settle *window* — a read that is still
 * partial after it simply becomes the first tick of {@link SETTLE_INTERVAL_MS}.
 */
export const WATCH_DEBOUNCE_MS = 400

/** Every ZIP begins with these two bytes. See {@link probeFile} for what they are used for. */
const ZIP_MAGIC = [0x50, 0x4b] as const

/* -------------------------------------------------------------------------------------------
 * The options
 * ---------------------------------------------------------------------------------------- */

/** What `fs.watch` gives this module, and all of it. Injected so the watch itself is assertable. */
export type DirectoryWatcher = { close(): void }
export type WatchDirectory = (directory: string, onChange: () => void) => DirectoryWatcher

export type SlicerSessionsOptions = {
  /** `<userData>/slicer-sessions`. May not exist; nothing here creates it. */
  sessionsDir: string
  /** The library open **right now**, resolved per call, exactly as the launcher resolves it. */
  session: () => DesktopSession | null
  /** Whether the shell is pointed at a server rather than at a folder. */
  isRemote: () => boolean
  /** The server, for the remote import. Null in local mode. */
  remote: () => RemoteProxy | null
  now?: () => number
  watch?: WatchDirectory
  settleWindowMs?: number
  settleIntervalMs?: number
  exitSettleMs?: number
  pollIntervalMs?: number
  watchDebounceMs?: number
  /** `setTimeout`/`setInterval`, injected so a test drives the clock instead of waiting on it. */
  timers?: SessionTimers
}

/**
 * The two schedulers, narrowed to what this module calls.
 *
 * Injected rather than taken from the global, because the alternative in a test is a real
 * ten-second wait per exit-sweep assertion. `unref` is optional and is called where it exists: a
 * poll that keeps the event loop alive would stop `node --test` exiting, and in Electron it would
 * keep a background timer running for a session nobody is watching.
 */
export type SessionTimers = {
  setTimeout(handler: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(handler: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export type TimerHandle = { unref?: () => unknown } | number

const NODE_TIMERS: SessionTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
}

/* -------------------------------------------------------------------------------------------
 * What one enumerated session is, inside this module
 * ---------------------------------------------------------------------------------------- */

/**
 * A session as the enumerator found it, DTO plus the two things the DTO deliberately does not
 * carry: where the file is, and the record beside it.
 *
 * **The path never crosses the IPC boundary and is never accepted across it either.**
 * `resolveSession` looks its argument up in a freshly enumerated list rather than joining it onto
 * the sessions directory, so the only paths this module ever touches are ones it found itself
 * (constraint 4). There is no traversal to defend against because there is no arithmetic.
 */
type Session = {
  dto: SlicerSessionDto
  path: string
  directory: string
  record: SlicerLaunchRecord | null
}

/** What a read of the file on disk found. See {@link probeFile}. */
type Probe =
  | { state: 'gone' }
  | { state: 'settling'; why: string }
  | { state: 'ready'; hash: string; sizeBytes: number }

type Tracked = {
  launchId: string
  path: string
  launchedHash: string
  /** Whether the process this app spawned is still running. Never "the slicer is open". */
  alive: boolean
  watcher: DirectoryWatcher | null
  poll: TimerHandle | null
  pending: TimerHandle | null
  /** The last (mtime, size) a poll saw — the mtime *hint*, and nothing more. */
  lastSeen: { mtimeMs: number; sizeBytes: number } | null
}

const { decorateFile } = createDecorators(FILE_URL_BASE)

/* -------------------------------------------------------------------------------------------
 * The host
 * ---------------------------------------------------------------------------------------- */

export class SlicerSessions {
  readonly #sessionsDir: string
  readonly #session: () => DesktopSession | null
  readonly #isRemote: () => boolean
  readonly #remote: () => RemoteProxy | null
  readonly #now: () => number
  readonly #watch: WatchDirectory
  readonly #settleWindowMs: number
  readonly #settleIntervalMs: number
  readonly #exitSettleMs: number
  readonly #pollIntervalMs: number
  readonly #watchDebounceMs: number
  readonly #timers: SessionTimers

  /** Live launches, by `launchId`. Empty at start-up: a previous run's sessions are not tracked. */
  readonly #tracked = new Map<string, Tracked>()

  /**
   * When each path was first seen unreadable, which is what makes the settle window a *window*.
   *
   * It lives here rather than in `#tracked` on purpose: an untracked session — one from a previous
   * run, or an orphan — settles on exactly the same clock, driven by nothing more than the user
   * looking at the list. Cleared the moment a read succeeds, so a file that goes unreadable twice
   * gets a fresh window each time rather than inheriting a spent one.
   */
  readonly #unsettledSince = new Map<string, number>()

  /** See `comparisonCount`. Incremented by the watch and the poll, never by `list()`. */
  #comparisons = 0

  constructor(options: SlicerSessionsOptions) {
    this.#sessionsDir = options.sessionsDir
    this.#session = options.session
    this.#isRemote = options.isRemote
    this.#remote = options.remote
    this.#now = options.now ?? Date.now
    this.#watch = options.watch ?? nodeWatch
    this.#settleWindowMs = options.settleWindowMs ?? SETTLE_WINDOW_MS
    this.#settleIntervalMs = options.settleIntervalMs ?? SETTLE_INTERVAL_MS
    this.#exitSettleMs = options.exitSettleMs ?? EXIT_SETTLE_MS
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.#watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS
    this.#timers = options.timers ?? NODE_TIMERS
  }

  /* -----------------------------------------------------------------------------------------
   * Listing
   * -------------------------------------------------------------------------------------- */

  /**
   * Every session under `slicer-sessions/`, compared afresh.
   *
   * This is the mechanism of record. It reads the directory, re-hashes every file it finds and
   * builds the answer from what is there — it consults the watch for exactly one field,
   * `processAlive`, which is the one fact only the spawner can know.
   */
  list(): SlicerSessionDto[] {
    return this.#scan().map((session) => session.dto)
  }

  /**
   * The sweep at next start: **it surfaces, and it deletes nothing.**
   *
   * The two things it does remove are, by inspection, incapable of losing anything. A directory
   * that is completely empty was a `mkdir` a crash interrupted before the copy — there is nothing
   * in it and nothing to put back. A `launch.json` whose file this app itself swept, more than
   * {@link SWEPT_RECORD_TTL_MS} ago, is a memory whose file was byte-identical to what the app
   * wrote when it went; keeping it for ever would mean `userData` growing by a record per launch
   * for the life of the installation.
   *
   * **It never touches a directory that holds a file.** That is the assertion
   * `test/slicers-sessions.test.ts` makes directly, because it is the rule the first draft of the
   * spec got wrong.
   *
   * **It counts by enumeration and deliberately does not call `list()`.** This runs before the
   * window is created, and `list()` re-hashes every file under `slicer-sessions/` — decompressing
   * every entry of every archive, and whole-file SHA-256 for anything that is not one. A remote
   * `.stl` launch copies the mesh into a launch directory and the reference library reaches
   * 674 MB, so the old version blocked start-up on hashing that, for one `console.info`. Nothing
   * above needs the answer; the count is a readdir.
   */
  sweepAtStart(): number {
    if (!existsSync(this.#sessionsDir)) return 0
    for (const entry of readdirSync(this.#sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(this.#sessionsDir, entry.name)
      const contents = readdirSync(directory)
      if (contents.length === 0) {
        rmSync(directory, { recursive: true, force: true })
        continue
      }
      if (contents.length !== 1 || contents[0] !== LAUNCH_RECORD_NAME) continue
      const record = readRecord(join(directory, LAUNCH_RECORD_NAME))
      if (record === null) continue
      const since = record.sweptAt ?? record.startedAt
      if (this.#now() - since > SWEPT_RECORD_TTL_MS) {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    const surfaced = this.#countSurfaced()
    if (surfaced > 0) {
      console.info(
        `desktop: ${surfaced} slicer session(s) are waiting to be answered; nothing was deleted`,
      )
    }
    return surfaced
  }

  /**
   * How many sessions `list()` would produce, without reading a byte of any of them.
   *
   * It walks the same two shapes `#scan` does and counts the same files, which is what makes the
   * two agree — a session is one file that is not a `launch.json`, wherever it sits. What it
   * cannot say is anything about *state*, which is exactly the part that costs a hash and exactly
   * the part a start-up log line has no use for.
   */
  #countSurfaced(): number {
    let count = 0
    for (const entry of readdirSync(this.#sessionsDir, { withFileTypes: true })) {
      if (entry.isFile()) count += 1
      else if (entry.isDirectory()) {
        count += readdirSync(join(this.#sessionsDir, entry.name), { withFileTypes: true }).filter(
          (child) => child.isFile() && child.name !== LAUNCH_RECORD_NAME,
        ).length
      }
    }
    return count
  }

  /* -----------------------------------------------------------------------------------------
   * Answering a session
   * -------------------------------------------------------------------------------------- */

  /**
   * The user's answer, which is the only thing besides an observed-and-settled exit that removes
   * a file from a launch directory.
   *
   * `import` adds the file to a project as a **new** file and then sweeps it; `discard` sweeps it
   * without adding it. Nothing here substitutes: the returning file lands under a derived
   * non-clashing name, and deleting the original is a separate action with a control that already
   * exists. A cross-slicer round trip is lossy, so replacing the original would destroy the only
   * copy of something the user may not have meant to convert.
   *
   * A file that is still settling, or that has been unreadable for the whole window, is refused
   * rather than imported. Uploading half a write is the exact failure the settle window exists to
   * prevent, and a `Conflict` says so in a way the UI can act on.
   */
  async resolve(
    launchId: string,
    action: 'import' | 'discard',
    opts?: { projectId?: string },
  ): Promise<FileDto | null> {
    const session = this.#require(launchId)
    if (action === 'discard') {
      this.#sweep(session)
      return null
    }
    if (session.dto.fileState !== 'changed' && session.dto.fileState !== 'unchanged') {
      throw new AppError(
        'Conflict',
        session.dto.fileState === 'settling'
          ? 'that file is still being written; try again in a moment'
          : 'that file could not be read, so there is nothing to add to the library',
        { fileState: session.dto.fileState },
      )
    }
    // The record's project when there is one, and the user's answer only for a file with nothing
    // beside it to say where it belongs.
    const projectId = session.dto.projectId === '' ? (opts?.projectId ?? '') : session.dto.projectId
    if (projectId === '') {
      throw new AppError('Validation', 'say which project this file belongs to')
    }
    const added = await this.#import(session, projectId)
    // Only now. A sweep before the upload is a file destroyed on a failed upload, and this order
    // is the same reasoning that makes the reconcile add-then-delete rather than delete-then-add.
    this.#sweep(session)
    return added
  }

  /**
   * The bulk answer, over the stale ones. A session that has already gone is not a failure.
   *
   * **One enumeration for the whole list, and not one per id.** `#scan()` hashes every file it
   * finds, the channel permits 500 ids, and discarding fifty stale sessions was fifty full
   * enumerations — quadratic in the thing a bulk action exists to make cheap. Scanning once is
   * equivalent because a sweep only ever *removes* a session: nothing in the loop can make a
   * later id resolve to a different file than it would have at the start.
   */
  async discardMany(launchIds: readonly string[]): Promise<{ discarded: number }> {
    const wanted = new Set(launchIds)
    const found = this.#scan().filter((session) => wanted.has(session.dto.launchId))
    for (const session of found) this.#sweep(session)
    return await Promise.resolve({ discarded: found.length })
  }

  /* -----------------------------------------------------------------------------------------
   * The watch
   * -------------------------------------------------------------------------------------- */

  /**
   * Starts watching a launch this process just made.
   *
   * Everything it starts is an optimisation — see the module docblock — so every failure in here
   * is logged and swallowed. `fs.watch` throws on a directory that has already gone, is
   * unsupported on some network filesystems, and can emit an `error` long after it was created;
   * none of those is a reason to fail a launch that has already happened, and none of them costs
   * correctness, because `list()` reads the disk.
   */
  track(launch: LaunchedSession): void {
    this.#untrack(launch.launchId)
    const tracked: Tracked = {
      launchId: launch.launchId,
      path: launch.path,
      launchedHash: launch.launchedHash,
      alive: true,
      watcher: null,
      poll: null,
      pending: null,
      lastSeen: null,
    }
    this.#tracked.set(launch.launchId, tracked)

    try {
      tracked.watcher = this.#watch(launch.directory, () => this.#onChanged(tracked))
    } catch (error) {
      console.warn('desktop: could not watch a slicer launch directory', error)
    }
    tracked.poll = unref(
      this.#timers.setInterval(() => this.#onPoll(tracked), this.#pollIntervalMs),
    )
    // The exit is an observation, not a conclusion: it starts a settle period, and what the
    // sweep at the end of it may delete is bounded by `#exitSweep`.
    launch.child.once?.('exit', () => this.#onExit(tracked))
  }

  /** Stops every watcher and timer. Called when the shell is going away. */
  close(): void {
    for (const launchId of [...this.#tracked.keys()]) this.#untrack(launchId)
  }

  /** For tests and for the leak hunt: how many launches are being watched right now. */
  trackedCount(): number {
    return this.#tracked.size
  }

  /**
   * How many comparisons the watch and the poll have run between them.
   *
   * It exists because the mtime hint has no other observable consequence. A poll tick that
   * decides not to hash produces exactly the same `list()` as one that hashes and finds nothing —
   * so without this the branch that skips the hash is a branch no assertion could fail on, which
   * is the same as not having written it. `list()` does not touch this: it is the mechanism of
   * record and hashes unconditionally, and counting it here would make the number mean two things.
   */
  comparisonCount(): number {
    return this.#comparisons
  }

  #onChanged(tracked: Tracked): void {
    if (!this.#tracked.has(tracked.launchId)) return
    if (tracked.pending !== null) return
    tracked.pending = unref(
      this.#timers.setTimeout(() => {
        tracked.pending = null
        this.#settleStep(tracked)
      }, this.#watchDebounceMs),
    )
  }

  /**
   * One comparison, and another one scheduled if the file is still being written.
   *
   * The loop terminates by itself: `#stateOf` turns a read that has been failing for the whole
   * settle window into `unreadable`, which is not `settling`, so the last tick is the one that
   * gives up. Nothing here records the result — `list()` recomputes it — and that is the point:
   * this exists to spend the window, so that by the time anybody asks the answer is not "wait".
   */
  #settleStep(tracked: Tracked): void {
    if (!this.#tracked.has(tracked.launchId)) return
    this.#comparisons += 1
    const state = this.#stateOf(tracked.path, tracked.launchedHash)
    if (state !== 'settling' || tracked.pending !== null) return
    tracked.pending = unref(
      this.#timers.setTimeout(() => {
        tracked.pending = null
        this.#settleStep(tracked)
      }, this.#settleIntervalMs),
    )
  }

  /**
   * The poll, and the one place mtime is consulted.
   *
   * It is a **hint about whether to bother hashing**, never an answer: a tick that sees the same
   * (mtime, size) as the last one does nothing, and a tick that sees a difference runs the real
   * comparison. Correctness does not rest on it, because `list()` hashes unconditionally — so the
   * worst a missed mtime can do is delay the settle loop until the next event or the next `list()`.
   */
  #onPoll(tracked: Tracked): void {
    if (!this.#tracked.has(tracked.launchId)) return
    let seen: { mtimeMs: number; sizeBytes: number }
    try {
      const info = statSync(tracked.path)
      seen = { mtimeMs: info.mtimeMs, sizeBytes: info.size }
    } catch {
      // Gone, or momentarily unreadable. Either way there is nothing to compare this tick.
      return
    }
    const last = tracked.lastSeen
    tracked.lastSeen = seen
    if (last !== null && last.mtimeMs === seen.mtimeMs && last.sizeBytes === seen.sizeBytes) return
    this.#settleStep(tracked)
  }

  #onExit(tracked: Tracked): void {
    tracked.alive = false
    if (!this.#tracked.has(tracked.launchId)) return
    unref(this.#timers.setTimeout(() => this.#exitSweep(tracked), this.#exitSettleMs))
  }

  /**
   * The exit sweep — the one deletion the user did not ask for, and the narrowest one available.
   *
   * It removes the file **only** when the file is still byte-identical to what this app wrote
   * there, after the settle period. That is not a proof the slicer has finished, and it is not
   * meant to be: it is a guarantee that what is being deleted is a copy the app can reproduce, so
   * the user loses nothing if the slicer is in fact still open. A file that came back changed, one
   * still being written, and one that could not be read are all left exactly where they are, to be
   * answered by a person.
   *
   * The record stays and gains a `sweptAt`, so a save after this lands beside something that still
   * says which project the file came from.
   */
  #exitSweep(tracked: Tracked): void {
    if (!this.#tracked.has(tracked.launchId)) return
    if (this.#stateOf(tracked.path, tracked.launchedHash) !== 'unchanged') return
    const session = this.#scan().find((candidate) => candidate.dto.launchId === tracked.launchId)
    if (!session) return
    this.#sweep(session)
  }

  #untrack(launchId: string): void {
    const tracked = this.#tracked.get(launchId)
    if (!tracked) return
    this.#tracked.delete(launchId)
    tracked.watcher?.close()
    if (tracked.poll !== null) this.#timers.clearInterval(tracked.poll)
    if (tracked.pending !== null) this.#timers.clearTimeout(tracked.pending)
  }

  /* -----------------------------------------------------------------------------------------
   * Enumeration
   * -------------------------------------------------------------------------------------- */

  /**
   * Every session there is, built from the directory as it is right now.
   *
   * Two shapes reach here. A **directory** is one launch: its `launch.json` names the file that
   * was handed over, and that file is the session. A **loose file** directly under
   * `slicer-sessions/` has no launch it could belong to and is an orphan on its own.
   *
   * And the third case, which is the one row 13 says should not happen: a file inside a launch
   * directory that is neither `launch.json` nor the file that was launched. It is **reported, not
   * adopted** — reported as a session of its own that a person has to answer, and never mistaken
   * for the file the record describes. The commonest way to produce one is a Cura Save-As aimed at
   * the launch directory under a name of the user's choosing, and sweep rule 2 is precisely that
   * such a file is never litter.
   */
  #scan(): Session[] {
    if (!existsSync(this.#sessionsDir)) return []
    const sessions: Session[] = []
    for (const entry of readdirSync(this.#sessionsDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        sessions.push(this.#orphan(entry.name, this.#sessionsDir, entry.name, null))
        continue
      }
      if (!entry.isDirectory()) continue
      const directory = join(this.#sessionsDir, entry.name)
      const record = readRecord(join(directory, LAUNCH_RECORD_NAME))
      const files = readdirSync(directory, { withFileTypes: true })
        .filter((child) => child.isFile() && child.name !== LAUNCH_RECORD_NAME)
        .map((child) => child.name)
      for (const name of files) {
        if (record !== null && name === record.fileName) {
          sessions.push(this.#launched(entry.name, directory, record))
        } else {
          if (record !== null) {
            console.warn(
              `desktop: ${entry.name} holds "${name}", which is not the file it was launched with; ` +
                'it is listed as a session of its own rather than adopted',
            )
          }
          sessions.push(this.#orphan(`${entry.name}/${name}`, directory, name, record))
        }
      }
    }
    return sessions
  }

  /** The file a `launch.json` describes: everything the DTO can carry is known for this one. */
  #launched(launchId: string, directory: string, record: SlicerLaunchRecord): Session {
    const path = join(directory, record.fileName)
    const { state: fileState, sizeBytes } = this.#inspect(path, record.launchedHash)
    const settled = fileState === 'unchanged' || fileState === 'changed'
    const returned = settled ? classifyFile(path).slicer : null
    const sourceSlicer = record.sourceSlicer ?? null
    const dto: SlicerSessionDto = {
      launchId,
      projectId: record.projectId,
      fileId: record.fileId,
      fileName: record.fileName,
      slicerId: record.slicerId,
      startedAt: record.startedAt,
      processAlive: this.#tracked.get(launchId)?.alive ?? false,
      fileState,
      isOrphan: false,
      sourceSlicer,
      ...(fileState === 'changed' && returned !== sourceSlicer ? { returnedAs: returned } : {}),
      ...(record.sourceSizeBytes === undefined ? {} : { sourceSizeBytes: record.sourceSizeBytes }),
      // From the same read the state came from, rather than a second `stat`: a file that vanished
      // between the two would otherwise throw out of `list()` and take every other session with it.
      ...(sizeBytes === undefined ? {} : { returnedSizeBytes: sizeBytes }),
      ...(fileState === 'changed' && record.launchedEntries !== undefined
        ? { entryDiff: diffOf(record.launchedEntries, path) }
        : {}),
    }
    return { dto, path, directory, record }
  }

  /**
   * A file with no record of its own.
   *
   * `record` is the record of the launch whose directory it turned up in, when there is one — a
   * Cura Save-As under a different name knows which project it came from even though it is not
   * the file that was launched, and asking the user a question the app can already answer would be
   * a worse kind of honesty. `isOrphan` stays true either way, because what makes it an orphan is
   * having no record *of its own*: nothing says this file is the one that was handed over.
   *
   * `slicerId` is the file's own classification, and it is the one place in this DTO that can be
   * null. There is genuinely nothing else to put there — an `.stl` that came back names no slicer
   * at all — and the alternatives were to invent a product the app has no evidence for, or to drop
   * the file from the list, which is the one thing sweep rule 2 forbids.
   */
  #orphan(
    launchId: string,
    directory: string,
    name: string,
    record: SlicerLaunchRecord | null,
  ): Session {
    const path = join(directory, name)
    const { state: fileState, sizeBytes: returnedSizeBytes } = this.#inspect(path, null)
    let startedAt = record?.startedAt ?? 0
    try {
      // When it appeared, which is the only "started" an orphan has.
      startedAt = record?.startedAt ?? Math.round(statSync(path).mtimeMs)
    } catch {
      // Removed between the readdir and here. It simply reports what it can.
    }
    const dto: SlicerSessionDto = {
      launchId,
      projectId: record?.projectId ?? '',
      fileId: '',
      fileName: name,
      slicerId:
        fileState === 'unchanged' || fileState === 'changed' ? classifyFile(path).slicer : null,
      startedAt,
      processAlive: false,
      fileState,
      isOrphan: true,
      ...(returnedSizeBytes === undefined ? {} : { returnedSizeBytes }),
    }
    return { dto, path, directory, record }
  }

  #require(launchId: string): Session {
    const session = this.#scan().find((candidate) => candidate.dto.launchId === launchId)
    if (!session) throw new AppError('NotFound', 'no such slicer session', { launchId })
    return session
  }

  /* -----------------------------------------------------------------------------------------
   * The comparison
   * -------------------------------------------------------------------------------------- */

  /**
   * What the file at `path` is, against the hash of what was launched.
   *
   * The settle window lives here rather than in the watch, so a session nothing is tracking — one
   * left by a previous run, an orphan — ages on exactly the same clock, driven by nothing more
   * than somebody looking at the list.
   *
   * `launchedHash` is null for an orphan, which has nothing to be compared against. `changed` is
   * the honest answer for one: something is there, and the app did not put it there.
   */
  #stateOf(path: string, launchedHash: string | null): SlicerSessionDto['fileState'] {
    return this.#inspect(path, launchedHash).state
  }

  /** The same answer, with the size the read already found. `undefined` unless it settled. */
  #inspect(
    path: string,
    launchedHash: string | null,
  ): { state: SlicerSessionDto['fileState']; sizeBytes?: number } {
    const probe = probeFile(path)
    if (probe.state === 'settling') {
      const since = this.#unsettledSince.get(path) ?? this.#now()
      this.#unsettledSince.set(path, since)
      if (this.#now() - since < this.#settleWindowMs) return { state: 'settling' }
      console.warn(
        `desktop: gave up reading ${basename(path)} after the settle window: ${probe.why}`,
      )
      return { state: 'unreadable' }
    }
    this.#unsettledSince.delete(path)
    // A file that vanished under the enumerator. Nothing can be said about it, and it will be
    // absent from the next list.
    if (probe.state === 'gone') return { state: 'unreadable' }
    if (launchedHash === null) return { state: 'changed', sizeBytes: probe.sizeBytes }
    return {
      state: probe.hash === launchedHash ? 'unchanged' : 'changed',
      sizeBytes: probe.sizeBytes,
    }
  }

  /* -----------------------------------------------------------------------------------------
   * Import and sweep
   * -------------------------------------------------------------------------------------- */

  /**
   * Adds the returning file to a project, under a derived name that does not clash.
   *
   * Two implementations of one operation, because in remote mode the bytes are already
   * main-process side and must not detour through the renderer: locally this is core's own
   * `uploadFile`, and remotely it is a proxied `POST /api/projects/:id/files`. Both stream off
   * disk, and both land on the same core use case with the same quota check.
   */
  async #import(session: Session, projectId: string): Promise<FileDto> {
    const taken = await this.#namesIn(projectId)
    const sizeBytes = statSync(session.path).size
    let name = derivedName(session.dto.fileName, this.#slicerFor(session), taken)
    // The probe above is not atomic with the write, and `uploadFile`'s own `Conflict` is the
    // backstop that makes that safe: nothing is written when it fires, so the answer is to take
    // the next ordinal and try again. Bounded, because a `Conflict` that is *not* about the name
    // would otherwise be an infinite loop.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#upload(projectId, name, session.path, sizeBytes)
      } catch (error) {
        if (attempt >= 8 || !(error instanceof AppError) || error.code !== 'Conflict') throw error
        taken.add(name)
        name = derivedName(session.dto.fileName, this.#slicerFor(session), taken)
      }
    }
  }

  /**
   * Which slicer the derived name is attributed to — **the returning file's, not the record's**.
   *
   * A round trip can change what a file *is*: a Bambu project opened in Orca and saved comes back
   * classified `orca`, and calling the result `bracket (bambu).3mf` because that is what the
   * record says would put the wrong product's name on it. So the file is classified again here,
   * rather than read off `returnedAs` — which is only set when the classification *differs* from
   * the source, and is therefore absent in exactly the ordinary case where the two agree.
   *
   * The record's own `slicerId` is the fallback for a file whose classification names nothing at
   * all — a stripped project, a mesh — because the product the app launched is then the best
   * thing it knows. An orphan has no record and falls through to no suffix, which is the honest
   * answer for a file nothing can attribute.
   */
  #slicerFor(session: Session): SlicerId | null {
    return classifyFile(session.path).slicer ?? session.record?.slicerId ?? null
  }

  async #namesIn(projectId: string): Promise<Set<string>> {
    if (this.#isRemote()) {
      const detail = await remoteProject(requireRemote(this.#remote()), projectId)
      return new Set(detail.files.map((file) => file.name))
    }
    const session = this.#requireLibrary()
    const detail = getProject(session.lib, session.ctx, projectId)
    return new Set(detail.files.map((file) => file.name))
  }

  async #upload(
    projectId: string,
    name: string,
    path: string,
    sizeBytes: number,
  ): Promise<FileDto> {
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
    const session = this.#requireLibrary()
    const core = await uploadFile(session.lib, session.ctx, projectId, name, { stream, sizeBytes })
    return decorateFile(core)
  }

  /**
   * Removes the file, and keeps the record that explains it.
   *
   * The record gaining a `sweptAt` rather than going with the file is the whole of the "a
   * recreated file lands beside a record" rule: four of five slicers save back in place, so the
   * next Ctrl+S puts a complete file at exactly this path, and what it finds beside it decides
   * whether the app can say which project it belongs to or has to ask.
   *
   * An orphan has no record to keep, so the directory it was in is removed once it holds nothing —
   * which cannot lose anything, because there is by then nothing in it.
   */
  #sweep(session: Session): void {
    rmSync(session.path, { force: true })
    this.#unsettledSince.delete(session.path)
    this.#untrack(session.dto.launchId)
    if (session.record !== null && session.dto.isOrphan === false) {
      writeJsonFile(join(session.directory, LAUNCH_RECORD_NAME), {
        ...session.record,
        sweptAt: this.#now(),
      } satisfies SlicerLaunchRecord)
      return
    }
    if (session.directory === this.#sessionsDir) return
    if (readdirSync(session.directory).length === 0) {
      rmSync(session.directory, { recursive: true, force: true })
    }
  }

  #requireLibrary(): DesktopSession {
    const session = this.#session()
    if (!session) throw new AppError('Conflict', 'no library folder is open')
    return session
  }
}

/* -------------------------------------------------------------------------------------------
 * The pieces, out of the class so they can be read on their own
 * ---------------------------------------------------------------------------------------- */

/**
 * One read of the file, and the three ways it can mean "not settled yet".
 *
 * - **0 bytes.** Cura's write was measured sitting at exactly this for at least six seconds.
 * - **A read that fails.** `EBUSY` and `EACCES` while another process holds the file, and an
 *   archive whose central directory parses but whose payload does not — a half-flushed entry
 *   behind an intact directory. `entryHash` throws for the last of those rather than inventing a
 *   hash, which is what makes it usable here.
 * - **A file whose first bytes say ZIP and whose central directory does not parse.** This one is
 *   the trap. `entryHash` falls back to a plain SHA-256 of the bytes when a file is not a readable
 *   ZIP, which is exactly right for an `.stl` and exactly wrong for a `.3mf` a slicer is halfway
 *   through writing: without this check the fallback would produce a perfectly plausible hash of
 *   half a file, and the app would report a change that has not finished happening — and then
 *   offer to upload it.
 *
 * The ZIP question is asked only of a file whose first two bytes claim to be one, so an `.stl` and
 * an `.obj` take the plain-hash path and never settle for ever. The bytes and not the extension,
 * because the extension is the user's and the magic is the writer's.
 */
function probeFile(path: string): Probe {
  let info
  try {
    info = statSync(path)
  } catch {
    return { state: 'gone' }
  }
  if (!info.isFile()) return { state: 'gone' }
  if (info.size === 0) return { state: 'settling', why: 'the file is still empty' }
  try {
    if (looksLikeZip(path) && !readsAsZip(path)) {
      return { state: 'settling', why: 'the archive directory does not parse yet' }
    }
    return { state: 'ready', hash: entryHash(path), sizeBytes: info.size }
  } catch (error) {
    return { state: 'settling', why: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether the first two bytes are `PK`. Throws what `probeFile` treats as "not settled yet". */
function looksLikeZip(path: string): boolean {
  const head = new Uint8Array(ZIP_MAGIC.length)
  const fd = openSync(path, 'r')
  let read: number
  try {
    read = readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  return read === head.length && ZIP_MAGIC.every((byte, index) => head[index] === byte)
}

/** The record beside a launched file, or null where there is none this build can read. */
function readRecord(path: string): SlicerLaunchRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Absent, or half-written by a crash. Either way the files beside it are orphans, which is
    // the safe reading: an orphan is offered to the user and never swept.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Partial<SlicerLaunchRecord>
  // Only the fields the reconcile cannot work without. Everything task 5 added is optional on
  // read, because a record written by a build that did not have it is still a record this one
  // understands — the session shows less, never something wrong.
  if (
    typeof record.launchId !== 'string' ||
    typeof record.projectId !== 'string' ||
    typeof record.fileId !== 'string' ||
    typeof record.fileName !== 'string' ||
    typeof record.launchedHash !== 'string' ||
    typeof record.startedAt !== 'number' ||
    !isSlicerId(record.slicerId)
  ) {
    console.warn(`desktop: ${path} is not a launch record this build can read`)
    return null
  }
  return record as SlicerLaunchRecord
}

/**
 * The entry-level diff between the file as launched and the file as it is now.
 *
 * It is computed against the digests in the record rather than against the library original,
 * because those are two different questions and only one of them is the user's. A `new-project`
 * launch hands over a *stripped* copy, so a diff against the original would report the app's own
 * strip as something the slicer did — every removed configuration entry attributed to the wrong
 * actor, in a list the user is about to make a decision from.
 */
function diffOf(launched: Record<string, string>, path: string): EntryDiff {
  return diffDigests(new Map(Object.entries(launched)), entryDigests(path))
}

/**
 * `bracket.3mf` from Orca becomes `bracket (orca).3mf`, then `bracket (orca) (2).3mf`.
 *
 * **Derived and non-clashing, never a substitution.** The original stays: a cross-slicer round
 * trip is measurably lossy, so replacing it would destroy the only copy of something the user may
 * not have meant to convert, and deleting it afterwards is a separate action with a control that
 * already exists.
 *
 * The ordinal starts at 2 and counts up, which is what makes a *second* round trip through the
 * same slicer work — the case where the naming actually has to do something. The extension is
 * preserved rather than assumed: the file that comes back is usually a `.3mf`, but an orphan need
 * not be one and a name that quietly changed its extension would be worse than a clumsy one.
 */
export function derivedName(
  fileName: string,
  slicerId: SlicerId | null,
  taken: ReadonlySet<string>,
): string {
  const extension = extname(fileName)
  const stem = extension === '' ? fileName : fileName.slice(0, -extension.length)
  const base = slicerId === null ? stem : `${stem} (${slicerId})`
  for (let ordinal = 1; ordinal < 1000; ordinal += 1) {
    const candidate = ordinal === 1 ? `${base}${extension}` : `${base} (${ordinal})${extension}`
    if (taken.has(candidate)) continue
    const parsed = fileNameSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new AppError('Validation', `${candidate} is not a name this library can hold`)
    }
    return parsed.data
  }
  throw new AppError('Conflict', `there are already too many files called "${base}"`)
}

/**
 * The real `fs.watch`, wrapped so the module's seam is two functions wide.
 *
 * `persistent: false` because a watcher that keeps the event loop alive would stop `node --test`
 * exiting and would hold Electron's main process open for a session nobody is looking at.
 * The `error` event is listened for rather than left to throw: `fs.watch` emits one when the
 * directory goes away underneath it, and an unhandled `error` on an `EventEmitter` takes the
 * process down.
 */
function nodeWatch(directory: string, onChange: () => void): DirectoryWatcher {
  const watcher = watch(directory, { persistent: false }, () => onChange())
  watcher.on('error', (error) => {
    console.warn('desktop: a slicer launch directory watcher failed', error)
  })
  return { close: () => watcher.close() }
}

function unref(handle: TimerHandle): TimerHandle {
  if (typeof handle !== 'number') handle.unref?.()
  return handle
}
