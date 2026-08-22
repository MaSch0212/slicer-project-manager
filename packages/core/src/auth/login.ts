import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Library } from '../db/open.ts'
import { diskUsageBytes } from '../users/usage.ts'
import { findUserByUsername, requireUserRow, toUserDto } from '../users/repo.ts'
import { consumeActivationToken } from './activation.ts'
import { hashPassword, needsRehash, verifyPassword } from './password.ts'
import { createSession } from './sessions.ts'

export type LoginResult = { user: UserDto; token: string; expiresAt: number }

const UNAUTHORIZED = 'username or password is not correct'

export async function login(
  lib: Library,
  username: string,
  password: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<LoginResult> {
  const row = findUserByUsername(lib.db, username)
  // One message for every failure mode: unknown user, pending, disabled, wrong password.
  if (!row || row.status !== 'active' || !row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    throw new AppError('Unauthorized', UNAUTHORIZED)
  }

  const stored = {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  }
  if (!(await verifyPassword(password, stored))) throw new AppError('Unauthorized', UNAUTHORIZED)

  if (needsRehash(stored)) {
    const upgraded = await hashPassword(password)
    lib.db
      .prepare(
        'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
      )
      .run(upgraded.hash, upgraded.salt, upgraded.iterations, upgraded.algo, row.id)
  }

  const session = await createSession(lib.db, row.id, userAgent, now)
  return {
    user: toUserDto(requireUserRow(lib.db, row.id), diskUsageBytes(lib.db, row.id)),
    ...session,
  }
}

/** Consumes the token, sets the first password, and issues a session in one step (spec 5.3). */
export async function activateAccount(
  lib: Library,
  token: string,
  newPassword: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<LoginResult> {
  const userId = await consumeActivationToken(lib.db, token, now)
  const pw = await hashPassword(newPassword)
  lib.db
    .prepare(
      `UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?,
                        status = 'active', activated_at = ?
       WHERE id = ?`,
    )
    .run(pw.hash, pw.salt, pw.iterations, pw.algo, now, userId)

  const session = await createSession(lib.db, userId, userAgent, now)
  return {
    user: toUserDto(requireUserRow(lib.db, userId), diskUsageBytes(lib.db, userId)),
    ...session,
  }
}
