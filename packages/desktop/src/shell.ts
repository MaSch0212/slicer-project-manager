import type { Capabilities, LocalLibraryDto, RemoteLibraryDto } from '@spm/contract/dtos.ts'
import { LOCAL_SHELL_CAPABILITIES } from './capabilities.ts'
import {
  confirmRemoteOptions,
  modePickerOptions,
  planStartup,
  type DesktopSession,
  type LibraryHost,
  type ModeChoice,
  type ModePicker,
  type PickerLanguage,
  type RemoteConfirmer,
  type PromptReason,
  type PromptTrigger,
} from './library.ts'
import type { BridgeMode } from './protocol.ts'
import { isPlaintextToAnotherMachine, parseRemoteOrigin, RemoteHost } from './remote.ts'
import { rememberChoice, type ShellMode } from './state.ts'

/**
 * Which of spec 2.6's two modes the shell is in, and the swap between them.
 *
 * `ActiveMode` is the runtime answer — the two modes, plus the state where nothing is open.
 * `state.ts`'s `ShellMode` is the on-disk half and has only the two, because "nothing chosen" is
 * spelled there by the absence of the key. They were both called `ShellState` at first, in one
 * package, which is exactly as confusing as it sounds.
 *
 * `LibraryHost` owns "which folder is open"; this owns "a folder at all, or a server". It exists
 * as its own object for the reason `LibraryHost` does: `app.ts` imports `electron` and cannot be
 * reached by a plain `node --test`, and this is where the property the plan calls out by name
 * lives — **switching modes must not leak the previous mode's client**.
 *
 * That property has two halves and only one of them is the obvious one:
 *
 * - *The renderer's half.* A stale `HttpApiClient` after switching to local. It cannot happen,
 *   because the transport is fixed at window creation (`BridgeMode`) and a change of transport
 *   replaces the window — the whole renderer, not its state.
 * - *The main process's half*, which is the one that would actually have shipped. A `RemoteHost`
 *   left alive after switching to local goes on answering `spm://app/api/...` out of a server the
 *   user has left, holding a session token for it; a `LibraryHost` left open after switching to a
 *   server goes on ticking its preview queue into a folder nobody is looking at, and holding that
 *   folder's SQLite handle. Task 4 measured that second failure from the other direction. Both
 *   are closed here, in one place, and asserted in `test/shell.test.ts`.
 */
export type ActiveMode = ShellMode | 'unset'

/**
 * Where the shell wants the window, when the answer is not simply "reload it".
 *
 * `connect` is the desktop-only page that takes a server URL, which is the one thing a native
 * message box cannot ask for. `home` is everything else.
 */
export type ShellRoute = 'home' | 'connect'

export type ShellHostOptions = {
  stateFile: string
  library: LibraryHost
  askMode: ModePicker
  /**
   * Ruling C-20's gate: confirms the origin the *renderer* asked to be connected to, before the
   * shell's network stack is pointed at it. Defaulted to a refusal rather than to a stub, so a
   * caller that forgets to wire it cannot silently be more permissive than the real shell.
   */
  confirmRemote?: RemoteConfirmer
  /**
   * The window has to be replaced: the transport changed. `app.ts` builds a new one with the new
   * `BridgeMode` and closes the old — in that order, because destroying the last window is what
   * makes Electron quit (measured: `window-all-closed` fires and a `loadURL` on the next window
   * dies with `ERR_FAILED`).
   *
   * It carries the route, because a transport change is not always a return to the library: the
   * connect flow *starts* by dropping a live server, and the window it needs afterwards is the
   * connect page on the new transport, not the home page on it.
   */
  onTransportChanged?: (route: ShellRoute) => void
  /** The window should go somewhere without being replaced — the transport has not changed. */
  onNavigate?: (route: ShellRoute) => void
  /**
   * The library under the windows has changed and they should be reloaded. Routed through here
   * rather than wired straight from `LibraryHost` so that `libraryChanged` below can decline it
   * when a window replacement is already on its way.
   */
  onLibraryChanged?: () => void
  /** The language the native dialogs speak, resolved per call — see `LibraryHostOptions`. */
  language?: () => PickerLanguage
  /** Injected so `test/shell.test.ts` can point at a server it started. */
  makeRemote?: (origin: string) => RemoteHost
}

