import { statSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { parseRemoteOrigin, REMOTE_URL_ENV } from './remote.ts'
import {
  readRememberedDir,
  readRememberedMode,
  readRememberedRemote,
  rememberDir,
  STATE_FILE_NAME,
} from './state.ts'

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
 *
 * **Four hand-written tables in this process speak them** — `PICKER_STRINGS`, `MODE_STRINGS`,
 * `CONFIRM_STRINGS` and `MENU_STRINGS` — with nothing tying them to the renderer's locale files.
 * That separation is deliberate and cannot be removed: every one of these is needed at a moment
 * when there is no library, and so no settings, and so no language the app has been told to use.
 * What it costs is a drift surface: a third language added to the renderer leaves the shell
 * speaking two, silently.
 *
 * `library.test.ts` holds the part that can be checked mechanically — that the four tables agree
 * with each other on which languages exist, so adding one to a single table fails rather than
 * half-shipping. Agreement with the *renderer's* set is not checked, because the main process
 * cannot import the Angular build's JSON without pulling the renderer into this bundle.
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
 * What the user can answer when the shell asks which of spec 2.6's two modes this is.
 *
 * `cancel` is a real answer and not an error: closing the question leaves the shell with nothing
 * open, which is the same state a cancelled folder dialog leaves it in — a usable window, no
 * library, and the menu still there.
 */
export type ModeChoice = 'local' | 'remote' | 'cancel'

type ModeStrings = { title: string; message: string; local: string; remote: string; cancel: string }

/**
 * The mode question, in the two languages the picker speaks.
 *
 * A native message box and not a page in the renderer, for the same reason the folder dialog is
 * native: it is asked before there is anything for a page to be *about*, and the answer decides
 * which transport the renderer will be built with. The *server URL* does need a text field, which
 * a message box has no way to offer — that half is the desktop-only connect page, which this
 * answer navigates to.
 */
const MODE_STRINGS: Readonly<Record<PickerLanguage, ModeStrings>> = {
  en: {
    title: 'Slicer Project Manager',
    message: 'Where is your library?',
    local: 'Open a local folder…',
    remote: 'Connect to a server…',
    cancel: 'Not now',
  },
  de: {
    title: 'Slicer Project Manager',
    message: 'Wo liegt Ihre Bibliothek?',
    local: 'Lokalen Ordner öffnen…',
    remote: 'Mit einem Server verbinden…',
    cancel: 'Später',
  },
}

export type ModePickerOptions = {
  type: 'question'
  title: string
  message: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/**
 * The `dialog.showMessageBox` options, built here so the copy and the button order are covered by
 * a unit test rather than by a native modal.
 *
 * The button *order* is load-bearing, because the answer comes back as an index: `MODE_CHOICES`
 * below is the one place that mapping exists, and `modePickerOptions` builds its buttons from it,
 * so a reordering cannot leave the two disagreeing.
 */
export const MODE_CHOICES: readonly ModeChoice[] = ['local', 'remote', 'cancel']

export function modePickerOptions(language: PickerLanguage = 'en'): ModePickerOptions {
  const strings = MODE_STRINGS[language]
  return {
    type: 'question',
    title: strings.title,
    message: strings.message,
    buttons: MODE_CHOICES.map((choice) => strings[choice]),
    // Local is the default because it is the mode that needs no server, and the escape key must
    // land on the answer that changes nothing.
    defaultId: MODE_CHOICES.indexOf('local'),
    cancelId: MODE_CHOICES.indexOf('cancel'),
  }
}

/** The index a message box answers with, as a choice. Anything out of range is a cancel. */
export function modeChoiceAt(index: number): ModeChoice {
  return MODE_CHOICES[index] ?? 'cancel'
}

/**
 * Shows the mode question and answers it. A function, like `FolderPicker`, so everything either
 * side of the native dialog is testable without Electron running.
 */
export type ModePicker = (options: ModePickerOptions) => Promise<ModeChoice>

/**
 * What the user is asked before the shell points its network stack at a server the *renderer*
 * named — ruling C-20.
 *
 * `library.connect` is the one call in this app that takes a host from the untrusted side of the
 * IPC boundary and makes the main process fetch from it. `parseRemoteOrigin` bounds the scheme
 * and the shape, and deliberately accepts loopback, link-local and RFC1918, because
 * `http://192.168.1.5:8000` is the documented use case — so the bound cannot come from the URL.
 * It comes from here instead: a native dialog, owned by the main process, naming the origin, with
 * the safe answer as the default. A compromised renderer can still *ask*; it cannot answer.
 *
 * The origin is interpolated rather than pre-rendered by the caller so that the sentence and the
 * value are built in one place, and `test/shell.test.ts` can assert the origin really appears in
 * what the user is shown — a confirmation that did not name the host would be worse than none.
 */
type ConfirmStrings = { title: string; message: (origin: string) => string; detail: string }

const CONFIRM_STRINGS: Readonly<Record<PickerLanguage, ConfirmStrings>> = {
  en: {
    title: 'Connect to a server',
    message: (origin) => `Connect this app to ${origin}?`,
    detail:
      'The app will send your sign-in and every request to that address until you change it. ' +
      'Only continue if you recognise it.',
  },
  de: {
    title: 'Mit einem Server verbinden',
    message: (origin) => `Diese App mit ${origin} verbinden?`,
    detail:
      'Die App sendet Ihre Anmeldung und jede Anfrage an diese Adresse, bis Sie sie ändern. ' +
      'Fahren Sie nur fort, wenn Sie die Adresse kennen.',
  },
}

export type ConfirmOptions = {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/**
 * The buttons, in the order the answer's index refers to.
 *
 * Cancel is **first**, and is both the default and the cancel id. The other dialogs in this shell
 * default to the affirmative because the user opened them; this one can be raised by the renderer
 * without any gesture at all, so the answer a stray return key gives has to be "no".
 */
export const CONFIRM_CHOICES = ['cancel', 'connect'] as const

export function confirmRemoteOptions(
  origin: string,
  language: PickerLanguage = 'en',
): ConfirmOptions {
  const strings = CONFIRM_STRINGS[language]
  const buttons = language === 'de' ? ['Abbrechen', 'Verbinden'] : ['Cancel', 'Connect']
  return {
    type: 'warning',
    title: strings.title,
    message: strings.message(origin),
    detail: strings.detail,
    buttons,
    defaultId: CONFIRM_CHOICES.indexOf('cancel'),
    cancelId: CONFIRM_CHOICES.indexOf('cancel'),
  }
}

/** True only for the affirmative button. Anything out of range is a refusal. */
export function confirmedAt(index: number): boolean {
  return CONFIRM_CHOICES[index] === 'connect'
}

/** Shows the confirmation and answers it. A function, so the shell is testable without Electron. */
export type RemoteConfirmer = (options: ConfirmOptions) => Promise<boolean>

/**
 * Which prompt a picker is being asked to answer.
 *
 * `startup` is the one the shell raises by itself, on first run or when the remembered folder has
 * gone; `user` is the header control. They are told apart because the Playwright suite answers the
 * first without a dialog (`SPM_FAKE_PICKER`, see `app.ts`) — that prompt fires on
 * `did-finish-load` and cannot be stubbed without racing it — while a pick the *test* triggers is
 * stubbed at the dialog, deterministically, because the test is the one doing the clicking. A
 * fake that answered "the first prompt" instead of "the startup prompt" would silently swallow a
 * later click in any spec that never raised a startup prompt at all.
 */
export type PromptTrigger = 'startup' | 'user'

/**
 * Shows the picker and answers the chosen folder, or null when the user cancelled.
 *
 * A function and not `dialog` itself, so everything above and below this line is testable
 * without Electron running.
 */
export type FolderPicker = (
  options: FolderPickerOptions,
  trigger: PromptTrigger,
) => Promise<string | null>

/** The reason for a folder that will not open, carrying the failure as its detail. */
export function unopenableReason(dir: string, error: unknown): PromptReason {
  return { kind: 'unopenable', dir, detail: error instanceof Error ? error.message : String(error) }
}

/**
 * What the shell opens at startup, decided before anything is opened.
 *
 * Task 4 answered "which folder"; task 5 answers "which of spec 2.6's two modes, and then which
 * folder or which server". The order is the whole content of the function:
 *
 * 1. **The environment**, which beats everything and is never remembered. `SPM_LIBRARY_DIR` and
 *    `SPM_REMOTE_URL` are the same statement in the two modes — "this launch is for that" — so
 *    setting *both* is a contradiction and is refused rather than resolved by precedence: an
 *    operator who names two libraries has made a mistake, and picking one of them silently would
 *    open the wrong one on somebody's machine.
 * 2. **What was remembered**, which is a mode and the target that goes with it. A `state.json`
 *    written by task 4 has a folder and no mode; `readRememberedMode` reads that as local, so
 *    upgrading does not throw anyone back to a question they already answered.
 * 3. **Ask**, which is now the *mode* picker and not the folder picker — a remembered folder that
 *    has gone still goes straight to the folder picker with its explanation, because the mode is
 *    not in doubt there.
 */
export type StartupPlan =
  | { mode: 'local'; source: 'env' | 'remembered'; dir: string }
  | { mode: 'remote'; source: 'env' | 'remembered'; origin: string }
  | { mode: 'local'; source: 'picker'; reason: PromptReason }
  | { mode: 'ask' }

/** The arm of the plan `LibraryHost` can act on; everything else belongs to `ShellHost`. */
export type LocalStartupPlan = Extract<StartupPlan, { mode: 'local' }>

export function planStartup(
  env: NodeJS.ProcessEnv,
  stateFile: string,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): StartupPlan {
  const fromEnv = resolveLibraryDir(env)
  const remoteFromEnv = env[REMOTE_URL_ENV]
  if (fromEnv && remoteFromEnv) {
    throw new Error(
      `${LIBRARY_DIR_ENV} and ${REMOTE_URL_ENV} are both set; they name two different libraries`,
    )
  }
  if (fromEnv) return { mode: 'local', source: 'env', dir: fromEnv }
  // Parsed here rather than at the point of use, so a malformed override fails at startup with a
  // sentence naming the variable — the same treatment `SPM_LIBRARY_DIR` gets from `open()`.
  if (remoteFromEnv) {
    return { mode: 'remote', source: 'env', origin: parseRemoteOrigin(remoteFromEnv) }
  }

  const mode = readRememberedMode(stateFile)
  if (mode === 'remote') {
    const origin = readRememberedRemote(stateFile)
    // A `mode: 'remote'` with no usable URL beside it is a state file somebody edited: there is
    // nothing to connect to and no folder was chosen either, so the only honest answer is to ask
    // again rather than to guess a mode from half a record.
    if (origin === null) return { mode: 'ask' }
    try {
      return { mode: 'remote', source: 'remembered', origin: parseRemoteOrigin(origin) }
    } catch {
      console.warn(`desktop: ignoring an unusable remembered server URL (${origin})`)
      return { mode: 'ask' }
    }
  }
  if (mode === null) return { mode: 'ask' }

  const remembered = readRememberedDir(stateFile)
  if (!remembered) return { mode: 'ask' }
  // Deleted, renamed, on an unmounted drive, or replaced by a file — all one answer, because the
  // user's next step is the same in every case and none of them is a crash.
  if (!isDirectory(remembered)) {
    return { mode: 'local', source: 'picker', reason: { kind: 'missing', dir: remembered } }
  }
  return { mode: 'local', source: 'remembered', dir: remembered }
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
  prompt(
    reason: PromptReason | null,
    trigger: PromptTrigger = 'user',
  ): Promise<LocalLibraryDto | null> {
    // One dialog at a time. Two quick clicks on the header control — or a click while the
    // first-run dialog is still up, which the control has no way to know about — would otherwise
    // open two native pickers and run two `open()` calls, the second of which closes the library
    // the first just opened. The second caller waits for the first answer, which is what they
    // asked for anyway.
    if (this.#asking) return this.#asking
    const asking = this.#promptOnce(reason, trigger).finally(() => {
      if (this.#asking === asking) this.#asking = null
    })
    this.#asking = asking
    return asking
  }

  async #promptOnce(
    reason: PromptReason | null,
    trigger: PromptTrigger,
  ): Promise<LocalLibraryDto | null> {
    // English, like every other log line here; the user-facing copy is in the dialog.
    if (reason) console.warn(`desktop: ${explainReason(reason)}`)
    const dir = await this.#pick(folderPickerOptions(reason, this.#language()), trigger)
    return dir === null ? null : this.open(dir)
  }

  /**
   * Runs the local half of the startup plan. Answers what happened, so the caller can create the
   * window first and ask for a folder afterwards rather than leaving a native dialog in front of
   * nothing.
   *
   * A remembered folder that will not open — a database from a newer schema, a permission error,
   * a drive that is mounted but unreadable — degrades to the picker exactly as a deleted one
   * does, with the failure as the explanation. An **environment** override that will not open is
   * rethrown instead: `SPM_LIBRARY_DIR` is somebody stating which folder this launch is for, and
   * silently asking for a different one would be answering a question they did not ask.
   *
   * It takes a plan rather than reading the environment itself, because since task 5 the first
   * question at startup is *which mode*, and that is `ShellHost`'s to answer — this class has no
   * opinion about remote servers and should not grow one.
   */
  openPlanned(plan: LocalStartupPlan): { opened: LocalLibraryDto } | { prompt: PromptReason } {
    if (plan.source === 'picker') return { prompt: plan.reason }
    try {
      return { opened: this.open(plan.dir, { remember: plan.source !== 'env' }) }
    } catch (error) {
      if (plan.source === 'env') throw error
      return { prompt: unopenableReason(plan.dir, error) }
    }
  }

  /**
   * Lets go of the folder that is open, with nothing taking its place.
   *
   * This is the mode switch's half of `open()`. Without it, connecting to a server would leave
   * the local library open behind the new one: its preview ticker would go on rendering
   * thumbnails into a folder the user has left, and its SQLite handle would go on holding the
   * directory — which is the *exact* failure task 4 measured when a chained release let a stopped
   * folder's ticker keep firing, only reached from the other direction.
   *
   * It goes through the same deferred release `open()` uses, so a rescan or a preview batch that
   * is in flight finishes against a database that is still open, and `whenSettled()` still covers
   * it.
   */
  closeCurrent(): void {
    const current = this.#current
    this.#current = null
    if (current) this.#release(current)
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
   * So the new library is live before this runs and the old one closes afterwards, and until it
   * does, that folder still has an open SQLite handle — on Windows, enough to refuse a rename or a
   * delete of it (measured: `EPERM` while open, success once closed).
   *
   * **How long that lasts is not a number, and two rounds of review were spent correcting one.**
   * It said "one preview job", then "a whole batch"; both were short, because the close is chained
   * onto `#releases` and so waits for every release queued ahead of it as well as for this
   * folder's own batch and rescan. The bound is the chain, not a duration: `whenSettled()` is
   * exactly when it is over, `a folder's handle is held until every earlier release has finished`
   * in `library.test.ts` is what pins it, and the three lines below are what decide it. A reader
   * who needs a figure should read those, not a sentence that has been wrong twice.
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
