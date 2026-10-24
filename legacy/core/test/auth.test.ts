import {
  PW_ALGO,
  PW_ITERATIONS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/auth/password.ts'
import { randomToken, sha256Bytes, timingSafeEqual } from '../src/auth/tokens.ts'
import {
  checkActivationToken,
  consumeActivationToken,
  issueActivationToken,
} from '../src/auth/activation.ts'
import {
  createSession,
  deleteSession,
  pruneExpiredSessions,
  resolveSession,
} from '../src/auth/sessions.ts'
import { newId } from '../src/db/ids.ts'
import type { Db } from '../src/db/open.ts'
import { AppError } from '@spm/contract/errors.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

const FAST = 1000

function seedUser(db: Db, over: { admin?: boolean; status?: string } = {}): string {
  const id = newId()
  db.prepare(
    'INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)',
  ).run(
    id,
    `u-${id.slice(0, 8)}`,
    'User',
    `dir-${id.slice(0, 8)}`,
    over.admin ? 1 : 0,
    over.status ?? 'active',
  )
  return id
}

test('the production PBKDF2 parameters are the ones the spec fixes', () => {
  assert.equal(PW_ITERATIONS, 600_000)
  assert.equal(PW_ALGO, 'pbkdf2-sha256')
})

test('hashPassword verifies the right password and rejects the wrong one', async () => {
  const stored = await hashPassword('correct horse battery', FAST)
  assert.equal(stored.hash.byteLength, 32)
  assert.equal(stored.salt.byteLength, 16)
  assert.equal(await verifyPassword('correct horse battery', stored), true)
  assert.equal(await verifyPassword('correct horse batterz', stored), false)
})

test('two hashes of the same password differ by salt', async () => {
  const a = await hashPassword('same password', FAST)
  const b = await hashPassword('same password', FAST)
  assert.equal(timingSafeEqual(a.hash, b.hash), false)
})

test('needsRehash flags weaker stored parameters only', async () => {
  const weak = await hashPassword('pw', FAST)
  assert.equal(needsRehash(weak), true)
  assert.equal(needsRehash({ iterations: PW_ITERATIONS, algo: PW_ALGO }), false)
})

test('randomToken is url-safe and 256 bits wide', () => {
  const token = randomToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(token, randomToken())
})

test('sha256Bytes is stable and 32 bytes', async () => {
  const a = await sha256Bytes('abc')
  assert.equal(a.byteLength, 32)
  assert.equal(timingSafeEqual(a, await sha256Bytes('abc')), true)
})

test('a session resolves to its user and stores only the hash', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { admin: true })
    const { token } = await createSession(db, userId, 'test-agent')
    const ctx = await resolveSession(db, token)
    assert.deepEqual(ctx, { userId, isAdmin: true })

    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: Uint8Array }[]
    assert.equal(rows.length, 1)
    assert.equal(timingSafeEqual(rows[0]!.token_hash, await sha256Bytes(token)), true)
  })
})

test('an expired session does not resolve and is pruned', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token, expiresAt } = await createSession(db, userId, null)
    assert.equal(await resolveSession(db, token, expiresAt + 1), null)
    assert.equal(pruneExpiredSessions(db, expiresAt + 1), 1)
  })
})

test('a disabled user cannot resolve a live session', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token } = await createSession(db, userId, null)
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId)
    assert.equal(await resolveSession(db, token), null)
  })
})

test('deleteSession revokes immediately', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token } = await createSession(db, userId, null)
    await deleteSession(db, token)
    assert.equal(await resolveSession(db, token), null)
  })
})

test('an activation token checks out once, then is consumed', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId)
    const check = await checkActivationToken(db, token)
    assert.equal(check.valid, true)
    assert.equal(check.userId, userId)

    assert.equal(await consumeActivationToken(db, token), userId)
    assert.equal((await checkActivationToken(db, token)).valid, false)
    await assert.rejects(() => consumeActivationToken(db, token))
  })
})

// node:sqlite is synchronous and single-threaded, so a real concurrent race between two
// consumeActivationToken calls can't be forced deterministically here. This instead pins
// the observable contract the atomic UPDATE exists to guarantee: a second consume never
// succeeds, and the token table never ends up with more than one consumed row for it.
test('consuming an activation token twice never yields two consumptions', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId)

    assert.equal(await consumeActivationToken(db, token), userId)
    await assert.rejects(() => consumeActivationToken(db, token))
    await assert.rejects(() => consumeActivationToken(db, token))

    const rows = db
      .prepare('SELECT consumed_at FROM activation_tokens WHERE user_id = ?')
      .all(userId) as { consumed_at: number | null }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.consumed_at !== null, true)
  })
})

// consumeActivationToken has real await points (findToken awaits sha256Bytes, which calls
// crypto.subtle.digest), so starting both calls before awaiting either genuinely interleaves
// them at the JS microtask level — this is the actual regression test for the TOCTOU: it
// fails against the pre-fix code, where both calls could pass the `consumedAt === null`
// read before either wrote.
test('two concurrent consumptions of the same token: exactly one wins', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId)

    const results = await Promise.allSettled([
      consumeActivationToken(db, token),
      consumeActivationToken(db, token),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(fulfilled[0]!.value, userId)
    assert.ok(rejected[0]!.reason instanceof AppError)
    assert.equal((rejected[0]!.reason as AppError).code, 'InvalidToken')

    const rows = db
      .prepare('SELECT consumed_at FROM activation_tokens WHERE user_id = ?')
      .all(userId) as { consumed_at: number | null }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.consumed_at !== null, true)
  })
})

test('an expired activation token is invalid', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId, 0)
    const eightDays = 8 * 24 * 60 * 60 * 1000
    assert.equal((await checkActivationToken(db, token, eightDays)).valid, false)
  })
})

test('an already-consumed token reports InvalidToken even after it also expires', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId, 0)
    await consumeActivationToken(db, token, 0)

    const eightDays = 8 * 24 * 60 * 60 * 1000
    let caught: unknown
    try {
      await consumeActivationToken(db, token, eightDays)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof AppError)
    assert.equal((caught as AppError).code, 'InvalidToken')
  })
})

test('an unknown token is invalid rather than an error', async () => {
  await withLibrary(async ({ db }) => {
    assert.equal((await checkActivationToken(db, randomToken())).valid, false)
  })
})
