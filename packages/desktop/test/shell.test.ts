import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { LOCAL_SHELL_CAPABILITIES } from '../src/capabilities.ts'
import {
  LibraryHost,
  MODE_CHOICES,
  modeChoiceAt,
  modePickerOptions,
  type ModeChoice,
  type ModePickerOptions,
} from '../src/library.ts'
import type { PreviewTicker } from '../src/previews.ts'
import { API_PATH_PREFIX } from '../src/protocol.ts'
import { RemoteHost } from '../src/remote.ts'
import { ShellHost, type ShellRoute } from '../src/shell.ts'
import { rememberChoice, STATE_FILE_NAME, writeState } from '../src/state.ts'
import { RENDERER_ORIGIN } from '../src/urls.ts'

/**
 * Which of spec 2.6's two modes the shell is in, and — the part the plan names by itself —
 * **switching between them without leaking the previous mode's client**.
 *
 * The renderer's half of that (a stale `HttpApiClient`) is structural: the transport is fixed at
 * window creation and a change of transport replaces the window, which `test/remote.spec.ts`
 * drives through a real one. This file is the main process's half, which is the half that would
 * actually have shipped broken: a `RemoteHost` still answering out of a server the user has left,
 * or a `LibraryHost` still ticking previews into a folder they have left.
 */

let root: string
let server: Server
let origin: string
let requests: string[] = []

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'spm-shell-'))
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        requiresAuth: true,
        canManageUsers: true,
        canPickLocalFolder: false,
        canLaunchSlicer: false,
        canConfigureSlicers: false,
        canBrowseModelSites: false,
      }),
    )
  })
  await new Promise<void>((resolve_) => server.listen(0, '127.0.0.1', resolve_))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  origin = `http://127.0.0.1:${address.port}`
})

after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

let seq = 0

function stateFileFor(): string {
  seq += 1
  return join(root, `state-${seq}`, STATE_FILE_NAME)
}

function folderWithProject(name: string, project: string): string {
  const dir = join(root, `${name}-${(seq += 1)}`)
  mkdirSync(join(dir, project), { recursive: true })
  writeFileSync(join(dir, project, 'part.stl'), 'solid part\nendsolid part\n')
  return dir
}

type FakeTicker = PreviewTicker & { stopRequested: boolean }

const madeTickers: FakeTicker[] = []

function fakeTicker(): FakeTicker {
  const ticker: FakeTicker = {
    stopRequested: false,
    stop: async () => {
      ticker.stopRequested = true
      await Promise.resolve()
    },
  }
  madeTickers.push(ticker)
  return ticker
}

type Harness = {
  shell: ShellHost
  library: LibraryHost
  stateFile: string
  tickers: FakeTicker[]
  /** Every window replacement the shell asked for, and every navigation. */
  replacements: number
  navigations: ShellRoute[]
  modeQuestions: ModePickerOptions[]
}

const openHosts: LibraryHost[] = []

function harness(options: {
  answerMode?: ModeChoice
  folder?: string | null
  stateFile?: string
}): Harness {
  const tickers: FakeTicker[] = []
  const navigations: ShellRoute[] = []
  const modeQuestions: ModePickerOptions[] = []
  const counters = { replacements: 0 }
  const stateFile = options.stateFile ?? stateFileFor()
  const library = new LibraryHost({
    stateFile,
    pick: () => Promise.resolve(options.folder ?? null),
    startTicker: () => {
      const ticker = fakeTicker()
      tickers.push(ticker)
      return ticker
    },
  })
  openHosts.push(library)
  const shell = new ShellHost({
    stateFile,
    library,
    askMode: (asked) => {
      modeQuestions.push(asked)
      return Promise.resolve(options.answerMode ?? 'cancel')
    },
    onTransportChanged: () => {
      counters.replacements += 1
    },
    onNavigate: (route) => navigations.push(route),
    // Pointed at the test's own server, so `capabilities()` is a real request and the union is a
    // real answer rather than a stub agreeing with the code under test.
    makeRemote: (target) => new RemoteHost(target),
  })
  return {
    shell,
    library,
    stateFile,
    tickers,
    navigations,
    modeQuestions,
    get replacements(): number {
      return counters.replacements
    },
  }
}

