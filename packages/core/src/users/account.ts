import { DEFAULT_SETTINGS, type SettingsDto, type UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { requireUserRow, toUserDto } from './repo.ts'
import { diskUsageBytes } from './usage.ts'

export function me(lib: Library, ctx: Ctx): UserDto {
  return toUserDto(requireUserRow(lib.db, ctx.userId), diskUsageBytes(lib.db, ctx.userId))
}

export async function changePassword(
  lib: Library,
  ctx: Ctx,
  current: string,
  next: string,
): Promise<void> {
  const row = requireUserRow(lib.db, ctx.userId)
  if (!row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    throw new AppError('Forbidden', 'account has no password to change')
  }
  const ok = await verifyPassword(current, {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  })
  if (!ok) throw new AppError('Unauthorized', 'current password is not correct')

  const pw = await hashPassword(next)
  lib.db
    .prepare(
      'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
    )
    .run(pw.hash, pw.salt, pw.iterations, pw.algo, ctx.userId)
}

export function updateProfile(lib: Library, ctx: Ctx, patch: { displayName?: string }): UserDto {
  if (patch.displayName !== undefined) {
    lib.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(patch.displayName, ctx.userId)
  }
  return me(lib, ctx)
}

const SETTING_KEYS = ['theme', 'language', 'viewMode', 'sort', 'dir'] as const
type SettingKey = (typeof SETTING_KEYS)[number]

export function getSettings(lib: Library, ctx: Ctx): SettingsDto {
  const rows = lib.db
    .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .all(ctx.userId) as { key: string; value: string | null }[]

  const stored: Record<string, string> = {}
  for (const row of rows) if (row.value !== null) stored[row.key] = row.value
  // Unknown or stale keys fall back to the default rather than corrupting the DTO.
  const merged = { ...DEFAULT_SETTINGS }
  for (const key of SETTING_KEYS) {
    const value = stored[key]
    if (value !== undefined) (merged as Record<string, string>)[key] = value
  }
  return merged
}

export function putSettings(
  lib: Library,
  ctx: Ctx,
  patch: Partial<Record<SettingKey, string>>,
): SettingsDto {
  const upsert = lib.db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  )
  for (const key of SETTING_KEYS) {
    const value = patch[key]
    if (value !== undefined) upsert.run(ctx.userId, key, value)
  }
  return getSettings(lib, ctx)
}
