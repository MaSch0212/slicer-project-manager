import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Capabilities, type UserDto } from '../api/generated'
import { ApiError } from '../core/api/error'

const ME: UserDto = {
  id: 'u1',
  username: 'marc',
  displayName: 'Marc',
  isAdmin: true,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}
const CAPS: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}
const MIB = 1024 * 1024

const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  account: { me: vi.fn(), updateProfile: vi.fn(), changePassword: vi.fn() },
  settings: { get: vi.fn(), put: vi.fn() },
  users: {
    list: vi.fn(),
    create: vi.fn(),
    reissueInvite: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  importer: { curaManagerZip: vi.fn() },
}))
vi.mock('../core/api/client', () => ({ api }))

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../core/notify', () => ({ notify }))

import { language, setLanguage } from '../core/i18n'
import { auth, capabilities, settings } from '../core/stores'
import AdminUsersPage from './admin-users'
import SettingsPage from './settings'

async function boot(caps: Partial<Capabilities> = {}) {
  api.capabilities.mockResolvedValue({ ...CAPS, ...caps })
  api.account.me.mockResolvedValue(ME)
  api.settings.get.mockResolvedValue(DEFAULT_SETTINGS)
  api.settings.put.mockImplementation((patch: object) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  )
  await capabilities.load()
  await auth.refresh()
  await settings.load()
}

function renderAt(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  render(() => (
    <MemoryRouter history={history}>
      <Route path="/settings" component={SettingsPage} />
      <Route path="/settings/slicers" component={() => <p>slicers page</p>} />
      <Route path="/admin/users" component={AdminUsersPage} />
    </MemoryRouter>
  ))
  return history
}

beforeEach(async () => {
  vi.clearAllMocks()
  await setLanguage('en')
  settings.reset()
  auth.setUser(null)
  // The sign-out-free dialogs use the clipboard.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

// Ported from settings.page.spec.ts: the tab strip is a navigation control driven by capabilities.
describe('SettingsPage tabs', () => {
  it('offers General alone where the shell cannot configure slicers', async () => {
    await boot()
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('offers General and Slicers where it can, and the Slicers tab navigates', async () => {
    await boot({ canConfigureSlicers: true })
    renderAt('/settings')
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Slicers'])
    fireEvent.click(screen.getByRole('tab', { name: 'Slicers' }))
    await screen.findByText('slicers page')
  })
})

// Ported from general.tab.spec.ts.
describe('Settings general tab', () => {
  it('persists a theme change', async () => {
    await boot()
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ theme: 'dark' }))
    expect(settings.settings().theme).toBe('dark')
  })

  it('persists a language change and switches the rendered language', async () => {
    await boot()
    renderAt('/settings')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Language' }), {
      target: { value: 'de' },
    })
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ language: 'de' }))
    expect(await screen.findByRole('heading', { name: 'Einstellungen', level: 1 })).toBeTruthy()
    expect(language()).toBe('de')
  })

  it('reports a failed language save and does not switch language', async () => {
    await boot()
    api.settings.put.mockRejectedValue(new ApiError('Internal', 'nope'))
    renderAt('/settings')
    fireEvent.change(await screen.findByRole('combobox', { name: 'Language' }), {
      target: { value: 'de' },
    })
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Something went wrong'))
    expect(language()).toBe('en')
    expect(settings.settings().language).toBe('en')
  })

  it('reports a failed theme save and returns the control to its value', async () => {
    await boot()
    api.settings.put.mockRejectedValue(new ApiError('Internal', 'nope'))
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await waitFor(() => expect(notify.error).toHaveBeenCalled())
    expect(settings.settings().theme).toBe('system')
  })

  it('saves the sidebar and default-view choices', async () => {
    await boot()
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('switch', { name: 'Collapse the navigation' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ navCollapsed: true }))
    fireEvent.click(screen.getByRole('radio', { name: 'List' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' }))
  })

  it('says nothing more once a save succeeds', async () => {
    await boot()
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('radio', { name: 'Light' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalled())
    expect(notify.error).not.toHaveBeenCalled()
  })

  // Ported: the library card appears only where a folder can be chosen.
  it('offers the library section only where a local folder can be picked', async () => {
    await boot()
    renderAt('/settings')
    await screen.findByRole('combobox', { name: 'Language' })
    expect(screen.queryByText('Where your library is')).toBeNull()
  })

  it('offers the library section where it can', async () => {
    await boot({ canPickLocalFolder: true })
    renderAt('/settings')
    expect(await screen.findByText('Where your library is')).toBeTruthy()
  })

  // Ported: the import panel is a card of the page.
  it('renders the import panel as a section', async () => {
    await boot()
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: 'Import a library' })).toBeTruthy()
    expect(screen.getByText('Choose a .zip archive')).toBeTruthy()
  })
})