afterEach(async () => {
  for (const host of openHosts.splice(0)) {
    host.shutdown()
    await host.whenSettled()
  }
  requests = []
})

function readState(stateFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>
}

/* -------------------------------------------------------------------------------------------
 * The mode question
 * ---------------------------------------------------------------------------------------- */

test('the mode question offers exactly the two modes, and a way out', () => {
  const options = modePickerOptions('en')
  assert.deepEqual(options.buttons, ['Open a local folder…', 'Connect to a server…', 'Not now'])
  assert.equal(options.type, 'question')
  assert.equal(options.message, 'Where is your library?')
  // The escape key must land on the answer that changes nothing, and the default on the mode
  // that needs no server.
  assert.equal(options.cancelId, 2)
  assert.equal(options.defaultId, 0)
  assert.equal(modePickerOptions('de').message, 'Wo liegt Ihre Bibliothek?')

  // The answer comes back as an index, so the mapping is the one thing that must not drift.
  assert.deepEqual(
    MODE_CHOICES.map((_, index) => modeChoiceAt(index)),
    ['local', 'remote', 'cancel'],
  )
  // Anything out of range is a cancel, which is the answer that changes nothing.
  assert.equal(modeChoiceAt(-1), 'cancel')
  assert.equal(modeChoiceAt(7), 'cancel')
})

test('first run asks which mode, and nothing is open until it is answered', () => {
  const h = harness({})
  assert.deepEqual(h.shell.start({}), { prompt: null })
  assert.equal(h.shell.mode(), 'unset')
  assert.equal(h.shell.session(), null)
  assert.equal(h.shell.remote(), null)
  assert.equal(h.modeQuestions.length, 0, 'the question is raised by main(), not by start()')
})

test('answering local goes on to the folder dialog, and remembers the mode with the folder', async () => {
  const chosen = folderWithProject('chosen', 'Widget')
  const h = harness({ answerMode: 'local', folder: chosen })
  h.shell.start({})

  assert.equal(await h.shell.askForMode(), 'local')

  assert.equal(h.modeQuestions.length, 1)
  assert.equal(h.shell.mode(), 'local')
  assert.equal(h.library.dir(), resolve(chosen))
  assert.deepEqual(readState(h.stateFile), { libraryDir: resolve(chosen), mode: 'local' })
  // The transport did not change — a shell with nothing open already serves the IPC one — so the
  // window is reloaded (by `LibraryHost`) rather than replaced.
  assert.equal(h.replacements, 0)
})

test('answering remote sends the window to the connect page and opens nothing yet', async () => {
  const h = harness({ answerMode: 'remote' })
  h.shell.start({})

  assert.equal(await h.shell.askForMode(), 'remote')

  assert.deepEqual(h.navigations, ['connect'])
  assert.equal(h.shell.mode(), 'unset', 'the URL has not been given yet')
  assert.equal(h.shell.remote(), null)
  assert.equal(existsSync(h.stateFile), false, 'and nothing has been written down')
})

test('cancelling changes nothing at all', async () => {
  const chosen = folderWithProject('kept', 'Widget')
  const h = harness({ answerMode: 'cancel', folder: chosen })
  h.shell.connectRemote(origin)

  assert.equal(await h.shell.askForMode(), 'cancel')

  assert.equal(h.shell.mode(), 'remote')
  assert.equal(h.shell.remote()?.origin, origin)
  assert.deepEqual(h.navigations, [])
})

test('two mode questions at once are one dialog', async () => {
  const h = harness({ answerMode: 'cancel' })
  const [first, second] = await Promise.all([h.shell.askForMode(), h.shell.askForMode()])
  assert.equal(first, 'cancel')
  assert.equal(second, 'cancel')
  assert.equal(h.modeQuestions.length, 1, 'a second native message box must not stack on the first')
})

/* -------------------------------------------------------------------------------------------
 * What is remembered, and what is read back
 * ---------------------------------------------------------------------------------------- */

