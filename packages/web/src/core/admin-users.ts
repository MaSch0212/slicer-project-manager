import { createSignal } from 'solid-js'
import type { CreateUserInput, UserDto, UserStatus } from '../api/generated'
import { api, type ApiClient, type UserPatch } from './api/client'
import { t, type TranslationKey } from './i18n'
import { errorMessage } from './i18n/errors'
import { formatBytes } from './format-bytes'

export const MIB = 1024 * 1024

const STATUS_KEY: Record<UserStatus, TranslationKey> = {
  pending: 'admin.statusPending',
  active: 'admin.statusActive',
  disabled: 'admin.statusDisabled',
}

export const statusLabelKey = (status: UserStatus): TranslationKey => STATUS_KEY[status]

export const statusVariant = (status: UserStatus): 'success' | 'warning' | 'neutral' =>
  status === 'active' ? 'success' : status === 'pending' ? 'warning' : 'neutral'

/** Share of the quota in use, 0 to 100, or `null` for an unlimited user. */
export function usagePercent(user: Pick<UserDto, 'diskUsageBytes' | 'quotaBytes'>): number | null {
  if (user.quotaBytes === null || user.quotaBytes <= 0) return null
  return Math.min(100, Math.round((user.diskUsageBytes / user.quotaBytes) * 100))
}

/** "1.2 MB of 5.0 MB", or just the usage for an unlimited user. */
export function usageLabel(user: Pick<UserDto, 'diskUsageBytes' | 'quotaBytes'>): string {
  const used = formatBytes(user.diskUsageBytes)
  return user.quotaBytes === null
    ? used
    : t('admin.usageOf', { used, quota: formatBytes(user.quotaBytes) })
}

/** The quota as the field shows it: whole MiB when it is one, empty for no limit. */
export function quotaFieldText(quotaBytes: number | null): string {
  if (quotaBytes === null) return ''
  return quotaBytes % MIB === 0 ? String(quotaBytes / MIB) : String(Math.ceil(quotaBytes / MIB))
}

export type AdminUsersDeps = {
  client: Pick<ApiClient, 'users'>
  /** Called with the words for a refused or failed action (the last admin, a network failure). */
  onError: (message: string) => void
}

/**
 * The users page as state: the list, whether it failed to load, and one method per admin action.
 * Every action reloads the list when it lands and returns whether it did; a refusal is reported
 * once through `onError` and leaves the list exactly as the server has it (a demotion the server
 * refused shows the administrator still ticked, because the reload says so).
 */
export function createAdminUsers(deps: Partial<AdminUsersDeps> & Pick<AdminUsersDeps, 'onError'>) {
  const client = deps.client ?? api
  const [users, setUsers] = createSignal<UserDto[] | undefined>(undefined)
  const [loadFailed, setLoadFailed] = createSignal(false)

  async function load(): Promise<void> {
    try {
      setUsers(await client.users.list())
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }

  /** Runs one mutation, reloads on success, reports on failure. */
  async function act<T>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await action()
      await load()
      return { ok: true, value }
    } catch (error) {
      deps.onError(errorMessage(error))
      // The list may be stale after a refusal that raced another admin; show the truth.
      await load()
      return { ok: false }
    }
  }

  /** Creates a user. Throws, so the dialog can say "that name is taken" next to the field. */
  async function create(input: CreateUserInput): Promise<string> {
    const created = await client.users.create(input)
    await load()
    return created.activationUrl
  }

  async function reissue(user: UserDto): Promise<string | null> {
    const result = await act(() => client.users.reissueInvite(user.id))
    return result.ok ? result.value.activationUrl : null
  }

  const patch = async (user: UserDto, change: UserPatch): Promise<boolean> =>
    (await act(() => client.users.update(user.id, change))).ok

  return {
    users,
    loadFailed,
    load,
    create,
    reissue,
    setDisabled: (user: UserDto, disabled: boolean) => patch(user, { isDisabled: disabled }),
    setAdmin: (user: UserDto, isAdmin: boolean) => patch(user, { isAdmin }),
    setQuota: (user: UserDto, bytes: number | null) => patch(user, { quotaBytes: bytes }),
    remove: async (user: UserDto): Promise<boolean> =>
      (await act(() => client.users.delete(user.id))).ok,
  }
}
