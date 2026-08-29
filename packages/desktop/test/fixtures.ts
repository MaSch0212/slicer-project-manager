import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The bundle the global setup built. Launched by path, exactly as `dev:desktop` does. */
export const MAIN_BUNDLE = resolve(here, '../dist/main.js')

export type LaunchedApp = { app: ElectronApplication; libraryDir: string; userDataDir: string }

/**
 * A private `app.getPath('userData')` for one launch.
 *
 * Two reasons, and the first one is not hygiene. Task 4 remembers the chosen folder in
 * `<userData>/state.json` and reopens it next launch, so a suite that shared one userData would
 * have every spec inherit the last spec's folder — and, worse, would write into the *developer's*
 * real `%APPDATA%/Slicer Project Manager` while it did it. The second is that this is what makes
 * "a chosen folder survives a relaunch" testable at all: two launches, one directory.
 */
export function newUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'spm-userdata-'))
}

/**
 * Replaces the native folder picker in the main process, for the picks a *test* triggers.
 *
 * The **startup** prompt of a launch is not this one's job: it fires on `did-finish-load`, before
 * any `evaluate` can be sure of landing, so it is answered by `SPM_FAKE_PICKER` in the launch
 * environment instead (see `launchWithUserData` and `resolveFolderPicker` in `src/app.ts`). This
 * covers every *user-triggered* pick, where the test is the one doing the clicking and the
 * ordering is therefore its own. The two cannot get in each other's way: the environment answers
 * `trigger === 'startup'` and nothing else, so a launch that never prompts at startup leaves no
 * armed one-shot waiting to swallow the first click a later spec makes.
 *
 * `answer` is the folder to return, or null to cancel. The options the shell passed are recorded
 * on the main process's `globalThis` — the same key the fake picker uses — so a test can assert on
 * them; there is no other way to see them, because the alternative is a dialog no test can read.
 */
export async function stubFolderPicker(
  app: ElectronApplication,
  answer: string | null,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const recorder = globalThis as unknown as { __spmPickerCalls?: unknown[] }
    recorder.__spmPickerCalls ??= []
    const stub = (...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => {
      // The real method is overloaded — (options) and (parentWindow, options) — so the options
      // are whichever argument came last.
      recorder.__spmPickerCalls?.push(args.length > 1 ? args[1] : args[0])
      return Promise.resolve(
        chosen === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [chosen] },
      )
    }
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = stub
  }, answer)
}

/** What the stub above recorded: one entry per `showOpenDialog`, in order. */
export async function pickerCalls(app: ElectronApplication): Promise<Record<string, unknown>[]> {
  return await app.evaluate(() => {
    const recorder = globalThis as unknown as { __spmPickerCalls?: Record<string, unknown>[] }
    return recorder.__spmPickerCalls ?? []
  })
}

/**
 * A project folder to create on disk before the app ever sees the library.
 *
 * `Uint8Array` as well as `string` because task 3 seeds a real binary STL — the viewer has to
 * parse what it fetches, and a text placeholder would only ever prove the transport.
 */
export type SeedProject = { name: string; files: Record<string, string | Uint8Array> }

/**
 * Launches the shell against a library folder of its own.
 *
 * With no `seed`, the folder is empty and does not yet contain a `.spm`: opening and migrating it
 * is the thing under test (ruling C-3), so handing the app a ready-made library would hide a
 * failure to do any of it.
 *
 * With a `seed`, the folders and files are written *before* launch and the database still does
 * not exist — so what the app later lists is a library it adopted from disk itself, not rows a
 * test inserted.
 *
 * `userDataDir` is a parameter, and defaulted, for the one thing `seed` cannot do: seed a file the
 * *shell* reads rather than one the library holds. `slicers.spec.ts` writes a `slicers.json` into
 * it before launch, which is what makes the two-install case testable on a machine that has one
 * install, or none, or is not Windows at all.
 */
