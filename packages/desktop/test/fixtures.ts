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

export async function launchApp(
  seed: SeedProject[] = [],
  chromiumArgs: string[] = [],
): Promise<LaunchedApp> {
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-desktop-'))
  seedLibrary(libraryDir, seed)
  const userDataDir = newUserDataDir()
  const app = await electron.launch({
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...LOCALE_ARGS, ...chromiumArgs],
    // The environment names the folder, so there should be no startup prompt here at all. The
    // empty `SPM_FAKE_PICKER` says what happens if that is ever wrong: the startup prompt is
    // cancelled rather than a real dialog opening on the runner — and, because it answers only
    // that prompt, a spec built on this fixture can still click the header control and have
    // `stubFolderPicker` answer it.
    env: { ...process.env, SPM_LIBRARY_DIR: libraryDir, SPM_FAKE_PICKER: '' },
  })
  await stubFolderPicker(app, null)
  return { app, libraryDir, userDataDir }
}

/**
 * The dialog's own language is the OS locale, and the assertions in `library.spec.ts` are on
 * English strings. `--lang` is what pins `app.getLocale()`, so the suite reads the same on a
 * German development machine as it does on an English CI runner.
 */
const LOCALE_ARGS = ['--lang=en-US']

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
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...LOCALE_ARGS],
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
 * The app's first window, with more patience than Playwright's 30-second default.
 *
 * **Measured on CI, three first-attempt failures in a row, each green on a re-run of the same
 * commit**: `electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event
 * "window"`. The first was the software-WebGL launch, which made it look like a property of the
 * heaviest launch in the suite; the third was an ordinary one, which settled it — it is the
 * runner, which sometimes needs longer than thirty seconds to bring up an Electron process, and
 * every launch here is exposed to it.
 *
 * Patience, not a weaker assertion. A shell that never opens a window still fails, later; the
 * job's own `timeout-minutes` is the backstop for a genuine hang, and the whole suite runs in
 * about a minute and a half, so this ceiling is nowhere near the normal path.
 *
 * Every spec goes through this rather than calling `firstWindow()` directly, so the number lives
 * in one place and a fourth failure has one line to change.
 */
export async function firstWindowOf(app: ElectronApplication): Promise<Page> {
  return await app.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })
}

const FIRST_WINDOW_TIMEOUT_MS = 90_000

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
  return await electron.launch({
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...LOCALE_ARGS],
    env,
  })
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
