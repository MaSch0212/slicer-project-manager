import { TestBed } from '@angular/core/testing'
import { Router, provideRouter } from '@angular/router'
import { provideJigControls, withAutoColorScheme } from '@awdlab/jig/api/ng'
import { withDefaultIcons } from '@awdlab/jig/default-icons'
import { nova } from '@awdlab/jig-themes/nova'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Capabilities, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './core/api/api-client.token'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { TranslateService } from './core/i18n/translate.service'
import { NotifyService } from './core/notify.service'
import { SettingsStore } from './core/settings.store'
import en from './core/i18n/locales/en.json'
import { App } from './app'

/**
 * The shell: the sidebar, the drawer, and the one entry list both of them render (spec G 4).
 *
 * `NotifyService` is a double, as it is in every component spec: jig's snackbar host attaches
 * itself to `ApplicationRef.components[0]`, which `TestBed` never populates, so a snackbar cannot
 * render under a `TestBed` at all. `app/app.config.spec.ts` bootstraps a real application for the
 * rendered path; these specs assert on what the shell asked for.
 */

const USER = {
  id: 'u1',
  username: 'marc',
  displayName: 'Marc',
  isAdmin: true,
  status: 'active' as const,
  quotaBytes: null,
  diskUsageBytes: 0,
  createdAt: 0,
}

const WEB_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

/** Every gate open at once, so the entry list is at its full length. */
const EVERY_ENTRY: Capabilities = { ...WEB_CAPABILITIES, canBrowseModelSites: true }

type Notify = { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }

type Options = {
  logout?: ReturnType<typeof vi.fn>
  capabilities?: Capabilities
  put?: ReturnType<typeof vi.fn>
  settings?: SettingsDto
  /** Left signed out, to exercise the gate the rest of the navigation sits behind. */
  signedIn?: boolean
  /** The signed-in user's own flag, which is half of the Users gate. */
  admin?: boolean
}

async function setup(options: Options = {}) {
  const {
    logout = vi.fn().mockResolvedValue(undefined),
    capabilities = WEB_CAPABILITIES,
    put = vi.fn((patch: Partial<SettingsDto>) =>
      Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
    ),
    settings = DEFAULT_SETTINGS,
    signedIn = true,
    admin = true,
  } = options

  const api = {
    auth: { logout },
    account: { me: vi.fn().mockResolvedValue(USER) },
    settings: { get: vi.fn().mockResolvedValue(settings), put },
    // A function, because that is what `ApiClient.capabilities` is and what
    // `CapabilitiesStore.load()` calls. It used to be `{ get: … }` here, which nothing ever
    // called, so the store sat on its offline defaults and the shell was only ever rendered
    // for one capability set.
    capabilities: vi.fn().mockResolvedValue(capabilities),
  }
  const notify: Notify = { success: vi.fn(), error: vi.fn() }

  await TestBed.configureTestingModule({
    imports: [App],
    // Mirrors app.config.ts: App injects ColorSchemeService directly, which needs
    // COLOR_SCHEME_STORAGE provided (only withAutoColorScheme() supplies it).
    providers: [
      provideRouter([
        { path: 'login', children: [] },
        { path: 'projects', children: [] },
        { path: 'settings', children: [] },
      ]),
      { provide: API_CLIENT, useValue: api },
      { provide: NotifyService, useValue: notify },
      // withDefaultIcons(): the shell renders jig-icon in its nav, and an icon slot with no
      // registry throws at render rather than degrading.
      ...provideJigControls({ theme: { preset: nova } }, withDefaultIcons(), withAutoColorScheme()),
    ],
  }).compileComponents()

  // Before createComponent: TestBed auto-detects changes and the template reads
  // t.translations() unguarded (app.config.ts awaits this same promise before bootstrap).
  await TestBed.inject(TranslateService).ready
  const auth = TestBed.inject(AuthStore)
  if (signedIn) {
    auth.setUser({ ...USER, isAdmin: admin })
  }
  const capabilityStore = TestBed.inject(CapabilitiesStore)
  await capabilityStore.load()
  const settingsStore = TestBed.inject(SettingsStore)
  await settingsStore.load()
  const router = TestBed.inject(Router)
  await router.navigateByUrl('/projects')

  const fixture = TestBed.createComponent(App)
  fixture.detectChanges()
  // The collapse control's accessible name is written by JigTooltip's afterRenderEffect, so the
  // queries below only find it once a render has actually landed.
  await fixture.whenStable()
  return {
    fixture,
    api,
    auth,
    notify,
    router,
    settings: settingsStore,
    app: fixture.componentInstance,
  }
}