/**
 * Chromium switches that give the renderer a WebGL context on a machine with no GPU.
 *
 * Only the viewer needs one, so only `files.spec.ts` passes these — the rest of the suite runs
 * the app exactly as a user would start it.
 *
 * Measured rather than copied off a wiki. Without them, `deno task test:desktop` on the CI
 * runner (ubuntu-latest, under `xvfb-run`) settles the viewer on
 * `"error: This browser could not open a 3D view. WebGL may be switched off…"` with
 * `roleImg: 0` — and that error hides the whole load-state switch in `viewer.page.ts`, so the
 * "bytes are gone" half of the pair loses its message too and both tests fail as
 * `element(s) not found`. It does not reproduce on a Windows development box: `--disable-gpu`
 * there still yields a `webgl2` context, which is why the reading above had to come from CI.
 *
 * `--enable-unsafe-swiftshader` is not optional on this Chromium: since 138 the software
 * rasteriser is refused for WebGL without it, and the flag is exactly as unsafe as the software
 * renderer Playwright's own Chromium uses for the `packages/web` viewer suite.
 */
export const SOFTWARE_WEBGL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]

/** Writes a seed's project folders into `libraryDir`, before any library exists there. */
export function seedLibrary(libraryDir: string, seed: SeedProject[]): void {
  for (const project of seed) {
    const dir = join(libraryDir, project.name)
    mkdirSync(dir, { recursive: true })
    for (const [name, contents] of Object.entries(project.files)) {
      writeFileSync(join(dir, name), contents)
    }
  }
}

/**
 * `prepare` is the folder's last moment alone.
 *
 * It runs after the seed is on disk and before Electron is started, which is the only window in
 * which a test can put something into the library that the shell will then find rather than
 * race. The shell starts its preview ticker inside `LibraryHost.open()` — before the adoption
 * rescan, and with the first tick fired immediately — so a `previews` row written *after* launch
 * is contested by the app's own queue, and one written here is not: `claimPendingPreviews` takes
 * `state = 'pending'` alone, and a rescan re-pends a row only where the file's bytes changed or a
 * `CLASSIFIER_VERSION` bump gave it a different kind — and the seed here is written by the same
 * build that will rescan it, so its rows are already stamped with the current version.
 * `files.spec.ts` is the caller, and carries the rest of that reasoning.
 */
export async function launchApp(
  seed: SeedProject[] = [],
  chromiumArgs: string[] = [],
  userDataDir: string = newUserDataDir(),
  prepare?: (libraryDir: string) => Promise<void> | void,
): Promise<LaunchedApp> {
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-desktop-'))
  seedLibrary(libraryDir, seed)
  await prepare?.(libraryDir)
  const app = await electron.launch({
    args: [
      MAIN_BUNDLE,
      `--user-data-dir=${userDataDir}`,
      ...LOCALE_ARGS,
      ...loggingArgs(),
      ...chromiumArgs,
    ],
    // The environment names the folder, so there should be no startup prompt here at all. The
    // empty `SPM_FAKE_PICKER` says what happens if that is ever wrong: the startup prompt is
    // cancelled rather than a real dialog opening on the runner — and, because it answers only
    // that prompt, a spec built on this fixture can still click the header control and have
    // `stubFolderPicker` answer it.
    env: { ...process.env, SPM_LIBRARY_DIR: libraryDir, SPM_FAKE_PICKER: '' },
  })
  pipeProcessOutput(app, 'launchApp')
  await stubFolderPicker(app, null)
  return { app, libraryDir, userDataDir }
}

/**
 * The dialog's own language is the OS locale, and the assertions in `library.spec.ts` are on
 * English strings. `--lang` is what pins `app.getLocale()`, so the suite reads the same on a
 * German development machine as it does on an English CI runner.
 */
const LOCALE_ARGS = ['--lang=en-US']

/** Where CI asks for Chromium's own log; unset locally, where nothing needs it. */
const LOG_DIR_ENV = 'SPM_ELECTRON_LOG_DIR'

let launchCount = 0

