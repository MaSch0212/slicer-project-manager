import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { LocalLibraryDto } from '@spm/contract/dtos.ts'
import {
  closeLibrary,
  ensureLocalUser,
  openLibrary,
  rescan,
  type Ctx,
  type Library,
} from '@spm/core'
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
  } catch (error) {
    // `ENOENT` is first run, or a userData directory that has just been wiped, and is the one
    // case worth no words. Everything else — `EACCES`, `EISDIR`, an I/O error — returns the user
    // to the picker with their folder apparently forgotten, and a silent catch would leave that
    // with no explanation in any log.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`desktop: could not read ${STATE_FILE_NAME}`, error)
    }
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
  // Temp-then-rename rather than a straight write. A torn file costs one forgotten folder today,
  // which `readState` already degrades to first run — but task 5 is putting the shell's mode and a
  // remote server URL into this same object, and then half a JSON file loses the whole
  // configuration rather than one path. `renameSync` replaces an existing file on Windows as well
  // as on POSIX, which is what lets this be a rename and not a delete-then-write.
  const temp = `${stateFile}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, stateFile)
}

/**
 * What `dialog.showOpenDialog` is asked for. A folder, and the user may create one on the spot —
 * the folder they want for a brand-new library usually does not exist yet.
 */
export const FOLDER_PICKER_PROPERTIES = ['openDirectory', 'createDirectory'] as const

/**
 * Why the app is asking for a folder, as a value rather than as a sentence.
 *
 * Structured because the sentence has to exist in more than one language. The *dialog* is the one
 * place a user meets this — the shell has no window it can be sure of when it asks — so the
 * explanation is built where the language is known, while the log line stays English like every
 * other log line in this repo. `null` is first run: nothing to explain.
 */
export type PromptReason =
  { kind: 'missing'; dir: string } | { kind: 'unopenable'; dir: string; detail: string }

/**
 * The languages the picker speaks, which is the pair the renderer ships (`locales/en.json` and
 * `locales/de.json`). It is the OS locale and not the app's own language setting because that
 * setting lives in a library, and this is needed exactly when no library is open.
 */
export type PickerLanguage = 'en' | 'de'

export function pickerLanguage(locale: string | undefined): PickerLanguage {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

type PickerStrings = {
  title: string
  buttonLabel: string
  missing: (dir: string) => string
  unopenable: (dir: string, detail: string) => string
}

const PICKER_STRINGS: Readonly<Record<PickerLanguage, PickerStrings>> = {
  en: {
    title: 'Choose a library folder',
    buttonLabel: 'Open',
    missing: (dir) => `the last folder is no longer there (${dir})`,
    unopenable: (dir, detail) => `the last folder could not be opened (${dir}): ${detail}`,
  },
  de: {
    title: 'Bibliotheksordner auswählen',
    buttonLabel: 'Öffnen',
    missing: (dir) => `Der zuletzt geöffnete Ordner ist nicht mehr vorhanden (${dir})`,
    unopenable: (dir, detail) =>
      `Der zuletzt geöffnete Ordner konnte nicht geöffnet werden (${dir}): ${detail}`,
  },
}

/** The picker's own title when there is nothing to explain, in the fallback language. */
export const FOLDER_PICKER_TITLE = PICKER_STRINGS.en.title

/** The explanation as one sentence, for the dialog. */
export function explainReason(reason: PromptReason, language: PickerLanguage = 'en'): string {
  const strings = PICKER_STRINGS[language]
  return reason.kind === 'missing'
    ? strings.missing(reason.dir)
    : strings.unopenable(reason.dir, reason.detail)
}

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
export function folderPickerOptions(
  reason: PromptReason | null,
  language: PickerLanguage = 'en',
): FolderPickerOptions {
  const strings = PICKER_STRINGS[language]
  const explanation = reason ? explainReason(reason, language) : null
  return {
    title: explanation ? `${strings.title} — ${explanation}` : strings.title,
    message: explanation ?? strings.title,
    buttonLabel: strings.buttonLabel,
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

/** The reason for a folder that will not open, carrying the failure as its detail. */
export function unopenableReason(dir: string, error: unknown): PromptReason {
  return { kind: 'unopenable', dir, detail: error instanceof Error ? error.message : String(error) }
}

/**
 * Where the library comes from at startup, decided before anything is opened.
 *
 * Three sources in a fixed order, and the order is the whole content of the function: an
 * environment override beats a remembered folder, and a remembered folder that is not a usable
 * directory any more is not a failure — it is a reason to ask.
 */
export type StartupPlan =
  { source: 'env' | 'remembered'; dir: string } | { source: 'picker'; reason: PromptReason | null }

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
    return { source: 'picker', reason: { kind: 'missing', dir: remembered } }
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

/**
 * `work` is everything this folder started that must finish before its database may be closed —
 * today the rescan `open()` fires. It never rejects; the failure is logged where it happens.
 */
type OpenFolder = {
  dir: string
  session: DesktopSession
  ticker: PreviewTicker
  work: Promise<void>
}

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
  /**
   * The language the dialog speaks, resolved per call because `app.getLocale()` is only dependable
   * once Electron is ready and this is constructed before that.
   */
  language?: () => PickerLanguage
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
  readonly #language: () => PickerLanguage
  #current: OpenFolder | null = null
  /** The dialog that is already open, so a second click cannot put a second one on top of it. */
  #asking: Promise<LocalLibraryDto | null> | null = null
  /** Every deferred release, chained, so a test (and `whenSettled`) can wait for all of them. */
  #releases: Promise<void> = Promise.resolve()

  constructor(options: LibraryHostOptions) {
    this.#stateFile = options.stateFile
    this.#pick = options.pick
    this.#onChanged = options.onChanged ?? ((): void => {})
    this.#startTicker = options.startTicker ?? ((lib): PreviewTicker => startPreviewTicker(lib))
    this.#language = options.language ?? ((): PickerLanguage => 'en')
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
    const opened: OpenFolder = {
      dir: resolved,
      session,
      ticker: this.#startTicker(session.lib),
      work: Promise.resolve(),
    }
    opened.work = this.#adopt(opened)
    this.#current = opened
    if (previous) this.#release(previous)
    if (opts.remember ?? true) this.#remember(resolved)
    this.#onChanged()
    return { dir: resolved }
  }

  /**
   * Writes the folder down, and does not fail the open if it cannot.
   *
   * The library is already open by the time this runs. A throw here — an unwritable `userData`, a
   * full disk — used to escape `open()` with the swap already done and the old library already
   * released: the renderer went on drawing a library the shell no longer served, because
   * `#onChanged()` was never reached, and through `start()` the same throw produced a prompt
   * saying the folder "could not be opened" about the folder that was open at that moment.
   */
  #remember(dir: string): void {
    try {
      rememberDir(this.#stateFile, dir)
    } catch (error) {
      console.error(`desktop: could not remember the library folder in ${STATE_FILE_NAME}`, error)
    }
  }

  /**
   * Takes in what is in the folder — ruling C-16.
   *
   * **Picking a folder is the gesture that says "this is my library".** The browser arm has an
   * operator who populates a folder and then rescans a long-lived server, and no per-user "choose
   * a folder" moment at all; local mode has a user who just pointed the app at a directory full of
   * projects. Without this they get an empty grid and a Rescan button, and the preview queue this
   * task also builds has nothing to claim — a freshly opened folder has no preview rows until
   * something adopts its files.
   *
   * Fire-and-forget, so `library.pick()` answers as soon as the library is open rather than after
   * a hash of every file in it. The window is reloaded once immediately (the library changed) and
   * again when this finds anything, because a rescan that adopts a project after the reload would
   * otherwise sit unseen until the user pressed something.
   */
  #adopt(opened: OpenFolder): Promise<void> {
    return rescan(opened.session.lib, opened.session.ctx)
      .then((result) => {
        opened.session.lib.log.info('rescanned the folder that was opened', result)
        const changed =
          result.adopted + result.markedMissing + result.filesAdded + result.filesRemoved > 0
        // Not if the user has already moved on: reloading for a library that is no longer the
        // open one would show them the wrong folder for as long as it took to notice.
        if (changed && this.#current === opened) this.#onChanged()
      })
      .catch((error: unknown) => {
        // A folder that cannot be read is still a library the user can work in — projects can be
        // created, and the next rescan is a button away.
        opened.session.lib.log.error('rescan after opening the library failed', { err: error })
      })
  }

  /**
   * Asks for a folder and opens it. Null when the user cancelled, which is not an error: the
   * library that was open (if any) stays open.
   */
  prompt(reason: PromptReason | null): Promise<LocalLibraryDto | null> {
    // One dialog at a time. Two quick clicks on the header control — or a click while the
    // first-run dialog is still up, which the control has no way to know about — would otherwise
    // open two native pickers and run two `open()` calls, the second of which closes the library
    // the first just opened. The second caller waits for the first answer, which is what they
    // asked for anyway.
    if (this.#asking) return this.#asking
    const asking = this.#promptOnce(reason).finally(() => {
      if (this.#asking === asking) this.#asking = null
    })
    this.#asking = asking
    return asking
  }

  async #promptOnce(reason: PromptReason | null): Promise<LocalLibraryDto | null> {
    // English, like every other log line here; the user-facing copy is in the dialog.
    if (reason) console.warn(`desktop: ${explainReason(reason)}`)
    const dir = await this.#pick(folderPickerOptions(reason, this.#language()))
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
  ): { opened: LocalLibraryDto } | { prompt: PromptReason | null } {
    const plan = planStartup(env, this.#stateFile)
    if (plan.source === 'picker') return { prompt: plan.reason }
    try {
      return { opened: this.open(plan.dir, { remember: plan.source !== 'env' }) }
    } catch (error) {
      if (plan.source === 'env') throw error
      return { prompt: unopenableReason(plan.dir, error) }
    }
  }

  /**
   * For `will-quit`. Stops the timer and closes the library **without** waiting for a preview run
   * or a rescan that is in flight, because the process is going away and a user who closed the
   * window should not watch it linger through a mesh render.
   *
   * **So the cost below is not only a crash's.** It is what an ordinary quit costs whenever the
   * queue happened to be rendering — closing the window during a backfill is the common case, not
   * the exotic one. A row the queue had claimed is left `pending` with a `claimed_at` and an
   * `attempts` that was already charged at claim time. Measured rather than inferred from the
   * constant's name, against a real library with
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
    // Not awaited — but kept in the chain, so `whenSettled()` still covers a rescan that was
    // running when the app quit rather than returning while it writes into a closed database.
    this.#releases = this.#releases.then(() => current.work)
    closeDesktopLibrary(current.session)
  }

  /**
   * Resolves when the open folder's own work (its rescan) and every deferred release have
   * finished. A test seam, and only used as one.
   */
  async whenSettled(): Promise<void> {
    await this.#current?.work
    await this.#releases
  }

  /**
   * Lets go of a library the user has switched away from — **after** its preview run has
   * finished, and without making the switch wait for it.
   *
   * Closing while work is in flight is not theoretical, and it is measured: the run's next
   * statement lands on a closed `DatabaseSync`, and it writes preview PNGs into a folder the user
   * has left. Making the *switch* wait for it is the other failure, and that half is an
   * **estimate rather than a measurement**: B1 timed whole-library backfills, not single jobs, so
   * what is on record is that rasterizing is CPU-bound work over meshes up to 208.8 MB — long
   * enough that `library.pick()` waiting for it would read as the app hanging on the folder the
   * user just chose. Nothing in this task timed one job.
   *
   * So the new library is live before this runs and the old one closes afterwards. **The window
   * that leaves open, stated with the right bound:** a preview run claims up to
   * `PREVIEW_BATCH_LIMIT` jobs and runs them one at a time, and the rescan `#adopt` started has to
   * finish too, so the old folder can keep its SQLite handle for a whole batch — not for one job,
   * which is what this comment said until a review caught it. On Windows that handle is enough to
   * refuse a rename or a delete of the folder: measured, `EPERM` while open, success once closed.
   * `whenSettled()` is when it is over.
   *
   * `stop()` is called **now** rather than inside the chain. It clears the interval synchronously
   * — only its promise is deferred — so a second switch cannot leave the middle folder's ticker
   * firing, and writing PNGs into a folder two removes from the one the user is looking at, for as
   * long as the earlier release takes.
   */
  #release(previous: OpenFolder): void {
    const stopped = previous.ticker.stop().catch((error: unknown) => {
      console.error('desktop: a preview run failed while closing a library', error)
    })
    this.#releases = this.#releases.then(async () => {
      await previous.work
      await stopped
      try {
        closeDesktopLibrary(previous.session)
      } catch (error) {
        console.error('desktop: failed to close a library', error)
      }
    })
  }
}
