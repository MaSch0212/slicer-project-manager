import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { windowIconFile } from '../src/icons.ts'

/**
 * The platform-to-icon-file decision, exhaustively, in plain Node.
 *
 * The same shape as `dispatch.test.ts` and the navigation-policy coverage: this is a three-branch
 * function where one branch means "none", and driving it through a real Electron launch would
 * cover exactly one operating system per run. `shell.spec.ts` covers the half that only Electron
 * can answer — that the file this names is beside the bundle and decodes.
 */
describe('windowIconFile', () => {
  test('gives Windows the icon container and everything else the image', () => {
    assert.equal(windowIconFile('win32'), 'icon.ico')
    assert.equal(windowIconFile('linux'), 'icon.png')
    assert.equal(windowIconFile('freebsd'), 'icon.png')
  })

  test('gives macOS nothing, because BrowserWindow ignores the option there', () => {
    // Not an oversight and not a gap to fill later. The dock icon on macOS comes from the
    // application bundle's `.icns`, which `package-app.ts` does not build — it refuses to run on
    // darwin at all and says why. A path returned here would be a value that looks like it does
    // something; `createMainWindow` turns this null into `icon: undefined`, which is the same as
    // not passing the option.
    assert.equal(windowIconFile('darwin'), null)
  })

  test('both spellings it can return are files this repo actually has', () => {
    // The function is a string table, so on its own it cannot be wrong in the way that matters:
    // it can name a file nobody generates. These are the two `deno task icons` writes, and this
    // is what turns a rename in the generator into a failure here rather than into a window
    // wearing Electron's default icon on one platform.
    const icons = fileURLToPath(new URL('../icons/', import.meta.url))
    for (const platform of ['win32', 'linux']) {
      const file = windowIconFile(platform)
      assert.ok(file !== null && existsSync(join(icons, file)), `no icons/${file} for ${platform}`)
    }
  })
})