/**
 * Chromium's own log, written by the browser process from its first line — ruling C-21.
 *
 * **What it is and is not, measured rather than assumed.** It carries *Chromium's* logging — the
 * dbus, GPU and sandbox complaints that were the only content of the four `firstWindow`
 * timeouts — and **not** the main process's Node `console.warn`, which goes to stderr. On a
 * healthy Windows launch it is written and stays **0 bytes**, which is the expected shape: an
 * empty file means Chromium had nothing at ERROR or WARNING to say.
 *
 * So it complements the stderr pipe rather than replacing it, and neither is the decisive
 * instrument — `describeStalledApp` above is, because it asks the live main process what state it
 * is in. This is the environment-side evidence to read beside that answer.
 *
 * A file per launch, because `--log-file` does not template and every launch in the suite would
 * otherwise leave one. Off unless the environment names a directory, so a local run writes
 * nothing.
 *
 * **The worker's pid is in the name because leaving it out destroyed the evidence once.** Run
 * 33122549571's artifact held thirty `electron-N.log` files and not one of them was from a failed
 * launch: Playwright discards a worker after a test fails, the counter below starts again at 1 in
 * the replacement, and each of the three workers in that run overwrote `electron-1.log` in turn —
 * so the only file that survived was the *passing* third attempt. The counter alone is unique
 * within a worker and nothing else.
 */
function loggingArgs(): string[] {
  const dir = process.env[LOG_DIR_ENV]
  if (!dir) return []
  launchCount += 1
  mkdirSync(dir, { recursive: true })
  return [
    '--enable-logging=file',
    `--log-file=${join(dir, `electron-${process.pid}-${launchCount}.log`)}`,
    '--log-level=0',
  ]
}

/**
 * Launches at a given userData directory, with no `SPM_LIBRARY_DIR` at all, and a picker stubbed
 * to `answer`. This is the shape task 4's own paths are driven through: first run, a remembered
 * folder, and a remembered folder that has gone.
 */
export async function launchWithUserData(
  userDataDir: string,
  answer: string | null = null,
  mode: 'local' | 'remote' | 'cancel' = 'local',
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...LOCALE_ARGS, ...loggingArgs()],
    // Two questions, two environment answers, and both exist for the same reason: they are raised
    // on `did-finish-load`, so a suite that replaced the dialogs after launch would be racing the
    // app's own startup and the price of losing is a real native modal on a CI runner.
    //
    // `SPM_FAKE_MODE` answers task 5's mode question — which comes *first* at a first run — and
    // defaults to `local`, so every spec written against task 4's behaviour reads unchanged.
    // `SPM_FAKE_PICKER` then answers the startup folder prompt with this folder, or cancels it
    // when the answer is null. A folder answered that way is remembered, exactly as a folder
    // chosen in the dialog is, which is what makes the relaunch assertion in `library.spec.ts` a
    // real one. Picks the test triggers open the real dialog, which is where `stubFolderPicker`
    // takes over.
    env: {
      ...envWithoutLibraryDir(),
      SPM_FAKE_MODE: mode,
      SPM_FAKE_PICKER: answer ?? '',
    },
  })
  pipeProcessOutput(app, 'launchWithUserData')
  await stubFolderPicker(app, answer)
  return app
}

/**
 * Answers the shell's *connect confirmation* (ruling C-20) without a native dialog.
 *
 * Unlike the two startup questions this one has no environment override, deliberately: it is
 * raised in answer to a call the renderer makes, so there is no `did-finish-load` race to lose,
 * and an environment variable that could pre-answer it would also be a way to switch the gate
 * off. It is stubbed at the dialog, after launch, the way `stubFolderPicker` stubs the folder
 * chooser — and it records what it was shown, so a test can assert the origin was named.
 *
 * It replaces `dialog.showMessageBox` wholesale, which in a launch that also raises the *mode*
 * question would answer that one too. Every spec that uses this sets `SPM_FAKE_MODE`, so the
 * mode question never reaches the dialog at all.
 */
export async function stubRemoteConfirmation(
  app: ElectronApplication,
  confirm: boolean,
): Promise<void> {
  await app.evaluate(({ dialog }, allow) => {
    const recorder = globalThis as unknown as { __spmConfirmCalls?: unknown[] }
    recorder.__spmConfirmCalls ??= []
    const parented = globalThis as unknown as { __spmConfirmParented?: boolean[] }
    parented.__spmConfirmParented ??= []
    const stub = (...args: unknown[]): Promise<{ response: number }> => {
      // The overload is `(options)` or `(parentWindow, options)`. Which one the shell used is the
      // whole of whether the dialog is window-modal — measured on Electron 44.0.0: a parented box
      // leaves `win.isEnabled()` **false** while it is up and a parentless one leaves it `true`,
      // so the page that asked cannot be touched until the question is answered.
      parented.__spmConfirmParented?.push(args.length > 1)
      recorder.__spmConfirmCalls?.push(args.length > 1 ? args[1] : args[0])
      // Index 1 is Connect and index 0 is Cancel — see `CONFIRM_CHOICES` in library.ts.
      return Promise.resolve({ response: allow ? 1 : 0 })
    }
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = stub
  }, confirm)
}

