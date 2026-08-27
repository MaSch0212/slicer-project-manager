import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { LocalLibraryDto } from '@spm/contract/dtos.ts'
import { closeLibrary, ensureLocalUser, openLibrary, type Ctx, type Library } from '@spm/core'
import { startPreviewTicker, type PreviewTicker } from './previews.ts'

/**
 * Which folder is open, how it was chosen, and what happens when it is swapped.
 *
 * Separate from `app.ts` because `app.ts` imports `electron` at its top level and this is the
 * part worth testing exhaustively: the picker is injected as a function, so `test/library.test.ts`
 * drives first run, a remembered folder, a folder that has been deleted, one that has been
 * replaced by a file, a corrupt state file and a mid-run folder switch under plain `node --test`.
 * `app.ts` supplies the one implementation of that function that opens a native dialog.
 */

/** A library that is open, migrated, and has its single local user (spec 2.6). */
export type DesktopSession = { lib: Library; ctx: Ctx }

/**
 * Task 4 owns *choosing* the folder; this owns opening it. `openLibrary` already runs the
 * migrations (see db/open.ts), so there is no separate `runMigrations` call here — adding one
 * would be a no-op that reads as if it were doing something.
 */
export function openDesktopLibrary(dir: string): DesktopSession {
  const lib = openLibrary(dir)
  return { lib, ctx: ensureLocalUser(lib) }
}

export function closeDesktopLibrary(session: DesktopSession): void {
  closeLibrary(session.lib)
}

/** Names the library folder to open, overriding whatever is remembered. */
export const LIBRARY_DIR_ENV = 'SPM_LIBRARY_DIR'

/**
 * The environment override. Same variable the Deno server reads, on purpose.
 *
 * One source, the environment: a `--library=` switch was written first and then removed, because
 * nothing exercised it and an untested second path into the one thing that decides which folder
 * the app writes to is not worth the convenience. It is deliberately *not* remembered in
 * `state.json` — an operator's override for one launch is not a choice the user made in the app,
 * and writing it down would make the next launch inherit it invisibly.
 */
export function resolveLibraryDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env[LIBRARY_DIR_ENV]
  return fromEnv ? resolve(fromEnv) : null
}

/** The file under `app.getPath('userData')` that remembers the last folder. */
export const STATE_FILE_NAME = 'state.json'

/** Its one key so far. Task 5 adds the remote-server mode beside it, in the same object. */
export const REMEMBERED_DIR_KEY = 'libraryDir'

type ShellState = Record<string, unknown>

function readState(stateFile: string): ShellState {
  let text: string
  try {
    text = readFileSync(stateFile, 'utf8')
  } catch {
    // No file yet — first run, or a userData directory that has just been wiped.
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object')
    return parsed as ShellState
  } catch (error) {
    // A truncated or hand-edited state file must not stop the app from starting. Say so once:
    // silently treating it as empty would make the folder the user chose look forgotten with no
    // explanation anywhere.
    console.warn(`desktop: ignoring an unreadable ${STATE_FILE_NAME}`, error)
    return {}
  }
}

