import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The bundle the global setup built. Launched by path, exactly as `dev:desktop` does. */
export const MAIN_BUNDLE = resolve(here, '../dist/main.js')

export type LaunchedApp = { app: ElectronApplication; libraryDir: string }

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

export async function launchApp(
  seed: SeedProject[] = [],
  chromiumArgs: string[] = [],
): Promise<LaunchedApp> {
  const libraryDir = mkdtempSync(join(tmpdir(), 'spm-desktop-'))
  for (const project of seed) {
    const dir = join(libraryDir, project.name)
    mkdirSync(dir, { recursive: true })
    for (const [name, contents] of Object.entries(project.files)) {
      writeFileSync(join(dir, name), contents)
    }
  }
  const app = await electron.launch({
    args: [MAIN_BUNDLE, ...chromiumArgs],
    env: { ...process.env, SPM_LIBRARY_DIR: libraryDir },
  })
  return { app, libraryDir }
}

/**
 * The shell with no library folder at all — `SPM_LIBRARY_DIR` unset rather than pointed at an
 * empty directory, which is a different state and the one task 4 will start in.
 *
 * `resolveLibraryDir` returns null, `main()` never calls `openDesktopLibrary`, and the window
 * still opens: the bridge answers `capabilities` out of the shell itself and every
 * library-backed call reports `Conflict`. What this fixture exists for is the protocol handler's
 * session accessor, which has to have an answer for that state too.
 */
export async function launchWithoutLibrary(): Promise<ElectronApplication> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'SPM_LIBRARY_DIR' && value !== undefined) env[key] = value
  }
  return await electron.launch({ args: [MAIN_BUNDLE], env })
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
