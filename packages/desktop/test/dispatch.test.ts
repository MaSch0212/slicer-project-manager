import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { AppError } from '@spm/contract/errors.ts'
import { closeLibrary, ensureLocalUser, openLibrary, type Library } from '@spm/core'
import { writeZip } from '../../core/test/fixtures/make-3mf.ts'
import {
  IpcApiClient,
  type IpcResult as WebIpcResult,
} from '../../web/src/app/core/api/ipc-api-client.ts'
import {
  DESKTOP_CAPABILITIES,
  dispatch,
  isApiPath,
  type ApiPath,
  type DispatchSession,
} from '../src/dispatch.ts'
import type { IpcResult as DesktopIpcResult } from '../src/protocol.ts'
import { FILE_URL_BASE } from '../src/urls.ts'

/**
 * The dispatch table, under plain Node with no Electron anywhere.
 *
 * That is the point of the table being a value: the Playwright suite proves the *channel* works
 * once, and this proves every route on it works, against a real library on disk. A route that is
 * only exercised by the GUI is a route that ships broken, because the GUI touches four of them.
 */

let dir: string
let lib: Library
let session: DispatchSession

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'spm-dispatch-'))
  lib = openLibrary(dir)
  session = { lib, ctx: ensureLocalUser(lib) }
})

after(() => {
  closeLibrary(lib)
  rmSync(dir, { recursive: true, force: true })
})

/** Calls a route the way `ipc.ts` does, so a test cannot accidentally bypass the validation. */
function call<P extends ApiPath>(path: P, args: unknown[] = []): Promise<unknown> {
  return dispatch[path](session, args)
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the call to reject, and it resolved' })
}

/* -------------------------------------------------------------------------------------------
 * The key set
 * ---------------------------------------------------------------------------------------- */

/**
 * One call per `ApiClient` method, through the renderer's own client.
 *
 * The annotation is what makes this exhaustive: `ApiPath` is derived from `ApiClient` itself, so
 * a method added to the interface and not listed here does not compile. That gives the key-set
 * equality the task asked for, sourced from the interface rather than from a hand-kept list.
 *
 * It is not the same guarantee as `DispatchTable`'s mapped type, which is why both exist. The
 * mapped type proves the *table* covers the interface; this proves the *renderer* reaches the
 * table — every path string in `IpcApiClient` is untyped as far as the compiler is concerned, so
 * a typo in one of them is a `NotFound` at runtime and nothing else would catch it.
 */
function exerciseAll(client: ApiClient): Record<ApiPath, () => Promise<unknown>> {
  const bytes = new Uint8Array([1, 2, 3])
  return {
    capabilities: () => client.capabilities(),
    'auth.login': () => client.auth.login('local', 'secret'),
    'auth.logout': () => client.auth.logout(),
    'auth.checkToken': () => client.auth.checkToken('tok'),
    'auth.activate': () => client.auth.activate('tok', 'a-long-enough-password'),
    'account.me': () => client.account.me(),
    'account.changePassword': () => client.account.changePassword('old', 'a-new-password'),
    'account.updateProfile': () => client.account.updateProfile({ displayName: 'Local' }),
    'settings.get': () => client.settings.get(),
    'settings.put': () => client.settings.put({ theme: 'dark' }),
    'users.list': () => client.users.list(),
    'users.create': () =>
      client.users.create({ username: 'x', displayName: 'X', isAdmin: false, quotaBytes: null }),
    'users.reissueInvite': () => client.users.reissueInvite('id'),
    'users.update': () => client.users.update('id', { isAdmin: true }),
    'users.delete': () => client.users.delete('id'),
    'projects.list': () => client.projects.list({}),
    'projects.get': () => client.projects.get('id'),
    'projects.create': () => client.projects.create({ name: 'n' }),
    'projects.update': () => client.projects.update('id', { name: 'n' }),
    'projects.delete': () => client.projects.delete('id', { deleteFiles: false }),
    'projects.addTag': () => client.projects.addTag('id', 'tag'),
    'projects.removeTag': () => client.projects.removeTag('id', 'tag'),
    'projects.rescan': () => client.projects.rescan(),
    'importer.curaManagerZip': () => client.importer.curaManagerZip({ blob: new Blob([bytes]) }),
    'files.upload': () => client.files.upload('id', 'a.stl', { blob: new Blob([bytes]) }),
    'files.rename': () => client.files.rename('id', 'b.stl'),
    'files.delete': () => client.files.delete('id'),
  }
}

