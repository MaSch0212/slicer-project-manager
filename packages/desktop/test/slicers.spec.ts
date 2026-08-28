import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  firstWindowOf,
  launchApp,
  newUserDataDir,
  stubFolderPicker,
  type LaunchedApp,
} from './fixtures.ts'

/**
 * `/settings/slicers`, driven through a real window.
 *
 * **Why this file exists, in one sentence:** two of the page's behaviours were wrong when it was
 * first written and *only* looking at it found them, so the two that a unit test structurally
 * cannot see are pinned here.
 *
 * - The install rows must **stack**. jig's radio-group root is `inline-flex; flex-direction: row`
 *   with a `[aria-orientation='vertical']` rule beside it, so `orientation="vertical"` on the
 *   element is the whole mechanism — measured, after a first attempt at this file found the app's
 *   own CSS override redundant and the override was deleted. jsdom does not lay out, so no
 *   `ng test` assertion can see that attribute go: dropping it puts the second Cura's remove
 *   button back outside the card, silently, and this is the only thing that would notice.
 * - **A picked file that is gone says so.** The shell answers `NotFound`, which on every other
 *   call on this page means a stale row in a list; the sentence that belongs to *that* meaning
 *   sends the user to a scan that cannot help.
 *
 * **It is machine-independent, which the task report first wrongly claimed it could not be.** The
 * two-Cura configuration is written into the launch's own `userData` before start-up, so nothing
 * here depends on what is installed on the runner — and nothing here scans, because
 * `detectionSupported` is false on the Linux runner this suite also runs on.
 */

/** Two installs of one product, in the shape `readConfig` stores. Paths are never resolved here. */
const TWO_CURAS = {
  version: 1,
  installs: [
    {
      id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0',
      slicerId: 'cura',
      label: 'UltiMaker Cura 5.12.0',
      origin: { kind: 'registry', hive: 'HKLM\\WOW6432Node', key: 'UltiMaker Cura 5.12.0-5.12.0' },
      version: '5.12.0',
      pathHint: 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
      addedAt: 1756382400000,
    },
    {
      id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0',
      slicerId: 'cura',
      label: 'UltiMaker Cura 5.13.0',
      origin: { kind: 'registry', hive: 'HKLM\\WOW6432Node', key: 'UltiMaker Cura 5.13.0-5.13.0' },
      version: '5.13.0',
      pathHint: 'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
      addedAt: 1756382400000,
    },
  ],
  // Deliberately empty: two installs and no binding is the case the page must ask about.
  bindings: {},
  defaultSlicerId: null,
}

async function launchWithSlicers(config: unknown): Promise<LaunchedApp> {
  const userDataDir = newUserDataDir()
  writeFileSync(join(userDataDir, 'slicers.json'), JSON.stringify(config), 'utf8')
  return await launchApp([{ name: 'Widget', files: { 'notes.txt': 'a project' } }], [], userDataDir)
}

test('two installs of one product stack, and neither is chosen for the user', async () => {
  const { app } = await launchWithSlicers(TWO_CURAS)
  try {
    const page = await firstWindowOf(app)
    await page.waitForURL('spm://app/projects', { timeout: 30_000 })
    await page.goto('spm://app/settings/slicers')

    const rows = page.getByRole('radio')
    await expect(rows).toHaveCount(2)

    // The versions, as rendered. Both labels also contain them, which is exactly why the unit
    // suite proves `install.version` renders with a Bambu row instead — here what matters is that
    // the two rows are distinguishable at all.
    await expect(rows.nth(0)).toContainText('5.12.0')
    await expect(rows.nth(1)).toContainText('5.13.0')
    // Written with `String.raw` and one backslash on purpose. The path is what tells two installs
    // of one product apart, and asserting a real separator also pins the fixture above: an earlier
    // draft of this file reached disk with its `\\` collapsed, and every assertion
    // that quoted the path would have been collapsed with it and matched anyway.
    await expect(rows.nth(0)).toContainText(String.raw`Cura 5.12.0\UltiMaker-Cura.exe`)
    await expect(rows.nth(0)).toHaveAttribute('aria-checked', 'false')
    await expect(rows.nth(1)).toHaveAttribute('aria-checked', 'false')

    // The layout rule, which is the whole reason this assertion is in a browser. Row-wise, the
    // second box starts to the *right* of the first and its bottom is level with it; stacked, it
    // begins at or below the first one's bottom edge.
    const first = await rows.nth(0).boundingBox()
    const second = await rows.nth(1).boundingBox()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height)

    // And nothing spills out of the card the rows are in.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

    // Choosing one is what makes the question go away, over a real IPC round trip.
    await rows.nth(1).click()
    await expect(rows.nth(1)).toHaveAttribute('aria-checked', 'true')
    await expect(rows.nth(0)).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('main')).not.toContainText('2 installs of UltiMaker Cura were found')
  } finally {
    await app.close()
  }
})

test('a picked executable that is not there says so, and does not send the user to a scan', async () => {
  const { app } = await launchWithSlicers(TWO_CURAS)
  try {
    const page = await firstWindowOf(app)
    await page.waitForURL('spm://app/projects', { timeout: 30_000 })
    await page.goto('spm://app/settings/slicers')

    // Absolute, never created, and spelled by the platform running the test — the shell's check is
    // a real `statSync`, so a path that happens to exist would assert nothing.
    await stubFolderPicker(app, join(tmpdir(), 'spm-no-such-slicer.exe'))
    await page.getByRole('button', { name: 'Add by hand' }).first().click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('That file is not there any more')
    // The sentence that belongs to a stale list, which is what this used to say.
    await expect(alert).not.toContainText('Look for installed slicers again')
    // And nothing was added on the way past.
    await expect(page.getByRole('radio')).toHaveCount(2)
  } finally {
    await app.close()
  }
})
