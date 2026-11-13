import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type Capabilities,
  type ProjectViewDto,
  type UserDto,
} from '../api/generated'
import { ApiError } from '../core/api/error'

const ADMIN: UserDto = {
  id: 'u1',
  username: 'anna',
  displayName: 'Anna',
  isAdmin: true,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}
const EVERY_ENTRY: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: true,
}

/** Two saved views: the first is the shape the shipped defaults have, so it starts active. */
const VIEWS: ProjectViewDto[] = [
  {
    id: 'v1',
    name: 'Everything',
    icon: 'layers',
    viewMode: 'grid',
    sort: 'updatedAt',
    dir: 'desc',
    includeArchived: false,
    tags: [],
  },
  {
    id: 'v2',
    name: 'Old prints',
    icon: 'archive',
    viewMode: 'list',
    sort: 'name',
    dir: 'asc',
    includeArchived: true,
    tags: ['petg'],
  },
]

const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  account: { me: vi.fn() },
  auth: { logout: vi.fn() },
  settings: { get: vi.fn(), put: vi.fn() },
}))
vi.mock('../core/api/client', () => ({ api }))

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../core/notify', () => ({ notify }))

/**
 * Whether this is the desktop app, per test. The window bar exists only there, and the sidebar's
 * brand row exists only where it does not.
 */
const shellHost = vi.hoisted(() => ({
  isDesktop: false,
  chooseLibrary: vi.fn(),
  browse: { sites: vi.fn(), openTab: vi.fn() },
  window: {
    state: vi.fn(),
    startDrag: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    toggleDevtools: vi.fn(),
  },
}))
vi.mock('../core/desktop', () => ({
  isDesktop: () => shellHost.isDesktop,
  desktop: {
    window: shellHost.window,
    browse: shellHost.browse,
    chooseLibrary: shellHost.chooseLibrary,
  },
}))

import { auth, capabilities, settings } from '../core/stores'
import { pickView } from '../core/view-selection'
import { Shell } from './shell'

async function setup(
  options: {
    caps?: Capabilities
    navCollapsed?: boolean
    path?: string
    ready?: string
    views?: ProjectViewDto[]
  } = {},
) {
  api.capabilities.mockResolvedValue(options.caps ?? EVERY_ENTRY)
  api.account.me.mockResolvedValue(ADMIN)
  api.settings.get.mockResolvedValue({
    ...DEFAULT_SETTINGS,
    navCollapsed: options.navCollapsed ?? false,
    views: options.views ?? [],
  })
  api.settings.put.mockImplementation((patch: object) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  )
  api.auth.logout.mockResolvedValue(undefined)
  await capabilities.load()
  await auth.refresh()
  await settings.load()

  const history = createMemoryHistory()
  history.set({ value: options.path ?? '/projects' })
  render(() => (
    <MemoryRouter history={history} root={Shell}>
      <Route path="/projects" component={() => <h1>projects page</h1>} />
      <Route path="/settings" component={() => <h1>settings page</h1>} />
      <Route path="/login" component={() => <h1>login page</h1>} />
      <Route path="/desktop/connect" component={() => <h1>connect page</h1>} />
    </MemoryRouter>
  ))
  await screen.findByText(options.ready ?? 'projects page')
  return { history }
}

const sidebar = () => screen.getAllByRole('navigation', { name: 'Main navigation' })[0]!
const labels = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.trim())

beforeEach(() => {
  vi.clearAllMocks()
  settings.reset()
  pickView(null)
  auth.setUser(null)
  shellHost.isDesktop = false
  shellHost.window.state.mockResolvedValue({ isMaximized: false })
  shellHost.window.toggleMaximize.mockResolvedValue({ isMaximized: true })
  for (const command of ['startDrag', 'minimize', 'close', 'toggleDevtools'] as const) {
    shellHost.window[command].mockResolvedValue(undefined)
  }
  shellHost.chooseLibrary.mockResolvedValue(undefined)
  shellHost.browse.sites.mockResolvedValue([])
  shellHost.browse.openTab.mockResolvedValue(undefined)
})

/**
 * The window frame the desktop app draws for itself, because its window has no system one. The
 * point of the whole change is that the app's name appears once: in the bar, not also at the head
 * of the sidebar.
 */
