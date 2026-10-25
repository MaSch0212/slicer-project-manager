import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../core/api/error'
import type { DesktopClient } from '../core/desktop'
import { setLanguage } from '../core/i18n'
import ConnectPage from './connect'
import { LibraryLocation } from './settings-library'

const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../core/notify', () => ({ notify }))

function fakeClient(overrides: Partial<DesktopClient> = {}): DesktopClient {
  return {
    libraryState: vi.fn().mockResolvedValue({ mode: 'unset', dir: null, origin: null }),
    pickFolder: vi.fn().mockResolvedValue({ dir: 'C:\\Library' }),
    connectRemote: vi.fn().mockResolvedValue({ origin: 'https://print.example.com' }),
    chooseLibrary: vi.fn().mockResolvedValue(undefined),
    // Not what these tests are about; the slicers have their own suites.
    slicers: {} as DesktopClient['slicers'],
    browse: {} as DesktopClient['browse'],
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await setLanguage('en')
})

describe('the connect page', () => {
  it('opens the native folder dialog and nothing else when the folder button is pressed', async () => {
    const client = fakeClient()
    render(() => <ConnectPage client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    await waitFor(() => expect(client.pickFolder).toHaveBeenCalledTimes(1))
    expect(client.connectRemote).not.toHaveBeenCalled()
  })

  it('says so when the folder could not be opened', async () => {
    const client = fakeClient({
      pickFolder: vi.fn().mockRejectedValue(new ApiError('Internal', 'boom')),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(() => <ConnectPage client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The library could not be opened.',
    )
  })

  it('sends the trimmed address to the shell, which asks the user to confirm it', async () => {
    const client = fakeClient()
    render(() => <ConnectPage client={client} />)
    fireEvent.input(screen.getByLabelText('Server address'), {
      target: { value: '  https://print.example.com  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(client.connectRemote).toHaveBeenCalledWith('https://print.example.com'),
    )
  })

  it('never sends an address the shell would refuse, and says why', async () => {
    const client = fakeClient()
    render(() => <ConnectPage client={client} />)
    fireEvent.input(screen.getByLabelText('Server address'), {
      target: { value: 'https://print.example.com/api' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/Enter only the server address/)).toBeTruthy()
    expect(client.connectRemote).not.toHaveBeenCalled()
  })

  it('reports an address the shell refused, and one it could not reach, differently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = fakeClient({
      connectRemote: vi.fn().mockRejectedValue(new ApiError('Validation', 'no')),
    })
    const view = render(() => <ConnectPage client={refused} />)
    fireEvent.input(screen.getByLabelText('Server address'), {
      target: { value: 'https://print.example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'That is not a usable server address',
    )
    view.unmount()

    const unreachable = fakeClient({
      connectRemote: vi.fn().mockRejectedValue(new ApiError('Internal', 'down')),
    })
    render(() => <ConnectPage client={unreachable} />)
    fireEvent.input(screen.getByLabelText('Server address'), {
      target: { value: 'https://print.example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The connection to that server could not be established.',
    )
  })
})

describe('the library location card', () => {
  function renderCard(client: DesktopClient) {
    const history = createMemoryHistory()
    history.set({ value: '/settings' })
    render(() => (
      <MemoryRouter history={history}>
        <Route path="/settings" component={() => <LibraryLocation client={client} />} />
        <Route path="/desktop/connect" component={() => <p>connect page</p>} />
      </MemoryRouter>
    ))
    return history
  }

  it('shows the open folder, and offers a folder and a server', async () => {
    const client = fakeClient({
      libraryState: vi.fn().mockResolvedValue({ mode: 'local', dir: 'C:\\Library', origin: null }),
    })
    const history = renderCard(client)
    expect(await screen.findByText('C:\\Library')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    await waitFor(() => expect(client.pickFolder).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Connect to a server instead' }))
    await waitFor(() => expect(history.get()).toBe('/desktop/connect'))
  })

  it('offers no folder control while a server is connected, only the way back', async () => {
    const client = fakeClient({
      libraryState: vi
        .fn()
        .mockResolvedValue({ mode: 'remote', dir: null, origin: 'https://print.example.com' }),
    })
    renderCard(client)
    expect(await screen.findByText('https://print.example.com')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Choose a folder…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose another library…' }))
    await waitFor(() => expect(client.chooseLibrary).toHaveBeenCalledTimes(1))
  })

  it('reports a change that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = fakeClient({
      libraryState: vi.fn().mockResolvedValue({ mode: 'local', dir: 'C:\\Library', origin: null }),
      pickFolder: vi.fn().mockRejectedValue(new ApiError('Internal', 'boom')),
    })
    renderCard(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a folder…' }))
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('The library could not be opened.'),
    )
  })
})
