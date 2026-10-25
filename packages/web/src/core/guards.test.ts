import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../api/generated'
import { adminDecision, authDecision, capabilityDecision } from './guards'
import { navEntriesFor } from './nav'
import { hasErrors, validateActivation, validateLogin } from './validation'

const SERVED: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}
// Desktop local mode: no session exists at all, so nothing may depend on one (spec 2.6).
const LOCAL: Capabilities = { ...SERVED, requiresAuth: false, canManageUsers: false }
const anon = { isAuthenticated: false, isAdmin: false }
const user = { isAuthenticated: true, isAdmin: false }
const admin = { isAuthenticated: true, isAdmin: true }

// Ported from guards.spec.ts.
describe('authDecision', () => {
  it('sends an anonymous visitor of a served app to the login page', () => {
    expect(authDecision(SERVED, anon)).toBe('/login')
  })
  it('lets a signed-in user through', () => {
    expect(authDecision(SERVED, user)).toBe(true)
  })
  it('lets everyone through when the shell does not require auth', () => {
    expect(authDecision(LOCAL, anon)).toBe(true)
  })
})

describe('adminDecision', () => {
  it('lets an admin into user administration', () => {
    expect(adminDecision(SERVED, admin)).toBe(true)
  })
  it('bounces a non-admin back to the projects list', () => {
    expect(adminDecision(SERVED, user)).toBe('/projects')
  })
  it('bounces even an admin when the shell cannot manage users', () => {
    expect(adminDecision({ ...SERVED, canManageUsers: false }, admin)).toBe('/projects')
  })
})

describe('capabilityDecision', () => {
  it('opens a desktop-only surface only where its capability is set', () => {
    expect(capabilityDecision(SERVED, 'canBrowseModelSites')).toBe('/projects')
    expect(
      capabilityDecision({ ...SERVED, canBrowseModelSites: true }, 'canBrowseModelSites'),
    ).toBe(true)
  })
})

// Ported from the App navigation specs (app.spec.ts), as the pure function they exercised.
describe('navEntriesFor', () => {
  const ids = (caps: Capabilities, session: typeof anon) =>
    navEntriesFor(caps, session).map((entry) => entry.id)

  it('offers nothing until there is a user, where the shell requires one', () => {
    expect(ids(SERVED, anon)).toEqual([])
  })
  it('offers the navigation immediately where the shell requires no authentication', () => {
    expect(ids(LOCAL, anon)).toEqual(['projects', 'settings'])
  })
  it('offers the model browser only where the shell can embed one', () => {
    expect(ids(SERVED, user)).not.toContain('browse')
    expect(ids({ ...SERVED, canBrowseModelSites: true }, user)).toContain('browse')
  })
  it('offers user administration only to an admin of a shell that has users', () => {
    expect(ids(SERVED, user)).not.toContain('users')
    expect(ids(SERVED, admin)).toContain('users')
    expect(ids({ ...SERVED, canManageUsers: false }, admin)).not.toContain('users')
  })
  it('offers sign-out only where there is a session to end', () => {
    expect(ids(LOCAL, user)).not.toContain('sign-out')
    expect(ids(SERVED, user).at(-1)).toBe('sign-out')
    expect(navEntriesFor(SERVED, user).find((entry) => entry.id === 'sign-out')?.route).toBeNull()
  })
})

// Ported from the contract's schema tests and the login/activate page specs: an invalid model
// never reaches the network, and the mismatch belongs to the confirm field.
describe('validation', () => {
  it('requires both login fields', () => {
    expect(validateLogin({ username: '', password: '' })).toHaveProperty('username')
    expect(validateLogin({ username: 'a', password: '' })).toHaveProperty('password')
    expect(hasErrors(validateLogin({ username: 'a', password: 'b' }))).toBe(false)
  })
  it('enforces the 10 character floor', () => {
    expect(validateActivation({ password: 'short', confirm: 'short' })).toHaveProperty('password')
    expect(
      hasErrors(validateActivation({ password: 'longenoughpw', confirm: 'longenoughpw' })),
    ).toBe(false)
  })
  it('attaches the password-mismatch error to the confirm field specifically', () => {
    const errors = validateActivation({ password: 'a good long password', confirm: 'other' })
    expect(errors).toHaveProperty('confirm')
    expect(errors).not.toHaveProperty('password')
  })
})
