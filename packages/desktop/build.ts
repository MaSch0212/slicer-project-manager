import * as esbuild from 'esbuild'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bundles the Electron main process and its preload.
 *
 * Run it with `deno task build:desktop`, which builds the Angular electron renderer first. This
 * script only produces `packages/desktop/dist`; it never reads the renderer.
 */

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'dist')
const migrationsSrc = resolve(here, '../core/src/db/migrations')
const iconsSrc = join(here, 'icons')
// Resolved rather than spelled out as `../../node_modules/…`: Deno's `nodeModulesDir: "auto"` puts
// the real package under `node_modules/.deno/occt-import-js@0.0.23/` and leaves a symlink behind,
// and `deno task build:desktop` is what runs this file.
const occtWasmSrc = createRequire(import.meta.url).resolve(
  'occt-import-js/dist/occt-import-js.wasm',
)
// The same package's own root, for the licence texts `copyThirdParty` stages. Resolved through its
// `package.json` for the reason above: the directory on disk is not `node_modules/occt-import-js`.
const occtPackageRoot = dirname(
  createRequire(import.meta.url).resolve('occt-import-js/package.json'),
)
const noticeSrc = resolve(here, '../..', 'THIRD-PARTY-NOTICES.md')

/**
 * The three CommonJS names an ESM bundle does not define, defined.
 *
 * **This is the answer to "does the OCCT glue survive esbuild", and it was measured rather than
 * reasoned about.** `occt-import-js` ships one emscripten glue file, and esbuild inlines it into
 * `main.js` with no warnings and no errors — but the bundled result then dies on its first call
 * with `Dynamic require of "fs" is not supported`. The glue is CommonJS written for Node: it does
 * `require('fs')` and `require('path')` at module scope and sets `scriptDirectory = __dirname + '/'`
 * (the only thing `locateFile` has to go on when it fetches the `.wasm`). None of those three names
 * exists in an ESM bundle, so esbuild substitutes a shim that throws.
 *
 * With them defined, the same bundle parses `cube.stp` to its measured 12 triangles under plain
 * Node, and `__dirname` is `dist/` — which is exactly where `copyWasm` below puts the `.wasm`, and
 * `resources/app/dist/` once `package-app.ts` has moved the bundle. So the resolution the glue uses
 * is its own default rather than anything this repo computes.
 *
 * **The branch this build did *not* take**, recorded because the next person to touch this file
 * will want to know which resolution is in force: the alternative was to add `occt-import-js` to
 * `external`, stage its 96 KB `dist/occt-import-js.js` beside the `.wasm`, and point the specifier
 * at a desktop-only shim doing its own `createRequire` and `locateFile`. That was rejected on one
 * ground: it would make the Electron bundle load a *different module* from the one `node --test`
 * and `deno test` measure, so the shell's only loading path would be the one no test covers. The
 * cost of the branch actually taken is that these three names are now visible to everything in the
 * bundle — a future dependency that sniffs `typeof __dirname` to detect CommonJS will take that arm
 * here, and a dynamic `require` of a package will resolve against `dist/`, where a packaged app has
 * no `node_modules`, instead of failing loudly at build time.
 *
 * Main only. The preload is already CommonJS and has all three for real; an `import` statement in
 * that bundle would throw at load time in a sandboxed preload, which is the whole point of `PRELOAD`
 * being `format: 'cjs'` below.
 */
const NODE_CJS_INTEROP = [
  "import { createRequire as __spmCreateRequire } from 'node:module'",
  "import { dirname as __spmDirname } from 'node:path'",
  "import { fileURLToPath as __spmFileURLToPath } from 'node:url'",
  'const require = __spmCreateRequire(import.meta.url)',
  'const __filename = __spmFileURLToPath(import.meta.url)',
  'const __dirname = __spmDirname(__filename)',
].join('\n')

/**
 * The main bundle is ESM and that is not a style choice.
 *
 * `packages/core/src/db/migrate.ts` resolves its SQL with `new URL('./migrations/...',
 * import.meta.url)`. esbuild rewrites `import.meta.url` in a CJS bundle to something that is not
 * a URL, and the first `openLibrary()` dies with `Invalid URL` from that line. Measured, in a
 * spike, before this package existed. If you are here because an ESM Electron main is awkward,
 * the fix is not `format: 'cjs'` — it is to give `migrate.ts` an injectable migrations
 * directory, and then this comment goes away with it.
 *
 * Because it is ESM, `packages/desktop/package.json` must keep `"type": "module"`: Electron
 * decides how to load `dist/main.js` from the nearest package.json, exactly as Node does.
 */
