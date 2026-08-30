import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@spm/contract/dtos.ts'
import type { AppError } from '@spm/contract/errors.ts'
import { z } from 'zod'
import { activateAccount, login } from '../src/auth/login.ts'
import { PW_ALGO, PW_ITERATIONS, hashPassword } from '../src/auth/password.ts'
import { timingSafeEqual } from '../src/auth/tokens.ts'
import {
  changePassword,
  getSettings,
  jsonCodec,
  me,
  putSettings,
  updateProfile,
} from '../src/users/account.ts'
import { ensureBootstrapAdmin, ensureLocalUser } from '../src/users/bootstrap.ts'
import { safeJoin, userRoot } from '../src/files/paths.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

test('safeJoin refuses to escape its base', async () => {
  // resolve(), not join(): the comparison must hold on Windows too.
  const base = resolve('/lib/marc')
  assert.equal(safeJoin(base, 'Benchy', 'a.stl'), resolve(base, 'Benchy', 'a.stl'))
  assert.throws(
    () => safeJoin(base, '..', 'anna'),
    (e: unknown) => (e as AppError).code === 'Forbidden',
  )
})

test('userRoot flattens the library when library_dir is "."', async () => {
  await withLibrary((lib) => {
    assert.equal(userRoot(lib, '.'), lib.dir)
    assert.equal(userRoot(lib, 'marc'), join(lib.dir, 'marc'))
  })
})

test('bootstrap creates a pending admin with no password and returns the token once', async () => {
  await withLibrary(async (lib) => {
    const first = await ensureBootstrapAdmin(lib)
    assert.ok(first)
    assert.equal(first.username, 'admin')
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)

    const row = lib.db.prepare('SELECT * FROM users').get() as Record<string, unknown>
    assert.equal(row.status, 'pending')
    assert.equal(row.is_admin, 1)
    assert.equal(row.pw_hash, null)
    assert.ok(existsSync(join(lib.dir, 'admin')))

    assert.equal(await ensureBootstrapAdmin(lib), null)
  })
})

test('a pending account cannot log in', async () => {
  await withLibrary(async (lib) => {
    await ensureBootstrapAdmin(lib)
    await assert.rejects(
      () => login(lib, 'admin', 'anything at all', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
  })
})

test('activation sets the password, activates, and logs the user straight in', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const result = await activateAccount(lib, boot!.token, 'a good long password', 'agent')
    assert.equal(result.user.status, 'active')
    assert.ok(result.user.activatedAt)
    assert.ok(result.token)

    const after = await login(lib, 'admin', 'a good long password', null)
    assert.equal(after.user.username, 'admin')
    assert.equal(after.user.isAdmin, true)
    assert.equal(after.user.diskUsageBytes, 0)
    assert.equal(after.user.quotaBytes, null)
  })
})

test('activation cannot be replayed', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)
    await assert.rejects(
      () => activateAccount(lib, boot!.token, 'another password', null),
      (e: unknown) => (e as AppError).code === 'InvalidToken',
    )
  })
})

test('login rejects a wrong password and a disabled account identically', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)

    await assert.rejects(
      () => login(lib, 'admin', 'wrong password', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
    lib.db.prepare("UPDATE users SET status = 'disabled'").run()
    await assert.rejects(
      () => login(lib, 'admin', 'a good long password', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
  })
})

test('login upgrades a hash stored with weaker parameters', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)

    const weak = await hashPassword('a good long password', 1000)
    lib.db
      .prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?')
      .run(weak.hash, weak.salt, weak.iterations, weak.algo)

    await login(lib, 'admin', 'a good long password', null)
    const row = lib.db
      .prepare('SELECT pw_hash, pw_salt, pw_iterations, pw_algo FROM users')
      .get() as { pw_hash: Uint8Array; pw_salt: Uint8Array; pw_iterations: number; pw_algo: string }

    // The write-back must land all four columns together: a partial write (e.g. a
    // refactor that drops the salt or algo assignment) would leave a password that can
    // never verify again, silently and permanently.
    assert.equal(row.pw_iterations, PW_ITERATIONS)
    assert.equal(row.pw_algo, PW_ALGO)
    assert.equal(timingSafeEqual(row.pw_hash, weak.hash), false)
    assert.equal(timingSafeEqual(row.pw_salt, weak.salt), false)

    // End-to-end proof the upgraded row is actually authenticatable, not just rewritten.
    assert.ok(await login(lib, 'admin', 'a good long password', null))
  })
})

