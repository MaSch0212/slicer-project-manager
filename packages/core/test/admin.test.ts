import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppError } from '@spm/contract/errors.ts'
import { activateAccount } from '../src/auth/login.ts'
import { ensureBootstrapAdmin } from '../src/users/bootstrap.ts'
import { createUser, deleteUser, listUsers, reissueInvite, updateUser } from '../src/users/admin.ts'
import type { Ctx } from '../src/ctx.ts'
import type { Library } from '../src/db/open.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

async function activeAdmin(lib: Library): Promise<Ctx> {
  const boot = await ensureBootstrapAdmin(lib)
  const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
  return { userId: user.id, isAdmin: true }
}

const NOT_ADMIN: Ctx = { userId: 'someone', isAdmin: false }

test('every users.* operation is refused to a non-admin', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const forbidden = (e: unknown) => (e as AppError).code === 'Forbidden'

    assert.throws(() => listUsers(lib, NOT_ADMIN), forbidden)
    await assert.rejects(
      () =>
        createUser(lib, NOT_ADMIN, {
          username: 'anna',
          displayName: 'Anna',
          isAdmin: false,
          quotaBytes: null,
        }),
      forbidden,
    )
    assert.throws(() => updateUser(lib, NOT_ADMIN, admin.userId, { isAdmin: false }), forbidden)
    assert.throws(() => deleteUser(lib, NOT_ADMIN, admin.userId), forbidden)
    await assert.rejects(() => reissueInvite(lib, NOT_ADMIN, admin.userId), forbidden)
  })
})

test('createUser makes a pending user, their folder, and one activation token', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user, token } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: 5_000_000,
    })

    assert.equal(user.status, 'pending')
    assert.equal(user.quotaBytes, 5_000_000)
    assert.equal(user.diskUsageBytes, 0)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(existsSync(join(lib.dir, 'anna')))
    assert.equal(listUsers(lib, admin).length, 2)
  })
})

test('a duplicate username is a conflict, case-insensitively', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    await assert.rejects(
      () =>
        createUser(lib, admin, {
          username: 'ANNA',
          displayName: 'Anna II',
          isAdmin: false,
          quotaBytes: null,
        }),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('reissueInvite hands out a fresh token and invalidates nothing else', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const created = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    const again = await reissueInvite(lib, admin, created.user.id)
    assert.notEqual(again.token, created.token)

    const { n } = lib.db
      .prepare('SELECT COUNT(*) AS n FROM activation_tokens WHERE user_id = ?')
      .get(created.user.id) as { n: number }
    assert.equal(n, 2)
  })
})

test('the last active admin cannot be deleted, disabled or demoted', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const lastAdmin = (e: unknown) => (e as AppError).code === 'LastActiveAdmin'

    assert.throws(() => deleteUser(lib, admin, admin.userId), lastAdmin)
    assert.throws(() => updateUser(lib, admin, admin.userId, { isDisabled: true }), lastAdmin)
    assert.throws(() => updateUser(lib, admin, admin.userId, { isAdmin: false }), lastAdmin)
  })
})

test('once a second admin is active, the first can be removed', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const second = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: true,
      quotaBytes: null,
    })

    // Still pending, so not yet an *active* admin.
    assert.throws(
      () => deleteUser(lib, admin, admin.userId),
      (e: unknown) => (e as AppError).code === 'LastActiveAdmin',
    )

    await activateAccount(lib, second.token, 'another long password', null)
    deleteUser(lib, admin, admin.userId)
    assert.deepEqual(
      listUsers(lib, { userId: second.user.id, isAdmin: true }).map((u) => u.username),
      ['anna'],
    )
  })
})

test('updateUser toggles admin, disabled and quota, and re-enabling respects pending', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })

    assert.equal(updateUser(lib, admin, user.id, { quotaBytes: 100 }).quotaBytes, 100)
    assert.equal(updateUser(lib, admin, user.id, { quotaBytes: null }).quotaBytes, null)
    assert.equal(updateUser(lib, admin, user.id, { isAdmin: true }).isAdmin, true)
    assert.equal(updateUser(lib, admin, user.id, { isDisabled: true }).status, 'disabled')
    // Never activates an account that has no password yet.
    assert.equal(updateUser(lib, admin, user.id, { isDisabled: false }).status, 'pending')
  })
})

test('deleting a user cascades their metadata but leaves their folder', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run('p1', user.id, 'Bin', 'Bin')

    deleteUser(lib, admin, user.id)

    const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    assert.equal(n, 0)
    assert.ok(existsSync(join(lib.dir, 'anna')))
  })
})

test('listUsers reports each user their own derived disk usage', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run('p1', user.id, 'Bin', 'Bin')
    lib.db
      .prepare(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES ('f1', 'p1', 'a.stl', 'model', 4096, 0)",
      )
      .run()

    const byName = new Map(listUsers(lib, admin).map((u) => [u.username, u.diskUsageBytes]))
    assert.equal(byName.get('anna'), 4096)
    assert.equal(byName.get('admin'), 0)
  })
})

test('a user disabled while pending cannot activate with their original token', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user, token } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    updateUser(lib, admin, user.id, { isDisabled: true })

    await assert.rejects(
      () => activateAccount(lib, token, 'a good long password', null),
      (e: unknown) => (e as AppError).code === 'InvalidToken',
    )
  })
})

test('reissueInvite refuses a disabled account', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    updateUser(lib, admin, user.id, { isDisabled: true })

    await assert.rejects(
      () => reissueInvite(lib, admin, user.id),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})
