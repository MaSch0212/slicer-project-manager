import { AppError } from '@spm/contract/errors.ts'
import type { Db } from '../db/open.ts'
import { newId } from '../db/ids.ts'
import { randomToken, sha256Bytes } from './tokens.ts'

export const ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Returns the raw token exactly once; only its hash is stored (spec 5.3). */
export async function issueActivationToken(
  db: Db,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const token = randomToken()
  db.prepare(
    'INSERT INTO activation_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), userId, await sha256Bytes(token), now + ACTIVATION_TTL_MS, now)
  return token
}

type TokenRow = { userId: string; username: string; expiresAt: number; consumedAt: number | null }

async function findToken(db: Db, token: string): Promise<TokenRow | undefined> {
  return db
    .prepare(
      `SELECT t.user_id AS userId, u.username AS username,
              t.expires_at AS expiresAt, t.consumed_at AS consumedAt
       FROM activation_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .get(await sha256Bytes(token)) as TokenRow | undefined
}

/** Read-only check, so an expired link errors before the user types a password (spec 5.3). */
export async function checkActivationToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<{ valid: boolean; username?: string; userId?: string }> {
  const row = await findToken(db, token)
  if (!row || row.consumedAt !== null || row.expiresAt <= now) return { valid: false }
  return { valid: true, username: row.username, userId: row.userId }
}

export async function consumeActivationToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<string> {
  const row = await findToken(db, token)
  if (!row) throw new AppError('InvalidToken', 'activation token is not usable')
  if (row.expiresAt <= now) throw new AppError('TokenExpired', 'activation token has expired')

  // `consumed_at IS NULL` in the WHERE clause is the single source of truth for who owns
  // this consumption: two concurrent calls can both pass the checks above, but only one
  // UPDATE can match an unconsumed row, so `changes` — not the earlier read — decides.
  const result = db
    .prepare(
      'UPDATE activation_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
    )
    .run(now, await sha256Bytes(token))
  if (Number(result.changes) === 0) {
    throw new AppError('InvalidToken', 'activation token is not usable')
  }
  return row.userId
}