export class ShellHost {
  readonly #stateFile: string
  readonly #library: LibraryHost
  readonly #askMode: ModePicker
  readonly #confirmRemote: RemoteConfirmer
  readonly #onTransportChanged: (route: ShellRoute) => void
  readonly #onNavigate: (route: ShellRoute) => void
  readonly #onLibraryChanged: () => void
  readonly #language: () => PickerLanguage
  readonly #makeRemote: (origin: string) => RemoteHost
  #remote: RemoteHost | null = null
  /** The mode question that is already open, so a second menu click cannot stack another. */
  #asking: Promise<ModeChoice> | null = null
  /**
   * The connect confirmation that is already open, for the same reason — and a stronger one.
   *
   * The mode question is raised by a menu click, so stacking two of them takes two clicks. This
   * one is raised by `library.connect`, which the *renderer* calls and which `ipc.ts` does not
   * serialize, so a loop could stack unbounded native dialogs. The gate holds either way — every
   * one of them defaults to refusing — but dialog fatigue is precisely the failure a confirmation
   * exists to resist, and the caller is the untrusted side of this boundary.
   */
  #connecting: Promise<RemoteLibraryDto | null> | null = null

  constructor(options: ShellHostOptions) {
    this.#stateFile = options.stateFile
    this.#library = options.library
    this.#askMode = options.askMode
    this.#confirmRemote = options.confirmRemote ?? ((): Promise<boolean> => Promise.resolve(false))
    this.#onTransportChanged = options.onTransportChanged ?? ((): void => {})
    this.#onNavigate = options.onNavigate ?? ((): void => {})
    this.#onLibraryChanged = options.onLibraryChanged ?? ((): void => {})
    this.#language = options.language ?? ((): PickerLanguage => 'en')
    this.#makeRemote = options.makeRemote ?? ((origin): RemoteHost => new RemoteHost(origin))
  }