test('the table implements exactly the interface, and IpcApiClient reaches every entry', async () => {
  const sent: string[] = []
  const client = new IpcApiClient({
    invoke: (path) => {
      sent.push(path)
      return Promise.resolve({ ok: true, value: undefined })
    },
  })

  const exercise = exerciseAll(client)
  assert.deepEqual(
    Object.keys(exercise).sort(),
    Object.keys(dispatch).sort(),
    'the dispatch table and the ApiClient method set have diverged',
  )

  for (const [path, invoke] of Object.entries(exercise)) {
    sent.length = 0
    await invoke()
    assert.deepEqual(sent, [path], `IpcApiClient sent the wrong path for ${path}`)
  }
})

test('the renderer and main-process declarations of the wire result agree', () => {
  // Purely a compile-time assertion: `IpcResult` is declared twice on purpose (the Angular build
  // must not resolve anything out of packages/desktop), and this is what stops the two drifting.
  // Both directions, because one-way assignability would accept a renderer type that had merely
  // dropped a field.
  const fromDesktop: WebIpcResult = {} as DesktopIpcResult
  const fromWeb: DesktopIpcResult = {} as WebIpcResult
  assert.ok(fromDesktop !== undefined && fromWeb !== undefined)
})

test('isApiPath refuses inherited property names', () => {
  // `dispatch[path](...)` with `path` straight off the wire would otherwise be able to reach
  // Object.prototype. A compromised renderer is the threat model here (constraint 4).
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
    assert.equal(isApiPath(name), false, `${name} must not be a dispatchable path`)
  }
  assert.equal(isApiPath('projects.list'), true)
  assert.equal(isApiPath(7), false)
})

/* -------------------------------------------------------------------------------------------
 * The shell's own answers
 * ---------------------------------------------------------------------------------------- */

