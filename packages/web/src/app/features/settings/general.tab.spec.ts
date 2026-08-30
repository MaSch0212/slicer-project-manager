import { TestBed } from '@angular/core/testing'
import { provideRouter } from '@angular/router'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Capabilities, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { NotifyService } from '../../core/notify.service'
import en from '../../core/i18n/locales/en.json'
import { SettingsGeneralTab } from './general.tab'
import { provideJigForTests } from '../../../testing/jig'

/**
 * The three controls and their save handling, which spec G 6 moved out of `SettingsPage` into
 * the tab component the `/settings` child route renders; and the two cards spec G 6.1 and 6.2
 * added beside them — where the library is, and importing.
 *
 * `NotifyService` is a double here, and in `app.config.spec.ts` it is not: jig's snackbar host
 * attaches itself to `ApplicationRef.components[0]`, which only a bootstrapped application has,
 * so a snackbar cannot render inside `TestBed` at all. That spec bootstraps a real one and drives
 * this very component; these specs assert on what it asked for.
 */

const LOCAL: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

type Notify = { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }

type Setup = {
  fixture: ReturnType<typeof TestBed.createComponent<SettingsGeneralTab>>
  api: {
    settings: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
    library: { pick: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }
  }
  notify: Notify
  tab: SettingsGeneralTab
  translate: TranslateService
}

async function setup(
  put: ReturnType<typeof vi.fn> = vi.fn((patch: Partial<SettingsDto>) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  ),
  library: Setup['api']['library'] = {
    pick: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(null),
  },
  capabilities: Capabilities = LOCAL,
): Promise<Setup> {
  const api = {
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), put },
    library,
    capabilities: vi.fn().mockResolvedValue(capabilities),
    importer: { curaManagerZip: vi.fn() },
  }
  const notify: Notify = { success: vi.fn(), error: vi.fn() }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      // The import card renders `ImportPanel`, whose "view projects" link is a routerLink.
      provideRouter([{ path: 'projects', children: [] }]),
      { provide: API_CLIENT, useValue: api },
      { provide: NotifyService, useValue: notify },
    ],
  })
  const translate = TestBed.inject(TranslateService)
  // Awaited *before* the component exists: TestBed auto-detects changes, so creating it
  // first renders the template immediately, and the template reads t.translations()
  // unguarded (legitimately — app.config.ts awaits this same promise before bootstrap).
  await translate.ready
  // The real store rather than a stub, so the flag reaching the template is the one the
  // transport reported (this is how app.spec.ts does it too).
  await TestBed.inject(CapabilitiesStore).load()
  const fixture = TestBed.createComponent(SettingsGeneralTab)
  return { fixture, api, notify, tab: fixture.componentInstance, translate }
}