export function readRememberedDir(stateFile: string): string | null {
  const value = readState(stateFile)[REMEMBERED_DIR_KEY]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Remembers the folder, preserving anything else in the file.
 *
 * Read-modify-write rather than a fresh object: task 5 puts the shell's *mode* and a remote
 * server URL in this same file, and a writer that only knows about its own key would drop the
 * others every time the user changed folders.
 */
export function rememberDir(stateFile: string, dir: string): void {
  const state = readState(stateFile)
  state[REMEMBERED_DIR_KEY] = dir
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * What `dialog.showOpenDialog` is asked for. A folder, and the user may create one on the spot —
 * the folder they want for a brand-new library usually does not exist yet.
 */
export const FOLDER_PICKER_PROPERTIES = ['openDirectory', 'createDirectory'] as const

/** The picker's own title when there is nothing to explain. */
export const FOLDER_PICKER_TITLE = 'Choose a library folder'

export type FolderPickerOptions = {
  title: string
  message: string
  buttonLabel: string
  properties: readonly ('openDirectory' | 'createDirectory')[]
}

/**
 * The dialog options, built here rather than at the `dialog.showOpenDialog` call site so the
 * explanation and the properties are covered by a unit test instead of by a native modal.
 *
 * **This is where "returns to the picker with an explanation" is honoured.** The explanation
 * rides in the picker's own title, which is the one surface the user is certainly looking at when
 * it matters — a second modal in front of the first would have to be dismissed before they could
 * do the thing it is telling them to do. `message` carries it too because macOS ignores `title`
 * on an open dialog and shows `message` instead; on Windows and Linux `message` is ignored and
 * the title bar carries it. `LibraryHost` also writes the same sentence to stderr, so it survives
 * in a log the user can paste.
 */
export function folderPickerOptions(reason: string | null): FolderPickerOptions {
  return {
    title: reason ? `${FOLDER_PICKER_TITLE} — ${reason}` : FOLDER_PICKER_TITLE,
    message: reason ?? FOLDER_PICKER_TITLE,
    buttonLabel: 'Open',
    properties: FOLDER_PICKER_PROPERTIES,
  }
}

/**
 * Shows the picker and answers the chosen folder, or null when the user cancelled.
 *
 * A function and not `dialog` itself, so everything above and below this line is testable
 * without Electron running.
 */
export type FolderPicker = (options: FolderPickerOptions) => Promise<string | null>

/** Why the app is asking, when a folder was remembered and is not usable any more. */
export function missingFolderReason(dir: string, error?: unknown): string {
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `the last folder could not be opened (${dir}): ${message}`
  }
  return `the last folder is no longer there (${dir})`
}

/**
 * Where the library comes from at startup, decided before anything is opened.
 *
 * Three sources in a fixed order, and the order is the whole content of the function: an
 * environment override beats a remembered folder, and a remembered folder that is not a usable
 * directory any more is not a failure — it is a reason to ask.
 */
export type StartupPlan =
  { source: 'env' | 'remembered'; dir: string } | { source: 'picker'; reason: string | null }

export function planStartup(
  env: NodeJS.ProcessEnv,
  stateFile: string,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): StartupPlan {
  const fromEnv = resolveLibraryDir(env)
  if (fromEnv) return { source: 'env', dir: fromEnv }
  const remembered = readRememberedDir(stateFile)
  if (!remembered) return { source: 'picker', reason: null }
  // Deleted, renamed, on an unmounted drive, or replaced by a file — all one answer, because the
  // user's next step is the same in every case and none of them is a crash.
  if (!isDirectory(remembered)) {
    return { source: 'picker', reason: missingFolderReason(remembered) }
  }
  return { source: 'remembered', dir: remembered }
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

type OpenFolder = { dir: string; session: DesktopSession; ticker: PreviewTicker }

export type LibraryHostOptions = {
  /** `app.getPath('userData')/state.json` in the real shell. */
  stateFile: string
  pick: FolderPicker
  /**
   * Called after the open library has been replaced. The shell reloads its windows here: every
   * store in the renderer is holding data from a library that is no longer the one being served.
   */
  onChanged?: () => void
  /** Injected in tests so a slow preview run can be observed; the real shell takes the defaults. */
  startTicker?: (lib: Library) => PreviewTicker
}

/**
 * The one open library, and the only thing allowed to open or close one.
 *
 * Ruling C-12 already made the `spm://` handler and the IPC handler read the session through an
 * accessor rather than capture it, so switching folders needs no re-registration anywhere: they
 * both call `session()` on this and get whatever is open now.
 */
export class LibraryHost {
  readonly #stateFile: string
  readonly #pick: FolderPicker
  readonly #onChanged: () => void
  readonly #startTicker: (lib: Library) => PreviewTicker
  #current: OpenFolder | null = null
  /** Every deferred release, chained, so a test (and `whenReleased`) can wait for all of them. */
  #releases: Promise<void> = Promise.resolve()

  constructor(options: LibraryHostOptions) {
    this.#stateFile = options.stateFile
    this.#pick = options.pick
    this.#onChanged = options.onChanged ?? ((): void => {})
    this.#startTicker = options.startTicker ?? ((lib): PreviewTicker => startPreviewTicker(lib))
  }

  session(): DesktopSession | null {
    return this.#current?.session ?? null
  }

  /** The folder that is open, for tests and for anything that wants to name it. */
  dir(): string | null {
    return this.#current?.dir ?? null
  }

  /**
   * Opens `dir` and remembers it, releasing whatever was open before.
   *
   * `openDesktopLibrary` runs *first* and the state file is written *last*, so a folder that
   * cannot be opened leaves the previous library open and the remembered folder unchanged — the
   * failure costs the user nothing but the dialog they just dismissed.
   *
   * `remember: false` is for the `SPM_LIBRARY_DIR` override alone. This started out unconditional
   * and a test caught it: an operator naming a folder for one launch would have had it written
   * into `state.json` and inherited, invisibly, by every launch after it.
   */
  open(dir: string, opts: { remember?: boolean } = {}): LocalLibraryDto {
    const resolved = resolve(dir)
    // Re-opening the folder that is already open would close the live session and hand the
    // renderer a new one for no reason; worse, it would briefly hold two handles on one database.
    if (this.#current?.dir === resolved) return { dir: resolved }

    const session = openDesktopLibrary(resolved)
    const previous = this.#current
    this.#current = { dir: resolved, session, ticker: this.#startTicker(session.lib) }
    if (previous) this.#release(previous)
    if (opts.remember ?? true) rememberDir(this.#stateFile, resolved)
    this.#onChanged()
    return { dir: resolved }
  }

  /**
   * Asks for a folder and opens it. Null when the user cancelled, which is not an error: the
   * library that was open (if any) stays open.
   */
  async prompt(reason: string | null): Promise<LocalLibraryDto | null> {
    if (reason) console.warn(`desktop: ${reason}`)
    const dir = await this.#pick(folderPickerOptions(reason))
    return dir === null ? null : this.open(dir)
  }

  /**
   * Runs the startup plan. Answers what happened, so `main()` can create the window first and ask
   * for a folder afterwards rather than leaving a native dialog in front of nothing.
   *
   * A remembered folder that will not open — a database from a newer schema, a permission error,
   * a drive that is mounted but unreadable — degrades to the picker exactly as a deleted one
   * does, with the failure as the explanation. An **environment** override that will not open is
   * rethrown instead: `SPM_LIBRARY_DIR` is somebody stating which folder this launch is for, and
   * silently asking for a different one would be answering a question they did not ask.
   */
  start(
    env: NodeJS.ProcessEnv = process.env,
  ): { opened: LocalLibraryDto } | { prompt: string | null } {
    const plan = planStartup(env, this.#stateFile)
    if (plan.source === 'picker') return { prompt: plan.reason }
    try {
      return { opened: this.open(plan.dir, { remember: plan.source !== 'env' }) }
    } catch (error) {
      if (plan.source === 'env') throw error
      return { prompt: missingFolderReason(plan.dir, error) }
    }
  }

  /**
   * For `will-quit`. Stops the timer and closes the library **without** waiting for a run that is
   * in flight, because the process is going away and a user who closed the window should not
   * watch it linger through a mesh render.
   *
   * **What that costs, measured rather than inferred from the constant's name.** A row the queue
   * had claimed when the process went is left `pending` with a `claimed_at` and an `attempts`
   * that was already charged at claim time. Driven against a real library with
   * `claimPendingPreviews(lib, handlers, 10, now)`:
   *
   * | when                        | rows claimed | row afterwards                          |
   * | --------------------------- | ------------ | --------------------------------------- |
   * | first claim                 | 1            | `pending`, attempts 1, claimed_at set   |
   * | one second later            | **0**        | unchanged — the lease hides it          |
   * | fourteen minutes later      | **0**        | unchanged                               |
   * | fifteen minutes + 1 ms      | 1            | `pending`, attempts 2                   |
   * | and again, fifteen later    | 1            | `pending`, attempts 3                   |
   * | and again                   | **0**        | `MAX_PREVIEW_ATTEMPTS` reached, for good |
   *
   * So a kill mid-render costs one attempt and fifteen minutes of invisibility (`PREVIEW_LEASE_MS`
   * counted from the *claim*, not from the restart — relaunching sooner does not shorten it), and
   * three of them retire the row until a rescan sees the file's bytes change, which resets the
   * state and the attempts. That is the queue's own design for a crash and is not re-invented
   * here: nothing in this shell clears `claimed_at` at startup.
   */
  shutdown(): void {
    const current = this.#current
    this.#current = null
    if (!current) return
    void current.ticker.stop()
    closeDesktopLibrary(current.session)
  }

  /** Resolves when every deferred release has finished. A test seam, and only used as one. */
  whenReleased(): Promise<void> {
    return this.#releases
  }

  /**
   * Lets go of a library the user has switched away from — **after** its preview run has
   * finished, and without making the switch wait for it.
   *
   * Both halves are measured. Closing while a run is in flight is not theoretical: the run's next
   * statement lands on a closed `DatabaseSync`, and it writes preview PNGs into a folder the user
   * has left. Making the *switch* wait for it is the other failure — a rasterizing job is seconds
   * to minutes on a big mesh, and `library.pick()` would not answer until it finished, which the
   * user experiences as the app hanging on the folder they just chose.
   *
   * So the new library is live before this runs, and the old one closes a moment later. What that
   * costs, stated plainly: for the length of one preview job the old folder still has an open
   * SQLite handle, and on Windows that is enough to refuse a rename or a delete of it — measured,
   * `EPERM` while open and success once closed. `whenReleased()` is when that is over.
   */
  #release(previous: OpenFolder): void {
    this.#releases = this.#releases.then(async () => {
      try {
        await previous.ticker.stop()
      } catch (error) {
        console.error('desktop: a preview run failed while closing a library', error)
      }
      try {
        closeDesktopLibrary(previous.session)
      } catch (error) {
        console.error('desktop: failed to close a library', error)
      }
    })
  }
}