/** Whether each confirmation was raised with a parent window, and so was window-modal. */
export async function confirmationsWereParented(app: ElectronApplication): Promise<boolean[]> {
  return await app.evaluate(() => {
    const recorder = globalThis as unknown as { __spmConfirmParented?: boolean[] }
    return recorder.__spmConfirmParented ?? []
  })
}

/** What that stub recorded: one entry per confirmation the shell raised, in order. */
export async function confirmationCalls(
  app: ElectronApplication,
): Promise<Record<string, unknown>[]> {
  return await app.evaluate(() => {
    const recorder = globalThis as unknown as { __spmConfirmCalls?: Record<string, unknown>[] }
    return recorder.__spmConfirmCalls ?? []
  })
}

/** What the fake mode picker recorded: one entry per question the shell raised, in order. */
export async function modeCalls(app: ElectronApplication): Promise<Record<string, unknown>[]> {
  return await app.evaluate(() => {
    const recorder = globalThis as unknown as { __spmModeCalls?: Record<string, unknown>[] }
    return recorder.__spmModeCalls ?? []
  })
}

function envWithoutLibraryDir(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Both mode overrides are stripped, not just the folder one: a developer with either set in
    // their shell would otherwise have every spec in this suite open their own library or point
    // at their own server, which is the failure this function has always existed to prevent.
    if (key !== 'SPM_LIBRARY_DIR' && key !== 'SPM_REMOTE_URL' && value !== undefined) {
      env[key] = value
    }
  }
  return env
}

/**
 * Forwards the Electron process's own stdout and stderr into the test output.
 *
 * Playwright captures the child's streams and shows them to nobody, so when a launch fails the
 * one account of *why* — the main process's `console.error('desktop: startup failed', …)`, a
 * missing shared library, a Chromium sandbox complaint — is thrown away, and the test reports
 * only that no window arrived. That is exactly the position the desktop job left us in: three
 * failures whose whole content was `Timeout … waiting for event "window"`.
 *
 * Prefixed and unconditional. The shell is quiet on a healthy launch — the suite's own
 * `renderer boots without a console error or warning` spec depends on that being true — so this
 * costs nothing on the runs that pass.
 *
 * **What it does not catch, measured rather than assumed.** The handlers attach after
 * `electron.launch` resolves, so anything the process wrote before that is already gone:
 * `resolveFolderPicker`'s `SPM_FAKE_PICKER is set` warning is emitted by every `launchApp` in
 * this file and appeared **zero** times in a full CI run through this pipe, while a later
 * `desktop: the last folder is no longer there` came through fine. So this shows what a launch
 * says once it is up, not what it says while starting — which is the half a wedged startup most
 * needs. Recorded rather than left to look complete.
 */
