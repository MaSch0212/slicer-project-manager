import { describe, expect, it, vi } from 'vitest'
import type { UserDto } from '../api/generated'
import { ApiError } from './api/error'
import {
  createAdminUsers,
  quotaFieldText,
  statusLabelKey,
  statusVariant,
  usageLabel,
  usagePercent,
} from './admin-users'
import { hasErrors, parseQuotaMib, validateNewUser } from './validation'

const MIB = 1024 * 1024

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u1',
    username: 'marc',
    displayName: 'Marc',
    isAdmin: true,
    status: 'active',
    diskUsageBytes: 0,
    quotaBytes: null,
    createdAt: 0,
    ...over,
  }
}

function setup(list = vi.fn().mockResolvedValue([user()])) {
  const client = {
    users: {
      list,
      create: vi.fn().mockResolvedValue({
        user: user({ id: 'u2', username: 'anna', status: 'pending' }),
        activationUrl: 'http://x/activate#tok',
      }),
      reissueInvite: vi.fn().mockResolvedValue({ activationUrl: 'http://x/activate#tok2' }),
      update: vi.fn().mockResolvedValue(user()),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }
  const onError = vi.fn()
  return { client, onError, store: createAdminUsers({ client, onError }) }
}

// Ported from users.page.spec.ts: the page's behaviour, as the store the page is built on.
describe('createAdminUsers', () => {
  it('lists users on load', async () => {
    const { store, client } = setup()
    await store.load()
    expect(client.users.list).toHaveBeenCalled()
    expect(store.users()).toHaveLength(1)
    expect(store.loadFailed()).toBe(false)
  })

  it('reports a failed load instead of showing a blank table', async () => {
    const { store } = setup(vi.fn().mockRejectedValue(new Error('boom')))
    await store.load()
    expect(store.loadFailed()).toBe(true)
    expect(store.users()).toBeUndefined()
  })

  it('hands back the activation link of a new user, and reloads the list', async () => {
    const { store, client } = setup()
    await store.load()
    const url = await store.create({
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    expect(url).toBe('http://x/activate#tok')
    expect(client.users.list).toHaveBeenCalledTimes(2)
  })

  it('lets a refused create reach the dialog, so it can say "taken" by the field', async () => {
    const { store, client, onError } = setup()
    client.users.create.mockRejectedValue(new ApiError('Conflict', 'taken'))
    await expect(
      store.create({ username: 'anna', displayName: 'Anna', isAdmin: false, quotaBytes: null }),
    ).rejects.toMatchObject({ code: 'Conflict' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('re-issuing an invite returns the new link', async () => {
    const { store } = setup()
    expect(await store.reissue(user({ id: 'u2', status: 'pending' }))).toBe(
      'http://x/activate#tok2',
    )
  })

  it('sends the quota in bytes, and null to clear it', async () => {
    const { store, client } = setup()
    await store.setQuota(user(), 500 * MIB)
    expect(client.users.update).toHaveBeenCalledWith('u1', { quotaBytes: 500 * MIB })
    await store.setQuota(user(), null)
    expect(client.users.update).toHaveBeenLastCalledWith('u1', { quotaBytes: null })
  })

  it('toggles disabled and administrator through one patch each', async () => {
    const { store, client } = setup()
    await store.setDisabled(user(), true)
    expect(client.users.update).toHaveBeenLastCalledWith('u1', { isDisabled: true })
    await store.setAdmin(user(), false)
    expect(client.users.update).toHaveBeenLastCalledWith('u1', { isAdmin: false })
  })

  it('explains a last-active-admin refusal, in words, and reloads so the list says what is true', async () => {
    const { store, client, onError } = setup()
    await store.load()
    client.users.delete.mockRejectedValueOnce(new ApiError('LastActiveAdmin', 'nope'))
    expect(await store.remove(user())).toBe(false)
    expect(onError).toHaveBeenCalledWith('The last active administrator must remain')
    expect(client.users.list).toHaveBeenCalledTimes(2)
  })

  it('refuses a demotion the server refused, and reports it once', async () => {
    const { store, client, onError } = setup()
    client.users.update.mockRejectedValueOnce(new ApiError('LastActiveAdmin', 'nope'))
    expect(await store.setAdmin(user(), false)).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('deletes a user and reloads', async () => {
    const { store, client } = setup()
    expect(await store.remove(user({ id: 'u9' }))).toBe(true)
    expect(client.users.delete).toHaveBeenCalledWith('u9')
  })
})

describe('presentation helpers', () => {
  // Ported: usage percent only when a quota exists.
  it('computes usage percent only when a quota exists', () => {
    expect(usagePercent(user({ diskUsageBytes: 50, quotaBytes: 200 }))).toBe(25)
    expect(usagePercent(user({ quotaBytes: null }))).toBeNull()
    expect(usagePercent(user({ quotaBytes: 0 }))).toBeNull()
    expect(usagePercent(user({ diskUsageBytes: 500, quotaBytes: 200 }))).toBe(100)
  })

  // Ported: quota and usage render in human units, never as a raw byte count.
  it('renders usage in human units', () => {
    expect(usageLabel(user({ diskUsageBytes: 5 * MIB, quotaBytes: 200 }))).toBe('5.0 MB of 200 B')
    expect(usageLabel(user({ diskUsageBytes: 5 * MIB }))).toBe('5.0 MB')
  })

  it('shows the quota as whole MiB in the field, and empty for no limit', () => {
    expect(quotaFieldText(null)).toBe('')
    expect(quotaFieldText(500 * MIB)).toBe('500')
    expect(quotaFieldText(500 * MIB + 1)).toBe('501')
  })

  it('maps status to a word and a colour', () => {
    expect(statusLabelKey('pending')).toBe('admin.statusPending')
    expect(statusVariant('active')).toBe('success')
    expect(statusVariant('pending')).toBe('warning')
    expect(statusVariant('disabled')).toBe('neutral')
  })
})

describe('parseQuotaMib', () => {
  // Ported: a megabyte entry converts to bytes; emptied means unlimited.
  it('converts whole MiB to bytes and reads empty as no limit', () => {
    expect(parseQuotaMib('500')).toBe(500 * MIB)
    expect(parseQuotaMib('  ')).toBeNull()
    expect(parseQuotaMib('')).toBeNull()
  })

  // Ported: zero, negative and fractional entries are refused, never reinterpreted (a typed 0
  // used to mean "unlimited", the opposite of what was asked).
  it('refuses zero, negative, fractional and non-numeric entries', () => {
    for (const bad of ['0', '-5', '0.3', '1.5', 'abc', '1e3', '9'.repeat(30)]) {
      expect(parseQuotaMib(bad), bad).toBe('invalid')
    }
  })
})

describe('validateNewUser', () => {
  const ok = { username: 'anna.b', displayName: 'Anna', quotaMib: '' }

  // Ported: an empty or too-short username never reaches the network.
  it('accepts a good user and refuses the bad ones field by field', () => {
    expect(hasErrors(validateNewUser(ok))).toBe(false)
    expect(validateNewUser({ ...ok, username: '' })).toHaveProperty('username')
    expect(validateNewUser({ ...ok, username: 'a' })).toHaveProperty('username')
    expect(validateNewUser({ ...ok, username: 'has space' })).toHaveProperty('username')
    expect(validateNewUser({ ...ok, username: '-leading' })).toHaveProperty('username')
    expect(validateNewUser({ ...ok, displayName: '  ' })).toHaveProperty('displayName')
    expect(validateNewUser({ ...ok, quotaMib: '0' })).toHaveProperty('quota')
  })
})
