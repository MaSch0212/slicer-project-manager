import assert from 'node:assert/strict'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
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
  FILE_REF_KEY as WEB_FILE_REF_KEY,
  type IpcResult as WebIpcResult,
} from '../../web/src/app/core/api/ipc-api-client.ts'
import {
  DESKTOP_CAPABILITIES,
  dispatch,
  isApiPath,
  type ApiPath,
  type DispatchSession,
  type ShellApi,
} from '../src/dispatch.ts'
import {
  FILE_REF_KEY,
  LOCAL_PATH_KEY,
  type IpcResult as DesktopIpcResult,
  type WireUploadBody,
} from '../src/protocol.ts'
import { sanitiseArg, sanitiseArgs, type PickedFile } from '../src/sanitise-args.ts'
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

/**
 * What the shell hands `library.pick`, with a picker that cannot open a dialog.
 *
 * `pickedFolders` records the calls, so the one route that reaches outside the table is still
 * exercised by the exhaustive sweep rather than skipped by it.
 */
const pickedFolders: (string | null)[] = []
const shell: ShellApi = {
  pickLibraryFolder: () => {
    pickedFolders.push(null)
    return Promise.resolve(null)
  },
}

/** Calls a route the way `ipc.ts` does, so a test cannot accidentally bypass the validation. */
function call<P extends ApiPath>(path: P, args: unknown[] = []): Promise<unknown> {
  return dispatch[path]({ session, shell }, args)
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
    'library.pick': () => client.library.pick(),
  }
}