function root(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement
}

/**
 * The sidebar, or `null` where the shell drew none.
 *
 * Nullable rather than throwing, because "there is no sidebar" is now a state the shell has: a
 * signed-out user of a shell that requires authentication gets no navigation chrome at all.
 */
function sidebar(fixture: { nativeElement: unknown }): HTMLElement | null {
  return root(fixture).querySelector('.spm-sidebar')
}

/** The sidebar, where a test is asserting on what is inside it. */
function sidebarOf(fixture: { nativeElement: unknown }): HTMLElement {
  const element = sidebar(fixture)
  if (!element) {
    throw new Error('the shell rendered no sidebar')
  }
  return element
}

/**
 * Every navigation entry under `scope`, as label, destination and icon markup.
 *
 * A string rather than an object so a mismatch prints as a readable diff, and the icon as its
 * rendered markup because an entry pointing at the right route with the wrong picture is exactly
 * the kind of drift a second copy of the list produces. `'action'` stands in for the sign-out
 * entry, which is a button and has no href.
 */
function entriesIn(scope: Element): string[] {
  return [...scope.querySelectorAll('.spm-nav-entry')].map((entry) => {
    const label = entry.querySelector('.spm-nav-label')?.textContent?.trim() ?? ''
    const destination = entry.getAttribute('href') ?? 'action'
    const icon = entry.querySelector('jig-icon')?.innerHTML ?? ''
    return [label, destination, icon].join(' | ')
  })
}

/** Entry labels under `scope`, for the gate assertions. */
function labelsIn(scope: Element): string[] {
  return [...scope.querySelectorAll('.spm-nav-label')].map(
    (label) => label.textContent?.trim() ?? '',
  )
}