/** The `role="alert"` the convention requires, as actually rendered. */
function alertText(fixture: Setup['fixture']): string | null {
  fixture.detectChanges()
  return (
    (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent?.trim() ??
    null
  )
}

describe('SettingsGeneralTab', () => {
  it('persists a theme change', async () => {
    const { tab, api } = await setup()
    await tab.onPatch('theme', 'dark')
    expect(api.settings.put).toHaveBeenCalledWith({ theme: 'dark' })
    expect(tab.saveFailed()).toBe(false)
  })

  // Spec G 0 defers moving this control to the projects page to segment H, so it is still here
  // and this is still the assertion that says so.
  it('persists a view-mode change', async () => {
    const { tab, api } = await setup()
    await tab.onPatch('viewMode', 'list')
    expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' })
  })

  it('renders all three controls', async () => {
    const { fixture } = await setup()
    fixture.detectChanges()
    const ids = [...(fixture.nativeElement as HTMLElement).querySelectorAll('jig-select')].map(
      (select) => select.getAttribute('inputid'),
    )
    expect(ids).toEqual(['settings-language', 'settings-theme', 'settings-view-mode'])
  })

  it('persists a language change and switches the rendered language', async () => {
    const { tab, api, translate } = await setup()

    await tab.onLanguage('de')

    expect(api.settings.put).toHaveBeenCalledWith({ language: 'de' })
    expect(translate.language()).toBe('de')
  })

  // SettingsStore.patch rethrows after rolling back. The page had no try/catch at all, so a
  // failed save silently reverted the control with no message, and onPatch handed a
  // rejecting promise straight to a template (change) binding — an unhandled rejection.
  it('surfaces a failed theme save in a role="alert" instead of rejecting', async () => {
    const { fixture, tab } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(tab.onPatch('theme', 'dark')).resolves.toBeUndefined()

    expect(tab.saveFailed()).toBe(true)
    expect(alertText(fixture)).toBeTruthy()
  })

  it('surfaces a failed language save in a role="alert" and does not switch language', async () => {
    const { fixture, tab, translate } = await setup(vi.fn().mockRejectedValue(new Error('boom')))

    await expect(tab.onLanguage('de')).resolves.toBeUndefined()

    expect(tab.saveFailed()).toBe(true)
    expect(alertText(fixture)).toBeTruthy()
    // A language that did not persist must not appear to have been applied.
    expect(translate.language()).toBe('en')
  })

  it('clears a previous failure once a save succeeds', async () => {
    const put = vi
      .fn<(patch: Partial<SettingsDto>) => Promise<SettingsDto>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: 'dark' })
    const { fixture, tab } = await setup(put)

    await tab.onPatch('theme', 'dark')
    expect(tab.saveFailed()).toBe(true)

    await tab.onPatch('theme', 'dark')
    expect(tab.saveFailed()).toBe(false)
    expect(alertText(fixture)).toBeNull()
  })

  // ---- Where the library is (spec G 6.1) ----

  // The capability, not the shell: nothing here asks what it is running in (constraint C3).
  it('offers the library card only where a folder can be chosen', async () => {
    const { fixture } = await setup(undefined, undefined, { ...LOCAL, canPickLocalFolder: false })
    fixture.detectChanges()
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
      en.settings.libraryTitle,
    )
  })

  it('offers both a folder and a server where one can be', async () => {
    const { fixture } = await setup()
    fixture.detectChanges()
    const text = (fixture.nativeElement as HTMLElement).textContent ?? ''
    expect(text).toContain(en.settings.chooseFolder)
    expect(text).toContain(en.settings.connectToServer)
  })

  it('says nothing when the folder picker is cancelled', async () => {
    // `null` is a cancelled dialog, not a failure: the library that was open stays open, and
    // reporting on a dialog the user themselves dismissed would be noise.
    const { tab, api, notify } = await setup()
    await tab.onChooseFolder()
    expect(api.library.pick).toHaveBeenCalledOnce()
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('notifies an error when the folder cannot be opened', async () => {
    const { tab, notify } = await setup(undefined, {
      pick: vi.fn().mockRejectedValue(new Error('not a library')),
      connect: vi.fn(),
    })

    await expect(tab.onChooseFolder()).resolves.toBeUndefined()

    expect(notify.error).toHaveBeenCalledWith(en.settings.libraryFailed)
  })

  // The assertion is the transport's call count and not a rendered message on purpose: "no
  // error was rendered" is also satisfied by a component that renders nothing at all, while a
  // `connect` that was never called can only mean the address was refused before the call.
  it('refuses a javascript: address without calling the transport', async () => {
    const { tab, api } = await setup()
    tab.connectModel.set({ url: 'javascript:alert(1)' })

    await tab.onConnect()

    expect(api.library.connect).not.toHaveBeenCalled()
  })

  it('refuses data: and file: addresses the same way', async () => {
    const { tab, api } = await setup()
    for (const url of ['data:text/html,x', 'file:///c:/', 'not a url']) {
      tab.connectModel.set({ url })
      await tab.onConnect()
    }
    expect(api.library.connect).not.toHaveBeenCalled()
  })

  it('passes an https address to the shell', async () => {
    const { tab, api } = await setup()
    tab.connectModel.set({ url: 'https://example.invalid:8443/' })

    await tab.onConnect()

    expect(api.library.connect).toHaveBeenCalledWith('https://example.invalid:8443/')
  })

  it('notifies an error when the server cannot be reached', async () => {
    const { tab, notify } = await setup(undefined, {
      pick: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error('unreachable')),
    })
    tab.connectModel.set({ url: 'https://example.invalid/' })

    // `submit()` has no catch of its own, so without one in the action this rejects and the
    // failure escapes the component as an unhandled rejection instead of being reported.
    await expect(tab.onConnect()).resolves.toBeUndefined()

    expect(notify.error).toHaveBeenCalledWith(en.settings.connectFailed)
  })

  it('labels the server address field once it is revealed', async () => {
    const { fixture, tab } = await setup()
    const host = fixture.nativeElement as HTMLElement
    fixture.detectChanges()
    expect(host.querySelector('#settings-server-url')).toBeNull()

    tab.connectOpen.set(true)
    fixture.detectChanges()

    const input = host.querySelector('#settings-server-url')
    expect(input).not.toBeNull()
    expect(host.querySelector('label[for="settings-server-url"]')?.textContent?.trim()).toBe(
      en.settings.serverUrl,
    )
  })

  // ---- Import (spec G 6.2) ----

  it('renders the import panel as a card', async () => {
    const { fixture } = await setup()
    fixture.detectChanges()
    const host = fixture.nativeElement as HTMLElement
    expect(host.querySelector('spm-import-panel')).not.toBeNull()
    // The panel itself, not an empty element bearing its name.
    expect(host.textContent).toContain(en.import.intro)
    // The page landmark belongs to SettingsPage; a second one here would be invalid markup.
    expect(host.querySelectorAll('main')).toHaveLength(0)
  })
})
