import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Library } from '../db/open.ts'
import { diskUsageBytes } from '../users/usage.ts'
import { findUserByUsername, requireUserRow, toUserDto } from '../users/repo.ts'
import { checkActivationToken, consumeActivationToken } from './activation.ts'
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
  // Known timing channel, deliberately not closed here: this branch returns in about a
  // millisecond, while a wrong password on an active account costs a real PBKDF2 derive
  // (150-400ms), so the two are distinguishable by wall-clock time even though the thrown
  // error is identical in code and message. The fix considered and rejected for this call
  // site is a dummy verifyPassword on every failure path to equalise timing — on a
  // self-hosted single-process server with admin-created accounts, no self-registration
  // and no rate limiting yet, that trade makes every bogus request cost 600,000 PBKDF2
  // iterations, which is a cheaper DoS than the enumeration it prevents. The mitigation
  // that fixes both at once — rate limiting — belongs in the transport and is a
  // requirement carried into the task that builds the server's route table.
  if (!row || row.status !== 'active' || !row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    // The reason is logged even though the *response* deliberately does not distinguish
    // them: the operator reading their own server log is not the attacker being denied
    // enumeration. Never the password, and never any part of it.
    lib.log.warn('login rejected', { username, reason: row ? row.status : 'no such user' })
    throw new AppError('Unauthorized', UNAUTHORIZED)
  }

  const stored = {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  }
  if (!(await verifyPassword(password, stored))) {
    lib.log.warn('login rejected', { username, reason: 'bad password' })
    throw new AppError('Unauthorized', UNAUTHORIZED)
  }

  if (needsRehash(stored)) {
    lib.log.info('rehashing password to current parameters', { userId: row.id })
    const upgraded = await hashPassword(password)
    lib.db
      .prepare(
        'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
      )
      .run(upgraded.hash, upgraded.salt, upgraded.iterations, upgraded.algo, row.id)
  }

  const session = await createSession(lib.db, row.id, userAgent, now)
  lib.log.info('login', { userId: row.id, username: row.username })
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
  // Checked before consuming: a disabled account's link must not be silently burned by a
  // rejected attempt, and disabled is the one status activation must never resurrect from
  // (resolveSession already refuses non-active users, so this is the last door). The check
  // is read-only, so an unconsumed-but-expired token still falls through to
  // consumeActivationToken below and reports TokenExpired as before.
  const check = await checkActivationToken(lib.db, token, now)
  if (check.valid && check.userId && requireUserRow(lib.db, check.userId).status === 'disabled') {
    throw new AppError('InvalidToken', 'activation token is not usable')
  }

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
  lib.log.info('account activated', { userId })
  return {
    user: toUserDto(requireUserRow(lib.db, userId), diskUsageBytes(lib.db, userId)),
    ...session,
  }
}
