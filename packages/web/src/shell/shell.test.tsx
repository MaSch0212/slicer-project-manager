import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Capabilities, type UserDto } from '../api/generated'
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
  desktop: { window: shellHost.window },
}))

import { auth, capabilities, settings } from '../core/stores'
import { Shell } from './shell'

async function setup(
  options: { caps?: Capabilities; navCollapsed?: boolean; path?: string; ready?: string } = {},
) {
  api.capabilities.mockResolvedValue(options.caps ?? EVERY_ENTRY)
  api.account.me.mockResolvedValue(ADMIN)
  api.settings.get.mockResolvedValue({
    ...DEFAULT_SETTINGS,
    navCollapsed: options.navCollapsed ?? false,
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
const toggle = () => screen.getByRole('button', { name: 'Collapse or expand the navigation' })
const labels = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.trim())

beforeEach(() => {
  vi.clearAllMocks()
  settings.reset()
  auth.setUser(null)
  shellHost.isDesktop = false
  shellHost.window.state.mockResolvedValue({ isMaximized: false })
  shellHost.window.toggleMaximize.mockResolvedValue({ isMaximized: true })
  for (const command of ['startDrag', 'minimize', 'close', 'toggleDevtools'] as const) {
    shellHost.window[command].mockResolvedValue(undefined)
  }
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

describe('Shell collapse', () => {
  it('persists a collapse through the settings API rather than the browser', async () => {
    await setup()
    fireEvent.click(toggle())
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ navCollapsed: true }))
  })

  it('draws the collapsed sidebar the setting describes and keeps every name', async () => {
    await setup({ navCollapsed: true })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    // The labels are visually hidden, never removed: an icon with no name is the failure to avoid.
    expect(within(sidebar()).getByRole('link', { name: 'Projects' })).toBeTruthy()
  })

  it('names the collapse control the same in both states', async () => {
    await setup()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
  })

  it('returns to the stored state when the save is refused, and says so', async () => {
    await setup()
    api.settings.put.mockRejectedValue(new ApiError('Internal', 'nope'))
    fireEvent.click(toggle())
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Something went wrong'))
    expect(settings.settings().navCollapsed).toBe(false)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
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
