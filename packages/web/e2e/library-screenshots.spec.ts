import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { curaManagerArchive } from './fixtures'
import {
  applySession,
  seedLibrary,
  startServer,
  WEB_DIST,
  type SeededProject,
  type SeededServer,
} from './seed'

/**
 * The visual check for the library pages (projects, project detail, viewer, import), against a real
 * seeded `spm-server` serving the built bundle. Not an assertion suite: it runs only when
 * SPM_SHOTS_DIR names a directory, and needs `pnpm --filter @spm/web build` first.
 *
 *   SPM_SHOTS_DIR=/some/dir pnpm --filter @spm/web exec playwright test library-screenshots
 */
const dir = process.env['SPM_SHOTS_DIR']
const SIZES = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } }

test.describe('library screenshots', () => {
  test.skip(!dir, 'set SPM_SHOTS_DIR to take screenshots')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  let server: SeededServer
  let seeded: Record<string, SeededProject>

  test.beforeAll(async () => {
    // A cold `cargo run` compiles the server first.
    test.setTimeout(420_000)
    if (!existsSync(WEB_DIST))
      throw new Error('build the web bundle first: pnpm --filter @spm/web build')
    server = await startServer()
    seeded = await seedLibrary(server)
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  const setView = (viewMode: 'grid' | 'list') =>
    server.request('PUT', '/api/account/settings', { viewMode })

  /** A few saved views, so the sidebar has something to show in the shot. */
  const setViews = (views: unknown[]) => server.request('PUT', '/api/account/settings', { views })

  const VIEWS = [
    {
      id: 'view-1',
      name: 'Everything',
      icon: 'layers',
      viewMode: 'grid',
      sort: 'updatedAt',
      dir: 'desc',
      includeArchived: false,
      tags: [],
    },
    {
      id: 'view-2',
      name: 'Gadgets',
      icon: 'box',
      viewMode: 'grid',
      sort: 'name',
      dir: 'asc',
      includeArchived: false,
      tags: ['gadgets'],
    },
    {
      id: 'view-3',
      name: 'Old prints',
      icon: 'archive',
      viewMode: 'list',
      sort: 'updatedAt',
      dir: 'desc',
      includeArchived: true,
      tags: [],
    },
  ]

  for (const scheme of ['light', 'dark'] as const) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      const shot = (name: string) => `${dir}/${name}-${scheme}-${size}.png`

      test.describe(`${scheme} ${size}`, () => {
        test.beforeEach(async ({ page }) => {
          await page.setViewportSize(viewport)
          await page.emulateMedia({ colorScheme: scheme })
          await applySession(page.context(), server)
        })

        for (const mode of ['grid', 'list'] as const) {
          test(`projects ${mode}`, async ({ page }) => {
            await setView(mode)
            await page.goto(`${server.origin}/projects`)
            await expect(page.getByRole('heading', { name: 'Benchy' })).toBeVisible()
            await page.waitForLoadState('networkidle')
            await page.screenshot({ path: shot(`projects-${mode}`), fullPage: true })
          })

          test(`project detail ${mode}`, async ({ page }) => {
            await setView(mode)
            await page.goto(`${server.origin}/projects/${seeded['Benchy']!.id}`)
            await expect(
              page
                .getByRole('complementary', { name: 'Project details' })
                .getByRole('heading', { name: 'Benchy', level: 2 }),
            ).toBeVisible()
            await page.waitForLoadState('networkidle')
            await page.screenshot({ path: shot(`detail-${mode}`), fullPage: true })
          })
        }

        test('projects filters open', async ({ page }) => {
          await setView('grid')
          await page.goto(`${server.origin}/projects`)
          await expect(page.getByRole('heading', { name: 'Benchy' })).toBeVisible()
          await page.getByRole('button', { name: 'Tags' }).click()
          await page.getByRole('listbox').waitFor()
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('projects-tags-open') })
        })

        test('saved views in the sidebar, and the editor', async ({ page }) => {
          await setView('grid')
          await setViews(VIEWS)
          await page.goto(`${server.origin}/projects`)
          await expect(page.getByRole('heading', { name: 'Benchy' })).toBeVisible()
          // Below `md` there is no sidebar: the same rows are in the drawer instead.
          const phone = size === 'phone'
          if (phone) await page.getByRole('button', { name: 'Open the navigation' }).click()
          const nav = (phone ? page.getByRole('dialog') : page)
            .getByRole('navigation', { name: 'Main navigation' })
            .first()
          const row = nav.getByRole('button', { name: /^Everything/ })
          await expect(row).toHaveAttribute('aria-current', 'page')
          await page.waitForLoadState('networkidle')
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('projects-views') })
          if (phone) return

          // The row's own menu, which is also where the editor is reached from.
          await row.hover()
          await nav.getByRole('button', { name: 'Options for Everything' }).click()
          await page.getByRole('menuitem', { name: 'Edit views…' }).waitFor()
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('projects-views-menu') })

          await page.getByRole('menuitem', { name: 'Edit views…' }).click()
          await page.getByRole('dialog').waitFor()
          await page.waitForTimeout(300)
          await page.screenshot({ path: shot('projects-views-editor') })
          await setViews([])
        })

        test('project detail: missing folder, empty, step', async ({ page }) => {
          await setView('grid')
          for (const [key, name] of [
            ['Lost Folder', 'missing'],
            ['Empty Project', 'empty'],
            ['Hinge', 'step'],
          ] as const) {
            await page.goto(`${server.origin}/projects/${seeded[key]!.id}`)
            await expect(
              page
                .getByRole('complementary', { name: 'Project details' })
                .getByRole('heading', { name: key, level: 2 }),
            ).toBeVisible()
            await page.waitForLoadState('networkidle')
            await page.screenshot({ path: shot(`detail-${name}`), fullPage: true })
          }
        })

        test('viewer', async ({ page }) => {
          const benchy = seeded['Benchy']!
          await page.goto(
            `${server.origin}/projects/${benchy.id}/view/${benchy.fileIds['benchy.stl']}`,
          )
          await expect(page.getByRole('button', { name: 'Reset view' })).toBeVisible({
            timeout: 30_000,
          })
          await page.waitForTimeout(500)
          await page.screenshot({ path: shot('viewer') })
        })

        test('viewer: STEP has no preview', async ({ page }) => {
          const hinge = seeded['Hinge']!
          await page.goto(
            `${server.origin}/projects/${hinge.id}/view/${hinge.fileIds['hinge.step']}`,
          )
          await expect(page.getByText('no preview for STEP', { exact: false })).toBeVisible()
          await page.screenshot({ path: shot('viewer-step') })
        })

        test('import', async ({ page }) => {
          await page.goto(`${server.origin}/import`)
          await expect(
            page.getByRole('heading', { name: 'Import a CuraManager library' }),
          ).toBeVisible()
          await page.screenshot({ path: shot('import') })
          await page.locator('input[type="file"]').setInputFiles({
            name: `curamanager-${scheme}-${size}.zip`,
            mimeType: 'application/zip',
            buffer: Buffer.from(curaManagerArchive(` ${scheme} ${size}`)),
          })
          await expect(page.getByText('Import finished')).toBeVisible()
          await page.screenshot({ path: shot('import-done') })
        })
      })
    }
  }
})