function byLabel(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement {
  const element = root(fixture).querySelector(`[aria-label="${label}"]`)
  if (!element) {
    throw new Error(`no control named "${label}"`)
  }
  return element as HTMLButtonElement
}

/** Opens the mobile drawer the way a user does, and waits for its content to mount. */
async function openDrawer(fixture: Awaited<ReturnType<typeof setup>>['fixture']): Promise<Element> {
  byLabel(fixture, en.nav.open).click()
  await fixture.whenStable()
  fixture.detectChanges()
  const content = root(fixture).querySelector('jig-drawer nav')
  if (!content) {
    throw new Error('the drawer opened with no navigation in it')
  }
  return content
}

describe('App', () => {
  it('should create the app', async () => {
    const { fixture } = await setup()
    expect(fixture.componentInstance).toBeTruthy()
  })

  /**
   * The four gates of spec G 4.4, each in both directions so the pair pins the expression rather
   * than today's value of the flag. They are asserted through the sidebar; the entry list is one
   * component, and the test below is what holds the drawer to rendering that same one.
   */
  it('waits for a user before offering the navigation where the shell requires one', async () => {
    const { fixture } = await setup({ signedIn: false })
    expect(root(fixture).querySelectorAll('.spm-nav-entry')).toHaveLength(0)
  })

  /**
   * No entries, no chrome (review finding 5).
   *
   * A signed-out user of a shell that requires authentication used to get a 240px column holding
   * a brand and a control to collapse nothing — and pressing that control PUT `/api/settings`,
   * was answered 401, and showed an error snackbar for an action the shell itself offered. The
   * condition is the entry list's own length, so it cannot disagree with the list.
   */
  it('draws no navigation chrome at all where there is nowhere to go', async () => {
    const { fixture } = await setup({ signedIn: false })

    expect(sidebar(fixture)).toBeNull()
    expect(root(fixture).querySelectorAll(`[aria-label="${en.nav.open}"]`)).toHaveLength(0)
    expect(root(fixture).querySelectorAll(`[aria-label="${en.nav.toggle}"]`)).toHaveLength(0)
  })

  it('draws the chrome again as soon as there is somewhere to go', async () => {
    const { fixture } = await setup()

    expect(sidebar(fixture)).not.toBeNull()
    expect(root(fixture).querySelectorAll(`[aria-label="${en.nav.open}"]`)).toHaveLength(1)
    expect(root(fixture).querySelectorAll(`[aria-label="${en.nav.toggle}"]`)).toHaveLength(1)
  })

  it('offers the navigation immediately where the shell requires no authentication', async () => {
    const { fixture } = await setup({
      signedIn: false,
      capabilities: { ...WEB_CAPABILITIES, requiresAuth: false, canManageUsers: false },
    })
    expect(labelsIn(sidebarOf(fixture))).toEqual([en.projects.title, en.settings.title])
  })

  it('offers no model-browser link where the shell cannot embed one', async () => {
    const { fixture } = await setup()
    expect(labelsIn(sidebarOf(fixture))).not.toContain(en.browse.title)
  })

  it('offers the model-browser link where the shell can embed one', async () => {
    const { fixture } = await setup({ capabilities: EVERY_ENTRY })
    const browse = [...sidebarOf(fixture).querySelectorAll('a')].filter(
      (anchor) => anchor.getAttribute('href') === '/browse',
    )
    expect(browse).toHaveLength(1)
    expect(labelsIn(browse[0]!)).toEqual([en.browse.title])
  })

  it('offers no user administration where the signed-in user is not an admin', async () => {
    const { fixture, auth } = await setup()
    auth.setUser({ ...USER, isAdmin: false })
    fixture.detectChanges()
    expect(labelsIn(sidebarOf(fixture))).not.toContain(en.admin.title)
  })

  it('offers user administration to an admin of a shell that has users', async () => {
    const { fixture } = await setup()
    expect(labelsIn(sidebarOf(fixture))).toContain(en.admin.title)
  })

  it('offers no sign-out where the shell requires no authentication', async () => {
    const { fixture } = await setup({
      capabilities: { ...WEB_CAPABILITIES, requiresAuth: false },
    })
    expect(labelsIn(sidebarOf(fixture))).not.toContain(en.app.signOut)
    // The rest of the navigation is still there — otherwise gating the whole block off would
    // pass the line above for the wrong reason.
    expect(labelsIn(sidebarOf(fixture))).toEqual(
      expect.arrayContaining([en.projects.title, en.settings.title]),
    )
  })

  it('shows sign-out where there is a session to end', async () => {
    const { fixture } = await setup()
    expect(labelsIn(sidebarOf(fixture))).toContain(en.app.signOut)
  })

  // The shell used to bind (click)="auth.logout()" directly. AuthStore.logout clears local
  // state in a `finally` and rethrows, so nothing navigated: a *successful* sign-out left
  // the user sitting on /projects with the grid still rendered.
  it('leaves the authenticated area after a successful sign-out', async () => {
    const { app, auth, notify, router } = await setup()

    await app.onSignOut()

    expect(auth.isAuthenticated()).toBe(false)
    expect(router.url).toBe('/login')
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('reports a failed sign-out in a snackbar instead of rejecting', async () => {
    const { app, auth, notify, router } = await setup({
      logout: vi.fn().mockRejectedValue(new Error('boom')),
    })

    await expect(app.onSignOut()).resolves.toBeUndefined()

    expect(notify.error).toHaveBeenCalledWith(en.errors.generic)
    // logout() clears local state in a finally, so the user really is signed out here and
    // the shell must not keep showing the authenticated area either way.
    expect(auth.isAuthenticated()).toBe(false)
    expect(router.url).toBe('/login')
  })

  /* ------------------------------------------------------------------- collapsing */

  it('persists a collapse through the settings store rather than the browser', async () => {
    const { fixture, api } = await setup()

    byLabel(fixture, en.nav.toggle).click()
    await fixture.whenStable()

    expect(api.settings.put).toHaveBeenCalledWith({ navCollapsed: true })
  })

  it('renders the collapsed sidebar the setting describes, and names its control the same', async () => {
    const { fixture } = await setup({ settings: { ...DEFAULT_SETTINGS, navCollapsed: true } })

    expect(sidebarOf(fixture).classList.contains('spm-sidebar--collapsed')).toBe(true)
    const toggle = byLabel(fixture, en.nav.toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The labels are hidden by CSS, not removed: an icon-only entry with no accessible name is
    // the failure this rule exists to prevent, and jsdom lays nothing out, so the assertion is
    // that the text is still in the tree.
    expect(labelsIn(sidebarOf(fixture))).toContain(en.projects.title)
  })

  it('names the collapse control the same in both states', async () => {
    const { fixture } = await setup()

    expect(byLabel(fixture, en.nav.toggle).getAttribute('aria-expanded')).toBe('true')
    byLabel(fixture, en.nav.toggle).click()
    await fixture.whenStable()
    fixture.detectChanges()

    // Same name, so the same query still finds it; only aria-expanded moved.
    expect(byLabel(fixture, en.nav.toggle).getAttribute('aria-expanded')).toBe('false')
  })

  /**
   * `SettingsStore.patch` is optimistic and puts the old value back when the server refuses. The
   * sidebar reads the store, so the rollback *is* the visual undo — the defect this pins is a
   * local signal that keeps the value the server rejected, leaving a collapsed sidebar under a
   * message saying the change did not save.
   */
  it('returns the sidebar to the stored state when the save is refused, and says so', async () => {
    const { fixture, notify, settings } = await setup({
      put: vi.fn().mockRejectedValue(new Error('nope')),
    })

    byLabel(fixture, en.nav.toggle).click()
    await fixture.whenStable()
    fixture.detectChanges()

    expect(notify.error).toHaveBeenCalledWith(en.errors.generic)
    expect(settings.settings().navCollapsed).toBe(false)
    expect(sidebarOf(fixture).classList.contains('spm-sidebar--collapsed')).toBe(false)
  })

  /* ---------------------------------------------------------------------- drawer */

  /**
   * The drawer's entries are in a deferred `#content` template, not projected between its tags,
   * because projected content is instantiated by the shell's own template no matter what the
   * drawer is doing. A closed drawer holding a full second navigation would be reachable by
   * anything walking the DOM, and would make every count in this file ambiguous.
   *
   * "Not yet opened" and not "closed": jig unmounts the deferred content when the close has
   * finished animating, so between a close and the end of that animation the entries are still
   * in the document. Measured in a real window — this is the state the shell starts in, which is
   * the one worth pinning.
   */
  it('renders no navigation until the drawer has been opened', async () => {
    const { fixture } = await setup({ capabilities: EVERY_ENTRY })

    const drawer = root(fixture).querySelector('jig-drawer')
    expect(drawer).not.toBeNull()
    expect(drawer!.querySelectorAll('.spm-nav-entry')).toHaveLength(0)
    expect(drawer!.querySelectorAll('a')).toHaveLength(0)
  })

  /**
   * One entry list, two hosts, asserted structurally (spec G 4.3, review finding 1).
   *
   * The agreement tests below compare what each host rendered. **That catches divergence, not
   * duplication** — a hand-written second list that happens to agree on the day it is written
   * passes them, which was measured on the first version of this file. This one asks the
   * question the other way round: how many navigation components are in the document, and does
   * every rendered entry belong to one of them. A copy written into the drawer's template is not
   * an `spm-nav-list` element, so its entries have no such ancestor however faithful they are.
   */
  it('renders one navigation component per host, and every entry inside one', async () => {
    const { fixture } = await setup({ capabilities: EVERY_ENTRY })

    // Closed: the sidebar's, and nothing else in the document.
    expect(root(fixture).querySelectorAll('spm-nav-list')).toHaveLength(1)

    await openDrawer(fixture)

    expect(root(fixture).querySelectorAll('spm-nav-list')).toHaveLength(2)
    expect(root(fixture).querySelectorAll('jig-drawer spm-nav-list')).toHaveLength(1)
    const entries = [...root(fixture).querySelectorAll('.spm-nav-entry')]
    expect(entries).toHaveLength(10)
    expect(entries.filter((entry) => entry.closest('spm-nav-list') === null)).toEqual([])
  })

  /**
   * The same entries in both hosts, **across varied state** (spec G 4.3, review finding 1).
   *
   * Comparing the two hosts under one capability set proves only that they agree there, and a
   * hand-written duplicate agrees there by construction — the measured failure that produced this
   * suite. Every gate therefore gets a case in which it is closed. A copy that does not implement
   * the gates cannot follow them, so it goes red on the first case that hides an entry; a copy
   * that does implement them has re-derived every gate in this application, which is the defect
   * stated out loud.
   *
   * Each case also pins the sidebar's own labels, so a fixture that quietly stopped hiding
   * anything would fail rather than make the comparison vacuous.
   */
  const AGREEMENT_CASES: { name: string; options: Options; labels: string[] }[] = [
    {
      name: 'every gate open',
      options: { capabilities: EVERY_ENTRY },
      labels: [
        en.projects.title,
        en.browse.title,
        en.settings.title,
        en.admin.title,
        en.app.signOut,
      ],
    },
    {
      name: 'a shell that cannot embed a model browser',
      options: { capabilities: WEB_CAPABILITIES },
      labels: [en.projects.title, en.settings.title, en.admin.title, en.app.signOut],
    },
    {
      name: 'a shell with no users to manage',
      options: { capabilities: { ...EVERY_ENTRY, canManageUsers: false } },
      labels: [en.projects.title, en.browse.title, en.settings.title, en.app.signOut],
    },
    {
      name: 'a signed-in user who is not an admin',
      options: { capabilities: EVERY_ENTRY, admin: false },
      labels: [en.projects.title, en.browse.title, en.settings.title, en.app.signOut],
    },
    {
      name: 'a shell that requires no authentication',
      options: {
        capabilities: { ...EVERY_ENTRY, requiresAuth: false, canManageUsers: false },
        signedIn: false,
      },
      labels: [en.projects.title, en.browse.title, en.settings.title],
    },
  ]

  for (const agreement of AGREEMENT_CASES) {
    it(`renders the same entries in the drawer as in the sidebar — ${agreement.name}`, async () => {
      const { fixture } = await setup(agreement.options)
      expect(labelsIn(sidebarOf(fixture))).toEqual(agreement.labels)
      const fromSidebar = entriesIn(sidebarOf(fixture))

      const fromDrawer = entriesIn(await openDrawer(fixture))

      expect(fromSidebar).toHaveLength(agreement.labels.length)
      expect(fromDrawer).toEqual(fromSidebar)
    })
  }

  /**
   * A drawer left open over the page the user just navigated to is the defect this closes
   * (spec G 4.3).
   */
  it('closes the drawer when a navigation lands', async () => {
    const { fixture, router } = await setup()
    await openDrawer(fixture)
    expect(fixture.componentInstance.drawerOpen()).toBe(true)

    await router.navigateByUrl('/settings')
    await fixture.whenStable()

    expect(fixture.componentInstance.drawerOpen()).toBe(false)
  })
})
