import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserDto } from '../api/generated'
import { ApiError } from '../core/api/error'

const USER: UserDto = {
  id: 'u1',
  username: 'anna',
  displayName: 'Anna',
  isAdmin: false,
  status: 'active',
  diskUsageBytes: 0,
  quotaBytes: null,
  createdAt: 0,
}

const api = vi.hoisted(() => ({
  auth: { login: vi.fn(), checkToken: vi.fn(), activate: vi.fn() },
  settings: { get: vi.fn() },
}))
vi.mock('../core/api/client', () => ({ api }))

// The pages sign in through the session module; its job here is only to be called.
const signedIn = vi.hoisted(() => vi.fn())
vi.mock('../core/session', () => ({ signedIn, hasSession: () => false }))

import ActivatePage from './activate'
import LoginPage from './login'

function renderAt(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  render(() => (
    <MemoryRouter history={history}>
      <Route path="/login" component={LoginPage} />
      <Route path="/activate" component={ActivatePage} />
      <Route path="/projects" component={() => <p>projects page</p>} />
    </MemoryRouter>
  ))
  return history
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// Ported from login.page.spec.ts.
describe('LoginPage', () => {
  it('signs in and goes to the projects list on success', async () => {
    api.auth.login.mockResolvedValue(USER)
    renderAt('/login')
    fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'anna' } })
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('projects page')
    expect(api.auth.login).toHaveBeenCalledWith('anna', 'pw')
    expect(signedIn).toHaveBeenCalledWith(USER)
  })

  it('shows one generic message for any credential failure', async () => {
    api.auth.login.mockRejectedValue(new ApiError('Forbidden', 'disabled'))
    renderAt('/login')
    fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'anna' } })
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Username or password is not correct',
    )
    expect(screen.queryByText('projects page')).toBeNull()
  })

  it('does not call the API when a field is empty, and says which', async () => {
    renderAt('/login')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(api.auth.login).not.toHaveBeenCalled()
  })
})

// Ported from activate.page.spec.ts.
describe('ActivatePage', () => {
  const password = 'a good long password'

  it('reports an invalid link when the fragment is missing', async () => {
    renderAt('/activate')
    expect((await screen.findByRole('alert')).textContent).toContain('not valid or has expired')
    expect(api.auth.checkToken).not.toHaveBeenCalled()
  })

  it('checks the token before asking for a password, and names the user', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: true, username: 'anna' })
    renderAt('/activate#sometoken')
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(api.auth.checkToken).toHaveBeenCalledWith('sometoken')
    expect(screen.getByText('anna')).toBeTruthy()
  })

  it('checks a newer link pasted over an older one in the same tab', async () => {
    api.auth.checkToken.mockImplementation((token: string) =>
      Promise.resolve(token === 'fresh' ? { valid: true, username: 'anna' } : { valid: false }),
    )
    const history = renderAt('/activate#stale')
    expect((await screen.findByRole('alert')).textContent).toContain('not valid or has expired')
    // Only the fragment changes, so the page is not reloaded and nothing remounts.
    history.set({ value: '/activate#fresh' })
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(api.auth.checkToken).toHaveBeenLastCalledWith('fresh')
  })

  it('reports an expired link as invalid', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: false })
    renderAt('/activate#expired')
    expect((await screen.findByRole('alert')).textContent).toContain('not valid or has expired')
  })

  it('does not call the API when the password is too short or the confirmation differs', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: true, username: 'anna' })
    renderAt('/activate#tok')
    fireEvent.input(await screen.findByLabelText('Password'), { target: { value: 'short' } })
    fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(api.auth.activate).not.toHaveBeenCalled()
  })

  it('keeps the form and shows an error when activation fails for a non-token reason', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: true, username: 'anna' })
    api.auth.activate.mockRejectedValue(new ApiError('Validation', 'rejected'))
    renderAt('/activate#tok')
    fireEvent.input(await screen.findByLabelText('Password'), { target: { value: password } })
    fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong')
    expect(screen.getByLabelText('Password')).toBeTruthy()
  })

  it('treats a dead token at submit time as an invalid link', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: true, username: 'anna' })
    api.auth.activate.mockRejectedValue(new ApiError('TokenExpired', 'late'))
    renderAt('/activate#tok')
    fireEvent.input(await screen.findByLabelText('Password'), { target: { value: password } })
    fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }))
    expect((await screen.findByRole('alert')).textContent).toContain('not valid or has expired')
  })

  it('activates, signs in and goes to the projects list', async () => {
    api.auth.checkToken.mockResolvedValue({ valid: true, username: 'anna' })
    api.auth.activate.mockResolvedValue(USER)
    renderAt('/activate#tok')
    fireEvent.input(await screen.findByLabelText('Password'), { target: { value: password } })
    fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }))
    await screen.findByText('projects page')
    expect(api.auth.activate).toHaveBeenCalledWith('tok', password)
    expect(signedIn).toHaveBeenCalledWith(USER)
  })
})
