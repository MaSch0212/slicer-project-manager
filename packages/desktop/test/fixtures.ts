import { _electron as electron, type ElectronApplication } from '@playwright/test'
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
 * Replaces the native folder picker in the main process.
 *
 * Every launch in this suite installs one, including the launches that expect no picker: without
 * it, a first-run app pops a real GTK/Win32 folder dialog on the runner, and while that is
 * survivable — measured, `electronApp.close()` still returns in 70 ms with one open — it is not
 * something a suite should leave on a CI machine.
 *
 * `answer` is the folder to return, or null to cancel. The options the shell passed are recorded
 * on the main process's `globalThis` so a test can assert on them; there is no other way to see
 * them, because the alternative is a dialog no test can read.
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
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`, ...chromiumArgs],
    env: { ...process.env, SPM_LIBRARY_DIR: libraryDir },
  })
  // The environment names the folder, so nothing here should ever reach the picker — the stub is
  // what turns "should" into a test that says so, and stops a regression opening a real dialog.
  await stubFolderPicker(app, null)
  return { app, libraryDir, userDataDir }
}

/**
 * Launches at a given userData directory, with no `SPM_LIBRARY_DIR` at all, and a picker stubbed
 * to `answer`. This is the shape task 4's own paths are driven through: first run, a remembered
 * folder, and a remembered folder that has gone.
 */
export async function launchWithUserData(
  userDataDir: string,
  answer: string | null = null,
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`],
    env: envWithoutLibraryDir(),
  })
  await stubFolderPicker(app, answer)
  return app
}

function envWithoutLibraryDir(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'SPM_LIBRARY_DIR' && value !== undefined) env[key] = value
  }
  return env
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
