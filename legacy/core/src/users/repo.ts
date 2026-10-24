import { AppError } from '@spm/contract/errors.ts'
import type { UserDto, UserStatus } from '@spm/contract/dtos.ts'
import type { Db } from '../db/open.ts'

export type UserRow = {
  id: string
  username: string
  display_name: string
  library_dir: string
  pw_hash: Uint8Array | null
  pw_salt: Uint8Array | null
  pw_iterations: number | null
  pw_algo: string | null
  is_admin: number
  status: UserStatus
  quota_bytes: number | null
  created_at: number
  activated_at: number | null
}

const SELECT_USER = 'SELECT * FROM users'

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE id = ?`).get(id) as UserRow | undefined
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE username = ? COLLATE NOCASE`).get(username) as
    UserRow | undefined
}

export function requireUserRow(db: Db, id: string): UserRow {
  const row = findUserById(db, id)
  if (!row) throw new AppError('NotFound', 'user not found')
  return row
}

export function toUserDto(row: UserRow, diskUsageBytes: number): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    status: row.status,
    diskUsageBytes,
    quotaBytes: row.quota_bytes,
    createdAt: row.created_at,
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
  }
}
