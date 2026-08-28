import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import { type Capabilities, DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { SettingsPage } from './settings.page'
import { provideJigForTests } from '../../../testing/jig'

/** What the Deno server publishes: no shell, so no slicers to configure. */
const BROWSER_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

type Setup = {
  fixture: ReturnType<typeof TestBed.createComponent<SettingsPage>>
  api: { settings: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } }
  page: SettingsPage
  translate: TranslateService
}

async function setup(
  put: ReturnType<typeof vi.fn> = vi.fn((patch: Partial<SettingsDto>) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  ),
  capabilities: Capabilities = BROWSER_CAPABILITIES,
): Promise<Setup> {
  const api = {
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), put },
    capabilities: vi.fn().mockResolvedValue(capabilities),
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The slicer link is a routerLink, and without a router it renders no href at all — which
      // would make the assertion below pass for the wrong reason. There is no route registered
      // for it here on purpose: the target exists only in the electron build, and what this page
      // owes is the address, not a page to land on.
      provideRouter([]),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  const translate = TestBed.inject(TranslateService)
  // Awaited *before* the component exists: TestBed auto-detects changes, so creating it
  // first renders the template immediately, and the template reads t.translations()
  // unguarded (legitimately — app.config.ts awaits this same promise before bootstrap).
  await translate.ready
  await TestBed.inject(CapabilitiesStore).load()
  const fixture = TestBed.createComponent(SettingsPage)
  return { fixture, api, page: fixture.componentInstance, translate }
}

/** The link to /settings/slicers, as rendered. */
function slicerLink(fixture: Setup['fixture']): HTMLAnchorElement | null {
  fixture.detectChanges()
  return (fixture.nativeElement as HTMLElement).querySelector('a[href="/settings/slicers"]')
}

/** The `role="alert"` the convention requires, as actually rendered. */
function alertText(fixture: Setup['fixture']): string | null {
  fixture.detectChanges()
  return (
    (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent?.trim() ??
    null
  )
}

describe('SettingsPage', () => {
  it('persists a theme change', async () => {
    const { page, api } = await setup()
    await page.onPatch('theme', 'dark')
    expect(api.settings.put).toHaveBeenCalledWith({ theme: 'dark' })
    expect(page.saveFailed()).toBe(false)
  })

  it('persists a view-mode change', async () => {
    const { page, api } = await setup()
    await page.onPatch('viewMode', 'list')
    expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' })
  })

  it('persists a language change and switches the rendered language', async () => {
    const { page, api, translate } = await setup()

    await page.onLanguage('de')

    expect(api.settings.put).toHaveBeenCalledWith({ language: 'de' })
    expect(translate.language()).toBe('de')
  })

  // SettingsStore.patch rethrows after rolling back. The page had no try/catch at all, so a
  // failed save silently reverted the control with no message, and onPatch handed a
  // rejecting promise straight to a template (change) binding — an unhandled rejection.
  it('surfaces a failed theme save in a role="alert" instead of rejecting', async () => {
    const { fixture, page } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(page.onPatch('theme', 'dark')).resolves.toBeUndefined()

    expect(page.saveFailed()).toBe(true)
    expect(alertText(fixture)).toBeTruthy()
  })

  it('surfaces a failed language save in a role="alert" and does not switch language', async () => {
    const { fixture, page, translate } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(page.onLanguage('de')).resolves.toBeUndefined()

    expect(page.saveFailed()).toBe(true)
    expect(alertText(fixture)).toBeTruthy()
    // A language that did not persist must not appear to have been applied.
    expect(translate.language()).toBe('en')
  })

  it('clears a previous failure once a save succeeds', async () => {
    const put = vi
      .fn<(patch: Partial<SettingsDto>) => Promise<SettingsDto>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: 'dark' })
    const { fixture, page } = await setup(put)

    await page.onPatch('theme', 'dark')
    expect(page.saveFailed()).toBe(true)

    await page.onPatch('theme', 'dark')
    expect(page.saveFailed()).toBe(false)
    expect(alertText(fixture)).toBeNull()
  })

  /*
   * Spec 2.4's canConfigureSlicers, from the page that is shared by both builds. Asserted on the
   * rendered anchor and its href rather than on the capability signal: the failure this pair is
   * written against is a link that renders where there is no route to reach, and a signal cannot
   * have that failure.
   */
  describe('the link to the slicer settings', () => {
    it('is absent where the shell cannot configure slicers', async () => {
      const { fixture, translate } = await setup()

      expect(slicerLink(fixture)).toBeNull()
      // The label too: nothing about the page should mention them where the route does not exist.
      expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
        translate.translations().settings.slicers,
      )
    })

    it('is rendered, with its address, where it can', async () => {
      const { fixture, translate } = await setup(undefined, {
        ...BROWSER_CAPABILITIES,
        canConfigureSlicers: true,
      })

      const link = slicerLink(fixture)
      expect(link).not.toBeNull()
      expect(link?.getAttribute('href')).toBe('/settings/slicers')
      expect(link?.textContent).toContain(translate.translations().settings.slicers)
    })
  })
})
