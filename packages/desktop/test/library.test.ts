import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import type { Library } from '@spm/core'
import {
  FOLDER_PICKER_PROPERTIES,
  LibraryHost,
  STATE_FILE_NAME,
  folderPickerOptions,
  planStartup,
  readRememberedDir,
  rememberDir,
  resolveLibraryDir,
  type FolderPickerOptions,
  type LibraryHostOptions,
} from '../src/library.ts'
import type { PreviewTicker } from '../src/previews.ts'

/**
 * Choosing a folder, remembering it, and swapping it — under plain Node, with the native dialog
 * replaced by a function.
 *
 * This is where the first-run picker, the remembered folder, and every way a remembered folder
 * can stop being usable are asserted. The Playwright suite proves the same paths through the real
 * app once each; it cannot enumerate them, because every enumeration would mean a native modal.
 */

let root: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-host-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

let seq = 0

/** A fresh, empty userData directory for one test. */
function stateFileFor(): string {
  seq += 1
  return join(root, `state-${seq}`, STATE_FILE_NAME)
}

/** A folder that exists and has no library in it yet. */
function emptyFolder(name: string): string {
  const dir = join(root, `${name}-${(seq += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A folder with one project in it, so opening it can be told apart from opening another. */
function folderWithProject(name: string, project: string): string {
  const dir = emptyFolder(name)
  mkdirSync(join(dir, project), { recursive: true })
  writeFileSync(join(dir, project, 'part.stl'), 'solid part\nendsolid part\n')
  return dir
}

type Recorded = { options: FolderPickerOptions }

type Harness = {
  host: LibraryHost
  stateFile: string
  picks: Recorded[]
  changes: number
  tickers: FakeTicker[]
}

type FakeTicker = PreviewTicker & { stopped: boolean; finish: () => void }

/**
 * A ticker that never touches the queue, and that can be made to finish late.
 *
 * `LibraryHost`'s own contract with the ticker is what these tests are about — it must stop one
 * before it closes the library under it, and it must not make the *switch* wait for that. The
 * real implementation is covered by `previews.test.ts` against a real library.
 */
function fakeTicker(): FakeTicker {
  let finish = (): void => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  let blocked = false
  const ticker: FakeTicker = {
    stopped: false,
    finish: () => {
      blocked = false
      finish()
    },
    stop: async () => {
      await (blocked ? pending : Promise.resolve())
      ticker.stopped = true
    },
  }
  // Tests that want a slow stop flip this on before switching.
  Object.defineProperty(ticker, 'block', {
    value: () => {
      blocked = true
    },
  })
  return ticker
}

function harness(pick?: (options: FolderPickerOptions) => Promise<string | null>): Harness {
  const picks: Recorded[] = []
  const tickers: FakeTicker[] = []
  const state = { changes: 0 }
  const options: LibraryHostOptions = {
    stateFile: stateFileFor(),
    pick: async (opts) => {
      picks.push({ options: opts })
      return await (pick ? pick(opts) : Promise.resolve(null))
    },
    onChanged: () => {
      state.changes += 1
    },
    startTicker: (_lib: Library) => {
      const ticker = fakeTicker()
      tickers.push(ticker)
      return ticker
    },
  }
  const host = new LibraryHost(options)
  return {
    host,
    stateFile: options.stateFile,
    picks,
    tickers,
    get changes(): number {
      return state.changes
    },
  }
}

let hosts: LibraryHost[] = []

beforeEach(() => {
  hosts = []
})

/**
 * Every host this test made, closed — including the ones a failing assertion skipped past.
 * A library left open holds its folder on Windows, and the cleanup in `after` then fails with
 * `EPERM`, which turns one failed assertion into two failures and a leaked temp directory.
 */
afterEach(async () => {
  for (const host of hosts) {
    try {
      host.shutdown()
      await host.whenReleased()
    } catch {
      // Already shut down by the test itself.
    }
  }
})

/* -------------------------------------------------------------------------------------------
 * The state file
 * ---------------------------------------------------------------------------------------- */

test('the remembered folder round-trips through state.json', () => {
  const stateFile = stateFileFor()
  assert.equal(readRememberedDir(stateFile), null)
  rememberDir(stateFile, 'C:/libraries/one')
  assert.equal(readRememberedDir(stateFile), 'C:/libraries/one')
  rememberDir(stateFile, 'C:/libraries/two')
  assert.equal(readRememberedDir(stateFile), 'C:/libraries/two')
})

test('remembering a folder keeps the rest of the state file', () => {
  const stateFile = stateFileFor()
  mkdirSync(join(stateFile, '..'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ mode: 'local', windowBounds: { width: 800 } }))

  rememberDir(stateFile, 'C:/libraries/one')

  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), {
    mode: 'local',
    windowBounds: { width: 800 },
    libraryDir: 'C:/libraries/one',
  })
})

test('an unreadable state file is treated as nothing remembered, not as a crash', () => {
  const stateFile = stateFileFor()
  mkdirSync(join(stateFile, '..'), { recursive: true })
  writeFileSync(stateFile, '{"libraryDir": "C:/half-written')
  assert.equal(readRememberedDir(stateFile), null)
  assert.deepEqual(planStartup({}, stateFile), { source: 'picker', reason: null })
})

/* -------------------------------------------------------------------------------------------
 * Where the folder comes from at startup
 * ---------------------------------------------------------------------------------------- */

test('first run, with nothing remembered, plans a picker and has nothing to explain', () => {
  assert.deepEqual(planStartup({}, stateFileFor()), { source: 'picker', reason: null })
})

test('a remembered folder that is still there is opened without asking', () => {
  const stateFile = stateFileFor()
  const dir = emptyFolder('remembered')
  rememberDir(stateFile, dir)
  assert.deepEqual(planStartup({}, stateFile), { source: 'remembered', dir })
})

test('a remembered folder that has been deleted returns to the picker, naming it', () => {
  const stateFile = stateFileFor()
  const dir = emptyFolder('deleted')
  rememberDir(stateFile, dir)
  rmSync(dir, { recursive: true, force: true })

  const plan = planStartup({}, stateFile)
  assert.equal(plan.source, 'picker')
  assert.match(plan.source === 'picker' ? (plan.reason ?? '') : '', /no longer there/)
  assert.ok(plan.source === 'picker' && plan.reason?.includes(dir), 'the folder must be named')
})

test('a remembered folder that has been renamed away returns to the picker', () => {
  const stateFile = stateFileFor()
  const dir = emptyFolder('renamed')
  rememberDir(stateFile, dir)
  renameSync(dir, `${dir}-elsewhere`)
  assert.equal(planStartup({}, stateFile).source, 'picker')
})

test('a remembered path that is now a file returns to the picker', () => {
  const stateFile = stateFileFor()
  const dir = emptyFolder('replaced')
  rememberDir(stateFile, dir)
  rmSync(dir, { recursive: true, force: true })
  writeFileSync(dir, 'a file where a folder used to be')
  assert.equal(planStartup({}, stateFile).source, 'picker')
})

test('SPM_LIBRARY_DIR overrides whatever is remembered', () => {
  const stateFile = stateFileFor()
  const remembered = emptyFolder('remembered')
  const override = emptyFolder('override')
  rememberDir(stateFile, remembered)
  assert.deepEqual(planStartup({ SPM_LIBRARY_DIR: override }, stateFile), {
    source: 'env',
    dir: resolve(override),
  })
  assert.equal(resolveLibraryDir({ SPM_LIBRARY_DIR: override }), resolve(override))
  assert.equal(resolveLibraryDir({}), null)
})

/* -------------------------------------------------------------------------------------------
 * The picker's options
 * ---------------------------------------------------------------------------------------- */

test('the picker asks for a directory, and lets the user create one', () => {
  const options = folderPickerOptions(null)
  assert.deepEqual([...options.properties], ['openDirectory', 'createDirectory'])
  assert.deepEqual([...FOLDER_PICKER_PROPERTIES], ['openDirectory', 'createDirectory'])
  assert.equal(options.title, 'Choose a library folder')
  assert.equal(options.message, 'Choose a library folder')
})

test('an explanation reaches the picker on both the platforms that show one', () => {
  const options = folderPickerOptions('the last folder is no longer there (C:/gone)')
  // Windows and Linux show the title; macOS ignores it on an open dialog and shows `message`.
  assert.match(options.title, /no longer there \(C:\/gone\)/)
  assert.equal(options.message, 'the last folder is no longer there (C:/gone)')
  assert.deepEqual([...options.properties], ['openDirectory', 'createDirectory'])
})

/* -------------------------------------------------------------------------------------------
 * Opening, remembering, switching
 * ---------------------------------------------------------------------------------------- */

test('first run shows the picker, and what it opens is remembered for next time', async () => {
  const chosen = folderWithProject('chosen', 'Widget')
  const first = harness(() => Promise.resolve(chosen))
  hosts.push(first.host)

  const started = first.host.start({})
  assert.deepEqual(started, { prompt: null }, 'nothing is remembered, so it must ask')
  assert.equal(first.host.session(), null, 'and nothing is open until it has asked')

  const opened = await first.host.prompt('prompt' in started ? started.prompt : null)

  assert.deepEqual(opened, { dir: resolve(chosen) })
  assert.equal(first.picks.length, 1)
  assert.deepEqual([...first.picks[0]!.options.properties], ['openDirectory', 'createDirectory'])
  // A real library, opened and migrated: `.spm` is on disk and the single local user exists.
  const session = first.host.session()
  assert.ok(session, 'a session must be open')
  assert.ok(existsSync(join(chosen, '.spm', 'app.db')))
  assert.equal(
    (session.lib.db.prepare('SELECT library_dir AS d FROM users').get() as { d: string }).d,
    '.',
  )
  first.host.shutdown()

  // Next launch: a different host over the same userData, and no dialog at all.
  const second = new LibraryHost({
    stateFile: first.stateFile,
    pick: () => assert.fail('a remembered folder must not ask'),
    startTicker: () => fakeTicker(),
  })
  hosts.push(second)
  const restarted = second.start({})
  assert.deepEqual(restarted, { opened: { dir: resolve(chosen) } })
  assert.equal(second.dir(), resolve(chosen))
  second.shutdown()
})

test('a remembered folder that is gone lands in the picker with the explanation', async () => {
  const gone = emptyFolder('gone')
  const replacement = folderWithProject('replacement', 'Gadget')
  const h = harness(() => Promise.resolve(replacement))
  hosts.push(h.host)
  rememberDir(h.stateFile, gone)
  rmSync(gone, { recursive: true, force: true })

  const started = h.host.start({})
  assert.ok('prompt' in started && started.prompt, 'it must have something to explain')
  await h.host.prompt('prompt' in started ? started.prompt : null)

  assert.equal(h.picks.length, 1)
  assert.ok(h.picks[0]!.options.title.includes(gone), 'the picker must name the folder that went')
  assert.equal(h.host.dir(), resolve(replacement))
  assert.equal(readRememberedDir(h.stateFile), resolve(replacement))
  h.host.shutdown()
})

test('a cancelled picker leaves the library that was open alone', async () => {
  const open = folderWithProject('kept', 'Widget')
  let answer: string | null = open
  const h = harness(() => Promise.resolve(answer))
  hosts.push(h.host)

  await h.host.prompt(null)
  const session = h.host.session()
  assert.ok(session)

  answer = null
  assert.equal(await h.host.prompt(null), null)
  assert.equal(h.host.session(), session, 'the same session must still be open')
  assert.equal(readRememberedDir(h.stateFile), resolve(open))
  h.host.shutdown()
})

test('re-picking the folder that is already open changes nothing', async () => {
  const only = folderWithProject('same', 'Widget')
  const h = harness(() => Promise.resolve(only))
  hosts.push(h.host)

  await h.host.prompt(null)
  const session = h.host.session()
  const changes = h.changes

  assert.deepEqual(await h.host.prompt(null), { dir: resolve(only) })
  assert.equal(h.host.session(), session, 'the live session must not have been replaced')
  assert.equal(h.changes, changes, 'and the window must not have been reloaded')
  assert.equal(h.tickers.length, 1)
  h.host.shutdown()
})

test('switching folders closes the one that was open and reloads the window', async () => {
  const a = folderWithProject('a', 'Widget')
  const b = folderWithProject('b', 'Gadget')
  let answer = a
  const h = harness(() => Promise.resolve(answer))
  hosts.push(h.host)

  await h.host.prompt(null)
  const first = h.host.session()
  assert.ok(first)
  assert.equal(h.changes, 1)

  answer = b
  await h.host.prompt(null)
  await h.host.whenReleased()

  assert.equal(h.host.dir(), resolve(b))
  assert.equal(h.changes, 2, 'the shell must reload the window after a switch')
  assert.equal(h.tickers[0]!.stopped, true, 'the old library must stop ticking the queue')
  assert.throws(
    () => first.lib.db.prepare('SELECT 1').get(),
    'the old library must be closed, not merely forgotten',
  )
  // The new one is live, and it is the folder that was chosen second.
  const projects = h.host.session()!.lib.db.prepare('SELECT dir_name AS n FROM projects').all()
  assert.deepEqual(projects, [])
  assert.equal(readRememberedDir(h.stateFile), resolve(b))
  h.host.shutdown()
})

test('a folder that will not open leaves the previous one open and remembered', async () => {
  const good = folderWithProject('good', 'Widget')
  // A path that is a file: `openLibrary` cannot make a `.spm` directory underneath it.
  const bad = join(root, `not-a-folder-${(seq += 1)}`)
  writeFileSync(bad, 'a file')
  let answer = good
  const h = harness(() => Promise.resolve(answer))
  hosts.push(h.host)

  await h.host.prompt(null)
  const session = h.host.session()

  answer = bad
  await assert.rejects(() => h.host.prompt(null))

  assert.equal(h.host.session(), session, 'the previous library must still be open')
  assert.equal(readRememberedDir(h.stateFile), resolve(good), 'and still be the remembered one')
  h.host.shutdown()
})

test('a remembered folder that will not open degrades to the picker rather than throwing', () => {
  const stateFile = stateFileFor()
  // A real directory that `openLibrary` cannot use: `.spm` is a file, so it cannot be created.
  // A path that is *not* a directory never reaches `openLibrary` at all — `planStartup` answers
  // for it first, which is what the three cases above cover.
  const bad = emptyFolder('unopenable')
  writeFileSync(join(bad, '.spm'), 'not a directory')
  rememberDir(stateFile, bad)
  const host = new LibraryHost({ stateFile, pick: () => Promise.resolve(null) })
  hosts.push(host)

  const started = host.start({})
  assert.ok('prompt' in started, 'it must ask rather than fail the launch')
  assert.match('prompt' in started ? (started.prompt ?? '') : '', /could not be opened/)
})

test('SPM_LIBRARY_DIR naming a folder that will not open is a startup failure, not a prompt', () => {
  const bad = emptyFolder('env-unopenable')
  writeFileSync(join(bad, '.spm'), 'not a directory')
  const host = new LibraryHost({ stateFile: stateFileFor(), pick: () => Promise.resolve(null) })
  hosts.push(host)
  assert.throws(() => host.start({ SPM_LIBRARY_DIR: bad }))
})

test('an environment override is not written to state.json', () => {
  const dir = folderWithProject('env', 'Widget')
  const h = harness()
  hosts.push(h.host)
  h.host.start({ SPM_LIBRARY_DIR: dir })
  assert.equal(h.host.dir(), resolve(dir))
  assert.equal(readRememberedDir(h.stateFile), null, 'one launch is not a choice to remember')
  h.host.shutdown()
})

/* -------------------------------------------------------------------------------------------
 * Switching while the queue is running
 * ---------------------------------------------------------------------------------------- */

test('a switch does not wait for a preview run, and the old library closes when it ends', async () => {
  const a = folderWithProject('slow-a', 'Widget')
  const b = folderWithProject('slow-b', 'Gadget')
  let answer = a
  const h = harness(() => Promise.resolve(answer))
  hosts.push(h.host)

  await h.host.prompt(null)
  const first = h.host.session()
  assert.ok(first)
  // The old ticker is now mid-run and will not finish until it is told to.
  ;(h.tickers[0] as unknown as { block: () => void }).block()

  answer = b
  const startedAt = Date.now()
  await h.host.prompt(null)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 250, `the switch waited ${elapsed}ms for the preview run`)
  assert.equal(h.host.dir(), resolve(b), 'the new library is live immediately')
  // Still open: the run is holding it, which is the cost this design accepts and states.
  assert.doesNotThrow(() => first.lib.db.prepare('SELECT 1').get())

  h.tickers[0]!.finish()
  await h.host.whenReleased()
  assert.throws(() => first.lib.db.prepare('SELECT 1').get(), 'it must close once the run ends')
  h.host.shutdown()
})

test('the default ticker is the real one, and shutdown stops it', async () => {
  const dir = folderWithProject('real-ticker', 'Widget')
  const host = new LibraryHost({
    stateFile: stateFileFor(),
    pick: () => Promise.resolve(dir),
  })
  hosts.push(host)
  await host.prompt(null)
  const session = host.session()
  assert.ok(session)

  host.shutdown()
  assert.equal(host.session(), null)
  assert.throws(() => session.lib.db.prepare('SELECT 1').get())
  // If the interval were still running, node --test would not exit after this file.
})