const MAIN: esbuild.BuildOptions = {
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(outDir, 'main.js'),
  format: 'esm',
  banner: { js: NODE_CJS_INTEROP },
}

/**
 * The preload is CommonJS, for the opposite reason.
 *
 * `sandbox: true` is a constraint of this subsystem, and a sandboxed preload is evaluated in a
 * restricted context with no ESM loader: an `import` statement there throws at load time, the
 * bridge never appears on `window`, and nothing in the renderer says why. Electron only treats a
 * preload as ESM when it is named `.mjs`, so a `.js` file with CJS inside is what a sandboxed
 * preload has to be.
 */
const PRELOAD: esbuild.BuildOptions = {
  entryPoints: [join(here, 'src/preload.ts')],
  outfile: join(outDir, 'preload.js'),
  format: 'cjs',
}

const COMMON: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  // Electron is supplied by the runtime, not bundled. Everything else — @spm/core, @spm/contract,
  // zod and the occt-import-js glue — is bundled in, so dist/ needs no node_modules beside it.
  // It does need one loose file beside it: `copyWasm` stages the OCCT `.wasm`, which is data the
  // glue fetches at call time and which no bundler ever inlines.
  external: ['electron'],
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
}

async function copyMigrations(): Promise<number> {
  const dest = join(outDir, 'migrations')
  await mkdir(dest, { recursive: true })
  const files = (await readdir(migrationsSrc)).filter((name) => name.endsWith('.sql'))
  // A silent zero here would ship a main process that cannot open a library, and the failure
  // would surface as a SQL error from the first query rather than as a missing file.
  if (files.length === 0) throw new Error(`no .sql migrations found in ${migrationsSrc}`)
  // Read-then-write rather than `cp`: CopyFileW on Windows carries the source's mtime across,
  // so a copied migration looks four days old the moment it is written, and the test suite's
  // "did this build actually produce these files" check reads that as a stale artifact.
  for (const file of files) {
    await writeFile(join(dest, file), await readFile(join(migrationsSrc, file)))
  }
  return files.length
}

/**
 * The window icon, next to the bundle rather than left in the source tree.
 *
 * `windowIconPath()` in `src/app.ts` resolves `./icons/<file>` against `import.meta.url`, which is
 * `dist/main.js` here and `resources/app/dist/main.js` in a packaged application. That is the
 * whole reason for this step: a path that reached back into `packages/desktop/icons` would work
 * in the repo and resolve to nothing once `package-app.ts` moved the bundle, and the symptom
 * would be a window wearing Electron's default icon on a user's machine and this app's icon on
 * every developer's.
 *
 * Read-then-write for the same reason `copyMigrations` does it: `cp` carries the source mtime
 * across on Windows, so a copied file looks older than the build that produced it.
 *
 * These are generated by `deno task icons` and committed, so a missing one means someone deleted
 * a tracked file rather than that a step was skipped — which is why this throws rather than
 * shrugging and continuing without an icon.
 */
async function copyIcons(): Promise<number> {
  const dest = join(outDir, 'icons')
  await mkdir(dest, { recursive: true })
  const files = (await readdir(iconsSrc)).filter((name) => /\.(ico|png)$/.test(name))
  if (files.length === 0) throw new Error(`no icons found in ${iconsSrc} — run \`deno task icons\``)
  for (const file of files) {
    await writeFile(join(dest, file), await readFile(join(iconsSrc, file)))
  }
  return files.length
}

/**
 * The 7.6 MB OCCT WebAssembly module, beside the bundle it is fetched from.
 *
 * **Needed whatever esbuild does with the glue**, which is why it is a separate step from the
 * bundling decision recorded in `NODE_CJS_INTEROP`: the `.wasm` is data the glue reads with
 * `fs.readFileSync` at call time, from `__dirname + '/occt-import-js.wasm'`. No bundler inlines it,
 * and nothing about the JavaScript changes that.
 *
 * `__dirname` is `dist/` here and `resources/app/dist/` in a packaged application, so the file has
 * to travel with `main.js` exactly as the icons and the migrations do — a path reaching back into
 * `node_modules` would work in the repo and resolve to nothing on a user's machine.
 *
 * Read-then-write for the same reason `copyMigrations` gives: CopyFileW carries the source's mtime
 * across on Windows, so a copied file looks older than the build that produced it.
 */
