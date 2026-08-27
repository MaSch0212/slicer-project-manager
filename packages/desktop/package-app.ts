import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * An unpacked, runnable application directory — the plan's Definition of Done, and not an
 * installer.
 *
 * Installers and code signing are deferred with reasons in the plan's Scope: they are a per-OS
 * concern with certificates attached and no design question in this subsystem depends on how the
 * result is shipped. What *cannot* be deferred is something a person can run, because a subsystem
 * nobody has run is a claim.
 *
 * Run it with `deno task package:desktop`, which builds the renderer and the main bundle first.
 *
 * ## What it produces, and what that directory assumes is installed
 *
 * `packages/desktop/out/slicer-project-manager-<platform>-<arch>/` holds the Electron runtime with
 * this app's own files inside it — the layout Electron looks for by default, `resources/app` with
 * a `package.json` naming the entry point. **It needs no Node, no Deno, no `node_modules` and no
 * Electron on the machine that runs it**, because `build.ts` bundles `@spm/core`, `@spm/contract`
 * and zod into the main bundle and everything else here is Electron's own distribution.
 *
 * What it does still assume is the platform's own C/C++ runtime and desktop libraries, which is
 * Electron's requirement rather than this app's: on Linux, the shared libraries the CI job
 * installs by name (`libgtk-3`, and Chromium's list); on Windows, nothing that a supported
 * Windows does not already have. That is the honest boundary of "runnable": it is a build of this
 * app that starts on a machine with no developer toolchain, not a self-contained static binary.
 *
 * ## The renderer, and why it is copied rather than referenced
 *
 * `defaultRendererDir()` looks for `renderer/index.html` beside the main bundle before falling
 * back to the repo layout. Copying the Angular build in is what makes the directory movable: with
 * the repo-relative path, the packaged app would serve `spm://app/` out of the source tree it was
 * built in and show a blank window anywhere else.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const distDir = join(here, 'dist')
const rendererSrc = resolve(repoRoot, 'packages/web/dist/electron/browser')
const electronDist = resolve(repoRoot, 'node_modules/electron/dist')

/** `app.setName` decides the userData directory; this only names the folder and the executable. */
const APP_SLUG = 'slicer-project-manager'

async function assertDirectory(path: string, why: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${path} is missing — ${why}`)
}

const outRoot = join(here, 'out')
const outDir = join(outRoot, `${APP_SLUG}-${process.platform}-${process.arch}`)
const appDir = join(outDir, 'resources', 'app')

await assertDirectory(distDir, 'run `deno task build:desktop` first')
await assertDirectory(rendererSrc, 'run `deno task build:ui:electron` first')
await assertDirectory(
  electronDist,
  'the Electron binary has not been downloaded; run `node node_modules/electron/install.js`',
)

// Removed rather than merged: a stale main.js from a previous shape of this script is exactly the
// artefact `build.ts` refuses to leave behind, and the reason is the same — a directory that
// half-updates is one nobody can reason about.
await rm(outDir, { recursive: true, force: true })
await mkdir(appDir, { recursive: true })

// Electron's own distribution, whole. `dereference` because npm may have linked rather than
// copied parts of it, and a packaged app full of symlinks into node_modules is not movable.
await cp(electronDist, outDir, { recursive: true, dereference: true })

// The main bundle, its preload, its sourcemaps and the SQL migrations `openLibrary` reads.
await cp(distDir, join(appDir, 'dist'), { recursive: true })
// The renderer, where `defaultRendererDir()` looks for it in a packaged app.
await cp(rendererSrc, join(appDir, 'dist', 'renderer'), { recursive: true })

/**
 * The manifest Electron reads to find the entry point.
 *
 * `"type": "module"` is not cosmetic and it is the same fact `build.ts` records: the main bundle
 * is ESM because `migrate.ts` resolves its SQL through `import.meta.url`, and Electron decides how
 * to load `main.js` from the nearest package.json exactly as Node does. Without it the first
 * `import` in the bundle is a syntax error and the app never opens a window.
 */
await writeFile(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: APP_SLUG,
      productName: 'Slicer Project Manager',
      version: JSON.parse(await readFile(join(here, 'package.json'), 'utf8')).version as string,
      main: 'dist/main.js',
      type: 'module',
    },
    null,
    2,
  )}\n`,
)

/**
 * What must be there afterwards, checked rather than assumed.
 *
 * A packaging script that exits 0 having written half a directory is worse than one that fails:
 * the failure it produces is a window that opens and is blank, or one that opens and cannot open
 * a library, both a long way from the step that caused them.
 */
const REQUIRED = [
  join(appDir, 'package.json'),
  join(appDir, 'dist', 'main.js'),
  join(appDir, 'dist', 'preload.js'),
  join(appDir, 'dist', 'migrations', '001_init.sql'),
  join(appDir, 'dist', 'renderer', 'index.html'),
]
for (const file of REQUIRED) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size === 0) throw new Error(`package:desktop did not write ${file}`)
}

const executable = (await readdir(outDir)).find((name) =>
  process.platform === 'win32' ? name === 'electron.exe' : name === 'electron',
)
if (!executable) throw new Error(`no Electron executable in ${outDir}`)

console.log(`desktop: packaged to ${outDir}`)
console.log(`desktop: run it with ${join(outDir, executable)}`)
