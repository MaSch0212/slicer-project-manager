import { ChangeDetectionStrategy, Component } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { provideRouter, Router } from '@angular/router'
import { RouterTestingHarness } from '@angular/router/testing'
import { describe, expect, it, vi } from 'vitest'
import { type Capabilities, DEFAULT_SETTINGS } from '@spm/contract/dtos.ts'
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

const DESKTOP_CAPABILITIES: Capabilities = { ...BROWSER_CAPABILITIES, canConfigureSlicers: true }

/**
 * Stand-ins for the two tab components, so this spec is about the strip and the outlet rather
 * than about what either tab renders.
 *
 * The Slicers stub matters more than it looks: the real one lives under `features/desktop/` and
 * this file is shared by both builds (spec G C2), so a spec that imported it to test the tab
 * would put the very import the rule forbids one file away from the page.
 */
@Component({
  selector: 'app-general-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p>general tab</p>`,
})
class GeneralStub {}

@Component({
  selector: 'app-slicers-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p>slicers tab</p>`,
})
class SlicersStub {}

type Setup = {
  harness: RouterTestingHarness
  translate: TranslateService
}

/**
 * The route tree the settings page is designed against: a parent with an empty-path General child
 * and, in the desktop build only, a `slicers` child appended by routes.electron.ts. Spelled out
 * here rather than imported so the web-build half of this spec is not the one file that pulls the
 * desktop route list in.
 */
async function setup(capabilities: Capabilities = BROWSER_CAPABILITIES): Promise<Setup> {
  const api = {
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), put: vi.fn() },
    capabilities: vi.fn().mockResolvedValue(capabilities),
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      provideRouter([
        {
          path: 'settings',
          component: SettingsPage,
          children: [
            { path: '', component: GeneralStub },
            ...(capabilities.canConfigureSlicers
              ? [{ path: 'slicers', component: SlicersStub }]
              : []),
          ],
        },
      ]),
      { provide: API_CLIENT, useValue: api },
    ],
  })
  const translate = TestBed.inject(TranslateService)
  // Awaited before anything renders: the template reads t.translations() unguarded, exactly as
  // app.config.ts lets it by awaiting this same promise before bootstrap.
  await translate.ready
  await TestBed.inject(CapabilitiesStore).load()
  return { harness: await RouterTestingHarness.create(), translate }
}

/** The tab headers as a user meets them: `role="tab"`, in the order they are rendered. */
function tabHeaders(harness: RouterTestingHarness): HTMLElement[] {
  harness.detectChanges()
  return [
    ...(harness.fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]'),
  ] as HTMLElement[]
}

function labels(harness: RouterTestingHarness): string[] {
  return tabHeaders(harness).map((tab) => tab.textContent?.trim() ?? '')
}

/** The label of the header the strip reports as selected, or null where none is. */
function selectedLabel(harness: RouterTestingHarness): string | null {
  const selected = tabHeaders(harness).find((tab) => tab.getAttribute('aria-selected') === 'true')
  return selected?.textContent?.trim() ?? null
}

function outletText(harness: RouterTestingHarness): string {
  harness.detectChanges()
  return (harness.fixture.nativeElement as HTMLElement).textContent ?? ''
}

describe('SettingsPage', () => {
  it('renders one landmark and one heading, both its own', async () => {
    const { harness, translate } = await setup()
    await harness.navigateByUrl('/settings', SettingsPage)
    harness.detectChanges()

    const host = harness.fixture.nativeElement as HTMLElement
    // Spec G C6: the tabs put another component's template on this page, and two <main>s on one
    // page is invalid. The tab components carry none, so this count must stay at one.
    expect(host.querySelectorAll('main')).toHaveLength(1)
    expect([...host.querySelectorAll('h1')].map((h) => h.textContent?.trim())).toEqual([
      translate.translations().settings.title,
    ])
  })

  describe('the tab strip', () => {
    it('offers General alone where the shell cannot configure slicers', async () => {
      const { harness, translate } = await setup()
      await harness.navigateByUrl('/settings', SettingsPage)

      expect(labels(harness)).toEqual([translate.translations().settings.general])
      // Nothing about the page should mention slicers where the route does not exist.
      expect(outletText(harness)).not.toContain(translate.translations().settings.slicers)
    })

    it('offers General and Slicers where it can', async () => {
      const { harness, translate } = await setup(DESKTOP_CAPABILITIES)
      await harness.navigateByUrl('/settings', SettingsPage)

      expect(labels(harness)).toEqual([
        translate.translations().settings.general,
        translate.translations().settings.slicers,
      ])
    })
  })

  describe('the active tab follows the URL', () => {
    it('activates General at /settings, and renders it in the outlet', async () => {
      const { harness, translate } = await setup(DESKTOP_CAPABILITIES)
      await harness.navigateByUrl('/settings', SettingsPage)

      expect(selectedLabel(harness)).toBe(translate.translations().settings.general)
      expect(outletText(harness)).toContain('general tab')
    })

    /*
     * The deep link, which is the assertion this whole task turns on: /settings/slicers was a
     * page of its own with no way back, and it is now a tab of the settings page — reached by
     * URL, not by a flag the page happens to be holding.
     */
    it('activates Slicers at /settings/slicers, and renders it in the outlet', async () => {
      const { harness, translate } = await setup(DESKTOP_CAPABILITIES)
      await harness.navigateByUrl('/settings/slicers', SettingsPage)

      expect(selectedLabel(harness)).toBe(translate.translations().settings.slicers)
      expect(outletText(harness)).toContain('slicers tab')
    })
  })

  describe('a click on a header', () => {
    it('navigates to the tab it names, and back', async () => {
      const { harness } = await setup(DESKTOP_CAPABILITIES)
      const router = TestBed.inject(Router)
      await harness.navigateByUrl('/settings', SettingsPage)

      tabHeaders(harness)[1]?.click()
      await harness.fixture.whenStable()
      harness.detectChanges()
      expect(router.url).toBe('/settings/slicers')
      expect(outletText(harness)).toContain('slicers tab')

      tabHeaders(harness)[0]?.click()
      await harness.fixture.whenStable()
      harness.detectChanges()
      expect(router.url).toBe('/settings')
      expect(outletText(harness)).toContain('general tab')
    })

    /*
     * Spec G C6. The strip is the only way between the two tabs now, so a pointer-only one would
     * take a page that was reachable by keyboard away. jig owns the mechanism — a roving tabindex
     * over `role="tab"` headers, with Enter selecting — and this asserts it is actually wired up
     * here rather than trusting the control from the outside.
     */
    it('is reachable from the keyboard: a roving tabindex, and Enter selects', async () => {
      const { harness } = await setup(DESKTOP_CAPABILITIES)
      const router = TestBed.inject(Router)
      await harness.navigateByUrl('/settings', SettingsPage)

      expect(tabHeaders(harness).map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1'])

      tabHeaders(harness)[1]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await harness.fixture.whenStable()
      harness.detectChanges()

      expect(router.url).toBe('/settings/slicers')
      expect(tabHeaders(harness).map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0'])
    })
  })
})
