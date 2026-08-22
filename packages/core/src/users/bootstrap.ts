import { mkdirSync } from 'node:fs'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { newId } from '../db/ids.ts'
import { issueActivationToken } from '../auth/activation.ts'
import { userRoot } from '../files/paths.ts'

const BOOTSTRAP_USERNAME = 'admin'

/**
 * First run against an empty users table: create a pending admin and hand back its raw
 * activation token for the caller to log (spec 5.4). No password exists at any point.
 * Returns null when the table already has rows.
 */
export async function ensureBootstrapAdmin(
  lib: Library,
  now: number = Date.now(),
): Promise<{ username: string; token: string } | null> {
  const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (n > 0) return null

  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'pending', ?)`,
    )
    .run(id, BOOTSTRAP_USERNAME, 'Administrator', BOOTSTRAP_USERNAME, now)
  mkdirSync(userRoot(lib, BOOTSTRAP_USERNAME), { recursive: true })

  return { username: BOOTSTRAP_USERNAME, token: await issueActivationToken(lib.db, id, now) }
}

/**
 * Electron local mode (spec 2.6): exactly one user, flat library, no password, no session.
 * Ctx still needs a userId, so the row exists; canManageUsers stays false.
 */
export function ensureLocalUser(lib: Library, now: number = Date.now()): Ctx {
  const existing = lib.db.prepare('SELECT id FROM users LIMIT 1').get() as
    { id: string } | undefined
  if (existing) return { userId: existing.id, isAdmin: false }

  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at, activated_at)
       VALUES (?, 'local', 'Local', '.', 0, 'active', ?, ?)`,
    )
    .run(id, now, now)
  return { userId: id, isAdmin: false }
}