test('a remembered server is reconnected at startup without asking, and asks for no window', () => {
  const stateFile = stateFileFor()
  rememberChoice(stateFile, 'remote', origin)
  const h = harness({ stateFile })

  assert.deepEqual(h.shell.start({}), { opened: true })
  assert.equal(h.shell.mode(), 'remote')
  assert.equal(h.shell.remote()?.origin, origin)
  assert.equal(requests.length, 0, 'and the server is not contacted to start the app')
  // There is no window to replace at startup: `main()` builds the first one from `transport()`
  // straight after this. Measured with the callback firing here anyway — two windows at every
  // remote-mode launch, and every Playwright assertion still green, because `firstWindow()`
  // answered the first of them.
  assert.equal(h.replacements, 0)
})

test('a state file from task 4 — a folder and no mode — still opens its folder', () => {
  const stateFile = stateFileFor()
  const dir = folderWithProject('task4', 'Widget')
  // Exactly what task 4 wrote: one key, no `mode`. Upgrading must not throw the user back to a
  // question they already answered.
  writeState(stateFile, { libraryDir: dir })
  const h = harness({ stateFile })

  assert.deepEqual(h.shell.start({}), { opened: true })
  assert.equal(h.shell.mode(), 'local')
  assert.equal(h.library.dir(), resolve(dir))
})

test('a remembered remote mode with no usable URL asks again rather than guessing', () => {
  for (const state of [
    { mode: 'remote' },
    { mode: 'remote', remoteUrl: '' },
    { mode: 'remote', remoteUrl: 'not a url' },
    { mode: 'remote', remoteUrl: 'file:///C:/somewhere' },
    { mode: 'sideways', remoteUrl: origin },
  ]) {
    const stateFile = stateFileFor()
    writeState(stateFile, state)
    const h = harness({ stateFile })
    assert.deepEqual(h.shell.start({}), { prompt: null }, JSON.stringify(state))
    assert.equal(h.shell.mode(), 'unset', JSON.stringify(state))
  }
})

test('switching modes keeps the other mode target written down', () => {
  const stateFile = stateFileFor()
  const dir = folderWithProject('kept-folder', 'Widget')
  const h = harness({ stateFile, folder: dir })
  rememberChoice(stateFile, 'local', dir)

  h.shell.connectRemote(origin)

  // The folder is still in the file: switching to a server and back should not make the shell
  // forget which folder it was. Only `mode` decides which is read at startup.
  assert.deepEqual(readState(stateFile), { libraryDir: dir, mode: 'remote', remoteUrl: origin })
})

test('SPM_REMOTE_URL points one launch at a server and is not remembered', () => {
  const h = harness({})
  assert.deepEqual(h.shell.start({ SPM_REMOTE_URL: `${origin}/` }), { opened: true })
  assert.equal(h.shell.remote()?.origin, origin)
  assert.equal(existsSync(h.stateFile), false, 'an override for one launch is not a choice')
})

test('naming both a folder and a server for one launch is refused, not resolved', () => {
  const h = harness({})
  const dir = folderWithProject('both', 'Widget')
  assert.throws(
    () => h.shell.start({ SPM_LIBRARY_DIR: dir, SPM_REMOTE_URL: origin }),
    /name two different libraries/,
  )
})

test('SPM_REMOTE_URL that is not a URL fails the launch rather than asking something else', () => {
  const h = harness({})
  assert.throws(() => h.shell.start({ SPM_REMOTE_URL: 'not a url' }), /not a URL/)
})

/* -------------------------------------------------------------------------------------------
 * The leak hunt
 * ---------------------------------------------------------------------------------------- */

test('connecting to a server lets go of the local library, and of its preview ticker', async () => {
  const dir = folderWithProject('left-behind', 'Widget')
  const h = harness({ folder: dir })
  h.library.open(dir)
  assert.equal(h.tickers.length, 1)
  const session = h.library.session()
  assert.ok(session)

  h.shell.connectRemote(origin)
  await h.library.whenSettled()

  // The ticker is the failure task 4 measured from the other direction: left running, it renders
  // thumbnails into a folder nobody is looking at for as long as the app stays up.
  assert.equal(h.tickers[0]!.stopRequested, true)
  assert.equal(
    h.shell.session(),
    null,
    'and the IPC routes must report no library, not the old one',
  )
  assert.equal(h.library.dir(), null)
  // Closed, not merely forgotten: a query on a closed DatabaseSync throws.
  assert.throws(() => session.lib.db.prepare('SELECT 1').get())
})