test('capabilities answers without a library, and says auth is not required', async () => {
  // Null session on purpose: the renderer asks for capabilities during bootstrap, and in task 4
  // that happens before a folder has been picked. The whole object, so a later task cannot flip
  // one flag unnoticed.
  assert.deepEqual(await dispatch.capabilities(null, []), {
    requiresAuth: false,
    canManageUsers: false,
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
  assert.deepEqual(await dispatch.capabilities(null, []), DESKTOP_CAPABILITIES)
})

test('every library-backed route refuses when no folder is open', async () => {
  for (const path of Object.keys(dispatch) as ApiPath[]) {
    if (path === 'capabilities') continue
    const error = await rejection(dispatch[path](null, []))
    assert.equal(error.code, 'Conflict', `${path} should report Conflict without a library`)
  }
})

/* -------------------------------------------------------------------------------------------
 * Routes that go straight to core
 * ---------------------------------------------------------------------------------------- */

test('account.me returns the single local user', async () => {
  const user = await call('account.me')
  assert.equal((user as { username: string }).username, 'local')
  assert.equal((user as { isAdmin: boolean }).isAdmin, false)
})

test('settings round-trip through the library', async () => {
  assert.equal(((await call('settings.get')) as { theme: string }).theme, 'system')
  const put = await call('settings.put', [{ theme: 'dark', viewMode: 'list' }])
  assert.equal((put as { theme: string }).theme, 'dark')
  assert.equal(((await call('settings.get')) as { viewMode: string }).viewMode, 'list')
})

test('account.updateProfile writes through, and me() sees it', async () => {
  await call('account.updateProfile', [{ displayName: 'Workshop' }])
  assert.equal(((await call('account.me')) as { displayName: string }).displayName, 'Workshop')
})

test('the four auth routes say what local mode actually is', async () => {
  assert.equal((await rejection(call('auth.login', ['local', 'secret']))).code, 'Forbidden')
  assert.equal(
    (await rejection(call('auth.activate', ['tok', 'a-long-enough-password']))).code,
    'Forbidden',
  )
  assert.equal(await call('auth.logout'), undefined)
  // A real core query against a library that has no activation tokens in it.
  assert.deepEqual(await call('auth.checkToken', ['no-such-token']), { valid: false })
})

test('the admin routes are refused, because the local user is not an admin', async () => {
  // Not a special case in the table: core's own `requireAdmin` throws, exactly as it does for a
  // non-admin over HTTP. `canManageUsers: false` keeps the UI away from these in the first place.
  for (const [path, args] of [
    ['users.list', []],
    ['users.create', [{ username: 'ann', displayName: 'Ann' }]],
    ['users.reissueInvite', ['some-id']],
    ['users.update', ['some-id', { isAdmin: true }]],
    ['users.delete', ['some-id']],
  ] as [ApiPath, unknown[]][]) {
    assert.equal((await rejection(call(path, args))).code, 'Forbidden', path)
  }
})

/* -------------------------------------------------------------------------------------------
 * Projects and files, including the URLs the decorator emits
 * ---------------------------------------------------------------------------------------- */

test('a project can be created, found, tagged, listed, updated and deleted', async () => {
  const created = (await call('projects.create', [{ name: 'Bracket' }])) as {
    id: string
    name: string
  }
  assert.equal(created.name, 'Bracket')

  await call('projects.addTag', [created.id, 'petg'])
  const detail = (await call('projects.get', [created.id])) as { tags: string[]; files: unknown[] }
  assert.deepEqual(detail.tags, ['petg'])
  assert.deepEqual(detail.files, [])

  const listed = (await call('projects.list', [{ search: 'Brack' }])) as { id: string }[]
  assert.deepEqual(
    listed.map((p) => p.id),
    [created.id],
  )

  const updated = (await call('projects.update', [created.id, { name: 'Bracket v2' }])) as {
    name: string
  }
  assert.equal(updated.name, 'Bracket v2')

  await call('projects.removeTag', [created.id, 'petg'])
  assert.deepEqual(((await call('projects.get', [created.id])) as { tags: string[] }).tags, [])

  await call('projects.delete', [created.id, { deleteFiles: true }])
  assert.equal((await rejection(call('projects.get', [created.id]))).code, 'NotFound')
})

test('files upload, rename and delete, and their URLs point at the reserved spm:// path', async () => {
  const project = (await call('projects.create', [{ name: 'Files' }])) as { id: string }
  const bytes = new TextEncoder().encode('solid cube\nendsolid cube\n')

  const file = (await call('files.upload', [project.id, 'cube.stl', bytes])) as {
    id: string
    name: string
    rawUrl: string
    thumbUrl?: string
    sizeBytes: number
  }
  assert.equal(file.name, 'cube.stl')
  assert.equal(file.sizeBytes, bytes.byteLength)
  // The exact string, not a `startsWith`: this is the URL task 3's handler has to answer, and the
  // renderer's own origin is `spm://app` so it is same-origin (ruling C-7).
  assert.equal(file.rawUrl, `spm://app/_spm/files/${file.id}/raw`)
  assert.equal(file.rawUrl, `${FILE_URL_BASE}/files/${file.id}/raw`)
  // No preview has been rendered, so no thumb URL is claimed.
  assert.equal(file.thumbUrl, undefined)
  assert.ok(existsSync(join(dir, 'Files', 'cube.stl')), 'the bytes did not reach the library')
  assert.equal(readFileSync(join(dir, 'Files', 'cube.stl'), 'utf8'), 'solid cube\nendsolid cube\n')

  const renamed = (await call('files.rename', [file.id, 'cube-v2.stl'])) as {
    name: string
    rawUrl: string
  }
  assert.equal(renamed.name, 'cube-v2.stl')
  assert.equal(renamed.rawUrl, `spm://app/_spm/files/${file.id}/raw`)

  await call('files.delete', [file.id])
  assert.equal(existsSync(join(dir, 'Files', 'cube-v2.stl')), false)
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('a ready preview decorates a thumb URL under the same prefix', async () => {
  // The one branch of `decorateFile` an upload cannot reach on its own: the preview row has to
  // say `ready`. Written directly, because rendering a preview is task 3's and the queue's.
  const project = (await call('projects.create', [{ name: 'Thumbed' }])) as { id: string }
  const file = (await call('files.upload', [
    project.id,
    'part.stl',
    new TextEncoder().encode('solid s endsolid s'),
  ])) as { id: string }
  // The upload already queued a `pending` preview row; this is the queue's later UPDATE.
  const changed = lib.db
    .prepare(`UPDATE previews SET state = 'ready', updated_at = ? WHERE file_id = ?`)
    .run(Date.now(), file.id)
  assert.equal(changed.changes, 1, 'no preview row to mark ready')

  const detail = (await call('projects.get', [project.id])) as {
    files: { id: string; thumbUrl?: string }[]
    coverThumbUrl?: string
  }
  assert.equal(detail.files[0]?.thumbUrl, `spm://app/_spm/files/${file.id}/thumb`)
  assert.equal(detail.coverThumbUrl, `spm://app/_spm/files/${file.id}/thumb`)

  const listed = (await call('projects.list', [{}])) as { id: string; coverThumbUrl?: string }[]
  const row = listed.find((p) => p.id === project.id)
  assert.equal(row?.coverThumbUrl, `spm://app/_spm/files/${file.id}/thumb`)
  // `coverFileId` is core's field and must not survive decoration; the UI binds coverThumbUrl.
  assert.equal(Object.hasOwn(row ?? {}, 'coverFileId'), false)

  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('rescan adopts a folder that was dropped into the library', async () => {
  const folder = join(dir, 'Dropped-In')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'thing.stl'), 'solid t endsolid t')

  const result = (await call('projects.rescan')) as { adopted: number; filesAdded: number }
  assert.equal(result.adopted, 1)
  assert.ok(result.filesAdded >= 1)

  const listed = (await call('projects.list', [{}])) as { name: string }[]
  assert.ok(
    listed.some((p) => p.name === 'Dropped-In'),
    'rescan did not adopt the folder',
  )
})

test('importer.curaManagerZip stages the bytes, imports them, and cleans up after itself', async () => {
  const zipPath = join(tmpdir(), `spm-dispatch-import-${Date.now()}.zip`)
  writeZip(zipPath, [
    { name: 'Imported Lib/Gadget/part.stl', data: 'solid g endsolid g' },
    { name: 'Imported Lib/Gadget/metadata.json', data: JSON.stringify({ Tags: ['imported'] }) },
  ])
  const bytes = new Uint8Array(readFileSync(zipPath))
  rmSync(zipPath, { force: true })

  const result = (await call('importer.curaManagerZip', [bytes])) as {
    projectsExtracted: number
    strippedRoot: string | null
  }
  assert.equal(result.projectsExtracted, 1)
  assert.equal(result.strippedRoot, 'Imported Lib')
  assert.ok(existsSync(join(dir, 'Gadget', 'part.stl')))

  // The staging copy must not survive: it lives inside the user's own library.
  const uploads = join(dir, '.spm', 'uploads')
  assert.deepEqual(existsSync(uploads) ? readdirSync(uploads) : [], [])
})

test('a rejected import still removes its staging copy', async () => {
  const error = await rejection(call('importer.curaManagerZip', [new Uint8Array([1, 2, 3, 4])]))
  assert.ok(error.message.length > 0)
  const uploads = join(dir, '.spm', 'uploads')
  assert.deepEqual(existsSync(uploads) ? readdirSync(uploads) : [], [])
})

/* -------------------------------------------------------------------------------------------
 * Argument validation (constraint 4)
 * ---------------------------------------------------------------------------------------- */

test('a bad argument is rejected before core sees it, with the code the server would send', async () => {
  // `createProjectSchema` is the same object `packages/server/src/json.ts` parses this body
  // with, so an empty name is `Validation` in both shells for the same reason.
  const error = await rejection(call('projects.create', [{ name: '' }]))
  assert.equal(error.code, 'Validation')
  assert.match(error.message, /projects\.create/)
  assert.ok(Array.isArray((error.details as { issues?: unknown[] })?.issues))
  // Nothing was written.
  const listed = (await call('projects.list', [{ search: '' }])) as unknown[]
  assert.ok(Array.isArray(listed))
})

test('the argument list itself is validated, not just its contents', async () => {
  // A tuple with no rest element: too few, too many, and the wrong type are all Validation.
  assert.equal((await rejection(call('files.rename', ['id']))).code, 'Validation')
  assert.equal((await rejection(call('files.rename', ['id', 'a.stl', 'extra']))).code, 'Validation')
  assert.equal((await rejection(call('projects.get', [{ id: 'x' }]))).code, 'Validation')
  assert.equal(
    (await rejection(call('settings.put', [{ theme: 'chartreuse' }]))).code,
    'Validation',
  )
  // The upload arms cannot cross IPC, so anything that is not bytes is refused here rather than
  // silently written as an empty file — which is exactly what a Blob would have become.
  assert.equal((await rejection(call('files.upload', ['id', 'a.stl', {}]))).code, 'Validation')
})

test('a traversing file name never reaches the filesystem', async () => {
  const project = (await call('projects.create', [{ name: 'Traversal' }])) as { id: string }
  for (const name of ['../escaped.stl', '..\\escaped.stl', '.hidden', 'CON.stl']) {
    const error = await rejection(
      call('files.upload', [project.id, name, new Uint8Array([1, 2, 3])]),
    )
    assert.equal(error.code, 'Validation', name)
  }
  assert.equal(existsSync(join(dir, 'escaped.stl')), false)
  await call('projects.delete', [project.id, { deleteFiles: true }])
})