test('changePassword requires the current one and invalidates nothing else', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    await assert.rejects(
      () => changePassword(lib, ctx, 'not it', 'a new long password'),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
    await changePassword(lib, ctx, 'a good long password', 'a new long password')
    assert.ok(await login(lib, 'admin', 'a new long password', null))
  })
})

test('updateProfile changes the display name only', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }
    assert.equal(updateProfile(lib, ctx, { displayName: 'Marc S' }).displayName, 'Marc S')
    assert.equal(me(lib, ctx).username, 'admin')
  })
})

test('settings return defaults, then merge a patch', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    // DEFAULT_SETTINGS, not a literal copy: a literal here would silently stop covering
    // whichever key the object gains next (R4 in task-1's brief is this exact trap).
    assert.deepEqual(getSettings(lib, ctx), DEFAULT_SETTINGS)
    assert.equal(putSettings(lib, ctx, { language: 'de' }).language, 'de')
    assert.equal(putSettings(lib, ctx, { theme: 'dark' }).language, 'de')
    assert.equal(getSettings(lib, ctx).theme, 'dark')
  })
})

// Spec 3.2: the codec table's enum tightening is a deliberate behaviour change, not
// incidental. Before it, getSettings copied a user_settings row into the DTO with no check,
// so a row written by a build that once offered a "purple" theme (or edited by hand) shipped
// straight to the renderer. Mutating enumCodec's `values.includes` guard to always accept the
// raw value turns this test red, which is the point: it is what stands between the codec table
// being a contract and being a lookup (spec 3.2's own words).
test('a stored theme value the enum no longer accepts falls back to the default, not through', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    lib.db
      .prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(user.id, 'theme', 'purple')

    const settings = getSettings(lib, ctx)
    assert.equal(settings.theme, DEFAULT_SETTINGS.theme)
    assert.notEqual(settings.theme, 'purple')
  })
})

test('navCollapsed round-trips true and false through putSettings/getSettings', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    assert.equal(getSettings(lib, ctx).navCollapsed, false)
    assert.equal(putSettings(lib, ctx, { navCollapsed: true }).navCollapsed, true)
    assert.equal(getSettings(lib, ctx).navCollapsed, true)
    assert.equal(putSettings(lib, ctx, { navCollapsed: false }).navCollapsed, false)
    assert.equal(getSettings(lib, ctx).navCollapsed, false)
  })
})

test('a navCollapsed row holding garbage falls back to the default', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    lib.db
      .prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run(user.id, 'navCollapsed', 'yes')

    assert.equal(getSettings(lib, ctx).navCollapsed, false)
  })
})

// jsonCodec has no production caller in this subsystem (segments H and I wire it up), so this
// exercises the codec directly rather than through getSettings/putSettings.
test('jsonCodec decodes a valid payload, and returns undefined for malformed JSON or a schema failure', () => {
  const codec = jsonCodec(z.object({ tags: z.array(z.string()) }))

  const encoded = codec.encode({ tags: ['petg', 'functional'] })
  assert.deepEqual(codec.decode(encoded), { tags: ['petg', 'functional'] })

  assert.equal(codec.decode('{not valid json'), undefined)
  assert.equal(codec.decode('{"tags": [1, 2]}'), undefined)
})

test('ensureLocalUser makes one flat-library user and is idempotent', async () => {
  await withLibrary((lib) => {
    const ctx = ensureLocalUser(lib)
    assert.equal(ctx.isAdmin, false)
    assert.deepEqual(ensureLocalUser(lib), ctx)
    const { library_dir, n } = lib.db
      .prepare('SELECT library_dir, (SELECT COUNT(*) FROM users) AS n FROM users')
      .get() as { library_dir: string; n: number }
    assert.equal(library_dir, '.')
    assert.equal(n, 1)
  })
})