describe('Settings account', () => {
  it('is absent where the shell has no sign-in', async () => {
    await boot({ requiresAuth: false })
    renderAt('/settings')
    await screen.findByRole('combobox', { name: 'Language' })
    expect(screen.queryByRole('heading', { name: 'Account' })).toBeNull()
  })

  it('saves a new display name and updates the signed-in user', async () => {
    await boot()
    api.account.updateProfile.mockResolvedValue({ ...ME, displayName: 'Marc S.' })
    renderAt('/settings')
    const field = await screen.findByLabelText('Display name')
    expect((field as HTMLInputElement).value).toBe('Marc')
    fireEvent.input(field, { target: { value: ' Marc S. ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() =>
      expect(api.account.updateProfile).toHaveBeenCalledWith({ displayName: 'Marc S.' }),
    )
    await waitFor(() => expect(auth.user()?.displayName).toBe('Marc S.'))
    expect(notify.success).toHaveBeenCalledWith('Your name was saved')
  })

  it('does not send an empty display name', async () => {
    await boot()
    renderAt('/settings')
    fireEvent.input(await screen.findByLabelText('Display name'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('This field is required')).toBeTruthy()
    expect(api.account.updateProfile).not.toHaveBeenCalled()
  })

  const fillPassword = (current: string, next: string, confirm: string) => {
    fireEvent.input(screen.getByLabelText('Current password'), { target: { value: current } })
    fireEvent.input(screen.getByLabelText('New password'), { target: { value: next } })
    fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: confirm } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  }

  it('keeps the 10 character floor and the confirmation off the network', async () => {
    await boot()
    renderAt('/settings')
    await screen.findByLabelText('Current password')
    fillPassword('old password 1', 'short', 'different')
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2))
    expect(api.account.changePassword).not.toHaveBeenCalled()
  })

  it('changes the password, clears the form and says so', async () => {
    await boot()
    api.account.changePassword.mockResolvedValue(undefined)
    renderAt('/settings')
    await screen.findByLabelText('Current password')
    fillPassword('old password 1', 'a brand new password', 'a brand new password')
    await waitFor(() =>
      expect(api.account.changePassword).toHaveBeenCalledWith(
        'old password 1',
        'a brand new password',
      ),
    )
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Your password was changed'))
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('')
  })

  it('puts a wrong current password on its own field', async () => {
    await boot()
    api.account.changePassword.mockRejectedValue(new ApiError('Unauthorized', 'no'))
    renderAt('/settings')
    await screen.findByLabelText('Current password')
    fillPassword('wrong password', 'a brand new password', 'a brand new password')
    expect(await screen.findByText('The current password is not correct')).toBeTruthy()
    expect(notify.error).not.toHaveBeenCalled()
  })
})