  /**
   * Derived from what is actually open, never stored.
   *
   * A `#mode` field was written first and a test caught it disagreeing with reality: opening a
   * library through `LibraryHost` without going through this object left the field saying
   * `unset` while a folder was open. Everything downstream of the mode — the capability column,
   * the transport, the `/api` branch of the protocol handler — is then answering about a shell
   * state that does not exist. There is no such gap to close if there is no second copy.
   */
  mode(): ActiveMode {
    if (this.#remote) return 'remote'
    return this.#library.session() ? 'local' : 'unset'
  }

  /** What a window must be built with. See `BridgeMode` for why `unset` is not one of these. */
  transport(): BridgeMode {
    return this.#remote ? 'remote' : 'local'
  }

  /** The open library, or null — including in remote mode, where there deliberately is none. */
  session(): DesktopSession | null {
    return this.#library.session()
  }

  /** The server the `spm://app/api/...` branch of the protocol handler answers out of, or null. */
  remote(): RemoteHost | null {
    return this.#remote
  }

  /**
   * Spec 2.4, resolved for whatever the shell is talking to right now.
   *
   * In local mode — and in the state where nothing is open, which is a shell that can still open
   * a folder — this is the shell's column alone: there is no backend to union with, and passing
   * the column to itself would be a no-op that read as if it were doing something. In remote mode
   * it is the union, fetched from the server. The renderer in remote mode never reaches this
   * (it runs `HttpApiClient`, and the proxy unions the response on the way past), but the two
   * paths call the same `unionCapabilities` with the same column, so they cannot disagree.
   */
  async capabilities(): Promise<Capabilities> {
    if (this.#remote) return await this.#remote.capabilities()
    return LOCAL_SHELL_CAPABILITIES
  }

  /**
   * Runs the startup plan.
   *
   * Answers whether the shell still has a question to ask, so `main()` can create the window
   * first and put a native dialog in front of a loaded app rather than in front of a grey
   * rectangle.
   */
  start(env: NodeJS.ProcessEnv = process.env): { prompt: PromptReason | null } | { opened: true } {
    const plan = planStartup(env, this.#stateFile)
    if (plan.mode === 'ask') return { prompt: null }
    if (plan.mode === 'remote') {
      // No request is made here, on purpose: a server that is down must not stop the app from
      // starting, and the login screen the renderer lands on is a better place to find out than
      // a dialog in front of nothing.
      //
      // `remember: false` for **both** sources. An environment override is not a choice the user
      // made in the app, and a *remembered* origin is already on disk — writing it again would
      // be an fsync per launch to produce a byte-identical file.
      //
      // `replaceWindow: false` because there is no window yet — `main()` creates the first one
      // from `transport()` immediately after this returns. Measured with it firing: two windows
      // at every remote-mode launch, one from the callback and one from `main()`, and every
      // assertion in `remote.spec.ts` still green because `firstWindow()` answered the first.
      this.#adoptRemote(plan.origin, { remember: false, replaceWindow: false })
      return { opened: true }
    }
    const started = this.#library.openPlanned(plan)
    if ('prompt' in started) return { prompt: started.prompt }
    this.#becomeLocal()
    return { opened: true }
  }

  /**
   * Asks which mode this is, and follows the answer.
   *
   * `local` goes on to the folder dialog — so first run is still "a folder chosen in a native
   * dialog", with one question in front of it. `remote` sends the window to the connect page,
   * because a message box cannot hold a text field. `cancel` leaves the shell exactly as it was.
   *
   * **Choosing `remote` disconnects first, and that is a change of transport.** The connect page
   * needs the IPC transport to reach `library.connect` at all, and leaving a live server behind a
   * page that is asking which server to use is the stale-client failure wearing a different hat.
   *
   * Review found the half of that which was missing: dropping the server was done, but the window
   * was only *navigated*, so it kept `--spm-mode=remote` and went on running `HttpApiClient`
   * against a proxy that now 404s everything. Worse, the "choose a folder" button on that page
   * then reached `#becomeLocal` with the transport *already* reading `local`, so no replacement
   * fired there either and the reload rebuilt the same stale client. The window is replaced here
   * instead, on the connect route, whenever the release actually changed the transport.
   */
  askForMode(trigger: PromptTrigger = 'user'): Promise<ModeChoice> {
    // One question at a time, the same rule `LibraryHost.prompt` applies to the folder dialog:
    // two menu clicks would otherwise stack two native message boxes, and the second answer would
    // undo the first.
    if (this.#asking) return this.#asking
    const asking = this.#askModeOnce(trigger).finally(() => {
      if (this.#asking === asking) this.#asking = null
    })
    this.#asking = asking
    return asking
  }

  async #askModeOnce(trigger: PromptTrigger): Promise<ModeChoice> {
    const choice = await this.#askMode(modePickerOptions(this.#language()))
    // The trigger travels with it: the folder dialog this leads to at startup is still the
    // *shell's* prompt, not the user reaching for the header control, and the two are answered by
    // different things in an automated run (see `resolveFolderPicker`).
    if (choice === 'local') await this.pickLocalFolder(trigger)
    if (choice === 'remote') {
      const previousTransport = this.transport()
      this.#releaseRemote()
      if (this.transport() !== previousTransport) this.#onTransportChanged('connect')
      else this.#onNavigate('connect')
    }
    return choice
  }

  /**
   * The library under the windows changed, so they should be reloaded — unless a replacement is
   * already coming.
   *
   * `LibraryHost` raises this from `open()`, which during a remote→local switch runs *before*
   * `#becomeLocal` has swapped the transport. Reloading there sends the old window's in-flight
   * requests at a `RemoteHost` that is about to close, which answers them 503, and then destroys
   * the window anyway. A live server at this moment can only mean that switch is in progress.
   */
  libraryChanged(): void {
    if (this.#remote) return
    this.#onLibraryChanged()
  }

  /**
   * The folder dialog, and the mode change that goes with a folder being opened.
   *
   * The windows are reloaded through `libraryChanged` above when the library changes; the
   * transport callback fires as well, and only, when this is also a change of mode.
   */
  async pickLocalFolder(trigger: PromptTrigger = 'user'): Promise<LocalLibraryDto | null> {
    const opened = await this.#library.prompt(null, trigger)
    if (opened) this.#becomeLocal()
    return opened
  }

  /**
   * Points the shell at a server. Null when the user refuses, exactly as `pickLocalFolder` is null
   * when they cancel the folder dialog.
   *
   * **Ruling C-20: the URL is untrusted and so is the call itself.** `parseRemoteOrigin` bounds
   * what the string may be — http or https, an origin and nothing else, no credentials — and that
   * is where a malformed one is refused. What it cannot bound is *which* host, because the
   * documented use case is a server on the user's own LAN: `http://192.168.1.5:8000` has to be
   * allowed, and `http://169.254.169.254` looks exactly like it. Nothing in the IPC channel ties
   * this call to a user gesture — any renderer holding `window.spm` can make it — so the gesture
   * is asked for here, in a native dialog the main process owns, naming the origin.
   *
   * The gate is on **this** method and not on `#adoptRemote`, which is the distinction that makes
   * it worth having: a remembered origin and `SPM_REMOTE_URL` are the user's own earlier answer
   * and this process's environment, and re-asking about them on every launch would train people
   * to dismiss the one question that matters.
   *
   * Nothing is asked of the *server* here. A `connect` that required it to answer would fail on a
   * laptop that is not on the network yet and leave the user with no way to write the URL down;
   * the login screen the window lands on is where an unreachable server is reported.
   */
  async connectRemote(url: unknown): Promise<RemoteLibraryDto | null> {
    // `async`, so a malformed URL *rejects* rather than throwing synchronously out of a function
    // whose type says it returns a promise. Everything below still runs before the first `await`,
    // which is what keeps the guard sound: two calls in a loop are two synchronous entries, and
    // the first has assigned `#connecting` before the second reads it.
    //
    // Parsed before that guard, so a malformed URL is refused immediately rather than queueing
    // behind a dialog it is never going to reach.
    const origin = parseRemoteOrigin(url)
    // Reconnecting to the server that is already open would throw the renderer away and log the
    // user out of it, for nothing — and would ask a question whose answer is already on screen.
    if (this.#remote?.origin === origin) return { origin }
    // One dialog at a time, whatever the renderer asks for. A second caller waits for the first
    // answer, which is the shape `askForMode` already uses; the difference is that this one can
    // be called in a loop by code we do not trust, and unbounded native dialogs are how a user is
    // trained to dismiss the one question that matters.
    if (this.#connecting) return await this.#connecting
    const connecting = this.#connectOnce(origin).finally(() => {
      if (this.#connecting === connecting) this.#connecting = null
    })
    this.#connecting = connecting
    return await connecting
  }

  async #connectOnce(origin: string): Promise<RemoteLibraryDto | null> {
    if (!(await this.#confirmRemote(confirmRemoteOptions(origin, this.#language())))) return null
    this.#adoptRemote(origin, { remember: true })
    return { origin }
  }

  #adoptRemote(origin: string, options: { remember: boolean; replaceWindow?: boolean }): void {
    if (isPlaintextToAnotherMachine(origin)) {
      console.warn(
        `desktop: ${origin} is plain http to another machine; the login, the session and every ` +
          'file will cross that network in the clear',
      )
    }
    const previousTransport = this.transport()
    this.#releaseRemote()
    // The local library goes *before* the server is adopted, and this is the half of the swap
    // that would otherwise leak: its preview ticker writes PNGs into the folder, and its SQLite
    // handle keeps the directory open, for as long as nothing closes it.
    this.#library.closeCurrent()
    this.#remote = this.#makeRemote(origin)
    if (options.remember) this.#remember('remote', origin)
    if ((options.replaceWindow ?? true) && this.transport() !== previousTransport) {
      this.#onTransportChanged('home')
    }
  }

  #becomeLocal(): void {
    const previousTransport = this.transport()
    this.#releaseRemote()
    if (this.transport() !== previousTransport) this.#onTransportChanged('home')
  }

  #releaseRemote(): void {
    // `close()` and not merely dropping the reference: the object carries the session, and the
    // protocol handler resolves it per call (ruling C-12) but a Response already in flight does
    // not. Closing it makes a late call fail rather than reach a server the shell has left.
    this.#remote?.close()
    this.#remote = null
  }

  /**
   * Writes the choice down, and does not fail the switch if it cannot — the same rule
   * `LibraryHost` applies to the folder, and for the same reason: the swap has already happened
   * by the time this runs, and a throw here would leave the renderer being told about a mode the
   * caller then saw fail.
   */
  #remember(mode: ShellMode, target: string): void {
    try {
      rememberChoice(this.#stateFile, mode, target)
    } catch (error) {
      console.error('desktop: could not remember the shell mode in state.json', error)
    }
  }

  /** For `will-quit`. The library's own shutdown rules are in `LibraryHost.shutdown`. */
  shutdown(): void {
    this.#releaseRemote()
    this.#library.shutdown()
  }
}
