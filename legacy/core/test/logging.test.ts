import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { login } from '../src/auth/login.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import type { LogRecord } from '../src/log.ts'
import { runPreviewQueue } from '../src/previews/queue.ts'
import {
  importCuraManagerLibrary,
  type ImportProgress,
} from '../src/projects/import-curamanager.ts'
import { createProject, deleteProject } from '../src/projects/usecases.ts'
import { rescan, type RescanProgress } from '../src/projects/rescan.ts'
import { createUser, deleteUser } from '../src/users/admin.ts'
import { assert, test } from './harness.ts'
import { withLibrary, withLoggedLibrary } from './tmp-library.ts'
import { curaProject } from './fixtures/make-3mf.ts'
import { makePng } from './fixtures/make-png.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  mkdirSync(join(lib.dir, username), { recursive: true })
  return { userId: id, isAdmin: false }
}

function find(records: LogRecord[], message: string): LogRecord | undefined {
  return records.find((record) => record.message === message)
}

test('a library with no logger configured stays completely silent', async () => {
  // The guarantee that matters for a library: importing core and using it must not print.
  // Asserted by capturing the real console, because NOOP_LOGGER routing to a no-op sink is
  // exactly the kind of thing a later refactor breaks without any test noticing.
  const original = { log: console.log, warn: console.warn, error: console.error }
  const captured: string[] = []
  console.log =
    console.warn =
    console.error =
      (...args: unknown[]) => {
        captured.push(args.join(' '))
      }
  try {
    await withLibrary(async (lib) => {
      const ctx = seedUser(lib)
      createProject(lib, ctx, { name: 'Silent' })
      await rescan(lib, ctx)
    })
  } finally {
    Object.assign(console, original)
  }
  assert.deepEqual(captured, [])
})

test('rescan logs a summary carrying its own counts', async () => {
  await withLoggedLibrary(async (lib, records) => {
    const ctx = seedUser(lib)
    mkdirSync(join(lib.dir, 'marc', 'Adopted Me'), { recursive: true })
    writeFileSync(join(lib.dir, 'marc', 'Adopted Me', 'part.stl'), 'solid x')

    const result = await rescan(lib, ctx)
    // The counts must be non-zero, or the assertion below could not tell a working summary
    // from one that logged zeroes.
    assert.equal(result.adopted, 1)
    assert.equal(result.filesAdded, 1)

    const summary = find(records, 'rescan complete')
    assert.ok(summary, 'no rescan summary was logged')
    assert.equal(summary.level, 'info')
    assert.equal(summary.fields.adopted, 1)
    assert.equal(summary.fields.filesAdded, 1)
    assert.equal(summary.fields.userId, ctx.userId)

    const adopted = find(records, 'adopted project folder')
    assert.equal(adopted?.level, 'debug')
    assert.equal(adopted?.fields.dirName, 'Adopted Me')
  })
})

test('the preview queue logs a batch summary and stays quiet when idle', async () => {
  await withLoggedLibrary(async (lib, records) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Project')
    mkdirSync(dir, { recursive: true })
    curaProject(join(dir, 'model.3mf'), makePng(256, 256))
    await rescan(lib, ctx)

    records.length = 0
    const counts = await runPreviewQueue(lib)
    assert.equal(counts.ready, 1, 'the fixture must actually produce a preview')
    const batch = find(records, 'preview batch')
    assert.equal(batch?.level, 'info')
    assert.equal(batch?.fields.claimed, 1)
    assert.equal(batch?.fields.ready, 1)

    // Second run: nothing pending, so an operator on the default level sees nothing at all
    // rather than a zeroed line every 30 seconds forever.
    records.length = 0
    await runPreviewQueue(lib)
    assert.deepEqual(
      records.filter((record) => record.level === 'info'),
      [],
    )
  })
})

test('a failing preview is logged at warn with the path that caused it', async () => {
  await withLoggedLibrary(async (lib, records) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Project')
    mkdirSync(dir, { recursive: true })
    curaProject(join(dir, 'model.3mf'), makePng(256, 256))
    await rescan(lib, ctx)

    records.length = 0
    const counts = await runPreviewQueue(lib, {
      handlers: [
        {
          kinds: ['slicer_project'],
          run: () => Promise.reject(new Error('handler exploded')),
        },
      ],
    })
    assert.equal(counts.failed, 1)
    const failure = find(records, 'preview failed')
    assert.equal(failure?.level, 'warn')
    assert.ok(String(failure?.fields.path).endsWith('model.3mf'), String(failure?.fields.path))
  })
})

