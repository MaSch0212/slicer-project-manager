import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Where `cube.stp` sits inside the published `occt-import-js@0.0.23` tarball.
 *
 * Verified against the installed package rather than inferred: that tarball carries 55 `.stp` and
 * `.step` files under `test/testfiles/`, and its `package.json` declares no `files` allowlist, so
 * the whole tree ships with the library. This one is 8 247 bytes and describes a box.
 */
const CUBE_REL_PATH = join('test', 'testfiles', 'simple-basic-cube', 'cube.stp')

/**
 * The only STEP file in this repository, borrowed from the parser's own test tree.
 *
 * **Nothing binary is committed here and this does not change that.** `test/fixtures/` holds four
 * generators and no model, because every other format in this package can be written out by a few
 * lines of JavaScript — and a STEP file cannot be, since producing one needs a CAD kernel. The
 * remaining options were to commit somebody else's LGPL model into an MIT repository or to resolve
 * one out of a dependency the suite already installs. This is the second.
 *
 * Resolved through `createRequire` rather than by a hand-built `node_modules/…` path: Deno's
 * `nodeModulesDir: "auto"` puts the real package under `node_modules/.deno/occt-import-js@0.0.23/`
 * and leaves a symlink behind, so a literal path is a different string in the two runtimes that
 * both run this directory. `require.resolve` returns the same absolute path under `node --test`
 * and under `deno test` — measured, both.
 *
 * Throws rather than returning a sentinel when the file is missing, and names the package, the
 * version and the path it looked for, because the failure that produces this is "dependencies are
 * not installed" or "the tarball's shape changed at some later version" — and neither is
 * diagnosable from a test that merely reports a mesh it could not read.
 */
export function stepFixturePath(): string {
  const resolve = createRequire(import.meta.url).resolve
  const packageRoot = dirname(resolve('occt-import-js/package.json'))
  const path = join(packageRoot, CUBE_REL_PATH)
  if (!existsSync(path)) {
    throw new Error(
      `no STEP fixture at ${path}: occt-import-js@0.0.23 is expected to carry ${CUBE_REL_PATH}, ` +
        'which is the only STEP file this repository has. Run `deno task install`.',
    )
  }
  return path
}

/**
 * Copies the fixture into `dir` under a caller-chosen `name`, and returns where it landed.
 *
 * The name is the caller's because the extension is what is under test: the same bytes have to be
 * reachable as `cube.step` and as `cube.stp`, and a helper that picked one of them would leave the
 * other arm of `readMesh`'s two-case label uncovered.
 */
export function writeStepFixture(dir: string, name: string): string {
  const target = join(dir, name)
  copyFileSync(stepFixturePath(), target)
  return target
}