async function copyWasm(): Promise<number> {
  const bytes = await readFile(occtWasmSrc)
  await writeFile(join(outDir, 'occt-import-js.wasm'), bytes)
  return bytes.byteLength
}

/**
 * The third-party notice and the LGPL texts, beside the library they are about.
 *
 * `occt-import-js` is LGPL-2.1 and so is the OCCT kernel compiled into its `.wasm`, and §6 of that
 * licence asks for prominent notice and a copy of the licence to accompany the work. A packaged
 * application has no `node_modules`, so pointing at the texts where npm put them would produce a
 * notice referring to files that are not on the user's disk. Copying them is 54 KB.
 *
 * **Three files, two texts.** Upstream ships `LICENSE.md`, `dist/license.occt-import-js.txt` and
 * `dist/license.occt.txt`; the first two are byte-identical — measured, same SHA-256 — so the first
 * is staged once under its own name and the third is staged as itself. `THIRD-PARTY-NOTICES.md`
 * records that, with the digest, so nobody comparing this directory against the tarball reads the
 * absent third filename as a file that went missing.
 *
 * Read out of the installed package rather than committed here, for the reason `stepFixturePath()`
 * gives about the STEP fixture: a copy in this repository is a second spelling free to drift from
 * whatever version `deno.json` actually pins.
 *
 * Read-then-write for the same reason `copyMigrations` does it: `cp` carries the source mtime
 * across on Windows, so a copied file looks older than the build that produced it.
 */
async function copyThirdParty(): Promise<number> {
  const dest = join(outDir, 'third-party')
  await mkdir(dest, { recursive: true })
  const sources = [
    noticeSrc,
    join(occtPackageRoot, 'LICENSE.md'),
    join(occtPackageRoot, 'dist', 'license.occt.txt'),
  ]
  for (const source of sources) {
    await writeFile(join(dest, basename(source)), await readFile(source))
  }
  return sources.length
}

async function assertWritten(...files: string[]): Promise<void> {
  for (const file of files) {
    const info = await stat(file).catch(() => null)
    if (!info || info.size === 0) throw new Error(`build produced no ${file}`)
  }
}

// The output directory is removed first, so a build that fails leaves nothing behind for a
// later step to mistake for a fresh one. The web job's bundle checks learned this the hard way.
await rm(outDir, { recursive: true, force: true })
await esbuild.build({ ...COMMON, ...MAIN })
await esbuild.build({ ...COMMON, ...PRELOAD })
const migrations = await copyMigrations()
const icons = await copyIcons()
const wasmBytes = await copyWasm()
const notices = await copyThirdParty()
await assertWritten(
  join(outDir, 'main.js'),
  join(outDir, 'preload.js'),
  // Named individually rather than counted, because `windowIconPath()` asks for these two
  // spellings and a rename in `icons/` would otherwise pass the count check and fail at runtime.
  join(outDir, 'icons', 'icon.ico'),
  join(outDir, 'icons', 'icon.png'),
  // Named for the same reason and a sharper one: the glue asks for this exact spelling, and a
  // `copyWasm` that silently produced nothing yields a shell that starts, opens a library and
  // renders a blank thumbnail for every STEP file in it. This fails the *build* — and so
  // `deno task dev:desktop` — where the same path in `requiredArtifacts()` fails only
  // `deno task package:desktop`, which no CI job runs. Both are wanted: this one says the file was
  // staged, that one says packager carried it into the packaged app.
  join(outDir, 'occt-import-js.wasm'),
  // The licence obligation, named for the same reason and one more: nothing in this repository
  // imports these, and nothing at run time reads them, so a `copyThirdParty` that wrote an empty
  // directory would break no bundle and no test that watches imports. `requiredArtifacts()` names
  // them again on the packaged output, which is a different question — this says the build staged
  // them, that says packager carried them across.
  join(outDir, 'third-party', 'THIRD-PARTY-NOTICES.md'),
  join(outDir, 'third-party', 'LICENSE.md'),
  join(outDir, 'third-party', 'license.occt.txt'),
)
console.log(
  `desktop: bundled main + preload, copied ${migrations} migrations, ${icons} icons and ` +
    `${wasmBytes} bytes of occt-import-js.wasm and ${notices} third-party files to ${outDir}`,
)
await esbuild.stop()