test('a rejected login is logged at warn with a reason, and never the password', async () => {
  await withLoggedLibrary(async (lib, records) => {
    seedUser(lib, 'marc')
    await assert.rejects(() => login(lib, 'nobody', 'hunter2 is a secret', null))

    const rejected = find(records, 'login rejected')
    assert.equal(rejected?.level, 'warn')
    assert.equal(rejected?.fields.username, 'nobody')
    assert.equal(rejected?.fields.reason, 'no such user')
    assert.ok(
      !JSON.stringify(records).includes('hunter2'),
      'the attempted password reached the log',
    )
  })
})

test('user and project lifecycle changes are logged at info with who did them', async () => {
  await withLoggedLibrary(async (lib, records) => {
    const admin: Ctx = { userId: 'admin-id', isAdmin: true }
    const created = await createUser(lib, admin, {
      username: 'newbie',
      displayName: 'Newbie',
      isAdmin: false,
      quotaBytes: null,
    })
    const createdRecord = find(records, 'user created')
    assert.equal(createdRecord?.level, 'info')
    assert.equal(createdRecord?.fields.username, 'newbie')
    assert.equal(createdRecord?.fields.by, 'admin-id')
    // The invite token is the credential; it must never be recoverable from the log.
    assert.ok(!JSON.stringify(records).includes(created.token), 'the invite token was logged')

    const ctx = seedUser(lib, 'owner')
    const project = createProject(lib, ctx, { name: 'Widget' })
    assert.equal(find(records, 'project created')?.fields.projectId, project.id)

    deleteProject(lib, ctx, project.id, { deleteFiles: false })
    assert.equal(find(records, 'project deleted')?.fields.projectId, project.id)

    deleteUser(lib, admin, created.user.id)
    assert.equal(find(records, 'user deleted')?.fields.username, 'newbie')
  })
})

test('rescan reports progress for every project and every file it examines', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    for (const name of ['Alpha', 'Beta']) {
      mkdirSync(join(lib.dir, 'marc', name), { recursive: true })
      writeFileSync(join(lib.dir, 'marc', name, 'a.stl'), 'solid a')
      writeFileSync(join(lib.dir, 'marc', name, 'b.stl'), 'solid b')
    }

    const events: RescanProgress[] = []
    const result = await rescan(lib, ctx, { onProgress: (event) => events.push(event) })
    assert.equal(result.filesAdded, 4)

    assert.deepEqual([...new Set(events.map((event) => event.dirName))].sort(), ['Alpha', 'Beta'])
    // Two projects, and each one reports once on entry plus once per file: 2 * (1 + 2).
    assert.equal(events.length, 6)
    for (const event of events) assert.equal(event.projectCount, 2)
    assert.deepEqual(
      events.map((event) => event.projectIndex),
      [1, 1, 1, 2, 2, 2],
    )
    // The cumulative counters must actually climb, not just be present.
    assert.deepEqual(
      events.map((event) => event.filesSeen),
      [0, 1, 2, 2, 3, 4],
    )
    assert.equal(events.at(-1)?.filesAdded, 3)
  })
})

test('the importer reports both phases, indexing before sidecars', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Widget')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'part.stl'), 'solid x')
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ Tags: ['toys'], IsArchived: true }))

    const events: ImportProgress[] = []
    const result = await importCuraManagerLibrary(lib, ctx, {
      moveIntoUserFolder: false,
      onProgress: (event) => events.push(event),
    })
    assert.equal(result.tagsApplied, 1)

    const phases = events.map((event) => event.phase)
    assert.ok(phases.includes('indexing'), 'no indexing progress was reported')
    assert.ok(phases.includes('sidecars'), 'no sidecar progress was reported')
    assert.ok(
      phases.lastIndexOf('indexing') < phases.indexOf('sidecars'),
      `phases interleaved: ${phases.join()}`,
    )
    const sidecar = events.find((event) => event.phase === 'sidecars')!
    assert.equal(sidecar.dirName, 'Widget')
    assert.equal(sidecar.projectIndex, 1)
    assert.equal(sidecar.projectCount, 1)
  })
})

test('a rescan with no progress callback still works', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(lib.dir, 'marc', 'Solo'), { recursive: true })
    const result = await rescan(lib, ctx)
    assert.equal(result.adopted, 1)
  })
})