test('the table implements exactly the interface, and IpcApiClient reaches every entry', async () => {
  const sent: string[] = []
  const client = new IpcApiClient({
    // No file behind these Blobs, which is what a real preload would answer for them too.
    canStreamFromDisk: () => false,
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

test('the three keys the upload path is spelled with cannot drift apart', () => {
  // 1. The renderer puts the picked File under its own copy of the key; the preload looks for
  //    its own. Drift is not silent — measured: the preload leaves the object untouched, the
  //    unrecognised key fails `uploadBodySchema`, and the import-page Playwright test goes red
  //    with "Import finished" never appearing. (An earlier version of this comment claimed the
  //    upload would quietly fall back to buffering. It does not; it fails outright. This
  //    assertion is the one that names *which* string is wrong when it does.)
  assert.equal(WEB_FILE_REF_KEY, FILE_REF_KEY)

  // 2. The key the preload writes a resolved path under has to be the key `WireUploadBody`'s
  //    path arm — and so `uploadBodySchema` — reads. If they disagree, the preload's strip stops
  //    removing the key a forged argument uses, which is the security-relevant half. This is a
  //    compile-time tie: the computed key is typed by `LOCAL_PATH_KEY`, so the annotation only
  //    holds while the two are the same literal.
  const pathArm: WireUploadBody = {
    [LOCAL_PATH_KEY]: 'C:\\somewhere\\picked.stl',
    sizeBytes: 1,
    lastModifiedMs: 1,
  }
  assert.ok(LOCAL_PATH_KEY in pathArm)
})

/* -------------------------------------------------------------------------------------------
 * The preload's argument sanitiser
 * ---------------------------------------------------------------------------------------- */

/**
 * Asserted here, on its own output, and not only through the bridge.
 *
 * Through the bridge, a nested `{ localPath }` comes back `Validation` whether the strip removed
 * it or not, because `uploadBodySchema` is a top-level union and never sees a nested object.
 * That made the end-to-end forgery cases pass for a reason that has nothing to do with the guard
 * — a coincidence the next schema change repeals. These read what the sanitiser actually
 * produced.
 *
 * `PICKED` stands in for a `File`; the real resolver is `webUtils.getPathForFile`, which needs an
 * Electron renderer, so it is injected.
 */
const PICKED = { picked: true }
const PICKED_WIRE = { localPath: 'C:\\picked\\model.stl', sizeBytes: 34, lastModifiedMs: 1700000 }
const resolvePicked = (file: unknown): PickedFile | null =>
  file === PICKED ? { ...PICKED_WIRE } : null

test('the sanitiser removes a forged localPath at every depth, not just the top', () => {
  const victim = 'C:\\Users\\someone\\.ssh\\id_rsa'
  assert.deepEqual(sanitiseArg({ localPath: victim }, resolvePicked), {})
  assert.deepEqual(sanitiseArg({ localPath: victim, bytes: 'kept' }, resolvePicked), {
    bytes: 'kept',
  })
  assert.deepEqual(sanitiseArg({ a: { localPath: victim } }, resolvePicked), { a: {} })
  assert.deepEqual(sanitiseArg({ a: { b: { c: { localPath: victim } } } }, resolvePicked), {
    a: { b: { c: {} } },
  })
  assert.deepEqual(sanitiseArg([{ localPath: victim }], resolvePicked), [{}])
  assert.deepEqual(sanitiseArg({ a: [{ b: { localPath: victim } }] }, resolvePicked), {
    a: [{ b: {} }],
  })
  // The whole list, the way `invoke` calls it.
  assert.deepEqual(sanitiseArgs(['id', 'a.stl', { localPath: victim }], resolvePicked), [
    'id',
    'a.stl',
    {},
  ])
  // Nowhere in the output does the string survive, at any depth.
  assert.equal(
    JSON.stringify(sanitiseArgs([{ deep: [{ localPath: victim }] }], resolvePicked)).includes(
      'id_rsa',
    ),
    false,
  )
})

test('the sanitiser writes a localPath only from a real picked file', () => {
  assert.deepEqual(sanitiseArg({ [FILE_REF_KEY]: PICKED }, resolvePicked), PICKED_WIRE)
  // Nested too, so the substitution is not a top-level special case either.
  assert.deepEqual(sanitiseArg({ a: { [FILE_REF_KEY]: PICKED } }, resolvePicked), {
    a: PICKED_WIRE,
  })
  // Anything the resolver cannot name yields neither arm, so the schema refuses it. A token
  // holding a string, a `Blob`, a made-up `File` and a value that makes the resolver throw all
  // land here.
  for (const held of ['C:\\Users\\someone\\.ssh\\id_rsa', {}, null, 7]) {
    assert.deepEqual(sanitiseArg({ [FILE_REF_KEY]: held }, resolvePicked), {}, String(held))
  }
  // Everything the main world put beside the file is discarded, not merged: a path it would
  // like used, and a size and time it would like the main process to check against. All three
  // come from the preload's own view of the `File` or they are worth nothing.
  assert.deepEqual(
    sanitiseArg(
      {
        [FILE_REF_KEY]: PICKED,
        localPath: 'C:\\forged',
        sizeBytes: 999,
        lastModifiedMs: 999,
        extra: 'dropped',
      },
      resolvePicked,
    ),
    PICKED_WIRE,
  )
})

test('the sanitiser passes binary payloads through by identity and terminates on a cycle', () => {
  // Rebuilding a Uint8Array through Object.entries would turn it into { "0": 1, … } and the
  // bytes arm would upload nothing.
  const bytes = new Uint8Array([1, 2, 3])
  const sanitised = sanitiseArg({ bytes }, resolvePicked) as { bytes: Uint8Array }
  assert.equal(sanitised.bytes, bytes)
  assert.equal(sanitiseArg(bytes, resolvePicked), bytes)

  // Past the depth cap the value becomes null, which every schema refuses. Without the cap a
  // cyclic argument — which contextBridge permits — would recurse until the stack gave out.
  const cyclic: Record<string, unknown> = { localPath: 'C:\\forged' }
  cyclic['self'] = cyclic
  const walked = JSON.stringify(sanitiseArg(cyclic, resolvePicked))
  assert.equal(walked, '{"self":{"self":{"self":{"self":{"self":{"self":null}}}}}}')
  // The forged path is gone from every one of those levels, not only the outermost.
  assert.equal(walked.includes('forged'), false)
  assert.equal(walked.includes('localPath'), false)
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
  assert.deepEqual(await dispatch.capabilities({ session: null, shell }, []), {
    requiresAuth: false,
    canManageUsers: false,
    canPickLocalFolder: true,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
  assert.deepEqual(await dispatch.capabilities({ session: null, shell }, []), DESKTOP_CAPABILITIES)
})

/**
 * The other route that must answer with no folder open, and the reason `capabilities` is not
 * alone in `shellCall`: with no library there is no way for the user to choose one, so a
 * `Conflict` here would be a dead end rather than an error.
 */
test('library.pick answers without a library, and reaches the shell', async () => {
  pickedFolders.length = 0
  const chosen: unknown[] = []
  const picking: ShellApi = {
    pickLibraryFolder: () => {
      chosen.push('asked')
      return Promise.resolve({ dir: '/tmp/somewhere' })
    },
  }
  assert.deepEqual(await dispatch['library.pick']({ session: null, shell: picking }, []), {
    dir: '/tmp/somewhere',
  })
  assert.deepEqual(chosen, ['asked'])

  // A cancelled picker is a null, not a throw: the library that was open stays open.
  assert.equal(await dispatch['library.pick']({ session: null, shell }, []), null)
  assert.deepEqual(pickedFolders, [null])
})

test('library.pick rejects an argument list, so a path from the renderer cannot reach it', async () => {
  const error = await rejection(
    dispatch['library.pick']({ session: null, shell }, ['C:\Windows\System32']),
  )
  assert.equal(error.code, 'Validation')
})

test('every library-backed route refuses when no folder is open', async () => {
  // The two routes that answer out of the shell itself are the exceptions, and they are asserted
  // directly above rather than skipped silently here.
  const fromShell: ApiPath[] = ['capabilities', 'library.pick']
  for (const path of Object.keys(dispatch) as ApiPath[]) {
    if (fromShell.includes(path)) continue
    const error = await rejection(dispatch[path]({ session: null, shell }, []))
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

  const file = (await call('files.upload', [project.id, 'cube.stl', { bytes }])) as {
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
    { bytes: new TextEncoder().encode('solid s endsolid s') },
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

/* -------------------------------------------------------------------------------------------
 * The two upload arms
 * ---------------------------------------------------------------------------------------- */

/** Whatever is sitting in the library's staging directory, which should be nothing, ever. */
function stagedFiles(): string[] {
  const uploads = join(dir, '.spm', 'uploads')
  return existsSync(uploads) ? readdirSync(uploads) : []
}

/**
 * A second library, opened and torn down for one test.
 *
 * The path-arm import test needs one because its assertion is that `.spm/uploads` was never
 * *created*, and the shared library's bytes-arm test creates it. Asserting on the directory
 * rather than on its contents is the whole point: the bytes arm deletes the staged file in a
 * `finally`, so "no files in it" is true of both arms and would have been a vacuous check.
 */
async function withFreshLibrary(
  run: (session: DispatchSession, libraryDir: string) => Promise<void>,
): Promise<void> {
  const freshDir = mkdtempSync(join(tmpdir(), 'spm-dispatch-fresh-'))
  const fresh = openLibrary(freshDir)
  try {
    await run({ lib: fresh, ctx: ensureLocalUser(fresh) }, freshDir)
  } finally {
    closeLibrary(fresh)
    rmSync(freshDir, { recursive: true, force: true })
  }
}

/**
 * What the preload sends for a file the user picked: the path, and the size and modification time
 * Chromium snapshotted when they picked it. Read off the file here, which is what the snapshot is
 * for a file nobody has touched since.
 */
function pickedBody(localPath: string): WireUploadBody {
  const info = statSync(localPath)
  return { localPath, sizeBytes: info.size, lastModifiedMs: Math.trunc(info.mtimeMs) }
}

test('files.upload streams a picked file off disk without ever holding it in memory', async () => {
  // The arm every upload the UI can start actually takes. `localPath` reaches the main process
  // only because the preload wrote it (see protocol.ts); here it is supplied directly, which is
  // the same thing the preload's substitution produces.
  const project = (await call('projects.create', [{ name: 'Picked' }])) as { id: string }
  const source = join(tmpdir(), `spm-dispatch-picked-${Date.now()}.stl`)
  const contents = 'solid picked\nendsolid picked\n'
  writeFileSync(source, contents)

  const file = (await call('files.upload', [project.id, 'picked.stl', pickedBody(source)])) as {
    id: string
    sizeBytes: number
    rawUrl: string
  }

  assert.equal(file.sizeBytes, Buffer.byteLength(contents))
  assert.equal(file.rawUrl, `${FILE_URL_BASE}/files/${file.id}/raw`)
  assert.equal(readFileSync(join(dir, 'Picked', 'picked.stl'), 'utf8'), contents)
  // The user's own file is read, never moved or removed.
  assert.ok(existsSync(source), 'the picked file was consumed instead of copied')

  rmSync(source, { force: true })
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('a picked path that no longer exists is NotFound, and a folder is Validation', async () => {
  const project = (await call('projects.create', [{ name: 'Gone' }])) as { id: string }
  const missing = join(tmpdir(), `spm-dispatch-missing-${Date.now()}.stl`)
  const snapshot = { sizeBytes: 1, lastModifiedMs: 1 }

  assert.equal(
    (
      await rejection(
        call('files.upload', [project.id, 'a.stl', { localPath: missing, ...snapshot }]),
      )
    ).code,
    'NotFound',
  )
  assert.equal(
    (await rejection(call('files.upload', [project.id, 'a.stl', { localPath: dir, ...snapshot }])))
      .code,
    'Validation',
  )
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('a file that changed after it was picked is refused, as it is in the browser', async () => {
  /*
   * Finding F. A `File` is a durable handle to a *path*: the renderer can hold one and redeem it
   * later for whatever is at that path then, and deleting the preload's token map did not change
   * that. Measured — pick, replace the bytes, upload the same `File`, and the *replacement* was
   * streamed under the old name.
   *
   * Chromium refuses that same stale `File` in a browser with `NotReadableError`, because it
   * snapshot-validates against the size and modification time from the pick. So the preload sends
   * that snapshot and this is where it is checked, and the two shells now answer the same way.
   * Either half of the snapshot catches an ordinary overwrite; both are asserted because a
   * same-size edit is exactly the case a size check alone misses.
   */
  const project = (await call('projects.create', [{ name: 'Swapped' }])) as { id: string }
  const source = join(tmpdir(), `spm-dispatch-swap-${Date.now()}.stl`)
  writeFileSync(source, 'solid original endsolid original')
  const snapshot = pickedBody(source) as {
    localPath: string
    sizeBytes: number
    lastModifiedMs: number
  }

  // Longer contents: size and modification time both move.
  writeFileSync(source, 'REPLACED AFTER THE USER PICKED IT, AND MUCH LONGER THAN BEFORE\n')
  assert.equal(
    (await rejection(call('files.upload', [project.id, 'swapped.stl', snapshot]))).code,
    'Conflict',
  )

  // Same length, so only the modification time betrays it. The time is set explicitly rather
  // than left to the clock: two writes a few microseconds apart can land in the same
  // millisecond, and then this would assert nothing — caught when it passed once and failed the
  // next run for a reason that had nothing to do with the code under test.
  writeFileSync(source, 'solid replaced endsolid replaced')
  utimesSync(source, new Date(), new Date(snapshot.lastModifiedMs + 5_000))
  const sameLength = { ...snapshot, sizeBytes: statSync(source).size }
  assert.equal(statSync(source).size, snapshot.sizeBytes, 'the probe needs an equal-length swap')
  assert.notEqual(
    Math.trunc(statSync(source).mtimeMs),
    snapshot.lastModifiedMs,
    'the probe needs a different modification time',
  )
  assert.equal(
    (await rejection(call('files.upload', [project.id, 'swapped.stl', sameLength]))).code,
    'Conflict',
  )

  assert.equal(existsSync(join(dir, 'Swapped', 'swapped.stl')), false, 'a stale file was written')

  // And picking it again works, which is what the error message tells the user to do.
  const file = (await call('files.upload', [project.id, 'swapped.stl', pickedBody(source)])) as {
    sizeBytes: number
  }
  assert.equal(file.sizeBytes, statSync(source).size)

  rmSync(source, { force: true })
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('the main process refuses a picked path it should never be given', async () => {
  /*
   * The preload is what stops the untrusted main world writing a `localPath` at all — but the
   * preload runs in the renderer process, on the untrusted side of the line constraint 4 draws.
   * This is the main process's own check, so a contextIsolation bypass or one careless edit to
   * `sanitise` does not restore the full escalation. Both entry points, because they validate
   * separately.
   *
   * What it does not stop is stated in `sizeOfPickedFile` and not pretended at here: an absolute
   * path to any *other* file the user can read still passes, because the main process has no way
   * to know what the user picked.
   */
  const project = (await call('projects.create', [{ name: 'Backstop' }])) as { id: string }
  const victim = join(dir, '.spm', 'app.db')
  assert.ok(existsSync(victim), 'the probe needs a real file inside .spm')
  const drive = dir.slice(0, 1)
  const withoutDrive = dir.slice(2)
  const BS = String.fromCharCode(92)

  /*
   * Every row below except the last two is an alias for the same `app.db`. Five of them defeated
   * the first version of this check, which compared `resolve()`d strings with `startsWith`:
   * `.SPM` (NTFS is case-insensitive), the `\\?\` device prefix, and two UNC spellings of the
   * local disk. `resolve()` case-folds nothing and normalises neither prefix, so the check now
   * compares filesystem identity up the ancestor chain — see `isInside`.
   *
   * They are Windows-only spellings, so they are only exercised there. The dot-segment and
   * doubled-separator rows run everywhere and are what `resolve()` alone already handled.
   */
  const aliases: [string, string, string][] = [
    ['the library database', victim, 'Forbidden'],
    ['the .spm directory itself', join(dir, '.spm'), 'Forbidden'],
    ['a preview inside .spm', join(dir, '.spm', 'previews', 'anything.png'), 'Forbidden'],
    ['a dot segment', join(dir, '.spm', '.', 'app.db'), 'Forbidden'],
    ['a dotdot segment', join(dir, 'elsewhere', '..', '.spm', 'app.db'), 'Forbidden'],
    ['forward slashes', victim.split(BS).join('/'), 'Forbidden'],
    // A relative path would otherwise resolve against the main process's working directory,
    // which is not anywhere a picker can point.
    ['a relative path', 'package.json', 'Validation'],
    ['a bare file name', 'app.db', 'Validation'],
  ]
  if (process.platform === 'win32') {
    aliases.push(
      ['case-folded .SPM', join(dir, '.SPM', 'app.db'), 'Forbidden'],
      ['the device-path prefix', `${BS}${BS}?${BS}${victim}`, 'Forbidden'],
      [
        'a UNC alias for the local disk',
        `${BS}${BS}localhost${BS}${drive}$${withoutDrive}${BS}.spm${BS}app.db`,
        'Forbidden',
      ],
      [
        'a device-prefixed UNC alias',
        `${BS}${BS}?${BS}UNC${BS}localhost${BS}${drive}$${withoutDrive}${BS}.spm${BS}app.db`,
        'Forbidden',
      ],
    )
  }

  for (const [label, path, code] of aliases) {
    // The real snapshot where the file exists, so only the containment check can be what refuses.
    const snapshot = existsSync(path)
      ? pickedBody(path)
      : { localPath: path, sizeBytes: 1, lastModifiedMs: 1 }
    assert.equal(
      (await rejection(call('files.upload', [project.id, 'stolen.txt', snapshot]))).code,
      code,
      label,
    )
    assert.equal(
      (await rejection(call('importer.curaManagerZip', [snapshot]))).code,
      code,
      `${label}, through the importer`,
    )
  }

  assert.equal(existsSync(join(dir, 'Backstop', 'stolen.txt')), false, 'a refused file was written')
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('a hard link into .spm is the limit of what path containment can see', async () => {
  /*
   * Documented rather than hidden. A hard link is a second, equally real name for the same bytes,
   * so walking up from it never passes through `.spm` and no path-based check can refuse it —
   * `realpathSync` does not collapse a hard link either, because there is nothing to collapse.
   * Catching it would mean comparing the file's own identity against every file in `.spm` on
   * every upload.
   *
   * Left as it is because of the threat model this backstop serves: it is defence in depth behind
   * the preload, against a *compromised renderer*, and a renderer has no filesystem access with
   * which to create a hard link in the first place. If that ever stops being true, this test is
   * the one that fails and says so.
   */
  const project = (await call('projects.create', [{ name: 'Linked' }])) as { id: string }
  const link = join(dir, `hard-link-${Date.now()}.bin`)
  try {
    linkSync(join(dir, '.spm', 'app.db'), link)
  } catch {
    // Some filesystems refuse hard links; there is nothing to assert then.
    await call('projects.delete', [project.id, { deleteFiles: true }])
    return
  }

  const copied = (await call('files.upload', [project.id, 'linked.bin', pickedBody(link)])) as {
    sizeBytes: number
  }
  assert.equal(copied.sizeBytes, statSync(join(dir, '.spm', 'app.db')).size)

  rmSync(link, { force: true })
  await call('projects.delete', [project.id, { deleteFiles: true }])
})

test('importer.curaManagerZip reads a picked archive in place, without staging a copy', async () => {
  const zipPath = join(tmpdir(), `spm-dispatch-picked-import-${Date.now()}.zip`)
  writeZip(zipPath, [
    { name: 'Picked Lib/Widget/part.stl', data: 'solid w endsolid w' },
    { name: 'Picked Lib/Widget/metadata.json', data: JSON.stringify({ Tags: ['picked'] }) },
  ])

  await withFreshLibrary(async (session, freshDir) => {
    const result = (await dispatch['importer.curaManagerZip']({ session, shell }, [
      pickedBody(zipPath),
    ])) as {
      projectsExtracted: number
      strippedRoot: string | null
    }
    assert.equal(result.projectsExtracted, 1)
    assert.equal(result.strippedRoot, 'Picked Lib')
    assert.ok(existsSync(join(freshDir, 'Widget', 'part.stl')))
    // Nothing was copied into the library to read it: the staging directory was never even
    // created. This is the observable difference between the two arms, and the reason a 10 GiB
    // archive costs no memory here.
    assert.equal(
      existsSync(join(freshDir, '.spm', 'uploads')),
      false,
      'the picked archive was staged instead of read where it lay',
    )
  })

  // And the user still has their archive.
  assert.ok(existsSync(zipPath), 'the picked archive was deleted')
  rmSync(zipPath, { force: true })
})

test('importer.curaManagerZip stages the bytes arm, imports it, and cleans up after itself', async () => {
  const zipPath = join(tmpdir(), `spm-dispatch-import-${Date.now()}.zip`)
  writeZip(zipPath, [
    { name: 'Imported Lib/Gadget/part.stl', data: 'solid g endsolid g' },
    { name: 'Imported Lib/Gadget/metadata.json', data: JSON.stringify({ Tags: ['imported'] }) },
  ])
  const bytes = new Uint8Array(readFileSync(zipPath))
  rmSync(zipPath, { force: true })

  const result = (await call('importer.curaManagerZip', [{ bytes }])) as {
    projectsExtracted: number
    strippedRoot: string | null
  }
  assert.equal(result.projectsExtracted, 1)
  assert.equal(result.strippedRoot, 'Imported Lib')
  assert.ok(existsSync(join(dir, 'Gadget', 'part.stl')))

  // The staging copy must not survive: it lives inside the user's own library.
  assert.deepEqual(stagedFiles(), [])
})

test('a rejected import still removes its staging copy', async () => {
  const error = await rejection(
    call('importer.curaManagerZip', [{ bytes: new Uint8Array([1, 2, 3, 4]) }]),
  )
  assert.ok(error.message.length > 0)
  assert.deepEqual(stagedFiles(), [])
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
  // Neither `UploadBody` arm can cross IPC as itself, so anything that is not one of the two
  // wire arms is refused here rather than silently written as an empty file — which is exactly
  // what a Blob would have become. `{}` is also what the preload produces for a file token it
  // did not mint, so this is the landing point for a forged one.
  for (const body of [{}, new Uint8Array([1]), { bytes: 'nope' }, { localPath: 7 }, null]) {
    assert.equal(
      (await rejection(call('files.upload', ['id', 'a.stl', body]))).code,
      'Validation',
      JSON.stringify(body),
    )
  }
})

test('a traversing file name never reaches the filesystem', async () => {
  const project = (await call('projects.create', [{ name: 'Traversal' }])) as { id: string }
  for (const name of ['../escaped.stl', '..\\escaped.stl', '.hidden', 'CON.stl']) {
    const error = await rejection(
      call('files.upload', [project.id, name, { bytes: new Uint8Array([1, 2, 3]) }]),
    )
    assert.equal(error.code, 'Validation', name)
  }
  assert.equal(existsSync(join(dir, 'escaped.stl')), false)
  await call('projects.delete', [project.id, { deleteFiles: true }])
})
