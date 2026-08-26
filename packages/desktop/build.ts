import * as esbuild from 'esbuild'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  // Electron is supplied by the runtime, not bundled. Everything else — @spm/core, @spm/contract
  // and zod — is bundled in, so dist/ needs no node_modules beside it.
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
await assertWritten(join(outDir, 'main.js'), join(outDir, 'preload.js'))
console.log(`desktop: bundled main + preload, copied ${migrations} migrations to ${outDir}`)
await esbuild.stop()