describe('Shell window bar', () => {
  const brandLink = () => screen.queryByRole('link', { name: 'Slicer Project Manager' })

  it('draws none in a browser, where the sidebar keeps the brand', async () => {
    await setup()

    expect(screen.queryByRole('button', { name: 'Minimise' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(brandLink()).not.toBeNull()
  })

  it('draws the three window buttons in the desktop app, and drops the sidebar brand', async () => {
    shellHost.isDesktop = true
    await setup()

    expect(screen.getByRole('button', { name: 'Minimise' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Maximise' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    // The name is in the bar now, so the sidebar's copy of it is gone.
    expect(brandLink()).toBeNull()
  })

  it('asks the window whether it is maximised, and renames the button to match', async () => {
    shellHost.isDesktop = true
    await setup()
    await waitFor(() => expect(shellHost.window.state).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))

    await waitFor(() => expect(shellHost.window.toggleMaximize).toHaveBeenCalled())
    await screen.findByRole('button', { name: 'Restore down' })
    expect(screen.queryByRole('button', { name: 'Maximise' })).toBeNull()
  })

  it('puts the app menu on the name and settings in the bar', async () => {
    shellHost.isDesktop = true
    await setup()

    // The name is a menu, not a link home: everything the app can do is behind it.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Application menu' }), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy())
    expect(screen.getByRole('menuitem', { name: 'Choose another library…' })).toBeTruthy()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    // And settings is one press from anywhere, as it is in the app this is modelled on.
    expect(screen.getAllByRole('button', { name: 'Settings' }).length).toBeGreaterThan(0)
  })

  it('offers the model sites behind a plus, each opening a tab of the browser', async () => {
    shellHost.isDesktop = true
    shellHost.browse.sites.mockResolvedValue([
      { id: 'printables', displayName: 'Printables', homeUrl: 'https://www.printables.com/' },
    ])
    const { history } = await setup()
    await waitFor(() => screen.getByRole('button', { name: 'Open a model site' }))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Open a model site' }), { key: 'Enter' })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'Printables' }), {
      pointerType: 'mouse',
      button: 0,
    })

    await waitFor(() => expect(history.get()).toBe('/browse'))
    expect(shellHost.browse.openTab).toHaveBeenCalledWith('https://www.printables.com/')
  })

  it('offers no plus where the shell cannot browse model sites', async () => {
    shellHost.isDesktop = true
    await setup({ caps: { ...EVERY_ENTRY, canBrowseModelSites: false } })

    expect(screen.queryByRole('button', { name: 'Open a model site' })).toBeNull()
  })

  it('closes and minimises through the shell rather than the page', async () => {
    shellHost.isDesktop = true
    await setup()

    fireEvent.click(screen.getByRole('button', { name: 'Minimise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(shellHost.window.minimize).toHaveBeenCalledOnce()
    expect(shellHost.window.close).toHaveBeenCalledOnce()
  })
})

// Ported from app.spec.ts (the navigation gates themselves are covered as `navEntriesFor`).
describe('Shell sign-out', () => {
  it('leaves the authenticated area after a successful sign-out', async () => {
    await setup()
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Sign out' }))
    await screen.findByText('login page')
    expect(auth.isAuthenticated()).toBe(false)
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('reports a failed sign-out in a toast and still leaves', async () => {
    await setup()
    api.auth.logout.mockRejectedValue(new ApiError('Internal', 'boom'))
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Sign out' }))
    await screen.findByText('login page')
    expect(notify.error).toHaveBeenCalledWith('Something went wrong')
    // The store clears local state in a `finally`: the user really is signed out.
    expect(auth.isAuthenticated()).toBe(false)
  })
})

describe('Shell on the desktop connect page', () => {
  it('draws no navigation: there is no library yet for it to lead into', async () => {
    await setup({
      caps: {
        ...EVERY_ENTRY,
        requiresAuth: false,
        canManageUsers: false,
        canPickLocalFolder: true,
      },
      path: '/desktop/connect',
      ready: 'connect page',
    })
    expect(screen.queryAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(0)
  })

  it('draws it everywhere else, for the same capabilities', async () => {
    await setup({
      caps: {
        ...EVERY_ENTRY,
        requiresAuth: false,
        canManageUsers: false,
        canPickLocalFolder: true,
      },
    })
    expect(sidebar()).toBeTruthy()
  })
})

/**
 * The sidebar still collapses; what is gone is the pair of buttons under it. The theme has lived
 * in settings for a while and the collapse is a setting too, so a footer of controls duplicating
 * them was two rows of furniture under an already compact menu.
 */
describe('Shell collapse', () => {
  it('draws the collapsed sidebar the setting describes and keeps every name', async () => {
    await setup({ navCollapsed: true })
    // The labels are visually hidden, never removed: an icon with no name is the failure to avoid.
    expect(within(sidebar()).getByRole('link', { name: 'Projects' })).toBeTruthy()
  })

  it('offers no theme or collapse control of its own under the navigation', async () => {
    await setup()

    expect(screen.queryByRole('button', { name: 'Collapse or expand the navigation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Theme' })).toBeNull()
  })
})

describe('Shell drawer', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open the navigation' }))
  const drawerNav = async () => {
    const dialog = await screen.findByRole('dialog')
    return within(dialog).getByRole('navigation', { name: 'Main navigation' })
  }

  it('renders no second navigation until the drawer has been opened', async () => {
    await setup()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(1)
  })

  it('offers the same entries in the drawer as in the sidebar', async () => {
    await setup()
    const fromSidebar = labels(sidebar())
    expect(fromSidebar).toEqual(['Projects', 'Find models', 'Settings', 'Users', 'Sign out'])
    open()
    expect(labels(await drawerNav())).toEqual(fromSidebar)
  })

  it('closes the drawer when a navigation lands', async () => {
    await setup()
    open()
    fireEvent.click(within(await drawerNav()).getByRole('link', { name: 'Settings' }))
    await screen.findByText('settings page')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

/**
 * Saved views: the sort order, the layout, the archive switch and the tag filter under a name.
 * The row marked as current is derived from the settings, never remembered, so it can never
 * disagree with what the list is actually showing.
 */
describe('Shell saved views', () => {
  const viewButton = (name: string) =>
    within(sidebar()).getByRole('button', { name: new RegExp(`^${name}`) })
  /** Kobalte's menus open on a key press and choose on pointer-up, as the other suites do it. */
  const act = async (view: string, item: string) => {
    fireEvent.keyDown(within(sidebar()).getByRole('button', { name: `Options for ${view}` }), {
      key: 'Enter',
    })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: item }), {
      pointerType: 'mouse',
    })
  }

  it('lists them and marks the one the list is showing', async () => {
    await setup({ views: VIEWS })

    expect(viewButton('Everything').getAttribute('aria-current')).toBe('page')
    expect(viewButton('Old prints').getAttribute('aria-current')).toBeNull()
  })

  it('writes every part of a view when one is picked, and nothing else', async () => {
    await setup({ views: VIEWS, path: '/settings', ready: 'settings page' })

    fireEvent.click(viewButton('Old prints'))

    await screen.findByText('projects page')
    expect(api.settings.put).toHaveBeenCalledWith({
      viewMode: 'list',
      sort: 'name',
      dir: 'asc',
      includeArchived: true,
      filterTags: ['petg'],
    })
  })

  it('marks the one that was picked, even when another has the same filters', async () => {
    // Two views saved without changing anything in between: matching alone always said "the
    // first", whichever was clicked.
    const twin = { ...VIEWS[0]!, id: 'v3', name: 'Twin' }
    await setup({ views: [VIEWS[0]!, twin] })

    fireEvent.click(viewButton('Twin'))

    await waitFor(() => expect(viewButton('Twin').getAttribute('aria-current')).toBe('page'))
    expect(viewButton('Everything').getAttribute('aria-current')).toBeNull()
  })

  it('keeps the picked one current once its filters change, and says it was changed', async () => {
    await setup({ views: VIEWS })
    fireEvent.click(viewButton('Old prints'))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalled())

    await settings.patch({ sort: 'createdAt' })

    expect(viewButton('Old prints').getAttribute('aria-current')).toBe('page')
    expect(viewButton('Old prints').textContent).toContain('Changed since it was saved')
    expect(viewButton('Everything').getAttribute('aria-current')).toBeNull()
  })

  it('marks none at all when nothing was picked and the list matches none', async () => {
    await setup({ views: VIEWS })

    await settings.patch({ sort: 'createdAt' })

    expect(viewButton('Everything').getAttribute('aria-current')).toBeNull()
    expect(viewButton('Old prints').getAttribute('aria-current')).toBeNull()
  })

  it('deletes one from its own menu, sending the whole shorter list', async () => {
    await setup({ views: VIEWS })

    await act('Old prints', 'Delete')

    await waitFor(() =>
      expect(api.settings.put).toHaveBeenCalledWith({
        views: [expect.objectContaining({ id: 'v1' })],
      }),
    )
  })

  it('keeps what the list is showing as a new view, with the icon that was chosen', async () => {
    await setup({ views: [] })

    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Save this view…' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText(/Name/), { target: { value: '  Functional  ' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Printer' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }))

    await waitFor(() =>
      expect(api.settings.put).toHaveBeenCalledWith({
        views: [
          {
            id: 'view-1',
            name: 'Functional',
            icon: 'printer',
            viewMode: 'grid',
            sort: 'updatedAt',
            dir: 'desc',
            includeArchived: false,
            tags: [],
          },
        ],
      }),
    )
  })

  it('renames one in the editor, and puts them in the order asked for', async () => {
    await setup({ views: VIEWS })

    await act('Everything', 'Rename')
    const dialog = await screen.findByRole('dialog')

    const field = within(dialog).getByLabelText('Name of Everything')
    fireEvent.blur(field, { target: { value: 'All projects' } })
    await waitFor(() =>
      expect(api.settings.put).toHaveBeenCalledWith({
        views: [
          expect.objectContaining({ name: 'All projects' }),
          expect.objectContaining({ id: 'v2' }),
        ],
      }),
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Old prints up' }))
    await waitFor(() =>
      expect(api.settings.put).toHaveBeenCalledWith({
        views: [expect.objectContaining({ id: 'v2' }), expect.objectContaining({ id: 'v1' })],
      }),
    )
  })
})