// Ported from users.page.spec.ts: what the page renders and how its dialogs talk to the store.
describe('AdminUsersPage', () => {
  const OTHER: UserDto = {
    ...ME,
    id: 'u2',
    username: 'anna',
    displayName: 'Anna',
    isAdmin: false,
    status: 'pending',
    diskUsageBytes: 5 * MIB,
    quotaBytes: 200,
  }

  async function open(users: UserDto[] = [ME, OTHER]) {
    await boot()
    api.users.list.mockResolvedValue(users)
    api.users.update.mockResolvedValue(ME)
    renderAt('/admin/users')
    await screen.findByRole('table')
  }
  const row = (username: string) => screen.getByRole('row', { name: new RegExp(username) })
  const openMenu = (username: string) =>
    fireEvent.keyDown(
      within(row(username)).getByRole('button', { name: `Actions for ${username}` }),
      { key: 'Enter' },
    )
  const act = async (username: string, item: string) => {
    openMenu(username)
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: item }), {
      pointerType: 'mouse',
    })
  }

  it('lists users with status, role, usage and quota in human units', async () => {
    await open()
    const anna = row('anna')
    expect(within(anna).getByText('Pending')).toBeTruthy()
    expect(within(anna).getByText('5.0 MB')).toBeTruthy()
    expect(within(anna).getByText('200 B')).toBeTruthy()
    expect(anna.textContent).not.toMatch(/5242880/)
    expect(within(row('marc')).getByText('Unlimited')).toBeTruthy()
    expect(within(row('marc')).getByText('you')).toBeTruthy()
    expect(within(row('marc')).getAllByText('Administrator').length).toBeGreaterThan(0)
  })

  it('renders an error branch instead of a blank table when the list fails to load', async () => {
    await boot()
    api.users.list.mockRejectedValue(new Error('boom'))
    renderAt('/admin/users')
    expect(await screen.findByText('The users could not be loaded.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('creates a user and shows the activation link once, to copy', async () => {
    await open()
    api.users.create.mockResolvedValue({
      user: { ...OTHER, id: 'u3', username: 'new' },
      activationUrl: 'http://x/activate#tok',
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Create user' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText(/Username/), { target: { value: 'new' } })
    fireEvent.input(within(dialog).getByLabelText(/Display name/), { target: { value: 'New One' } })
    fireEvent.input(within(dialog).getByLabelText('Quota (MiB)'), { target: { value: '300' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))
    await waitFor(() =>
      expect(api.users.create).toHaveBeenCalledWith({
        username: 'new',
        displayName: 'New One',
        isAdmin: false,
        quotaBytes: 300 * MIB,
      }),
    )
    const link = (await screen.findByRole('textbox', { name: 'Link address' })) as HTMLInputElement
    expect(link.value).toBe('http://x/activate#tok')
    fireEvent.click(screen.getByRole('button', { name: 'Copy activation link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://x/activate#tok'),
    )
  })

  it('does not call create when the model is invalid', async () => {
    await open()
    fireEvent.click(screen.getAllByRole('button', { name: 'Create user' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBe(2))
    expect(api.users.create).not.toHaveBeenCalled()
  })

  it('says "taken" next to the username when the server reports a conflict', async () => {
    await open()
    api.users.create.mockRejectedValue(new ApiError('Conflict', 'taken'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Create user' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText(/Username/), { target: { value: 'anna' } })
    fireEvent.input(within(dialog).getByLabelText(/Display name/), { target: { value: 'Anna' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))
    expect(await within(dialog).findByText('That username is already taken')).toBeTruthy()
  })

  it('re-issues an invite for a pending user and shows the new link', async () => {
    await open()
    api.users.reissueInvite.mockResolvedValue({ activationUrl: 'http://x/activate#tok2' })
    await act('anna', 'Re-issue invite')
    const link = (await screen.findByRole('textbox', { name: 'Link address' })) as HTMLInputElement
    expect(link.value).toBe('http://x/activate#tok2')
  })

  it('offers no re-issue for an active user', async () => {
    await open()
    openMenu('marc')
    await screen.findByRole('menuitem', { name: 'Disable' })
    expect(screen.queryByRole('menuitem', { name: 'Re-issue invite' })).toBeNull()
  })

  it('converts a MiB quota entry into bytes', async () => {
    await open()
    await act('anna', 'Set quota')
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Quota (MiB)'), { target: { value: '500' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.users.update).toHaveBeenCalledWith('u2', { quotaBytes: 500 * MIB }),
    )
  })

  it('clears a quota back to unlimited when the field is emptied', async () => {
    await open()
    await act('anna', 'Set quota')
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Quota (MiB)'), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('u2', { quotaBytes: null }))
  })

  it('refuses a typed zero without calling update', async () => {
    await open()
    await act('anna', 'Set quota')
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Quota (MiB)'), { target: { value: '0' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await within(dialog).findByText(/whole number of MiB/)).toBeTruthy()
    expect(api.users.update).not.toHaveBeenCalled()
  })

  it('disables and demotes through the row menu', async () => {
    await open()
    await act('anna', 'Disable')
    await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('u2', { isDisabled: true }))
    await act('marc', 'Remove administrator rights')
    await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('u1', { isAdmin: false }))
  })

  it('explains a last-active-admin refusal', async () => {
    await open()
    api.users.update.mockRejectedValueOnce(new ApiError('LastActiveAdmin', 'nope'))
    await act('marc', 'Remove administrator rights')
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('The last active administrator must remain'),
    )
  })

  // Ported: delete needs a second, confirming press, and cancelling leaves the user in place.
  it('deletes only after the confirmation', async () => {
    await open()
    await act('anna', 'Delete user')
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))
    expect(api.users.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() => expect(api.users.delete).toHaveBeenCalledWith('u2'))
  })

  it('leaves the user in place when the delete is cancelled', async () => {
    await open()
    await act('anna', 'Delete user')
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.users.delete).not.toHaveBeenCalled()
  })
})
