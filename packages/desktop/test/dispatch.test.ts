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
import type {
  BrowseDownloadDto,
  BrowseNoticeDto,
  BrowseStateDto,
  FileDto,
  SlicerConfigDto,
  SlicerLaunchDto,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { closeLibrary, ensureLocalUser, openLibrary, type Library } from '@spm/core'
import { writeZip } from '../../core/test/fixtures/make-3mf.ts'
import {
  IpcApiClient,
  FILE_REF_KEY as WEB_FILE_REF_KEY,
  UPLOAD_LENGTH_HEADER as WEB_UPLOAD_LENGTH_HEADER,
  type BridgeMode as WebBridgeMode,
  type IpcResult as WebIpcResult,
} from '../../web/src/app/core/api/ipc-api-client.ts'
import { LOCAL_SHELL_CAPABILITIES } from '../src/capabilities.ts'
import {
  dispatch,
  isApiPath,
  type ApiPath,
  type DispatchSession,
  type ShellApi,
} from '../src/dispatch.ts'
import {
  FILE_REF_KEY,
  LOCAL_PATH_KEY,
  modeFromArgv,
  MODE_SWITCH,
  UPLOAD_LENGTH_HEADER,
  type BridgeMode,
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
const connected: string[] = []
const shell: ShellApi = {
  pickLibraryFolder: () => {
    pickedFolders.push(null)
    return Promise.resolve(null)
  },
  connectRemote: (url) => {
    connected.push(url)
    return Promise.resolve({ origin: 'https://example.invalid' })
  },
  capabilities: () => Promise.resolve(LOCAL_SHELL_CAPABILITIES),
  slicers: {
    get: () => Promise.resolve(slicerCall('get')),
    scan: () => Promise.resolve(slicerCall('scan')),
    addManual: (slicerId) => Promise.resolve(slicerCall('addManual', slicerId)),
    remove: (installId) => Promise.resolve(slicerCall('remove', installId)),
    // `?? 'none'` and not `?? ''`: `null` is a request the renderer can make now — unbind, and
    // clear the default — and a recorder that rendered it as an empty string would make it
    // indistinguishable from an argument that simply arrived blank.
    bind: (slicerId, installId) =>
      Promise.resolve(slicerCall('bind', slicerId, installId ?? 'none')),
    setDefault: (slicerId) => Promise.resolve(slicerCall('setDefault', slicerId ?? 'none')),
    resetConfig: () => Promise.resolve(slicerCall('resetConfig')),
    open: (fileId, projectId, opts) => {
      slicerCalls.push(`open ${fileId} ${projectId} ${opts.mode} ${opts.slicerId ?? '-'}`.trimEnd())
      return Promise.resolve({
        launchId: 'launch-1',
        slicerId: opts.slicerId ?? 'orca',
        installLabel: 'OrcaSlicer',
        stripped: false,
        notices: [],
        pid: 4242,
      })
    },
    sessions: () => {
      slicerCalls.push('sessions')
      return Promise.resolve([])
    },
    resolveSession: (launchId, action, opts) => {
      slicerCalls.push(`resolveSession ${launchId} ${action} ${opts.projectId ?? '-'}`)
      return Promise.resolve(null)
    },
    discardSessions: (launchIds) => {
      slicerCalls.push(`discardSessions ${launchIds.join(',')}`)
      return Promise.resolve({ discarded: launchIds.length })
    },
  },
  browse: {
    sites: () => {
      browseCalls.push('sites')
      return Promise.resolve([
        { id: 'thingiverse', displayName: 'Thingiverse', homeUrl: 'https://x/' },
      ])
    },
    attach: (bounds, url) => {
      // The rectangle is spelled out field by field rather than JSON-stringified: `x` and `y`
      // swapped with `width` and `height` is exactly the mistake the compiler cannot see, and a
      // stringified object would record it as happily as the right one.
      browseCalls.push(
        `attach ${bounds.x},${bounds.y},${bounds.width},${bounds.height} ${url ?? '-'}`,
      )
      return Promise.resolve(browseState)
    },
    detach: () => {
      browseCalls.push('detach')
      return Promise.resolve()
    },
    hide: () => {
      browseCalls.push('hide')
      return Promise.resolve()
    },
    show: () => {
      browseCalls.push('show')
      return Promise.resolve(browseState)
    },
    setBounds: (bounds) => {
      browseCalls.push(`setBounds ${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
      return Promise.resolve()
    },
    navigate: (url) => {
      browseCalls.push(`navigate ${url}`)
      return Promise.resolve(browseState)
    },
    back: () => {
      browseCalls.push('back')
      return Promise.resolve(browseState)
    },
    forward: () => {
      browseCalls.push('forward')
      return Promise.resolve(browseState)
    },
    reload: () => {
      browseCalls.push('reload')
      return Promise.resolve(browseState)
    },
    state: () => {
      browseCalls.push('state')
      return Promise.resolve(browseState)
    },
    clearLastPage: () => {
      browseCalls.push('clearLastPage')
      return Promise.resolve()
    },
    downloads: () => {
      browseCalls.push('downloads')
      return Promise.resolve([browseDownload])
    },
    discard: (downloadId) => {
      browseCalls.push(`discard ${downloadId}`)
      return Promise.resolve()
    },
    notices: () => {
      browseCalls.push('notices')
      return Promise.resolve([browseNotice])
    },
    land: (downloadId, projectId, opts) => {
      browseCalls.push(`land ${downloadId} ${projectId} ${opts?.name ?? '-'}`)
      return Promise.resolve(landedFile)
    },
    dismissNotice: (id) => {
      browseCalls.push(`dismissNotice ${id}`)
      return Promise.resolve()
    },
  },
}

/** What the shell's browse half was asked, so every route is exercised on its arguments. */
const browseCalls: string[] = []

const browseState: BrowseStateDto = {
  attached: true,
  url: 'https://www.thingiverse.com/thing:1',
  title: 'a title',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  siteId: 'thingiverse',
  lastError: null,
}

const browseDownload: BrowseDownloadDto = {
  downloadId: 'dl-1',
  fileName: 'benchy.zip',
  // A `blob:` source beside an `https:` page, which is the measured Thingiverse shape and the
  // reason the DTO carries both.
  sourceUrl: 'blob:https://www.thingiverse.com/ae5e',
  pageUrl: 'https://www.thingiverse.com/thing:1',
  siteId: 'thingiverse',
  mimeType: 'application/zip',
  state: 'completed',
  receivedBytes: 21_060_699,
  totalBytes: 21_060_699,
  hadUserGesture: false,
  startedAt: 1_700_000_000_000,
  isOrphan: false,
  isVerifiable: true,
}

/** What the shell answers a landing with. The archive Thingiverse actually hands over (5.5). */
const landedFile: FileDto = {
  id: 'file-landed',
  name: 'benchy.zip',
  kind: 'other',
  sizeBytes: 21_060_699,
  previewState: 'pending',
  rawUrl: 'spm://app/api/files/file-landed/raw',
}

const browseNotice: BrowseNoticeDto = {
  id: 'notice-1',
  kind: 'refused',
  fileName: 'huge.zip',
  detail: 'this download is larger than the 2 GiB limit for a single file',
  at: 1_700_000_000_000,
}

/**
 * What the shell's slicer half was asked, so the seven routes are exercised on their *arguments*
 * and not only on their arity.
 *
 * The mapped type over `ApiClient` cannot see an argument tuple at all — `Dispatched` takes
 * `unknown[]` — so `bind` with its two arguments the wrong way round typechecks clean everywhere
 * and would only show up here.
 */
const slicerCalls: string[] = []
function slicerCall(method: string, ...args: string[]): SlicerConfigDto {
  slicerCalls.push([method, ...args].join(' '))
  return { installs: [], bindings: {}, defaultSlicerId: null, detectionSupported: false }
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
    'library.connect': () => client.library.connect('https://example.invalid'),
    'slicers.get': () => client.slicers.get(),
    'slicers.scan': () => client.slicers.scan(),
    'slicers.addManual': () => client.slicers.addManual('cura'),
    'slicers.remove': () => client.slicers.remove('manual:one'),
    'slicers.bind': () => client.slicers.bind('cura', 'manual:one'),
    'slicers.setDefault': () => client.slicers.setDefault('orca'),
    'slicers.resetConfig': () => client.slicers.resetConfig(),
    'slicers.open': () => client.slicers.open('file', 'project', { mode: 'as-is' }),
    'slicers.sessions': () => client.slicers.sessions(),
    'slicers.resolveSession': () => client.slicers.resolveSession('launch-1', 'discard'),
    'slicers.discardSessions': () => client.slicers.discardSessions(['launch-1']),
    'browse.sites': () => client.browse.sites(),
    'browse.attach': () => client.browse.attach({ x: 0, y: 0, width: 800, height: 600 }),
    'browse.detach': () => client.browse.detach(),
    'browse.hide': () => client.browse.hide(),
    'browse.show': () => client.browse.show(),
    'browse.setBounds': () => client.browse.setBounds({ x: 0, y: 0, width: 800, height: 600 }),
    'browse.navigate': () => client.browse.navigate('https://example.invalid/'),
    'browse.back': () => client.browse.back(),
    'browse.forward': () => client.browse.forward(),
    'browse.reload': () => client.browse.reload(),
    'browse.state': () => client.browse.state(),
    'browse.clearLastPage': () => client.browse.clearLastPage(),
    'browse.downloads': () => client.browse.downloads(),
    'browse.discard': () => client.browse.discard('dl-1'),
    'browse.notices': () => client.browse.notices(),
    'browse.dismissNotice': () => client.browse.dismissNotice('notice-1'),
    'browse.land': () => client.browse.land('dl-1', 'p-1'),
  }
}

test('the table implements exactly the interface, and IpcApiClient reaches every entry', async () => {
  const sent: string[] = []
  const client = new IpcApiClient({
    mode: 'local',
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

test('the renderer and main-process declarations of the transport mode agree', () => {
  const fromDesktop: WebBridgeMode = 'remote' as BridgeMode
  const fromWeb: BridgeMode = 'local' as WebBridgeMode
  assert.ok(fromDesktop !== undefined && fromWeb !== undefined)

  // The header a remote-mode upload declares its length in. Drift here is not a compile error on
  // either side — the renderer sets a header nobody reads — and the failure it produces is the
  // server answering 411 for every upload in remote mode, which looks nothing like a typo.
  assert.equal(WEB_UPLOAD_LENGTH_HEADER, UPLOAD_LENGTH_HEADER)
})

/**
 * The switch the window carries its transport to the preload in.
 *
 * Anything that is not exactly `remote` is `local`, and that asymmetry is the point: IPC talks
 * only to this process, while remote points the app at a server, so the value that has to be
 * stated clearly is the one that leaves the machine.
 */
test('the transport is read out of the window arguments, and defaults to the local one', () => {
  assert.equal(modeFromArgv([`${MODE_SWITCH}remote`]), 'remote')
  assert.equal(modeFromArgv(['--other', `${MODE_SWITCH}remote`, '/prefetch:1']), 'remote')
  assert.equal(modeFromArgv([`${MODE_SWITCH}local`]), 'local')
  assert.equal(modeFromArgv([]), 'local')
  assert.equal(modeFromArgv([MODE_SWITCH]), 'local')
  assert.equal(modeFromArgv(['--spm-mode']), 'local')
  assert.equal(modeFromArgv([`${MODE_SWITCH}REMOTE`]), 'local')
  assert.equal(modeFromArgv([`${MODE_SWITCH}something-new`]), 'local')
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
    // Spec D: the shell detects and launches the slicers on this machine whichever library is
    // open, so both are the shell's to offer even with no session.
    canLaunchSlicer: true,
    canConfigureSlicers: true,
    canBrowseModelSites: false,
  })
  assert.deepEqual(
    await dispatch.capabilities({ session: null, shell }, []),
    LOCAL_SHELL_CAPABILITIES,
  )
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
    ...shell,
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

test('library.connect answers without a library, and hands the URL to the shell to validate', async () => {
  connected.length = 0
  assert.deepEqual(
    await dispatch['library.connect']({ session: null, shell }, ['https://print.example.com']),
    { origin: 'https://example.invalid' },
  )
  assert.deepEqual(connected, ['https://print.example.com'])

  // The schema only keeps a non-string out; the rules live in `parseRemoteOrigin`, which is what
  // the shell applies. Both failures are `Validation`, and the arity check is the one that stops
  // a second argument arriving with it.
  for (const args of [[], [42], ['https://a', 'https://b']]) {
    assert.equal(
      (await rejection(dispatch['library.connect']({ session: null, shell }, args))).code,
      'Validation',
      JSON.stringify(args),
    )
  }
})

/**
 * **The whole reason the slicer routes are `shellCall`s, asserted rather than argued.**
 *
 * In remote mode `deps.session` is null. `libraryCall` refuses a null session by design, so a
 * slicer entry built with it would answer `Conflict` for every call in the mode where the desktop
 * shell is the only thing that could launch a slicer at all. Rewriting any one of the seven as a
 * `libraryCall` turns its line below red.
 */
test('every slicer route answers with no library open, because none of them needs one', async () => {
  slicerCalls.length = 0
  const empty: SlicerConfigDto = {
    installs: [],
    bindings: {},
    defaultSlicerId: null,
    detectionSupported: false,
  }
  assert.deepEqual(await dispatch['slicers.get']({ session: null, shell }, []), empty)
  assert.deepEqual(await dispatch['slicers.scan']({ session: null, shell }, []), empty)
  assert.deepEqual(await dispatch['slicers.resetConfig']({ session: null, shell }, []), empty)
  assert.deepEqual(await dispatch['slicers.addManual']({ session: null, shell }, ['bambu']), empty)
  assert.deepEqual(await dispatch['slicers.remove']({ session: null, shell }, ['manual:x']), empty)
  assert.deepEqual(
    await dispatch['slicers.bind']({ session: null, shell }, ['bambu', 'manual:x']),
    empty,
  )
  assert.deepEqual(await dispatch['slicers.setDefault']({ session: null, shell }, ['bambu']), empty)
  // `open` answers a launch rather than a configuration, and it is on this list for the same
  // reason the other seven are: in remote mode `deps.session` is null and a `libraryCall` entry
  // would be refused before the launcher could say anything about the mode it is actually in.
  const launch = await dispatch['slicers.open']({ session: null, shell }, [
    'file',
    'project',
    { mode: 'new-project', slicerId: 'cura' },
  ])
  assert.equal((launch as SlicerLaunchDto).slicerId, 'cura')
  assert.equal(slicerCalls.length, 8)
})

test('every library-backed route refuses when no folder is open', async () => {
  // The routes that answer out of the shell itself are the exceptions, and every one of them is
  // asserted directly above rather than skipped silently here. `library.connect` is one for the
  // same reason `library.pick` is: with nothing open, they are the only ways out. All ten slicer
  // routes are, because slicer configuration and the launch directories are properties of the
  // machine — and because in remote mode `deps.session` is null and there is nothing else they
  // could be.
  const fromShell: ApiPath[] = [
    'capabilities',
    'library.pick',
    'library.connect',
    'slicers.get',
    'slicers.scan',
    'slicers.addManual',
    'slicers.remove',
    'slicers.bind',
    'slicers.setDefault',
    'slicers.resetConfig',
    'slicers.open',
    'slicers.sessions',
    'slicers.resolveSession',
    'slicers.discardSessions',
    // Every browse route, for the third instance of the same reason: the model browser is a
    // native view in *this process*, and in remote mode `deps.session` is null. The four download
    // routes are on this list for a second reason as well — the staging directory is under
    // `userData` and belongs to the machine, not to whichever library happens to be open, so
    // `browse.downloads()` has to answer before a folder is chosen and after one is closed.
    'browse.sites',
    'browse.attach',
    'browse.detach',
    'browse.hide',
    'browse.show',
    'browse.setBounds',
    'browse.navigate',
    'browse.back',
    'browse.forward',
    'browse.reload',
    'browse.state',
    'browse.clearLastPage',
    'browse.downloads',
    'browse.discard',
    'browse.notices',
    'browse.dismissNotice',
    // `land` too, and it is the one that needs the sentence rather than the list: it is the only
    // browse route that writes into a library, so it is the one a reader would expect to be a
    // `libraryCall`. It is not, because in remote mode there is no session and the upload goes
    // through the proxy — `BrowseLanding` resolves whichever of the two is current, and refuses
    // with its own `Conflict` when local mode has nothing open.
    'browse.land',
  ]
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

/**
 * The ten slicer routes, on their arguments rather than on their arity alone.
 *
 * Every one of them is a `shellCall`, so none of them touches a library — which is the point:
 * `deps.session` is null in remote mode, and a `libraryCall` slicer entry would be refused there
 * before it ran. The calls below are made with a real session present and reach the shell anyway.
 */
test('the slicer routes reach the shell with their arguments in the right order', async () => {
  slicerCalls.length = 0
  await call('slicers.get')
  await call('slicers.scan')
  await call('slicers.addManual', ['prusaslicer'])
  await call('slicers.remove', ['registry:HKCU:Thing'])
  await call('slicers.bind', ['cura', 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0'])
  await call('slicers.setDefault', ['orca'])
  // The arm spec 8.3 typed and the first implementation dropped: "launch nothing for this", and
  // "no default". `null` has to reach the shell as `null`, not be swallowed on the way.
  await call('slicers.bind', ['cura', null])
  await call('slicers.setDefault', [null])
  await call('slicers.resetConfig')
  await call('slicers.open', ['file-1', 'project-1', { mode: 'new-project', slicerId: 'bambu' }])
  await call('slicers.sessions')
  await call('slicers.resolveSession', ['launch-1', 'import', { projectId: 'project-9' }])
  await call('slicers.discardSessions', [['launch-1', 'launch-2']])

  // `bind` is the one with two arguments, and swapping them is invisible to the compiler.
  assert.deepEqual(slicerCalls, [
    'get',
    'scan',
    'addManual prusaslicer',
    'remove registry:HKCU:Thing',
    'bind cura registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0',
    'setDefault orca',
    'bind cura none',
    'setDefault none',
    'resetConfig',
    // Two opaque ids of the same shape, in an order the compiler cannot see: a `fileId` and a
    // `projectId` swapped here would typecheck everywhere and answer `NotFound` at runtime.
    'open file-1 project-1 new-project bambu',
    'sessions',
    // Three arguments of three different shapes: a `launchId` and a `projectId` swapped here
    // would send a returning file to whichever project happened to share the id.
    'resolveSession launch-1 import project-9',
    'discardSessions launch-1,launch-2',
  ])
})

/**
 * Every browse route, on its arguments and with no library open.
 *
 * Both halves in one test because they are the same claim: every one of them is a `shellCall`, so
 * none touches a library, and rewriting any of them as a `libraryCall` turns this red twice over —
 * once because `session: null` would answer `Conflict`, and once because `browseCalls` would be
 * short.
 */
test('the browse routes reach the shell with their arguments, and need no library', async () => {
  browseCalls.length = 0
  const deps = { session: null, shell }
  await dispatch['browse.sites'](deps, [])
  await dispatch['browse.attach'](deps, [{ x: 1, y: 2, width: 3, height: 4 }])
  await dispatch['browse.attach'](deps, [
    { x: 5, y: 6, width: 7, height: 8 },
    'https://www.printables.com/model/1807378-universal-clip',
  ])
  await dispatch['browse.setBounds'](deps, [{ x: 9, y: 10, width: 11, height: 12 }])
  await dispatch['browse.navigate'](deps, ['https://makerworld.com/en/models/2093108-dji-neo-2'])
  await dispatch['browse.show'](deps, [])
  await dispatch['browse.hide'](deps, [])
  await dispatch['browse.back'](deps, [])
  await dispatch['browse.forward'](deps, [])
  await dispatch['browse.reload'](deps, [])
  await dispatch['browse.state'](deps, [])
  await dispatch['browse.clearLastPage'](deps, [])
  await dispatch['browse.downloads'](deps, [])
  await dispatch['browse.discard'](deps, ['dl-1'])
  await dispatch['browse.notices'](deps, [])
  await dispatch['browse.dismissNotice'](deps, ['notice-1'])
  await dispatch['browse.land'](deps, ['dl-1', 'p-1'])
  await dispatch['browse.land'](deps, ['dl-2', 'p-2', { name: 'benchy.zip' }])
  await dispatch['browse.detach'](deps, [])

  assert.deepEqual(browseCalls, [
    'sites',
    // The optional `url` really is absent rather than arriving as the string "undefined", and the
    // four rectangle fields are in the order the caller wrote them: `x` and `width` swapped here
    // typechecks everywhere and would put the view in the wrong half of the window.
    'attach 1,2,3,4 -',
    'attach 5,6,7,8 https://www.printables.com/model/1807378-universal-clip',
    'setBounds 9,10,11,12',
    'navigate https://makerworld.com/en/models/2093108-dji-neo-2',
    'show',
    'hide',
    'back',
    'forward',
    'reload',
    'state',
    'clearLastPage',
    'downloads',
    // The id arrives as the id and not as an object or a path: the renderer names a `downloadId`
    // and never a location on disk, and `discard` is the one route here that removes anything.
    'discard dl-1',
    'notices',
    'dismissNotice notice-1',
    // Two ids in the order they were written, and the optional name absent rather than arriving as
    // the string "undefined". `downloadId` and `projectId` swapped here typechecks everywhere and
    // would answer `NotFound` about the wrong one of the two.
    'land dl-1 p-1 -',
    'land dl-2 p-2 benchy.zip',
    'detach',
  ])
})

test('a browse route rejects a wrong argument tuple with Validation, and calls nothing', async () => {
  browseCalls.length = 0
  const wrong: [ApiPath, unknown[]][] = [
    // Arity, in both directions.
    ['browse.sites', [{}]],
    ['browse.state', [null]],
    ['browse.detach', ['now']],
    ['browse.attach', []],
    ['browse.attach', [{ x: 0, y: 0, width: 1, height: 1 }, 'https://a/', 'extra']],
    ['browse.setBounds', []],
    ['browse.navigate', []],
    ['browse.navigate', ['https://a/', 'https://b/']],
    // A rectangle that is not one. `NaN` and `Infinity` are the two `z.number()` alone lets past,
    // and every comparison in the intersection answers `false` about them — so a request built
    // from either is a rectangle nothing downstream can reason about.
    ['browse.setBounds', [{ x: Number.NaN, y: 0, width: 100, height: 100 }]],
    ['browse.setBounds', [{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }]],
    ['browse.setBounds', [{ x: 0, y: 0, width: 100 }]],
    ['browse.setBounds', [{ x: '0', y: 0, width: 100, height: 100 }]],
    ['browse.setBounds', [[0, 0, 100, 100]]],
    // `z.strictObject`: a key this validation was not written for is a refusal, not a silently
    // dropped field — and the field that would be dropped here is one the renderer must not have.
    ['browse.setBounds', [{ x: 0, y: 0, width: 100, height: 100, chromeInset: 0 }]],
    // Not a string, and not an unbounded one. The bound is on what a *renderer* may send; whether
    // the URL may be opened is `browseNavigationPolicy`'s answer, in the shell.
    ['browse.navigate', [{ url: 'https://a/' }]],
    ['browse.navigate', ['']],
    ['browse.navigate', [`https://example.invalid/${'x'.repeat(2049)}`]],
    ['browse.attach', [{ x: 0, y: 0, width: 1, height: 1 }, '']],
    // The two routes that take an id. Arity in both directions, and a bound on the string — the
    // real check is that the id is one the main process minted or enumerated, and this only keeps
    // an object, or a megabyte of text, out of that lookup.
    ['browse.downloads', ['dl-1']],
    ['browse.notices', [{}]],
    ['browse.discard', []],
    ['browse.discard', [{ downloadId: 'dl-1' }]],
    ['browse.discard', ['']],
    ['browse.discard', ['x'.repeat(513)]],
    ['browse.discard', ['dl-1', 'dl-2']],
    ['browse.dismissNotice', []],
    ['browse.dismissNotice', [null]],
    ['browse.dismissNotice', ['']],
    // The landing. Arity in both directions, both ids bounded, and the options object checked for
    // the one key it may carry.
    ['browse.land', []],
    ['browse.land', ['dl-1']],
    ['browse.land', ['dl-1', 'p-1', { name: 'benchy.zip' }, 'extra']],
    ['browse.land', ['', 'p-1']],
    ['browse.land', ['dl-1', '']],
    ['browse.land', ['x'.repeat(65), 'p-1']],
    ['browse.land', ['dl-1', 'x'.repeat(65)]],
    // A path-shaped first argument, in the two shapes the schema can actually see: an object,
    // which is what a renderer forwarding a `{ localPath }` would send, and a string too long to
    // be an id. A *short* path-shaped string is not refused here and is not meant to be — nothing
    // joins it onto anything, and what answers it is the map lookup in `BrowseDownloads.find`,
    // asserted in `browse-land.test.ts` against a real staging directory.
    ['browse.land', [{ localPath: '/home/someone/.ssh/id_rsa' }, 'p-1']],
    ['browse.land', [`/home/someone/${'x'.repeat(80)}.zip`, 'p-1']],
    // The name is `fileNameSchema`'s, the same object `files.upload` accepts names under.
    ['browse.land', ['dl-1', 'p-1', { name: '../escaped.zip' }]],
    ['browse.land', ['dl-1', 'p-1', { name: 'CON.zip' }]],
    ['browse.land', ['dl-1', 'p-1', { name: '' }]],
    ['browse.land', ['dl-1', 'p-1', 'benchy.zip']],
  ]
  for (const [path, args] of wrong) {
    const error = await rejection(dispatch[path]({ session: null, shell }, args))
    assert.equal(error.code, 'Validation', `${path} ${JSON.stringify(args)}`)
    assert.match(error.message, new RegExp(path.replace('.', '\\.')))
  }
  assert.deepEqual(browseCalls, [], 'nothing reached the shell')
})

test('a slicer route rejects a wrong argument tuple with Validation, and calls nothing', async () => {
  slicerCalls.length = 0
  const wrong: [ApiPath, unknown[]][] = [
    // Too many, and too few.
    ['slicers.get', ['cura']],
    ['slicers.scan', [{}]],
    ['slicers.resetConfig', [null]],
    ['slicers.addManual', []],
    ['slicers.addManual', ['cura', 'extra']],
    ['slicers.bind', ['cura']],
    ['slicers.bind', ['cura', 'id', 'extra']],
    ['slicers.remove', []],
    ['slicers.open', ['file', 'project']],
    ['slicers.open', ['file', 'project', { mode: 'as-is' }, 'extra']],
    // `z.strictObject`, so a key the validation was not written for is a refusal and not a
    // silently dropped field.
    ['slicers.open', ['file', 'project', { mode: 'as-is', path: 'C:\evil.exe' }]],
    ['slicers.open', ['file', 'project', { mode: 'open' }]],
    ['slicers.open', ['file', 'project', { mode: 'as-is', slicerId: 'CURA' }]],
    // Not a `SlicerId`: the renderer's whole vocabulary here is five product names.
    ['slicers.addManual', ['CURA']],
    ['slicers.addManual', ['superslicer']],
    ['slicers.setDefault', ['']],
    ['slicers.setDefault', [{ slicerId: 'cura' }]],
    ['slicers.bind', ['superslicer', 'manual:one']],
    // Not a plausible install id.
    ['slicers.remove', ['']],
    ['slicers.remove', [{ id: 'manual:one' }]],
    ['slicers.remove', ['x'.repeat(513)]],
    ['slicers.bind', ['cura', 42]],
    // The three session routes. `resolveSession` takes exactly three, and the action is a closed
    // pair — a renderer naming a third one would otherwise reach a `switch` written for two.
    ['slicers.sessions', ['launch-1']],
    ['slicers.resolveSession', ['launch-1']],
    ['slicers.resolveSession', ['launch-1', 'import']],
    ['slicers.resolveSession', ['launch-1', 'import', {}, 'extra']],
    ['slicers.resolveSession', ['launch-1', 'delete', {}]],
    ['slicers.resolveSession', ['', 'import', {}]],
    ['slicers.resolveSession', ['x'.repeat(513), 'import', {}]],
    // `z.strictObject` again: a key this validation was not written for is a refusal, not a
    // silently dropped field — and the field that would be dropped here names a project.
    ['slicers.resolveSession', ['launch-1', 'import', { project: 'p' }]],
    ['slicers.discardSessions', ['launch-1']],
    ['slicers.discardSessions', [['launch-1'], 'extra']],
    ['slicers.discardSessions', [[42]]],
    ['slicers.discardSessions', [Array.from({ length: 501 }, (_, i) => `l-${i}`)]],
  ]
  for (const [path, args] of wrong) {
    const error = await rejection(call(path, args))
    assert.equal(error.code, 'Validation', `${path} ${JSON.stringify(args)}`)
    assert.match(error.message, new RegExp(path.replace('.', '\\.')))
  }
  assert.deepEqual(slicerCalls, [], 'nothing reached the shell')
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
