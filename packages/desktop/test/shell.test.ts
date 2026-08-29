import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { AppError } from '@spm/contract/errors.ts'
import { LOCAL_SHELL_CAPABILITIES } from '../src/capabilities.ts'
import {
  confirmedAt,
  confirmRemoteOptions,
  LibraryHost,
  MODE_CHOICES,
  modeChoiceAt,
  modePickerOptions,
  type ConfirmOptions,
  type ModeChoice,
  type ModePickerOptions,
} from '../src/library.ts'
import type { PreviewTicker } from '../src/previews.ts'
import { API_PATH_PREFIX } from '../src/protocol.ts'
import { RemoteHost } from '../src/remote.ts'
import { ShellHost, type ShellRoute } from '../src/shell.ts'
import { readState, rememberChoice, STATE_FILE_NAME, writeState } from '../src/state.ts'
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

/** What both test servers answer `/api/capabilities` with: the Deno server's own column. */
const BACKEND_COLUMN = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

let root: string
let server: Server
let origin: string
/**
 * A second, identical server, so "connect somewhere else" is a case this file can actually reach.
 *
 * The suite had no such thing, which is how remote → remote went three rounds unnoticed: every
 * reconnection in it was to the origin already open, and `connectRemote` short-circuits that
 * before any of the interesting code runs.
 */
let second: { server: Server; origin: string }
let requests: string[] = []

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'spm-shell-'))
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(BACKEND_COLUMN))
  })
  await new Promise<void>((resolve_) => server.listen(0, '127.0.0.1', resolve_))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  origin = `http://127.0.0.1:${address.port}`

  const other = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(BACKEND_COLUMN))
  })
  await new Promise<void>((resolve_) => other.listen(0, '127.0.0.1', resolve_))
  const otherAddress = other.address()
  assert.ok(otherAddress && typeof otherAddress === 'object')
  second = { server: other, origin: `http://127.0.0.1:${otherAddress.port}` }
})

