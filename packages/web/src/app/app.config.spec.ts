import type { ApplicationRef } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Capabilities } from '@spm/contract/dtos.ts'
import { appConfig } from './app.config'
import { API_CLIENT } from './core/api/api-client.token'
import en from './core/i18n/locales/en.json'
import { SettingsGeneralTab } from './features/settings/general.tab'

/**
 * That the providers the real application boots with actually back the notifications it shows.
 *
 * `core/notify.service.spec.ts` covers what `NotifyService` asks jig for, with the snackbar
 * module mocked; every component spec covers what a component asks `NotifyService` for, with the
 * service doubled. Neither of them, nor anything else in the suite, noticed when `withSnackbars()`
 * was taken out of `app.config.ts` — the provider it registers is only ever reached at *render*,
 * and until this segment nothing rendered a snackbar at all.
 *
 * **This is the only spec that bootstraps a real application, and it has to be.** jig's snackbar
 * host attaches itself to `ApplicationRef.components[0]` — the bootstrapped root component — and
 * `TestBed` never populates that array, so under a `TestBed` the host throws "Failed to find
 * application root element to attach snackbar host!" out of a `queueMicrotask` and no snackbar
 * is ever rendered. Bootstrapping is what makes a rendered one reachable.
 *
 * It bootstraps with `appConfig.providers` and overrides only `API_CLIENT`, so removing
 * `withSnackbars()` from `app.config.ts` turns this red. The root component is the settings
 * General tab because that is where the first real call site is: a `library.pick()` that rejects.
 * The path covered is therefore end to end — the handler, the transport's rejection, the service,
 * and a snackbar in the document — rather than an assertion about a provider list.
 */

const LOCAL: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

let app: ApplicationRef | undefined

afterEach(() => {
  app?.destroy()
  app = undefined
  // The root element is put in the document by hand below, so it has to be taken out by hand:
  // a leftover one is what the next bootstrap in this file would attach to.
  document.querySelectorAll('app-settings-general').forEach((element) => element.remove())
})

/** Bootstraps the General tab as a real application, with only the transport replaced. */
async function bootstrap(pick: ReturnType<typeof vi.fn>): Promise<SettingsGeneralTab> {
  document.body.appendChild(document.createElement('app-settings-general'))
  const api = {
    capabilities: vi.fn().mockResolvedValue(LOCAL),
    // `requiresAuth: false`, so nothing asks the user to sign in; this is here because the
    // bootstrap initializer calls `AuthStore.refresh()` regardless, which treats a rejection
    // as the ordinary "not signed in yet" case.
    account: { me: vi.fn().mockRejectedValue(new Error('no session')) },
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), put: vi.fn() },
    library: { pick, connect: vi.fn() },
    importer: { curaManagerZip: vi.fn() },
  }
  app = await bootstrapApplication(SettingsGeneralTab, {
    providers: [...appConfig.providers, { provide: API_CLIENT, useValue: api }],
  })
  return app.components[0]?.instance as SettingsGeneralTab
}

describe('the application the real providers boot', () => {
  it('renders a failed library pick as a snackbar', async () => {
    const tab = await bootstrap(vi.fn().mockRejectedValue(new Error('not a library')))

    await tab.onChooseFolder()
    await app!.whenStable()

    const snackbar = document.querySelector('jig-snackbar')
    expect(snackbar).not.toBeNull()
    expect(snackbar?.textContent).toContain(en.settings.libraryFailed)
    // jig derives the live-region role from the colour — `error` is assertive, which is
    // `role="alert"`. A snackbar that renders without one is never announced.
    expect(snackbar?.getAttribute('role')).toBe('alert')
  })

  it('renders nothing when the picker was merely cancelled', async () => {
    const tab = await bootstrap(vi.fn().mockResolvedValue(null))

    await tab.onChooseFolder()
    await app!.whenStable()

    expect(document.querySelector('jig-snackbar')).toBeNull()
  })
})
