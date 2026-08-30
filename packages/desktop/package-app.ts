import { packager } from '@electron/packager'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_SLUG, packagedExecutableName, requiredArtifacts } from './packaging.ts'

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
 * Electron on the machine that runs it**, because `build.ts` bundles every dependency the main
 * process imports — `@spm/core`, `@spm/contract`, zod and the `occt-import-js` glue — into the
 * main bundle, and stages the loose files that bundle then reads beside it: the OCCT `.wasm`, the
 * SQL migrations and the window icons. Those are this app's own files, not Electron's; the rest
 * of the directory is Electron's own distribution.
 *
 * What it does still assume is the platform's own C/C++ runtime and desktop libraries, which is
 * Electron's requirement rather than this app's: on Linux, the shared libraries the CI job
 * installs by name (`libgtk-3`, and Chromium's list); on Windows, nothing that a supported
 * Windows does not already have. That is the honest boundary of "runnable": it is a build of this
 * app that starts on a machine with no developer toolchain, not a self-contained static binary.
 *
 * ## What ships inside it
 *
 * `dist/` is staged whole, **sourcemaps included**, so the unpacked application carries the full
 * main-process source. That is a decision and not an inheritance: this artifact exists so a
 * person can run the subsystem and report what happened, and a stack trace that names
 * `remote.ts:329` is worth more here than the modest secrecy of a bundle nobody is shipping to
 * customers. There is nothing in this source a reader of the public repository does not have.
 *
 * `asar: false` is the same decision one layer down. An asar archive would fold `resources/app`
 * into one opaque file, which is the opposite of what the paragraph above wants.
 *
 * An installer would want both of those inverted, and that is one of the things deferred with it:
 * when packaging becomes real, dropping `*.map` and turning asar on are two lines in this file.
 *
 * ## The renderer, and why it is staged rather than referenced
 *
 * `defaultRendererDir()` looks for `renderer/index.html` beside the main bundle before falling
 * back to the repo layout. Copying the Angular build in is what makes the directory movable: with
 * the repo-relative path, the packaged app would serve `spm://app/` out of the source tree it was
 * built in and show a blank window anywhere else.
 *
 * ## Why `@electron/packager`, and the one option that makes it usable here
 *
 * This script used to copy `node_modules/electron/dist` itself and leave the executable exactly as
 * Electron shipped it — called `electron.exe`, wearing Electron's logo and version strings in
 * every place that reads a file rather than a running window: Explorer, a pinned taskbar entry,
 * Alt-Tab, Task Manager. `app.setName` and `BrowserWindow`'s `icon` option do not reach any of
 * those; they are resources inside the PE, and renaming the file is the other half.
 *
 * `@electron/packager` is the Electron organisation's own tool for exactly that, and it is what
 * this script now calls. `executableName` gives the binary its name on every platform, `icon`
 * replaces the `RT_GROUP_ICON` resource from an `.ico`, and `win32metadata` writes the version
 * strings — the same work by the people who maintain the format, instead of a hand-rolled rename
 * plus a resource editor here.
 *
 * The one thing it does not do by default is stay off the network, and that mattered enough to
 * measure rather than assume. Packager obtains Electron through `@electron/get` as a zip; it
 * passes no `checksums`, so `@electron/get` fetches `SHASUMS256.txt` fresh on **every** run — even
 * when the zip is already cached. Measured: with no `download` option, the call below under
 * `deno run -A --deny-net` fails with `Requires net access to "github.com:443"`.
 *
 * `download: { checksums }` is what fixes it, and the checksums come from a file this repo already
 * has on disk: `node_modules/electron/checksums.json`, which the `electron` package ships and its
 * own installer uses for the same purpose. With it, the identical call under `--deny-net` packages
 * successfully — measured. Nothing is traded away for that: the zip is still verified, against the
 * digests the installed Electron vouches for.
 *
 * What remains is narrower and worth stating rather than hiding: packager unpacks the **zip** from
 * `@electron/get`'s cache, not the already-extracted `node_modules/electron/dist`, and there is no
 * option to point it at the latter. `deno install --allow-scripts` puts that zip in the cache as a
 * side effect of installing `electron`, so a machine that has installed this repo's dependencies
 * has it. A machine whose `node_modules` was restored from a CI cache without the matching
 * `@electron/get` cache would download it once. `electronZipDir` is the escape hatch if that ever
 * needs closing.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const distDir = join(here, 'dist')
const rendererSrc = resolve(repoRoot, 'packages/web/dist/electron/browser')
const electronPkg = resolve(repoRoot, 'node_modules/electron')

async function assertDirectory(path: string, why: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${path} is missing — ${why}`)
}

const outRoot = join(here, 'out')
const outDir = join(outRoot, `${APP_SLUG}-${process.platform}-${process.arch}`)

/**
 * Computed here, above everything, because on macOS this throws.
 *
 * That placement is the point: the refusal has to happen before anything is written, not part-way
 * through. `packaging.ts` carries the message and the reasons; this is only where it fires.
 */
const executable = packagedExecutableName(process.platform)

/** The same `version` the manifest records and the PE's version resource gets on Windows. */
const version = JSON.parse(await readFile(join(here, 'package.json'), 'utf8')).version as string

await assertDirectory(distDir, 'run `deno task build:desktop` first')
await assertDirectory(rendererSrc, 'run `deno task build:ui:electron` first')
await assertDirectory(electronPkg, 'run `deno task install`')

/**
 * The Electron version and its checksums, both read from the `electron` package rather than named
 * here.
 *
 * Packager can infer a version from the app directory's own `devDependencies`, but the directory
 * it is given below is a staging tree with no dependencies at all — so this passes it explicitly,
 * and reads it from the one place that cannot disagree with what `deno install` actually put on
 * disk. A literal here would be a second spelling of `^44.0.0` free to drift from `package.json`.
 */
const electronVersion = JSON.parse(await readFile(join(electronPkg, 'package.json'), 'utf8'))
  .version as string
const checksums = JSON.parse(await readFile(join(electronPkg, 'checksums.json'), 'utf8'))

/**
 * The staging tree packager copies into `resources/app`.
 *
 * Packager's `dir` is "the application directory", and it copies it wholesale. This repo has no
 * such directory — the main bundle is in `dist/`, the renderer is built into `packages/web`, and
 * `packages/desktop/package.json` is a workspace manifest with `devDependencies` that must not
 * ship. So one is assembled here, holding exactly what the packaged app needs and nothing else.
 *
 * Kept out of `outDir`, because packager's `overwrite` deletes that.
 */
const stagingDir = join(outRoot, '.staging')
await rm(stagingDir, { recursive: true, force: true })
await mkdir(stagingDir, { recursive: true })

// `dist/` whole, and it is copied whole rather than file by file so that a new output of
// `build.ts` arrives here without an edit: the main bundle, its preload, their sourcemaps, and
// every loose file the bundle reads at run time — the SQL migrations `openLibrary` reads, the
// window icons `windowIconPath()` resolves, and the OCCT `.wasm` the glue fetches.
await cp(distDir, join(stagingDir, 'dist'), { recursive: true })
// The renderer, where `defaultRendererDir()` looks for it in a packaged app.
await cp(rendererSrc, join(stagingDir, 'dist', 'renderer'), { recursive: true })

/**
 * The manifest Electron reads to find the entry point.
 *
 * `"type": "module"` is not cosmetic and it is the same fact `build.ts` records: the main bundle
 * is ESM because `migrate.ts` resolves its SQL through `import.meta.url`, and Electron decides how
 * to load `main.js` from the nearest package.json exactly as Node does. Without it the first
 * `import` in the bundle is a syntax error and the app never opens a window. Measured that it
 * survives: packager rewrites this file through its own `sanitize-package-json` step, and `type`
 * is still `module` in the packaged copy.
 */
await writeFile(
  join(stagingDir, 'package.json'),
  `${JSON.stringify(
    {
      name: APP_SLUG,
      productName: APP_NAME,
      version,
      main: 'dist/main.js',
      type: 'module',
    },
    null,
    2,
  )}\n`,
)

/**
 * `name` and `executableName` are separate on purpose, and this is the only place that shows why.
 *
 * `name` decides the **output directory**, which stays `slicer-project-manager-<platform>-<arch>`:
 * a path that other tooling and this repo's own docs already spell, and one nobody wants to quote
 * in a shell. `executableName` decides the **binary**, which is the user-facing string on Windows
 * — `packaging.ts` argues that split, and packager appends the `.exe` itself.
 *
 * `win32metadata` is spelled out rather than left to default because packager derives those
 * strings from `name`, which is the slug here; without them the executable would say
 * "slicer-project-manager" everywhere Explorer shows a product. `CompanyName` is set because
 * Electron ships it as `GitHub, Inc.` and leaving that under this `ProductName` tells Explorer
 * GitHub published the app; `MaSch0212` is the owner in `git remote -v`, the only publisher
 * identity this repository states.
 *
 * `appCopyright` is still deliberately **not** passed, so `LegalCopyright` stays Electron's — but
 * the reason changed, and the old one is gone. It used to be that there was no LICENSE file and no
 * `author` field anywhere in this repo, so any copyright line here would have been invented. There
 * is a `LICENSE` now: MIT, with a named holder, and a line could be written from it.
 *
 * What holds the omission is narrower and is about what the string is attached to. `LegalCopyright`
 * is a field of *this executable's* version resource, and this executable is Electron's compiled
 * binary with its icon and its product strings replaced — none of this repository's own code is
 * compiled into it. This app lives in `resources/app`, which the binary loads at run time. So
 * Electron's notice remains a true statement about the bytes it is attached to.
 *
 * That is a reason rather than a settlement, and the plan records it as an open question: the other
 * reading, that a version resource describes the product a user installed rather than the object
 * file it sits in, is at least as common in shipped software, and under it this line should say
 * `Copyright (c) 2026 Marc Schmidt`. Whichever way it is decided, the change is one option on this
 * call. Packager leaves the field alone when `appCopyright` is absent.
 */
const [packagedDir] = await packager({
  dir: stagingDir,
  out: outRoot,
  name: APP_SLUG,
  executableName: process.platform === 'win32' ? APP_NAME : APP_SLUG,
  appVersion: version,
  electronVersion,
  download: { checksums },
  icon: join(here, 'icons', 'icon.ico'),
  win32metadata: {
    CompanyName: 'MaSch0212',
    FileDescription: APP_NAME,
    InternalName: APP_NAME,
    ProductName: APP_NAME,
  },
  asar: false,
  prune: false,
  overwrite: true,
  quiet: true,
})

await rm(stagingDir, { recursive: true, force: true })

if (packagedDir !== outDir) {
  throw new Error(`packager wrote ${packagedDir}, expected ${outDir}`)
}

const appDir = join(outDir, 'resources', 'app')

for (const file of requiredArtifacts(outDir, appDir, executable)) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size === 0) throw new Error(`package:desktop did not write ${file}`)
}

console.log(`desktop: packaged to ${outDir}`)
console.log(`desktop: run it with ${join(outDir, executable)}`)