function pipeProcessOutput(app: ElectronApplication, label: string): void {
  const child = app.process()
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${label} out] ${chunk}`))
  child.stderr?.on('data', (chunk: Buffer) => process.stdout.write(`[${label} err] ${chunk}`))
}

/**
 * The app's first window: Playwright's own wait, a nudge for the one thing patience cannot fix,
 * and the main process's own state attached when neither works.
 *
 * **Ruling C-21, and this time with the mechanism rather than a shrug.** Six CI failures across
 * this branch, every one passing on a re-run of the same commit, all reporting
 * `firstWindow: Timeout … waiting for event "window"`. The diagnostic below produced the same
 * reading four times:
 *
 * ```
 * main process at the moment of the timeout:
 *   {"isReady":true,"windowCount":1,"urls":["spm://app/projects"],"uptimeMs":90526, …}
 * ```
 *
 * The window **existed**, had loaded, and had routed itself to `/projects` for the whole ninety
 * seconds. Not the environment (`isReady: true`), not this app (a window, at the right URL):
 * Playwright never reported it.
 *
 * **Why, read out of `playwright-core` and then reproduced.** Playwright reports an Electron
 * window only once `CRPage`'s `FrameSession._initialize` resolves, and the last thing that
 * function awaits is `_firstNonInitialNavigationCommittedPromise` — the main frame committing a
 * navigation that is not the initial empty document. A window whose commit Playwright does not
 * observe is therefore a window Playwright never announces, for ever; `app.windows()` and the
 * `window` event are two views of that same unreported page, which is why the window-list
 * fallback measured useless last round.
 *
 * That shape is reproducible on demand, and was: an Electron app that opens a `BrowserWindow` and
 * never calls `loadURL` puts Playwright in exactly the observed state —
 * `BrowserWindow.getAllWindows().length === 1` in the main process against `app.windows() === 0`,
 * `app.context().pages() === 0`, and a `firstWindow` that never resolves. Measured, on this
 * Playwright (1.62.1) and this Electron (44.0.0), rather than inferred: the third accessor was
 * checked because the docblock could otherwise only have asserted it shared the attachment.
 *
 * **So the nudge.** Make the window commit a navigation Playwright cannot miss: ask the *main
 * process* — over the Node inspector connection, which is a different socket from the browser one
 * and demonstrably still answering — to reload the window it says it has. In the reproduction
 * above the page arrived **21 ms** later, and `app.context().pages()` went 0 → 1.
 *
 * What this does **not** claim. It cannot conjure a window: `nudgeMissedAttachment` reloads only a
 * window the main process reports and only one that has already loaded a URL, so a launch that
 * never opened one still fails, with `windowCount: 0` printed against it. It does not weaken a
 * single assertion — the page returned is a real Playwright page onto a real window that really
 * loaded the app — and it cannot pass silently: every nudge is warned about on stdout, so a run
 * that needed one says so. Upstream this is still open (microsoft/playwright#21117, where the
 * same hang is worked around by opening the devtools); the CI-only retry stays behind this as the
 * last resort.
 */
export async function firstWindowOf(app: ElectronApplication): Promise<Page> {
  const window = app.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })
  const nudges = nudgeMissedAttachment(app, window)
  try {
    const page = await window
    const notes = await nudges
    // Loud on purpose. A recovery nobody can see is indistinguishable from a bug that stopped
    // happening, and this line is the only evidence that C-21 fired at all on a green run.
    if (notes.length > 0)
      console.warn(`desktop: C-21 — first window arrived after ${notes.join('; ')}`)
    return page
  } catch (error) {
    const notes = await nudges
    throw new Error([(error as Error).message, await describeStalledApp(app), ...notes].join('\n'))
  }
}

/**
 * Every `NUDGE_INTERVAL_MS` that passes without Playwright announcing a window, ask the main
 * process what it has and reload it — see `firstWindowOf` for why that is what unsticks it.
 *
 * A loop rather than one shot, because the two failure shapes need different moments: a window
 * that exists at launch is nudged at the first interval, and a window that only appears at, say,
 * forty seconds on a loaded runner would be missed entirely by a single check at fifteen. It
 * stops as soon as `window` settles either way, so a healthy launch pays for one `Promise.race`
 * and never touches the main process at all.
 *
 * It returns notes rather than throwing: this runs beside the wait it is trying to rescue, and a
 * helper that fails on its own account would replace the diagnosis with its own stack.
 */
async function nudgeMissedAttachment(
  app: ElectronApplication,
  window: Promise<Page>,
): Promise<string[]> {
  const notes: string[] = []
  const startedAt = Date.now()
  const deadline = startedAt + FIRST_WINDOW_TIMEOUT_MS - NUDGE_INTERVAL_MS
  while (Date.now() < deadline) {
    if (await settledWithin(window, NUDGE_INTERVAL_MS)) return notes
    notes.push(await nudgeOnce(app, Date.now() - startedAt))
  }
  return notes
}

/** True if `window` settled — resolved or rejected — inside `ms`, false if the time ran out. */
async function settledWithin(window: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<false>((settle) => {
    timer = setTimeout(() => settle(false), ms)
  })
  try {
    return await Promise.race([
      window.then(
        () => true,
        () => true,
      ),
      expiry,
    ])
  } finally {
    // Without this a healthy launch would hold the event loop open for the rest of the interval.
    clearTimeout(timer)
  }
}

/** One nudge, and a sentence saying what it found — which is the whole of what it guarantees. */
async function nudgeOnce(app: ElectronApplication, elapsedMs: number): Promise<string> {
  const at = `${Math.round(elapsedMs / 1000)}s`
  try {
    const loaded = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      if (!window) return null
      const url = window.webContents.getURL()
      // A window that has loaded nothing has no navigation to repeat, and `reload()` on it is a
      // no-op — so say so instead of pretending to have done something.
      if (url) window.webContents.reload()
      return url
    })
    if (loaded === null) return `no window in the main process at ${at} either, so nothing to nudge`
    if (loaded === '') return `a window at ${at} that had loaded nothing, so a reload was pointless`
    return `a window Playwright had not attached to at ${at}, whose ${loaded} was reloaded`
  } catch (error) {
    return `the main process could not be asked for a window at ${at}: ${String(error)}`
  }
}

/**
 * What the main process looks like at the moment `firstWindow` gave up — ruling C-21.
 *
 * **`electron.launch()` succeeded in every one of those failures.** The error was a `firstWindow`
 * timeout, not a launch timeout, so Playwright had a live connection to the main process the
 * whole time and the diagnosis was one `evaluate` away rather than a packet capture. Four
 * occurrences were shrugged at for want of `isReady`, `windowCount`, `urls`, `uptimeMs` and
 * `gpu` — named rather than counted, because the count is what went stale the last time this
 * sentence was written.
 *
 * **Two things make it survive the cases it exists for**, neither of which the first version had:
 *
 * - `gpu` and `urls` are wrapped on their own. They are the two fields that can throw — a torn
 *   down window has no `webContents.getURL()`, and GPU state is least likely to be available in
 *   exactly the `isReady: false` case this is most needed for. One throwing field used to discard
 *   the other four and print "could not be inspected either" instead.
 * - The `evaluate` races a timer. A main process wedged *synchronously* — hypothesis 2 below —
 *   cannot answer an `evaluate` at all, and with a 90 s wait inside a 120 s budget there is only
 *   about 30 s of slack, so an unbounded call would take the test out on its own timeout and lose
 *   even the original `firstWindow` message. Ten seconds makes this strictly better than saying
 *   nothing, under all three hypotheses.
 *
 * How to read what it prints:
 *
 * - `isReady: false` — `app.whenReady()` never resolved. That is the environment, not this app:
 *   nothing in `main()` runs before it.
 * - `isReady: true, windowCount: 0` — the ready block is stuck or threw before
 *   `createMainWindow`. The only synchronous work there is `shellHost.start()` →
 *   `openDesktopLibrary`, and SQLite's `busy_timeout` is 5 s, which cannot produce 90 s; a throw
 *   would have called `app.exit` and given Playwright a *closed app* instead of this timeout. So
 *   this combination would be genuinely new information.
 * - `windowCount: 1` — the window exists and Playwright missed it. That is the harness.
 *
 * It must not throw on its own account: a diagnostic that fails while reporting a failure buries
 * the thing it was called about.
 */
async function describeStalledApp(app: ElectronApplication): Promise<string> {
  const asked = app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    // Each fallible field on its own, so one of them throwing costs one value and not the report.
    let urls: string[] | string
    try {
      urls = windows.map((window) => window.webContents.getURL())
    } catch (error) {
      urls = `unavailable: ${String(error)}`
    }
    let gpu: unknown
    try {
      gpu = electronApp.getGPUFeatureStatus()
    } catch (error) {
      gpu = `unavailable: ${String(error)}`
    }
    return {
      isReady: electronApp.isReady(),
      windowCount: windows.length,
      urls,
      uptimeMs: Math.round(process.uptime() * 1000),
      gpu,
    }
  })

  const timedOut = Symbol('timed out')
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<typeof timedOut>((settle) => {
    timer = setTimeout(() => settle(timedOut), INSPECT_TIMEOUT_MS)
  })

  try {
    const state = await Promise.race([asked, expiry])
    if (state === timedOut) {
      // The most informative answer this function can give, and only reachable when the main
      // process cannot answer at all — which is itself the finding.
      return `main process did not answer an evaluate within ${INSPECT_TIMEOUT_MS} ms, so it is wedged rather than merely slow`
    }
    return `main process at the moment of the timeout: ${JSON.stringify(state)}`
  } catch (error) {
    return `main process could not be inspected either: ${String(error)}`
  } finally {
    clearTimeout(timer)
    // The losing branch must not surface as an unhandled rejection after the test has failed.
    void asked.catch(() => {})
  }
}

const INSPECT_TIMEOUT_MS = 10_000

const FIRST_WINDOW_TIMEOUT_MS = 90_000

/**
 * How long Playwright gets to announce a window on its own before the main process is asked.
 *
 * Fifteen seconds is not a guess about the stall — that one never ends, so any interval would do —
 * it is a bound on the *healthy* path, which on this suite is about a second and on the slowest
 * CI launch measured (a cold first launch after the Angular build, where the GPU process took
 * 3.6 s to appear) still well inside it. Short enough that all five nudges fit inside the ninety
 * seconds; long enough that a merely slow launch is never reloaded out from under itself.
 */
const NUDGE_INTERVAL_MS = 15_000

export type ShellLaunch = {
  /** `SPM_REMOTE_URL`: this launch is for that server, and it is not remembered. */
  remoteUrl?: string
  /** `SPM_FAKE_MODE`: how the startup (and menu) mode question is answered without a dialog. */
  fakeMode?: 'local' | 'remote' | 'cancel'
  /**
   * `SPM_FAKE_PICKER`: the folder the *startup* folder prompt is answered with, or `null` to
   * cancel it. Left unset when absent, so a user-triggered pick reaches the real dialog and
   * `stubFolderPicker` can answer it.
   */
  fakePicker?: string | null
}

/**
 * The shell, launched with nothing but the environment a case needs.
 *
 * `launchApp` and `launchWithUserData` above are task 4's shapes and stay as they are; this is
 * the one task 5's cases are built on, because they vary along a different axis — which *mode*
 * the launch starts in, and whether it was told or has to remember.
 */
export async function launchShell(
  userDataDir: string,
  launch: ShellLaunch = {},
): Promise<ElectronApplication> {
  const env = envWithoutLibraryDir()
  if (launch.remoteUrl !== undefined) env['SPM_REMOTE_URL'] = launch.remoteUrl
  if (launch.fakeMode !== undefined) env['SPM_FAKE_MODE'] = launch.fakeMode
  if (launch.fakePicker !== undefined) env['SPM_FAKE_PICKER'] = launch.fakePicker ?? ''
  const app = await electron.launch({
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...LOCALE_ARGS, ...loggingArgs()],
    env,
  })
  pipeProcessOutput(app, 'launchShell')
  return app
}

/**
 * The shell with no library folder at all — no `SPM_LIBRARY_DIR`, nothing remembered, and a
 * cancelled picker, which since task 4 is the only way a user reaches this state.
 *
 * Nothing is open, and the window still opens: the bridge answers `capabilities` out of the shell
 * itself and every library-backed call reports `Conflict`. What this fixture exists for is the
 * protocol handler's session accessor, which has to have an answer for that state too.
 */
export async function launchWithoutLibrary(): Promise<ElectronApplication> {
  // A fresh userData, so nothing is remembered, and a picker that cancels — which is exactly how
  // a user reaches this state now that task 4 asks for a folder on first run.
  return await launchWithUserData(newUserDataDir(), null)
}

declare global {
  // The preload's bridge, as the renderer sees it. Declared here rather than in one spec so
  // every `page.evaluate` body in the suite is type-checked by `deno task typecheck:desktop`
  // against the same shape instead of being `any`.
  var spm: {
    /** Which transport this window was built with; see `BridgeMode` in `src/protocol.ts`. */
    mode: 'local' | 'remote'
    canStreamFromDisk(file: unknown): boolean
    invoke(
      path: string,
      args: unknown[],
    ): Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
    >
  }
}