test('opening a folder lets go of the server, its session, and the /api route with it', async () => {
  const dir = folderWithProject('back-to-local', 'Widget')
  const h = harness({ answerMode: 'local', folder: dir })
  h.shell.connectRemote(origin)
  const remote = h.shell.remote()
  assert.ok(remote)

  await h.shell.askForMode()

  assert.equal(h.shell.mode(), 'local')
  assert.equal(h.shell.remote(), null, 'the protocol handler must find no server to proxy to')
  // The object itself is closed, not just dropped: anything still holding a reference — a request
  // already in flight, a captured accessor a later task might add — must fail rather than reach
  // a server the user has left.
  assert.equal(
    (await remote.proxy(new Request(`${RENDERER_ORIGIN}${API_PATH_PREFIX}/projects`))).status,
    503,
  )
  assert.equal(remote.hasSession(), false)
  assert.equal(requests.length, 0)
})

test('the transport callback fires exactly on a change of transport, and not otherwise', async () => {
  const first = folderWithProject('one', 'Widget')
  const second = folderWithProject('two', 'Gadget')
  const h = harness({ folder: first })

  h.library.open(first)
  assert.equal(h.replacements, 0, 'nothing open to a local library is not a change of transport')

  h.shell.connectRemote(origin)
  assert.equal(h.replacements, 1)

  // The same server again is not a change, and must not throw the renderer away.
  h.shell.connectRemote(`${origin}/`)
  assert.equal(h.replacements, 1)

  await h.shell.pickLocalFolder()
  assert.equal(h.replacements, 2)

  // A second folder is a library change, which `LibraryHost` handles with a reload.
  h.library.open(second)
  assert.equal(h.replacements, 2)
})

test('the transport is what a window must be built with, in each state', () => {
  const dir = folderWithProject('transport', 'Widget')
  const h = harness({ folder: dir })
  // Nothing chosen yet is the IPC transport, deliberately: `capabilities` answers out of the
  // shell and `library.pick`/`library.connect` are how the user leaves this state.
  assert.equal(h.shell.transport(), 'local')
  h.library.open(dir)
  assert.equal(h.shell.transport(), 'local')
  h.shell.connectRemote(origin)
  assert.equal(h.shell.transport(), 'remote')
})

/* -------------------------------------------------------------------------------------------
 * Capabilities, in both modes
 * ---------------------------------------------------------------------------------------- */

test('capabilities are the shell column in local mode and the union in remote mode', async () => {
  const dir = folderWithProject('caps', 'Widget')
  const h = harness({ folder: dir })

  assert.deepEqual(await h.shell.capabilities(), LOCAL_SHELL_CAPABILITIES)
  h.library.open(dir)
  assert.deepEqual(await h.shell.capabilities(), LOCAL_SHELL_CAPABILITIES)

  h.shell.connectRemote(origin)
  assert.deepEqual(await h.shell.capabilities(), {
    // From the server, which the test's own HTTP server really answered — `requests` proves the
    // request happened rather than a constant being returned.
    requiresAuth: true,
    canManageUsers: true,
    // From the shell's *remote* column. The local column says true, and unioning that one here
    // is the defect `capabilities.test.ts` names.
    canPickLocalFolder: false,
    canLaunchSlicer: false,
    canConfigureSlicers: false,
    canBrowseModelSites: false,
  })
  assert.deepEqual(requests, ['/api/capabilities'])
})

test('a bad server URL from the renderer is a Validation failure and changes nothing', () => {
  const dir = folderWithProject('unchanged', 'Widget')
  const h = harness({ folder: dir })
  h.library.open(dir)

  assert.throws(() => h.shell.connectRemote('file:///C:/Windows'), /http or https/)

  assert.equal(h.shell.mode(), 'local')
  assert.ok(h.shell.session(), 'the library that was open must still be open')
  assert.equal(h.replacements, 0)
})