after(() => {
  server.close()
  second.server.close()
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
  /** Every window replacement the shell asked for, with the route it asked to land on. */
  replacements: ShellRoute[]
  navigations: ShellRoute[]
  modeQuestions: ModePickerOptions[]
  /** Every origin the shell asked the user to confirm, and the message it showed them. */
  confirmations: ConfirmOptions[]
  /** Reloads the shell forwarded, as opposed to the ones it declined mid-switch. */
  reloads: number
}

const openHosts: LibraryHost[] = []

function harness(options: {
  answerMode?: ModeChoice
  folder?: string | null
  stateFile?: string
  /** Whether the user says yes to the connect confirmation. Defaults to yes. */
  confirm?: boolean
}): Harness {
  const tickers: FakeTicker[] = []
  const navigations: ShellRoute[] = []
  const replacements: ShellRoute[] = []
  const modeQuestions: ModePickerOptions[] = []
  const confirmations: ConfirmOptions[] = []
  const counters = { reloads: 0 }
  const stateFile = options.stateFile ?? stateFileFor()
  // Wired exactly as `main()` wires it: the library's change goes *through* the shell, which is
  // what lets it decline a reload that a window replacement is about to make pointless. A harness
  // that called the reload directly would test a shape the app does not have.
  const library = new LibraryHost({
    stateFile,
    pick: () => Promise.resolve(options.folder ?? null),
    onChanged: () => shell.libraryChanged(),
    startTicker: () => {
      const ticker = fakeTicker()
      tickers.push(ticker)
      return ticker
    },
  })
  openHosts.push(library)
  const shell: ShellHost = new ShellHost({
    stateFile,
    library,
    askMode: (asked) => {
      modeQuestions.push(asked)
      return Promise.resolve(options.answerMode ?? 'cancel')
    },
    confirmRemote: (asked) => {
      confirmations.push(asked)
      return Promise.resolve(options.confirm ?? true)
    },
    onTransportChanged: (route) => replacements.push(route),
    onNavigate: (route) => navigations.push(route),
    onLibraryChanged: () => {
      counters.reloads += 1
    },
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
    replacements,
    modeQuestions,
    confirmations,
    get reloads(): number {
      return counters.reloads
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
  // window is reloaded rather than replaced.
  assert.deepEqual(h.replacements, [])
  assert.equal(h.reloads, 1)
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
  await h.shell.connectRemote(origin)

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
  // Rewritten by hand in a spelling `rememberChoice` would never produce: no indentation, no
  // trailing newline. **That is what makes the "nothing is rewritten" assertion below able to
  // fail** — comparing the parsed object could not, because a rewrite produces byte-identical
  // content and the review caught exactly that. Any write at all reformats this.
  const compact = '{"mode":"remote","remoteUrl":"' + origin + '"}'
  writeFileSync(stateFile, compact)
  const h = harness({ stateFile })

  assert.deepEqual(h.shell.start({}), { opened: true })
  assert.equal(h.shell.mode(), 'remote')
  assert.equal(h.shell.remote()?.origin, origin)
  assert.equal(requests.length, 0, 'and the server is not contacted to start the app')
  // There is no window to replace at startup: `main()` builds the first one from `transport()`
  // straight after this. Measured with the callback firing here anyway — two windows at every
  // remote-mode launch, and every Playwright assertion still green, because `firstWindow()`
  // answered the first of them.
  assert.deepEqual(h.replacements, [])
  // And nothing is rewritten either: the origin came off disk and putting it back would be an
  // fsync per launch to produce a byte-identical file. Read as raw text, not as an object —
  // see the fixture above.
  assert.equal(readFileSync(stateFile, 'utf8'), compact)
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

test('switching modes keeps the other mode target written down', async () => {
  const stateFile = stateFileFor()
  const dir = folderWithProject('kept-folder', 'Widget')
  const h = harness({ stateFile, folder: dir })
  rememberChoice(stateFile, 'local', dir)

  await h.shell.connectRemote(origin)

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

  await h.shell.connectRemote(origin)
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
  await h.shell.connectRemote(origin)
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

test('the windows are invalidated when the target moves, transport or not', async () => {
  const first = folderWithProject('one', 'Widget')
  const secondFolder = folderWithProject('two', 'Gadget')
  const h = harness({ folder: first })

  h.library.open(first)
  assert.deepEqual(h.replacements, [], 'nothing open to a local library is not a change')

  await h.shell.connectRemote(origin)
  assert.deepEqual(h.replacements, ['home'])

  // The same server again is not a change, and must not throw the renderer away — nor ask the
  // user to confirm a server they are already looking at.
  await h.shell.connectRemote(`${origin}/`)
  assert.deepEqual(h.replacements, ['home'])
  assert.equal(h.confirmations.length, 1)

  // **A different server is.** This is the case the test used to look like it covered while only
  // ever reconnecting to the same origin, which `connectRemote` short-circuits: the transport
  // does not move between two remotes, so keying the invalidation on it left the renderer showing
  // server A while every request went to server B.
  await h.shell.connectRemote(second.origin)
  assert.deepEqual(h.replacements, ['home', 'home'])

  await h.shell.pickLocalFolder()
  assert.deepEqual(h.replacements, ['home', 'home', 'home'])

  // A second folder is a library change, which is a reload.
  h.library.open(secondFolder)
  assert.deepEqual(h.replacements, ['home', 'home', 'home'])
})

/**
 * Remote A → remote B, end to end through the shell.
 *
 * The transport does not move between two servers, so this is the case the previous invariant
 * could not see. What the renderer would have been left holding is not subtle: `AuthStore`'s user
 * and `CapabilitiesStore`'s answer from A, a project list whose ids name rows in A's database,
 * and every request going to B and coming back 401.
 */
test('connecting to a different server replaces the window and lets go of the first', async () => {
  const h = harness({})
  await h.shell.connectRemote(origin)
  const first = h.shell.remote()
  assert.ok(first)
  assert.deepEqual(h.replacements, ['home'])

  await h.shell.connectRemote(second.origin)

  assert.equal(h.shell.remote()?.origin, second.origin)
  // The window really is thrown away: everything in the renderer belongs to the other server.
  assert.deepEqual(h.replacements, ['home', 'home'])
  // And the first host is closed, not merely dropped — the same rule a mode switch follows.
  assert.equal(first.hasSession(), false)
  assert.equal(
    (await first.proxy(new Request(`${RENDERER_ORIGIN}${API_PATH_PREFIX}/projects`))).status,
    503,
  )
  // Written down, so a relaunch comes back to B rather than to A.
  assert.deepEqual(readState(h.stateFile), { mode: 'remote', remoteUrl: second.origin })
})

test('the transport is what a window must be built with, in each state', async () => {
  const dir = folderWithProject('transport', 'Widget')
  const h = harness({ folder: dir })
  // Nothing chosen yet is the IPC transport, deliberately: `capabilities` answers out of the
  // shell and `library.pick`/`library.connect` are how the user leaves this state.
  assert.equal(h.shell.transport(), 'local')
  h.library.open(dir)
  assert.equal(h.shell.transport(), 'local')
  await h.shell.connectRemote(origin)
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

  await h.shell.connectRemote(origin)
  assert.deepEqual(await h.shell.capabilities(), {
    // From the server, which the test's own HTTP server really answered — `requests` proves the
    // request happened rather than a constant being returned.
    requiresAuth: true,
    canManageUsers: true,
    // From the shell's *remote* column. The local column says true, and unioning that one here
    // is the defect `capabilities.test.ts` names.
    canPickLocalFolder: false,
    // Also from the shell's remote column, over a `BACKEND_COLUMN` that says false for all
    // three: a server that cannot launch a slicer, or embed a browser, does not stop the machine
    // this window runs on from doing either.
    canLaunchSlicer: true,
    canConfigureSlicers: true,
    canBrowseModelSites: true,
  })
  assert.deepEqual(requests, ['/api/capabilities'])
})

test('a bad server URL from the renderer is a Validation failure and changes nothing', async () => {
  const dir = folderWithProject('unchanged', 'Widget')
  const h = harness({ folder: dir })
  h.library.open(dir)

  await assert.rejects(() => h.shell.connectRemote('file:///C:/Windows'), /http or https/)

  assert.equal(h.shell.mode(), 'local')
  assert.ok(h.shell.session(), 'the library that was open must still be open')
  assert.deepEqual(h.replacements, [])
  // Refused before the user was troubled with a question about it.
  assert.deepEqual(h.confirmations, [])
})

/* -------------------------------------------------------------------------------------------
 * Ruling C-20: the renderer may ask, and only the user may answer
 * ---------------------------------------------------------------------------------------- */

/**
 * The gate, and the reason it is not the URL rules.
 *
 * `parseRemoteOrigin` deliberately accepts loopback, link-local and RFC1918, because
 * `http://192.168.1.5:8000` is the documented use case and `http://169.254.169.254` is
 * indistinguishable from it by shape. Nothing on the IPC channel carries a user gesture, so the
 * gesture is asked for.
 */
test('a server the renderer named is not connected to until the user says so', async () => {
  const h = harness({ confirm: false })

  assert.equal(await h.shell.connectRemote('http://169.254.169.254'), null)

  assert.equal(h.shell.remote(), null, 'nothing was pointed at it')
  assert.equal(h.shell.mode(), 'unset')
  assert.deepEqual(h.replacements, [])
  assert.equal(existsSync(h.stateFile), false, 'and nothing was written down')
  assert.equal(requests.length, 0)

  // The user was asked, and the question named the host — a confirmation that did not would be
  // worse than none, because it would train people to accept an unnamed one.
  assert.equal(h.confirmations.length, 1)
  assert.match(h.confirmations[0]!.message, /169\.254\.169\.254/)
})

/**
 * The renderer can ask as often as it likes; it gets one dialog.
 *
 * `askForMode` has had this guard since it was written, because two menu clicks could stack two
 * message boxes. Here the caller is the untrusted side and needs no clicks at all — a loop over
 * `spm.invoke('library.connect', ...)` would stack a native dialog per iteration. The gate would
 * still hold, since every one of them defaults to refusing, but dialog fatigue is the failure a
 * confirmation gate exists to resist.
 */
test('a renderer asking to connect in a loop gets one dialog, not one per call', async () => {
  const h = harness({ confirm: false })

  const answers = await Promise.all(Array.from({ length: 25 }, () => h.shell.connectRemote(origin)))

  assert.equal(h.confirmations.length, 1, 'one native dialog, however many times it was asked')
  assert.deepEqual(
    answers,
    Array.from({ length: 25 }, () => null),
    'and they all get the answer',
  )
  assert.equal(h.shell.remote(), null)

  // The guard is released afterwards, so the next genuine attempt is asked about again rather
  // than silently inheriting the refusal. The folder is what makes the pick actually *switch* —
  // a cancelled one leaves the server attached, and the second call would then take the
  // already-connected shortcut instead of the path under test. (It did, first time round.)
  const h2 = harness({ confirm: true, folder: folderWithProject('between-connects', 'Widget') })
  await h2.shell.connectRemote(origin)
  assert.equal(h2.confirmations.length, 1)
  await h2.shell.pickLocalFolder()
  assert.equal(h2.shell.remote(), null, 'the server really was let go of')
  await h2.shell.connectRemote(origin)
  assert.equal(h2.confirmations.length, 2)
})

/**
 * The guard answers about the origin the caller asked about, or it does not answer.
 *
 * It used to hand the in-flight result to whoever asked next, so `connect(B)` racing `connect(A)`
 * resolved `{ origin: A }` — a server the user confirmed, reported as the answer to a question
 * about a server they never saw. `askForMode` has one question and can coalesce; this has one
 * *per server* and cannot.
 */
test('a second connect to a different server is refused, not answered with the first', async () => {
  const h = harness({ confirm: true })

  const first = h.shell.connectRemote(origin)
  const refused = h.shell.connectRemote(second.origin)

  await assert.rejects(
    () => refused,
    (error: unknown) => error instanceof AppError && error.code === 'Conflict',
  )
  assert.deepEqual(await first, { origin })
  assert.equal(h.shell.remote()?.origin, origin, 'and the one that was confirmed is the one open')
  assert.equal(h.confirmations.length, 1)

  // Once the first is done the guard is clear, so the second server is a question of its own.
  assert.deepEqual(await h.shell.connectRemote(second.origin), { origin: second.origin })
  assert.equal(h.confirmations.length, 2)
})

test('a malformed URL rejects rather than throwing out of a promise-typed call', async () => {
  const h = harness({})
  // Sharp edge worth pinning: the guard made this synchronous for a moment, and a function whose
  // type says `Promise` throwing before it returns one is a footgun for every caller.
  const returned = h.shell.connectRemote('file:///C:/Windows')
  assert.ok(returned instanceof Promise)
  await assert.rejects(() => returned, /http or https/)
  assert.deepEqual(h.confirmations, [])
})

test('the confirmation defaults to refusing, and is refused by dismissal', () => {
  const options = confirmRemoteOptions('http://192.168.1.5:8000', 'en')
  assert.deepEqual(options.buttons, ['Cancel', 'Connect'])
  assert.match(options.message, /http:\/\/192\.168\.1\.5:8000/)
  // Both the default *and* the cancel id, unlike the other dialogs in this shell: those are
  // opened by the user, and this one can be raised by a renderer with no gesture at all, so the
  // answer a stray return key or an escape gives has to be "no".
  assert.equal(options.defaultId, 0)
  assert.equal(options.cancelId, 0)
  assert.equal(confirmedAt(0), false)
  assert.equal(confirmedAt(1), true)
  assert.equal(confirmedAt(-1), false)
  assert.equal(confirmedAt(9), false)
  assert.match(confirmRemoteOptions('https://x.example', 'de').message, /verbinden\?/)
})

/**
 * The gate is on the renderer's call and not on adopting a server, which is the distinction that
 * makes it worth having: re-asking about the user's own earlier answer on every launch is how a
 * confirmation becomes something people dismiss without reading.
 */
test('a remembered server and an environment override are not re-confirmed', () => {
  const stateFile = stateFileFor()
  rememberChoice(stateFile, 'remote', origin)
  const remembered = harness({ stateFile })
  remembered.shell.start({})
  assert.equal(remembered.shell.remote()?.origin, origin)
  assert.deepEqual(remembered.confirmations, [])

  const fromEnv = harness({})
  fromEnv.shell.start({ SPM_REMOTE_URL: origin })
  assert.equal(fromEnv.shell.remote()?.origin, origin)
  assert.deepEqual(fromEnv.confirmations, [])
})

/* -------------------------------------------------------------------------------------------
 * The connect flow, from a live server
 * ---------------------------------------------------------------------------------------- */

/**
 * Review found this one: answering "a server" while already in remote mode released the server
 * but only *navigated* the window, so it kept `--spm-mode=remote` and went on running
 * `HttpApiClient` against a proxy that now 404s everything — the stale client the plan names.
 *
 * Worse, it was sticky: the connect page's own "choose a folder" button then reached
 * `#becomeLocal` with the transport already reading `local`, so no replacement fired there
 * either and the reload rebuilt the same stale client.
 */
test('asking to connect while a server is live replaces the window on the connect page', async () => {
  const h = harness({ answerMode: 'remote' })
  await h.shell.connectRemote(origin)
  assert.equal(h.shell.transport(), 'remote')

  assert.equal(await h.shell.askForMode(), 'remote')

  assert.equal(h.shell.remote(), null, 'the server is let go of')
  assert.equal(h.shell.transport(), 'local')
  // The window must be *replaced* and land on the connect page: navigating it would leave a
  // renderer built for the remote transport talking to a proxy that no longer answers.
  assert.deepEqual(h.replacements, ['home', 'connect'])
  assert.deepEqual(h.navigations, [], 'and not merely navigated')
})

test('the same question with nothing open only navigates, because the transport has not changed', async () => {
  const h = harness({ answerMode: 'remote' })
  assert.equal(await h.shell.askForMode(), 'remote')
  assert.deepEqual(h.navigations, ['connect'])
  assert.deepEqual(h.replacements, [])
})

test('choosing a folder from the connect page still gets there from a local transport', async () => {
  const dir = folderWithProject('after-connect-flow', 'Widget')
  const h = harness({ answerMode: 'remote', folder: dir })
  await h.shell.connectRemote(origin)
  await h.shell.askForMode()

  // The sequence review walked: remote → menu → "connect to a server" → "choose a folder".
  const opened = await h.shell.pickLocalFolder()

  assert.deepEqual(opened, { dir: resolve(dir) })
  assert.equal(h.shell.mode(), 'local')
  // No *further* replacement: the connect flow already put the window on the local transport, so
  // what this needs is the reload a library change always gets.
  assert.deepEqual(h.replacements, ['home', 'connect'])
  assert.equal(h.reloads, 1)
})

/**
 * The other half of that reload: during a remote→local switch, `LibraryHost.open` raises its
 * change *before* the transport has swapped, and the window it would reload is one that is about
 * to be destroyed — its in-flight requests landing on a `RemoteHost` that is closing.
 */
test('the reload is declined while a mode switch is still in flight', async () => {
  const dir = folderWithProject('mid-switch', 'Widget')
  const h = harness({ folder: dir })
  await h.shell.connectRemote(origin)
  assert.equal(h.reloads, 0)

  await h.shell.pickLocalFolder()

  assert.deepEqual(h.replacements, ['home', 'home'])
  assert.equal(h.reloads, 0, 'the replacement is the invalidation; a reload would race it')

  // And an ordinary library change, with no switch under way, still reloads.
  h.library.open(folderWithProject('ordinary', 'Gadget'))
  assert.equal(h.reloads, 1)
})
