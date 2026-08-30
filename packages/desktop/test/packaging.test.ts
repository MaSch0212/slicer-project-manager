import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_SLUG, packagedExecutableName } from '../packaging.ts'

/**
 * The packaged executable's name per platform, exhaustively, in plain Node.
 *
 * The same shape and the same reason as `icons.test.ts`: a three-branch platform decision where
 * one branch means "refuse", and the only other way to cover it is to run a 250 MB packaging job
 * once per operating system. `package-app.ts` cannot be imported to reach this — it packages an
 * application as a side effect of being imported — which is why the decision lives in
 * `packaging.ts` at all.
 */
describe('packagedExecutableName', () => {
  test('gives Windows the product name, because Explorer shows the file name', () => {
    assert.equal(packagedExecutableName('win32'), 'Slicer Project Manager.exe')
  })

  test('gives Linux the slug, because a space there is quoted at every use', () => {
    assert.equal(packagedExecutableName('linux'), 'slicer-project-manager')
    assert.equal(packagedExecutableName('freebsd'), 'slicer-project-manager')
  })

  test('refuses macOS rather than shipping a bundle with the wrong icon', () => {
    // The claim two other files already make in prose — `src/icons.ts` and
    // `tools/generate-icons.ts` both tell the reader that `package-app.ts` "fails loudly on macOS
    // and says why" — asserted in the one place that can hold it to that. Those comments were
    // true of nothing until this branch existed: the script copied the whole Electron
    // distribution and then died with `no Electron executable`, because Electron ships darwin as
    // `Electron.app/Contents/MacOS/Electron` and the top-level lookup found no bare `electron`.
    assert.throws(() => packagedExecutableName('darwin'), /macOS packaging is not implemented/)
  })

  test('the refusal names the missing file and what already works without it', () => {
    // A refusal that only says "no" sends the next person to read Electron's layout themselves,
    // and this one has a specific job: `@electron/packager` does the bundle mechanics, so a
    // reader who assumes macOS is wholly unimplemented would redo work that is already done. The
    // message has to keep naming the three parts packager covers and the one file it does not.
    const message = (() => {
      try {
        packagedExecutableName('darwin')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    for (const needed of ['.app', 'Contents/MacOS', 'Info.plist', '.icns', 'generate-icons']) {
      assert.ok(message.includes(needed), `the macOS refusal does not mention ${needed}`)
    }
  })

  test('the two names it builds from are the ones the rest of the build spells', () => {
    // `APP_NAME` is duplicated from `src/app.ts` on purpose (see `packaging.ts`), and `APP_SLUG`
    // names the output directory as well as the Linux binary. Pinning both here is what turns a
    // rename of either into a failure in `deno task verify` rather than into an executable that
    // does not match the manifest `package-app.ts` writes beside it.
    assert.equal(APP_NAME, 'Slicer Project Manager')
    assert.equal(APP_SLUG, 'slicer-project-manager')
    assert.equal(packagedExecutableName('win32'), `${APP_NAME}.exe`)
    assert.equal(packagedExecutableName('linux'), APP_SLUG)
  })
})

/**
 * The files at the repository root that nothing imports.
 *
 * The same reason `favicon.svg` and `manifest.webmanifest` are in the packaging list: a licence is
 * read by people and by nothing in the build, so a merge that dropped it — or a checkout that
 * never had it — breaks no bundle, no import and no test that watches imports. This is the one
 * thing that notices.
 */
describe('the licence artifacts at the repository root', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

  for (const name of ['LICENSE']) {
    test(`${name} exists and is not empty`, () => {
      const info = statSync(join(repoRoot, name), { throwIfNoEntry: false })
      assert.ok(info?.isFile(), `${name} is missing from the repository root`)
      assert.ok(info.size > 0, `${name} is empty`)
    })
  }
})
