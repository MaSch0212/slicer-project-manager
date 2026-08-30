import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { APP_NAME, APP_SLUG, packagedExecutableName, requiredArtifacts } from '../packaging.ts'

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
 * The two files at the repository root that nothing imports.
 *
 * The same reason `favicon.svg` and `manifest.webmanifest` are in the packaging list: a licence and
 * a third-party notice are read by people and by nothing in the build, so a merge that dropped one
 * — or a checkout that never had it — breaks no bundle, no import and no test that watches imports.
 * This is the one thing that notices.
 *
 * `THIRD-PARTY-NOTICES.md` has a second reason: `build.ts` reads it from here and stages it into
 * every build, so its absence is a build failure rather than a quiet one. That is the mechanism;
 * this is what says the source file it reads is still in the repository.
 */
describe('the licence artifacts at the repository root', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    test(`${name} exists and is not empty`, () => {
      const info = statSync(join(repoRoot, name), { throwIfNoEntry: false })
      assert.ok(info !== undefined, `${name} is missing from the repository root`)
      assert.ok(info.isFile(), `${name} is not a file`)
      assert.ok(info.size > 0, `${name} is empty`)
    })
  }
})

/**
 * The list `package-app.ts` stats after packaging, reachable because it lives here now.
 *
 * It moved out of `package-app.ts` for the reason `packagedExecutableName` is here at all: that
 * script packages an application as a side effect of being imported, so nothing in it can be read
 * by `node --test`, and the list was therefore covered by exactly one thing — a manual
 * `deno task package:desktop` on Windows. **No CI job packages**; all eight run `ubuntu-latest`.
 * These assertions are the half of it CI can carry: they say the list names the files. Only the
 * packaging run says the build wrote them.
 */
describe('requiredArtifacts', () => {
  const outDir = join('out', 'slicer-project-manager-win32-x64')
  const appDir = join(outDir, 'resources', 'app')
  const paths = requiredArtifacts(outDir, appDir, 'x.exe')
  const relative = paths.map((path) =>
    path
      .slice(outDir.length + 1)
      .split(sep)
      .join('/'),
  )

  test('names the executable it was given, under the directory it was given', () => {
    // The positive control for everything below: an implementation that returned `[]` would pass
    // the prefix assertion vacuously, and one that ignored its arguments would pass none of the
    // membership checks. This is the cheapest thing that fails on both.
    //
    // `>= 10` against the sixteen entries the list actually has is deliberately slack, and this
    // line's only job is killing `[]`. Six entries could be dropped without tripping it, which
    // costs nothing here: the executable is named on the next line and the other fifteen are named
    // individually by the three tests below, and those are what a dropped entry fails. A tight
    // count would add a second thing to edit
    // every time the list grows, and counting is the thing those tests were written to avoid.
    assert.ok(paths.length >= 10, `expected the packaging list, found ${paths.length} entries`)
    assert.ok(paths.includes(join(outDir, 'x.exe')), 'the executable is not in the list')
  })

  test('every path is under the output directory it was handed', () => {
    // An entry that forgot to `join` — a bare 'dist/main.js', say — would be stat'd relative to
    // wherever the packaging script happens to be running and would pass for the wrong reason.
    for (const path of paths) {
      assert.ok(path.startsWith(outDir + sep), `${path} is not under ${outDir}`)
    }
  })

  test('names what a packaged application cannot start without', () => {
    // Named individually rather than counted, for the reason the two icons are: a count survives a
    // rename, and every one of these is a file whose absence produces a window that opens blank or
    // a library that will not open, a long way from the packaging step that dropped it.
    for (const expected of [
      'package.json',
      'dist/main.js',
      'dist/preload.js',
      'dist/renderer/index.html',
      'dist/renderer/favicon.svg',
      'dist/renderer/manifest.webmanifest',
      'dist/icons/icon.ico',
      'dist/icons/icon.png',
    ]) {
      assert.ok(
        relative.includes(`resources/app/${expected}`),
        `the packaging list does not name ${expected}`,
      )
    }
  })

  test('names all three migrations, not just the first', () => {
    // `001_init.sql` alone used to be the whole of it, and 002 has never been in this list.
    // `runMigrations` reads a frozen list and `readFileSync` throws on the first file that is not
    // there, so a staging that dropped one produces an app that starts and then fails the moment a
    // folder is picked. Asserted per entry rather than as a count, because a count survives a
    // rename and this is the failure the list exists to prevent.
    for (const migration of [
      '001_init.sql',
      '002_preview_claim.sql',
      '003_classifier_version.sql',
    ]) {
      assert.ok(
        relative.includes(`resources/app/dist/migrations/${migration}`),
        `the packaging list does not name ${migration}`,
      )
    }
  })

  test('names the OCCT wasm and the licence texts that have to travel with it', () => {
    // The `.wasm` is what LGPL-2.1 §6b wants left replaceable, and until now nothing checked it
    // survived packaging: `build.ts` asserts it was staged, which is a different question from
    // whether packager copied it. The three text files are the notice obligation, and they are the
    // same class of file as `favicon.svg` — nothing imports them, so nothing else would notice.
    for (const expected of [
      'dist/occt-import-js.wasm',
      'dist/third-party/THIRD-PARTY-NOTICES.md',
      'dist/third-party/LICENSE.md',
      'dist/third-party/license.occt.txt',
    ]) {
      assert.ok(
        relative.includes(`resources/app/${expected}`),
        `the packaging list does not name ${expected}`,
      )
    }
  })
})
