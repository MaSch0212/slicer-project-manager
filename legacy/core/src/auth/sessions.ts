import type { Ctx } from '../ctx.ts'
import type { Db } from '../db/open.ts'
import { randomToken, sha256Bytes } from './tokens.ts'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Only push the expiry forward once a day, so a busy client is not a write per request. */
export const SESSION_SLIDE_MS = 24 * 60 * 60 * 1000

export async function createSession(
  db: Db,
  userId: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken()
  const expiresAt = now + SESSION_TTL_MS
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(await sha256Bytes(token), userId, now, now, expiresAt, userAgent)
  return { token, expiresAt }
}

export async function resolveSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<Ctx | null> {
  const hash = await sha256Bytes(token)
  const row = db
    .prepare(
      `SELECT s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt,
              u.id AS userId, u.is_admin AS isAdmin, u.status AS status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | { expiresAt: number; lastSeenAt: number; userId: string; isAdmin: number; status: string }
    | undefined

  if (!row) return null
  if (row.expiresAt <= now) return null
  if (row.status !== 'active') return null

  // Write only when the expiry actually slides: with no WAL (default SQLite settings), a
  // write takes a write lock that serialises concurrent readers, so a write on every
  // authenticated request is exactly the per-request cost SESSION_SLIDE_MS exists to avoid.
  // Consequence: `last_seen_at` now means "when this session was last extended", not
  // literally every request — a later subsystem wanting true last-seen needs its own
  // decision about that write cost.
  if (now - row.lastSeenAt > SESSION_SLIDE_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
      now,
      now + SESSION_TTL_MS,
      hash,
    )
  }

  return { userId: row.userId, isAdmin: row.isAdmin === 1 }
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(await sha256Bytes(token))
}

export function pruneExpiredSessions(db: Db, now: number = Date.now()): number {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes)
}
