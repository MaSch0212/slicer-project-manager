import { mkdirSync } from 'node:fs'
import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { CreateUserInput, UpdateUserInput } from '@spm/contract/schemas.ts'
import { issueActivationToken } from '../auth/activation.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Db, Library } from '../db/open.ts'
import { userRoot } from '../files/paths.ts'
import { findUserByUsername, requireUserRow, toUserDto, type UserRow } from './repo.ts'
import { diskUsageByUser, diskUsageBytes } from './usage.ts'

/** Admin authorisation lives in core, not in a transport (spec 2.2, 5.5). */
export function requireAdmin(ctx: Ctx): void {
  if (!ctx.isAdmin) throw new AppError('Forbidden', 'administrator rights are required')
}

function countOtherActiveAdmins(db: Db, excludeId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active' AND id <> ?")
    .get(excludeId) as { n: number }
  return Number(row.n)
}

/** Refuses the operation that would leave the installation with no way to manage users. */
function assertNotLastActiveAdmin(db: Db, row: UserRow): void {
  const isActiveAdmin = row.is_admin === 1 && row.status === 'active'
  if (isActiveAdmin && countOtherActiveAdmins(db, row.id) === 0) {
    throw new AppError('LastActiveAdmin', 'the last active administrator must remain')
  }
}

export function listUsers(lib: Library, ctx: Ctx): UserDto[] {
  requireAdmin(ctx)
  const usage = diskUsageByUser(lib.db)
  const rows = lib.db
    .prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE')
    .all() as UserRow[]
  return rows.map((row) => toUserDto(row, usage.get(row.id) ?? 0))
}

export async function createUser(
  lib: Library,
  ctx: Ctx,
  input: CreateUserInput,
): Promise<{ user: UserDto; token: string }> {
  requireAdmin(ctx)
  if (findUserByUsername(lib.db, input.username)) {
    throw new AppError('Conflict', `username "${input.username}" is already taken`)
  }

  const id = newId()
  const now = Date.now()
  // library_dir is stored, not derived, so a later username change is an explicit rename (3.3).
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, quota_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      input.username,
      input.displayName,
      input.username,
      input.isAdmin ? 1 : 0,
      input.quotaBytes,
      now,
    )
  mkdirSync(userRoot(lib, input.username), { recursive: true })

  const token = await issueActivationToken(lib.db, id, now)
  return { user: toUserDto(requireUserRow(lib.db, id), 0), token }
}

export async function reissueInvite(
  lib: Library,
  ctx: Ctx,
  id: string,
): Promise<{ token: string }> {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)
  if (row.status === 'active') throw new AppError('Conflict', 'account is already active')
  // Disabled means revoked: a fresh invite would let activation resurrect it. Re-enable
  // first, then re-invite.
  if (row.status === 'disabled') {
    throw new AppError('Conflict', 're-enable the account before issuing a new invite')
  }
  return { token: await issueActivationToken(lib.db, row.id) }
}

export function updateUser(lib: Library, ctx: Ctx, id: string, patch: UpdateUserInput): UserDto {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)

  if (patch.isAdmin === false || patch.isDisabled === true) assertNotLastActiveAdmin(lib.db, row)

  if (patch.isAdmin !== undefined) {
    lib.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(patch.isAdmin ? 1 : 0, id)
  }
  if (patch.isDisabled !== undefined) {
    // Re-enabling must not activate an account that never set a password.
    const status = patch.isDisabled ? 'disabled' : row.pw_hash ? 'active' : 'pending'
    lib.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id)
  }
  if (patch.quotaBytes !== undefined) {
    // Lowering below current usage is allowed: it blocks uploads, it does not delete (5.6).
    lib.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(patch.quotaBytes, id)
  }

  return toUserDto(requireUserRow(lib.db, id), diskUsageBytes(lib.db, id))
}

export function deleteUser(lib: Library, ctx: Ctx, id: string): void {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)
  assertNotLastActiveAdmin(lib.db, row)
  // Cascades projects, files, previews, tags and sessions. The folder on disk is left alone.
  lib.db.prepare('DELETE FROM users WHERE id = ?').run(id)
}
