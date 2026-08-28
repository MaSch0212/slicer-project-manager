import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, before, test } from 'node:test'
import type { FileDto, ProjectDetailDto, SlicerId, SlicerSessionDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import {
  closeLibrary,
  createProject,
  ensureLocalUser,
  entryDigests,
  entryHash,
  getProject,
  openLibrary,
  resolveFilePath,
  uploadFile,
  type Ctx,
  type Library,
} from '@spm/core'
import { bambuLineageProject, curaProject, writeZip } from '../../core/test/fixtures/make-3mf.ts'
import { patchZipHeaders } from '../../core/test/fixtures/patch-zip.ts'
import { RemoteHost } from '../src/remote.ts'
import {
  SLICERS_CONFIG_VERSION,
  SLICERS_FILE_NAME,
  writeConfig,
  type SlicersConfig,
} from '../src/slicers/config.ts'
import { SlicersHost } from '../src/slicers/host.ts'
import {
  LAUNCH_RECORD_NAME,
  SlicerLauncher,
  type LaunchedSession,
  type SlicerLaunchRecord,
} from '../src/slicers/launch.ts'
import type { RemoteProxy } from '../src/slicers/remote-files.ts'
import {
  derivedName,
  EXIT_SETTLE_MS,
  SlicerSessions,
  SWEPT_RECORD_TTL_MS,
  type DirectoryWatcher,
  type SessionTimers,
  type TimerHandle,
} from '../src/slicers/sessions.ts'

/**
 * The loop that reads what a launch left behind: the watch, the comparison, the two sweeps and
 * the reconcile — against a real temporary `slicer-sessions/`, a real library and a real
 * `RemoteHost`.
 *
 * **The two rules this file exists for are the two data-loss ones**, and they are asserted the way
 * a test that would actually have caught the first draft of the spec has to be: the sweep at next
 * start is asserted to leave the directory *and* to leave it listed, because a sweep that deleted
 * the directory and one that merely stopped listing it are both green against "it was not
 * reported gone". And an orphan is asserted to survive by name on disk, not only to appear in an
 * array.
 *
 * The clock is injected rather than waited on. Every number in `sessions.ts` — the 60 s settle
 * window, the 10 s exit settle, the 90 day record retention — is a duration, and a suite that
 * waited on any of them would either take two minutes or assert nothing about them.
 *
 * Nothing here needs Electron, a slicer, or Windows.
 */

let root: string
let lib: Library
let ctx: Ctx
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-sessions-'))
  const libDir = join(root, 'library')
  mkdirSync(libDir, { recursive: true })
  lib = openLibrary(libDir)
  ctx = ensureLocalUser(lib)
})

after(() => {
  closeLibrary(lib)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/* -------------------------------------------------------------------------------------------
 * A clock the test drives
 * ---------------------------------------------------------------------------------------- */

type Scheduled = { id: number; at: number; run: () => void; every: number | null }

/**
 * `Date.now`, `setTimeout` and `setInterval`, all moved by hand.
 *
 * It is deliberately not a general fake-timer library: what this needs is that `now()` and the
 * schedulers agree, because the settle window is measured with the first and spent by the second.
 * A suite where those two clocks could drift would let a 60 s window elapse in fifty ticks of a
 * 500 ms timer and never notice which of them was wrong.
 */
class Clock {
  now = 1_756_000_000_000
  #nextId = 1
  readonly #scheduled = new Map<number, Scheduled>()

  readonly timers: SessionTimers = {
    setTimeout: (run, ms) => this.#add(run, ms, null),
    clearTimeout: (handle) => this.#scheduled.delete(handle as number),
    setInterval: (run, ms) => this.#add(run, ms, ms),
    clearInterval: (handle) => this.#scheduled.delete(handle as number),
  }

  /** Moves time forward, firing everything due, in order. */
  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      const due = [...this.#scheduled.values()]
        .filter((entry) => entry.at <= until)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.now = due.at
      if (due.every === null) this.#scheduled.delete(due.id)
      else due.at += due.every
      due.run()
    }
    this.now = until
  }

  pending(): number {
    return this.#scheduled.size
  }

  #add(run: () => void, ms: number, every: number | null): TimerHandle {
    const id = this.#nextId
    this.#nextId += 1
    this.#scheduled.set(id, { id, at: this.now + ms, run, every })
    return id
  }
}

/* -------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------- */

type Watched = { directory: string; fire: () => void; closed: boolean }

type Harness = {
  sessions: SlicerSessions
  sessionsDir: string
  clock: Clock
  watched: Watched[]
}

type HarnessOptions = {
  isRemote?: boolean
  remote?: RemoteProxy | null
  hasLibrary?: boolean
  /** Which folder the open library reports, so a folder switch is a value rather than a fixture. */
  libraryDir?: string
}

function harness(options: HarnessOptions = {}): Harness {
  seq += 1
  const sessionsDir = join(root, `case-${seq}`, 'slicer-sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const clock = new Clock()
  const watched: Watched[] = []
  const sessions = new SlicerSessions({
    sessionsDir,
    session: () =>
      options.hasLibrary === false
        ? null
        : {
            lib: options.libraryDir === undefined ? lib : { ...lib, dir: options.libraryDir },
            ctx,
          },
    isRemote: () => options.isRemote === true,
    remote: () => options.remote ?? null,
    now: () => clock.now,
    timers: clock.timers,
    watch: (directory, onChange): DirectoryWatcher => {
      const entry: Watched = { directory, fire: onChange, closed: false }
      watched.push(entry)
      return {
        close: () => {
          entry.closed = true
        },
      }
    },
  })
  return { sessions, sessionsDir, clock, watched }
}

/** A launch directory with a record, as `launch.ts` writes one. */
function launchDirectory(
  h: Harness,
  launchId: string,
  fileName: string,
  build: (path: string) => void,
  overrides: Partial<SlicerLaunchRecord> = {},
): { directory: string; path: string; record: SlicerLaunchRecord } {
  const directory = join(h.sessionsDir, launchId)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, fileName)
  build(path)
  const record: SlicerLaunchRecord = {
    launchId,
    mode: 'new-project',
    projectId: 'project-1',
    fileId: 'file-1',
    slicerId: 'orca',
    installId: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
    fileName,
    launchedHash: entryHash(path),
    startedAt: h.clock.now,
    sourceSlicer: 'bambu',
    sourceSizeBytes: 1234,
    launchedEntries: Object.fromEntries(entryDigests(path)),
    ...overrides,
  }
  writeFileSync(join(directory, LAUNCH_RECORD_NAME), JSON.stringify(record, null, 2))
  return { directory, path, record }
}

/**
 * A launch directory holding a record with **exactly the nine fields task 4 wrote** — no
 * `sourceSlicer`, no `sourceSizeBytes`, no `launchedEntries`, no `sweptAt`.
 *
 * Deliberately not `launchDirectory` with overrides: overrides can only *add*, so a harness built
 * that way can never produce the shape this asserts about, and the backward-compatibility claim
 * would go on being true by inspection and untested. It is written out here so that `readRecord`
 * starting to require one of the four turns something red.
 */
function taskFourRecord(
  h: Harness,
  launchId: string,
  fileName: string,
  projectId: string,
  build: (path: string) => void,
): { directory: string; path: string } {
  const directory = join(h.sessionsDir, launchId)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, fileName)
  build(path)
  writeFileSync(
    join(directory, LAUNCH_RECORD_NAME),
    JSON.stringify({
      launchId,
      mode: 'new-project',
      projectId,
      fileId: 'file-4',
      slicerId: 'orca',
      installId: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
      fileName,
      launchedHash: 'what-task-4-wrote',
      startedAt: h.clock.now,
    }),
  )
  return { directory, path }
}

function readRecordAt(directory: string): SlicerLaunchRecord {
  return JSON.parse(readFileSync(join(directory, LAUNCH_RECORD_NAME), 'utf8')) as SlicerLaunchRecord
}

function only(sessions: SlicerSessionDto[]): SlicerSessionDto {
  assert.equal(sessions.length, 1, `expected exactly one session, got ${sessions.length}`)
  return sessions[0]!
}

/** A project in the real library, so an import lands somewhere with real ownership scoping. */
function project(name: string): string {
  seq += 1
  return createProject(lib, ctx, { name: `${name} ${seq}` }).id
}

async function addLibraryFile(projectId: string, name: string, bytes: Uint8Array): Promise<string> {
  const dto = await uploadFile(lib, ctx, projectId, name, {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    sizeBytes: bytes.byteLength,
  })
  return dto.id
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
    assert.fail('expected a rejection')
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
}

/** A Bambu-lineage project with one setting in it, so a later save can change exactly that entry. */
function projectWithSetting(path: string, value: string): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: '<model/>', deflate: true },
    { name: 'Metadata/project_settings.config', data: `{"wall_loops": "${value}"}` },
    { name: 'Metadata/slice_info.config', data: '<config/>' },
  ])
}

/* -------------------------------------------------------------------------------------------
 * The two data-loss rules (constraint 10)
 * ---------------------------------------------------------------------------------------- */

test('the sweep at next start leaves an unchanged directory on disk AND listed', async () => {
  const h = harness()
  const { directory, path } = launchDirectory(h, 'launch-a', 'bracket.3mf', curaProject)

  h.sessions.sweepAtStart()

  // Both halves, and they are different claims. A sweep that deleted the directory and one that
  // merely stopped listing it would each pass the other assertion on its own — and only the pair
  // says the session survived in a form the user can still answer.
  assert.equal(existsSync(directory), true, 'the launch directory was deleted')
  assert.equal(existsSync(path), true, 'the launched file was deleted')
  const session = only(h.sessions.list())
  assert.equal(session.launchId, 'launch-a')
  assert.equal(session.fileState, 'unchanged')
  assert.equal(session.isOrphan, false)
  // The two sizes, as outputs rather than as fixture inputs: `sourceSizeBytes` is what the record
  // kept because an in-place save destroys it, and `returnedSizeBytes` is the file as it is now.
  assert.equal(session.sourceSizeBytes, 1234)
  assert.equal(session.returnedSizeBytes, statSync(path).size)
  await Promise.resolve()
})

test('a .3mf with no launch.json comes back as an orphan and is never swept', () => {
  const h = harness()
  // Both shapes a record-less file can take: inside a directory whose record never got written,
  // and loose in `slicer-sessions/` itself.
  const inDirectory = join(h.sessionsDir, 'crashed')
  mkdirSync(inDirectory, { recursive: true })
  curaProject(join(inDirectory, 'came-back.3mf'))
  curaProject(join(h.sessionsDir, 'loose.3mf'))

  // The count the start-up log line is built from — counted by enumeration, without reading a
  // byte of any of these files, so it has to agree with what `list()` would produce the hard way.
  assert.equal(h.sessions.sweepAtStart(), 2)

  const listed = h.sessions.list().sort((a, b) => a.fileName.localeCompare(b.fileName))
  assert.equal(listed.length, 2)
  assert.deepEqual(
    listed.map((session) => [session.launchId, session.isOrphan, session.fileState]),
    [
      ['crashed/came-back.3mf', true, 'changed'],
      ['loose.3mf', true, 'changed'],
    ],
  )
  // The classification is the only thing an orphan can say about which slicer it came from.
  assert.deepEqual(
    listed.map((session) => session.slicerId),
    ['cura', 'cura'],
  )
  // On disk, by name. The array above would look the same if the sweep had listed them and then
  // removed them.
  assert.equal(existsSync(join(inDirectory, 'came-back.3mf')), true)
  assert.equal(existsSync(join(h.sessionsDir, 'loose.3mf')), true)
})

test('an orphan that names no slicer at all is still listed, and settles', () => {
  const h = harness()
  writeFileSync(join(h.sessionsDir, 'cube.stl'), 'solid cube\nendsolid cube\n')

  const session = only(h.sessions.list())

  // The load-bearing half, and the one `slicerId === null` cannot carry: a mesh is not a ZIP and
  // never will be, so a settle check that asked "does the central directory parse?" of *every*
  // file would leave this settling until the window ran out and then call it unreadable — for
  // ever, on a file that is perfectly readable. `null` is what both branches answer.
  assert.equal(session.fileState, 'changed')
  assert.equal(session.isOrphan, true)
  // The one honest answer, and the reason the field is nullable: nothing about an `.stl` names a
  // product. Dropping it from the list instead is what sweep rule 2 forbids.
  assert.equal(session.slicerId, null)
  assert.equal(existsSync(join(h.sessionsDir, 'cube.stl')), true)
})

test('a file beside a record that is not the launched one is reported, not adopted', () => {
  const h = harness()
  const { directory } = launchDirectory(h, 'launch-b', 'bracket.3mf', curaProject)
  // What a Cura Save-As aimed at the launch directory produces: a second file, under a name of
  // the user's choosing, that is emphatically not the file the record describes.
  curaProject(join(directory, 'bracket-v2.3mf'))

  const listed = h.sessions.list().sort((a, b) => a.fileName.localeCompare(b.fileName))

  assert.deepEqual(
    listed.map((session) => [session.fileName, session.isOrphan]),
    [
      ['bracket-v2.3mf', true],
      ['bracket.3mf', false],
    ],
  )
  // It is not mistaken for the launched file — that session is still `unchanged` — and it carries
  // the neighbouring record's project, because the app can answer that question without asking.
  assert.equal(listed[1]!.fileState, 'unchanged')
  assert.equal(listed[0]!.projectId, 'project-1')
  assert.equal(listed[0]!.fileId, '')
})

/* -------------------------------------------------------------------------------------------
 * The record outliving its file
 * ---------------------------------------------------------------------------------------- */

test('an observed and settled exit sweeps the file, keeps the record, and keeps the directory', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-c', 'bracket.3mf', curaProject)
  const child = trackLaunch(h, 'launch-c', directory, path, record.launchedHash)

  const exitedAt = h.clock.now
  child.exit()
  // Nothing yet: the settle period is what makes the exit an observation rather than a verdict.
  h.clock.advance(EXIT_SETTLE_MS - 1)
  assert.equal(existsSync(path), true, 'the sweep ran before the settle period was up')
  h.clock.advance(2)

  assert.equal(existsSync(path), false, 'the byte-unchanged copy should have been swept')
  assert.equal(existsSync(directory), true, 'the directory must survive its file')
  const kept = readRecordAt(directory)
  assert.equal(kept.sweptAt, exitedAt + EXIT_SETTLE_MS)
  assert.equal(kept.projectId, 'project-1')
  // The memory is not a session: there is nothing there for anyone to answer.
  assert.deepEqual(h.sessions.list(), [])
})

test('a file recreated beside a swept record is matched back to its project', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-d', 'bracket.3mf', (target) =>
    projectWithSetting(target, '2'),
  )
  const child = trackLaunch(h, 'launch-d', directory, path, record.launchedHash)
  child.exit()
  h.clock.advance(11_000)
  assert.equal(existsSync(path), false)

  // Row 20: the next Ctrl+S puts a complete file back at exactly this path.
  projectWithSetting(path, '4')

  const session = only(h.sessions.list())
  assert.equal(session.isOrphan, false, 'the record is what makes this not an orphan')
  assert.equal(session.projectId, 'project-1')
  assert.equal(session.fileId, 'file-1')
  assert.equal(session.fileState, 'changed')
  // And the diff is against what was *launched*, which the record kept when the file went.
  assert.deepEqual(session.entryDiff, {
    added: [],
    removed: [],
    changed: ['Metadata/project_settings.config'],
  })
})

test('an exit sweep leaves a changed file exactly where it is', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-e', 'bracket.3mf', (target) =>
    projectWithSetting(target, '2'),
  )
  const child = trackLaunch(h, 'launch-e', directory, path, record.launchedHash)

  projectWithSetting(path, '4')
  child.exit()
  h.clock.advance(60_000)

  assert.equal(existsSync(path), true, 'a file that came back changed must never be swept')
  assert.equal(only(h.sessions.list()).fileState, 'changed')
})

test('a record whose file has gone expires after ninety days, and not before', () => {
  const h = harness()
  const { directory, path } = launchDirectory(h, 'launch-f', 'bracket.3mf', curaProject)
  rmSync(path)
  const record = readRecordAt(directory)
  writeFileSync(
    join(directory, LAUNCH_RECORD_NAME),
    JSON.stringify({ ...record, sweptAt: h.clock.now }),
  )

  h.clock.advance(SWEPT_RECORD_TTL_MS - 1)
  h.sessions.sweepAtStart()
  assert.equal(existsSync(directory), true, 'the record must outlive its file for the full period')

  h.clock.advance(2)
  h.sessions.sweepAtStart()
  assert.equal(existsSync(directory), false)
})

test('the start sweep never touches a directory that still holds a file, however old', () => {
  const h = harness()
  const { directory, path } = launchDirectory(h, 'launch-g', 'bracket.3mf', curaProject, {
    startedAt: 1,
    sweptAt: 1,
  })

  h.clock.advance(SWEPT_RECORD_TTL_MS * 10)
  h.sessions.sweepAtStart()

  // A `sweptAt` older than any retention there is, beside a file that came back anyway. The
  // retention is about the *record*; the file is the user's and the app has never compared it.
  assert.equal(existsSync(directory), true)
  assert.equal(existsSync(path), true)
  assert.equal(only(h.sessions.list()).fileState, 'unchanged')
})

test('a record written before task 5 still lists, and shows less rather than something wrong', () => {
  const h = harness()
  taskFourRecord(h, 'launch-task4', 'bracket.3mf', 'project-4', curaProject)

  const listed = only(h.sessions.list())

  // The seven fields `readRecord` requires are all there, so this is a session and not an orphan,
  // and everything that identifies it survives.
  assert.equal(listed.isOrphan, false)
  assert.equal(listed.projectId, 'project-4')
  assert.equal(listed.fileId, 'file-4')
  assert.equal(listed.slicerId, 'orca')
  assert.equal(listed.fileState, 'changed')
  // And the four fields task 5 added are simply absent — never a wrong value, never a throw.
  assert.equal(listed.entryDiff, undefined)
  assert.equal(listed.sourceSlicer, null)
  assert.equal(listed.sourceSizeBytes, undefined)
  // `returnedAs` against an unknown source is reached deliberately rather than by accident: the
  // app does not know what went out and does know what is there, and saying so is more use than
  // silence. The card renders the missing half as "unknown".
  assert.equal(listed.returnedAs, 'cura')
})

test('a record written before task 5 can still be imported and swept', async () => {
  const h = harness()
  const projectId = project('Task four')
  const { directory, path } = taskFourRecord(
    h,
    'launch-task4-import',
    'bracket.3mf',
    projectId,
    curaProject,
  )

  const added = (await h.sessions.resolve('launch-task4-import', 'import', {})) as FileDto

  assert.equal(added.name, 'bracket (cura).3mf')
  assert.equal(existsSync(path), false)
  assert.equal(readRecordAt(directory).sweptAt, h.clock.now)
})

/* -------------------------------------------------------------------------------------------
 * Which library a session belongs to
 * ---------------------------------------------------------------------------------------- */

test('a session from a library that is not open is not listed, and is not answerable', async () => {
  const h = harness()
  const { directory, path } = launchDirectory(h, 'launch-elsewhere', 'bracket.3mf', curaProject, {
    library: `local:${join(root, 'some-other-library')}`,
  })

  // `slicer-sessions/` is per-machine and every id in a record is per-library, so without the
  // library key this sat on `/settings/slicers` beside the open library's own sessions, and an
  // import resolved its `projectId` against whatever happened to be open.
  assert.deepEqual(h.sessions.list(), [])

  const refused = await rejection(h.sessions.resolve('launch-elsewhere', 'import', {}))
  assert.equal(refused.code, 'Conflict')
  assert.match(refused.message, /different library/)
  // Nothing was deleted, and nothing was uploaded. Switching back is the whole recovery.
  assert.equal(existsSync(path), true)
  assert.equal(existsSync(directory), true)
  assert.deepEqual(await h.sessions.discardMany(['launch-elsewhere']), { discarded: 0 })
})

test('the same session lists again once its own library is open', () => {
  const elsewhere = join(root, 'the-other-library')
  const h = harness({ libraryDir: elsewhere })
  launchDirectory(h, 'launch-theirs', 'bracket.3mf', curaProject, {
    library: `local:${elsewhere}`,
  })

  // The pair to the test above, against the same fixture: if the filter refused everything, both
  // would pass, and only this one says the key is being compared rather than merely present.
  assert.equal(only(h.sessions.list()).launchId, 'launch-theirs')
})

test('an orphan beside a foreign record is listed, asks where it belongs, and can be answered', async () => {
  const h = harness()
  const projectId = project('Adopted from elsewhere')
  const { directory } = launchDirectory(h, 'launch-foreign', 'bracket.3mf', curaProject, {
    library: `local:${join(root, 'not-this-one')}`,
    projectId: 'a-project-in-the-other-library',
  })
  // What a Cura Save-As into somebody else's launch directory leaves behind. The launched file is
  // that library's business; this one has no record of its own, and the two rules meet here —
  // "only this library's sessions" must not quietly become "and none of the files it cannot
  // explain either", which is the one thing sweep rule 2 forbids outright.
  const stray = join(directory, 'came-back.3mf')
  curaProject(stray)

  const listed = only(h.sessions.list())
  assert.equal(listed.launchId, 'launch-foreign/came-back.3mf')
  assert.equal(listed.isOrphan, true)
  // **The half that listing alone cannot see.** Inheriting the neighbouring record's `projectId`
  // made the card render no "which project?" prompt and enable Import — which then resolved
  // another library's UUID against this one and came back `NotFound`, flattened to "that did not
  // work", with "Throw it away" as the only other button on the row.
  assert.equal(listed.projectId, '')
  assert.equal(
    listed.startedAt,
    Math.round(statSync(stray).mtimeMs),
    'it aged against a foreign library clock',
  )

  const added = (await h.sessions.resolve('launch-foreign/came-back.3mf', 'import', {
    projectId,
  })) as FileDto

  assert.equal(added.name, 'came-back (cura).3mf')
  assert.deepEqual(
    getProject(lib, ctx, projectId).files.map((file) => file.name),
    ['came-back (cura).3mf'],
  )
  assert.equal(existsSync(stray), false)
  // And the foreign session it was sitting beside is untouched: not swept, not stamped, not listed.
  assert.equal(existsSync(join(directory, 'bracket.3mf')), true)
  assert.equal(readRecordAt(directory).sweptAt, undefined)
})

test('a remote session is told apart by its origin, not merely by being remote', () => {
  const remote = recordingRemote()
  const h = harness({ isRemote: true, remote: remote.proxy })
  launchDirectory(h, 'launch-here', 'a.3mf', curaProject, {
    library: 'remote:https://library.invalid',
  })
  launchDirectory(h, 'launch-there', 'b.3mf', curaProject, {
    library: 'remote:https://someone-else.invalid',
  })

  assert.deepEqual(
    h.sessions.list().map((session) => session.launchId),
    ['launch-here'],
  )
})

test('the same folder reached by another name is the same library', () => {
  // `Library.dir` is stored verbatim, and case is not the only way one folder gets two spellings:
  // a device-path prefix, a UNC alias for a local disk, an 8.3 short name and a junction all name
  // one directory and none of them compare equal as strings. A junction is the one of the five
  // that can be built without privileges on Windows *and* exists on POSIX, so it is the one this
  // asserts with; the failure they all produce is the same, and it is quiet — a user's own
  // sessions vanishing from the list with only a `console.info` to say why.
  const real = join(root, `linked-real-${(seq += 1)}`)
  mkdirSync(real, { recursive: true })
  const viaLink = join(root, `linked-alias-${seq}`)
  symlinkSync(real, viaLink, 'junction')

  // Launched with the folder named one way, listed with it named the other.
  const h = harness({ libraryDir: viaLink })
  launchDirectory(h, 'launch-linked', 'bracket.3mf', curaProject, {
    library: `local:${real}`,
  })

  assert.equal(only(h.sessions.list()).launchId, 'launch-linked')
})

test('a hand-edited library that is not a string is ignored, not thrown on', () => {
  const h = harness()
  const directory = join(h.sessionsDir, 'launch-handedited')
  mkdirSync(directory, { recursive: true })
  curaProject(join(directory, 'bracket.3mf'))
  // `launch.json` lives in `userData` and the threat model is a person editing it, not an
  // attacker — but `sameLibrary` calls `toLowerCase`, so this is the one optional field where a
  // wrong *type* throws rather than reading oddly, and a throw here loses every other session too.
  writeFileSync(
    join(directory, LAUNCH_RECORD_NAME),
    JSON.stringify({
      launchId: 'launch-handedited',
      mode: 'new-project',
      projectId: 'project-9',
      fileId: 'file-9',
      slicerId: 'orca',
      installId: 'msix:x',
      fileName: 'bracket.3mf',
      launchedHash: 'whatever',
      startedAt: h.clock.now,
      library: 42,
    }),
  )

  const listed = only(h.sessions.list())

  // Dropped to "cannot tell", which is the same safe default a record written before the field
  // existed gets — and everything else in the record is still read.
  assert.equal(listed.projectId, 'project-9')
  assert.equal(listed.isOrphan, false)
})

test('a record with no library at all is still listed, and an orphan always is', () => {
  const h = harness({ libraryDir: join(root, 'a-third-library') })
  // Written before the field existed. "Cannot tell" is not "belongs to somebody else", and
  // hiding these would be this change deleting the user's memory of unfinished work.
  taskFourRecord(h, 'launch-task4-lib', 'bracket.3mf', 'project-4', curaProject)
  curaProject(join(h.sessionsDir, 'stray.3mf'))

  assert.deepEqual(
    h.sessions
      .list()
      .map((session) => session.launchId)
      .sort(),
    ['launch-task4-lib', 'stray.3mf'],
  )
})

/* -------------------------------------------------------------------------------------------
 * Not re-reading what has not moved
 * ---------------------------------------------------------------------------------------- */

test('listing twice hashes once, and a write is still noticed', () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-memo', 'bracket.3mf', (target) =>
    projectWithSetting(target, 'one'),
  )
  // The fixture hashes with `entryHash` directly, not through the host, so nothing is memoised yet.
  assert.equal(h.sessions.hashCount(), 0)

  // The hot path: the card mounts on every project page visit and asks on construction. This used
  // to decompress every entry of every archive under `slicer-sessions/` on each of them,
  // synchronously, on the main process, behind an IPC call.
  assert.equal(only(h.sessions.list()).fileState, 'unchanged')
  const afterFirst = h.sessions.hashCount()
  assert.equal(afterFirst, 1, 'the first list has to actually read the file')
  for (let i = 0; i < 5; i += 1) assert.equal(only(h.sessions.list()).fileState, 'unchanged')
  assert.equal(h.sessions.hashCount(), afterFirst, 'nothing moved, and it read the bytes anyway')

  // And the half that matters: `list()` is still the mechanism of record. It asks the disk every
  // time; what it skips is recomputing a hash for bytes whose mtime, size and inode all agree.
  //
  // A **different-length** value, not `'one'` → `'two'`. Same length meant same archive size and,
  // at the same path, the same inode — so the whole assertion rested on `mtimeMs` moving between
  // two writes a few milliseconds apart. Windows last-write granularity is about 15.6 ms and CI is
  // `ubuntu-latest` on every job, so a red here would only ever have appeared on a developer's
  // machine, which is the worst place for it to appear first.
  projectWithSetting(path, 'a considerably longer value than the one before it')
  assert.equal(only(h.sessions.list()).fileState, 'changed')
  assert.ok(h.sessions.hashCount() > afterFirst, 'a changed file was answered from the memo')
})

test('a file recreated after a sweep is hashed again rather than remembered', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-memo-2', 'bracket.3mf', (target) =>
    projectWithSetting(target, 'one'),
  )
  const child = trackLaunch(h, 'launch-memo-2', directory, path, record.launchedHash)
  child.exit()
  h.clock.advance(11_000)
  assert.equal(existsSync(path), false)

  // Row 20 puts a complete file back at exactly this path. A memo the sweep had not invalidated
  // would answer for it out of what the *previous* file hashed to.
  projectWithSetting(path, 'two')
  const before = h.sessions.hashCount()

  assert.equal(only(h.sessions.list()).fileState, 'changed')
  assert.ok(h.sessions.hashCount() > before)
})

/* -------------------------------------------------------------------------------------------
 * Change detection, end to end
 * ---------------------------------------------------------------------------------------- */

test('a changed entry is named, and nothing else is', () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-h', 'bracket.3mf', (target) =>
    projectWithSetting(target, 'two'),
  )

  projectWithSetting(path, 'three')

  const session = only(h.sessions.list())
  assert.equal(session.fileState, 'changed')
  assert.deepEqual(session.entryDiff, {
    added: [],
    removed: [],
    changed: ['Metadata/project_settings.config'],
  })
  // The pair of sizes is what a user compares at a glance, so it has to move with the file: the
  // source is the record's, and the returned one is measured now.
  assert.equal(session.sourceSizeBytes, 1234)
  assert.equal(session.returnedSizeBytes, statSync(path).size)
  assert.notEqual(session.returnedSizeBytes, session.sourceSizeBytes)
})

test('the same content with different ZIP timestamps is unchanged', () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-i', 'bracket.3mf', (target) =>
    bambuLineageProject(target, ['X-BBL-Client-Version']),
  )

  // What all three of the Bambu-lineage savers do on every save: the same entries, wall-clock
  // timestamps in the headers. A whole-file hash reports this as a change; `entryHash` does not.
  const before = readFileSync(path)
  patchZipHeaders(path, (entry) => {
    entry.file.setUint16(entry.centralAt + 12, 0x4321, true)
    entry.file.setUint16(entry.centralAt + 14, 0x5678, true)
    entry.file.setUint16(entry.localAt + 10, 0x4321, true)
    entry.file.setUint16(entry.localAt + 12, 0x5678, true)
  })
  assert.notDeepEqual(readFileSync(path), before, 'the fixture did not actually change any bytes')

  assert.equal(only(h.sessions.list()).fileState, 'unchanged')
})

test('a returning file that classifies as another slicer says so', () => {
  const h = harness()
  const { path } = launchDirectory(
    h,
    'launch-j',
    'bracket.3mf',
    (target) => bambuLineageProject(target, ['X-BBL-Client-Type']),
    { sourceSlicer: 'bambu' },
  )

  // §16: a Bambu project opened in Orca and saved comes back classified `orca` — the header its
  // `slice_info.config` carries is the writer's, and the writer changed. The reconcile carries the
  // returning file's identity, not the record's.
  bambuLineageProject(path, ['OrcaSlicer-Version'])

  const session = only(h.sessions.list())
  assert.equal(session.fileState, 'changed')
  assert.equal(session.sourceSlicer, 'bambu')
  assert.equal(session.returnedAs, 'orca')
})

/* -------------------------------------------------------------------------------------------
 * The settle window
 * ---------------------------------------------------------------------------------------- */

test('a file that is empty, then half written, then complete reports settling then changed', () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-k', 'bracket.3mf', (target) =>
    projectWithSetting(target, 'one'),
  )
  // What the slicer is going to end up having written — built elsewhere so the launch directory
  // can hold nothing but the partial states until the last step.
  const complete = readFileSync(sample('saved.3mf', (target) => projectWithSetting(target, 'two')))

  // Cura's measured shape: 0 bytes, and an exclusive lock, for at least six seconds.
  writeFileSync(path, new Uint8Array(0))
  const first = only(h.sessions.list()).fileState
  h.clock.advance(5_000)

  // Half of an archive: the local header is there, the central directory is not. This is the one
  // `entryHash` alone gets wrong — it would hash the partial bytes and report a change, and the
  // user would be offered half a file to upload.
  writeFileSync(path, complete.subarray(0, 40))
  const second = only(h.sessions.list()).fileState
  h.clock.advance(5_000)

  writeFileSync(path, complete)
  const third = only(h.sessions.list())

  // Ten seconds of unreadability — past Cura's measured six-second lock and well inside the
  // window — and `unreadable` never appears.
  assert.deepEqual([first, second, third.fileState], ['settling', 'settling', 'changed'])
  assert.deepEqual(third.entryDiff, {
    added: [],
    removed: [],
    changed: ['Metadata/project_settings.config'],
  })
})

test('a file that never settles is reported unreadable once the window is spent', () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-l', 'bracket.3mf', curaProject)
  writeFileSync(path, new Uint8Array(0))

  assert.equal(only(h.sessions.list()).fileState, 'settling')
  h.clock.advance(59_000)
  assert.equal(only(h.sessions.list()).fileState, 'settling')
  h.clock.advance(2_000)
  assert.equal(only(h.sessions.list()).fileState, 'unreadable')

  // And a window that has been spent is not held against the next write: a file that goes
  // unreadable twice gets a fresh window each time rather than inheriting a spent one.
  bambuLineageProject(path, ['OrcaSlicer-Version'])
  assert.equal(only(h.sessions.list()).fileState, 'changed')
})

test('an unreadable file is refused for import rather than uploaded half written', async () => {
  const h = harness()
  const { path } = launchDirectory(h, 'launch-m', 'bracket.3mf', curaProject)
  writeFileSync(path, new Uint8Array(0))

  const settling = await rejection(h.sessions.resolve('launch-m', 'import', {}))
  assert.equal(settling.code, 'Conflict')
  assert.match(settling.message, /still being written/)

  h.clock.advance(61_000)
  const unreadable = await rejection(h.sessions.resolve('launch-m', 'import', {}))
  assert.equal(unreadable.code, 'Conflict')
  assert.match(unreadable.message, /could not be read/)
  assert.equal(existsSync(path), true, 'a refused import must not remove anything')
})

/* -------------------------------------------------------------------------------------------
 * The watch, and what it may not do on its own
 * ---------------------------------------------------------------------------------------- */

test('a watch event uploads nothing; only resolveSession does', async () => {
  const remote = recordingRemote()
  const h = harness({ isRemote: true, remote: remote.proxy })
  const { directory, path, record } = launchDirectory(h, 'launch-n', 'bracket.3mf', (target) =>
    projectWithSetting(target, 'one'),
  )
  trackLaunch(h, 'launch-n', directory, path, record.launchedHash)

  projectWithSetting(path, 'two')
  assert.equal(h.watched.length, 1, 'the launch was not watched at all')
  h.watched[0]!.fire()
  h.clock.advance(120_000)

  assert.deepEqual(
    remote.calls.filter((call) => call.method === 'POST'),
    [],
    'something uploaded a file nobody asked to upload',
  )
  assert.equal(existsSync(path), true)

  await h.sessions.resolve('launch-n', 'import', {})

  assert.deepEqual(
    remote.calls.filter((call) => call.method === 'POST').map((call) => call.path),
    ['/api/projects/project-1/files'],
  )
})

test('the poll compares only when the file has moved, and catches a write no watch reported', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-o', 'bracket.3mf', curaProject)
  trackLaunch(h, 'launch-o', directory, path, record.launchedHash)

  // Six ticks of a five-second poll, over a file nothing has touched. The first establishes the
  // baseline; the rest are the "do not bother" half of the mtime hint, and they are the only
  // reason the hint is not a branch no assertion could fail on.
  h.clock.advance(30_000)
  assert.equal(h.sessions.comparisonCount(), 1)
  assert.equal(only(h.sessions.list()).fileState, 'unchanged')

  // A write the watch never told anyone about — which is the whole case the poll exists for, and
  // why open question 6 says not to delete it as redundant.
  writeFileSync(path, new Uint8Array(0))
  h.clock.advance(6_000)
  assert.ok(h.sessions.comparisonCount() > 1, 'the poll never noticed the write')
  assert.equal(only(h.sessions.list()).fileState, 'settling')
  h.clock.advance(60_000)
  assert.equal(only(h.sessions.list()).fileState, 'unreadable')
})

test('the real fs.watch reaches the settle loop on this platform', async () => {
  // Everything else in this file injects the watch, which proves the loop and says nothing about
  // `fs.watch` itself. This one uses the real one — with the clock still injected, so the debounce
  // is not a real wait — because "the watch fires" is a property of the platform and not of this
  // module, and open question 6 says it is unmeasured on a network-backed `userData`.
  const clock = new Clock()
  seq += 1
  const sessionsDir = join(root, `watch-${seq}`, 'slicer-sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const sessions = new SlicerSessions({
    sessionsDir,
    session: () => ({ lib, ctx }),
    isRemote: () => false,
    remote: () => null,
    now: () => clock.now,
    timers: clock.timers,
  })
  try {
    const directory = join(sessionsDir, 'launch-real')
    mkdirSync(directory)
    const path = join(directory, 'bracket.3mf')
    curaProject(path)
    sessions.track({
      launchId: 'launch-real',
      directory,
      path,
      launchedHash: entryHash(path),
      child: { pid: 1 },
    })
    assert.equal(sessions.comparisonCount(), 0)

    bambuLineageProject(path, ['OrcaSlicer-Version'])

    // A real event, so a real wait — but polled to a generous ceiling rather than slept for a
    // fixed 300 ms, which is the shape `library.test.ts` was fixed for in this same task: the
    // behaviour being ruled out is "the event never arrives", so any ceiling separates the two and
    // a tight one only measures how busy the machine is. It exits on the first tick that sees it.
    const deadline = Date.now() + 20_000
    while (sessions.comparisonCount() === 0 && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 25))
      clock.advance(1_000)
    }

    assert.ok(sessions.comparisonCount() > 0, 'fs.watch never reached the settle loop')
  } finally {
    sessions.close()
  }
})

test('closing lets go of every watcher and timer', () => {
  const h = harness()
  const { directory, path, record } = launchDirectory(h, 'launch-p', 'bracket.3mf', curaProject)
  trackLaunch(h, 'launch-p', directory, path, record.launchedHash)
  assert.equal(h.sessions.trackedCount(), 1)

  h.sessions.close()

  assert.equal(h.sessions.trackedCount(), 0)
  assert.deepEqual(
    h.watched.map((entry) => entry.closed),
    [true],
  )
  assert.equal(h.clock.pending(), 0, 'a timer outlived the session it belonged to')
})

/* -------------------------------------------------------------------------------------------
 * The reconcile, locally
 * ---------------------------------------------------------------------------------------- */

test('an import adds a derived name, twice, and never touches the original', async () => {
  const h = harness()
  const projectId = project('Round trip')
  const original = new Uint8Array(readFileSync(sample('bracket-original.3mf', curaProject)))
  const fileId = await addLibraryFile(projectId, 'bracket.3mf', original)

  for (const round of ['first', 'second']) {
    const { path } = launchDirectory(
      h,
      `launch-${round}`,
      'bracket.3mf',
      (target) => bambuLineageProject(target, ['X-BBL-Client-Version', 'Application']),
      { projectId, fileId, launchedHash: 'not-what-is-there' },
    )
    const added = await h.sessions.resolve(`launch-${round}`, 'import', {})
    assert.ok(added, 'an import must answer with the file it added')
    assert.equal(existsSync(path), false, 'the launch copy is swept once it is safely in')
  }

  const detail = getProject(lib, ctx, projectId)
  assert.deepEqual(detail.files.map((file) => file.name).sort(), [
    'bracket (orca) (2).3mf',
    'bracket (orca).3mf',
    'bracket.3mf',
  ])
  // The original is untouched, byte for byte. Substitution is ordered, not barred — and this is
  // the order: the returning file is added, and deleting the old one is the user's own action.
  assert.deepEqual(
    new Uint8Array(readFileSync(resolveFilePath(lib, ctx, fileId).absPath)),
    original,
  )
})

test('the derived name follows what the file classifies as now, not what was launched', async () => {
  const h = harness()
  const projectId = project('Round trip identity')
  const { path } = launchDirectory(
    h,
    'launch-identity',
    'bracket.3mf',
    (target) => bambuLineageProject(target, ['X-BBL-Client-Type']),
    { projectId, sourceSlicer: 'bambu', slicerId: 'orca', launchedHash: 'not-what-is-there' },
  )
  // What came back is a *Cura* project — which is neither what went out (`bambu`) nor the product
  // that was launched (`orca`). A name taken from the record would say one of those two.
  curaProject(path)

  const added = (await h.sessions.resolve('launch-identity', 'import', {})) as FileDto

  assert.equal(added.name, 'bracket (cura).3mf')
})

test('discarding an orphan beside a record touches neither the record nor the launched file', async () => {
  const h = harness()
  const { directory, path } = launchDirectory(h, 'launch-neighbour', 'bracket.3mf', curaProject)
  const stray = join(directory, 'bracket-v2.3mf')
  curaProject(stray)

  await h.sessions.resolve('launch-neighbour/bracket-v2.3mf', 'discard', {})

  assert.equal(existsSync(stray), false)
  // The neighbour is a different session with a different file. Writing a `sweptAt` onto its
  // record would say the app had removed a file that is still sitting right there.
  assert.equal(existsSync(path), true)
  assert.equal(readRecordAt(directory).sweptAt, undefined)
  assert.equal(existsSync(directory), true)
})

test('an orphan needs a project, and takes the one it is given', async () => {
  const h = harness()
  const projectId = project('Adopted')
  curaProject(join(h.sessionsDir, 'stray.3mf'))

  const missing = await rejection(h.sessions.resolve('stray.3mf', 'import', {}))
  assert.equal(missing.code, 'Validation')
  assert.match(missing.message, /which project/)
  assert.equal(existsSync(join(h.sessionsDir, 'stray.3mf')), true)

  const added = (await h.sessions.resolve('stray.3mf', 'import', { projectId })) as FileDto
  assert.equal(added.name, 'stray (cura).3mf')
  assert.deepEqual(
    getProject(lib, ctx, projectId).files.map((file) => file.name),
    ['stray (cura).3mf'],
  )
  // The whole directory entry goes, because there was no record to keep.
  assert.equal(existsSync(join(h.sessionsDir, 'stray.3mf')), false)
})

test('a discard removes the file and keeps the record', async () => {
  const h = harness()
  const first = launchDirectory(h, 'launch-q', 'a.3mf', curaProject)

  assert.equal(await h.sessions.resolve('launch-q', 'discard', {}), null)

  assert.equal(existsSync(first.path), false)
  assert.equal(existsSync(first.directory), true)
  assert.equal(readRecordAt(first.directory).sweptAt, h.clock.now)
})

test('a bulk discard sweeps every one it was given, and counts only those', async () => {
  const h = harness()
  const first = launchDirectory(h, 'launch-r', 'a.3mf', curaProject)
  const second = launchDirectory(h, 'launch-s', 'b.3mf', curaProject)
  const spared = launchDirectory(h, 'launch-t', 'c.3mf', curaProject)

  // Three ids, one of which has never existed: an id that has already gone is not a failure, and
  // the count is what actually happened rather than what was asked for.
  const bulk = await h.sessions.discardMany(['launch-r', 'launch-s', 'launch-nowhere'])

  assert.deepEqual(bulk, { discarded: 2 })
  // Both, and by name. One enumeration serves the whole list now, and a loop that swept only the
  // first of them would still have counted two.
  assert.equal(existsSync(first.path), false)
  assert.equal(existsSync(second.path), false)
  assert.equal(readRecordAt(first.directory).sweptAt, h.clock.now)
  assert.equal(readRecordAt(second.directory).sweptAt, h.clock.now)
  // And nothing it was not given.
  assert.equal(existsSync(spared.path), true)
})

test('resolving a session that is not there is NotFound rather than a path join', async () => {
  const h = harness()
  launchDirectory(h, 'launch-elsewhere', 'a.3mf', curaProject)

  for (const launchId of ['..', '../../etc/passwd', '..\\..\\evil', 'launch-nowhere']) {
    const error = await rejection(h.sessions.resolve(launchId, 'discard', {}))
    assert.equal(error.code, 'NotFound', launchId)
  }
  // Nothing outside the sessions directory was reachable, because nothing was joined: the id is
  // matched against what the enumerator found.
  assert.deepEqual(readdirSync(h.sessionsDir), ['launch-elsewhere'])
})

test('derivedName counts up, and keeps the extension it was given', () => {
  assert.equal(derivedName('bracket.3mf', 'orca', new Set()), 'bracket (orca).3mf')
  assert.equal(
    derivedName('bracket.3mf', 'orca', new Set(['bracket (orca).3mf'])),
    'bracket (orca) (2).3mf',
  )
  assert.equal(
    derivedName('bracket.3mf', 'orca', new Set(['bracket (orca).3mf', 'bracket (orca) (2).3mf'])),
    'bracket (orca) (3).3mf',
  )
  // An orphan that names no slicer gets no attribution invented for it.
  assert.equal(derivedName('cube.stl', null, new Set()), 'cube.stl')
  assert.equal(derivedName('cube.stl', null, new Set(['cube.stl'])), 'cube (2).stl')
  assert.equal(derivedName('README', 'cura', new Set()), 'README (cura)')
})

/* -------------------------------------------------------------------------------------------
 * Remote mode
 * ---------------------------------------------------------------------------------------- */

test('a remote launch downloads through the proxy and launches out of the launch directory', async () => {
  const bytes = new Uint8Array(readFileSync(sample('remote-source.3mf', curaProject)))
  const seen: string[] = []
  const remote = new RemoteHost('https://library.invalid', (input) => {
    seen.push(input)
    if (input.endsWith('/api/projects/p-1')) {
      return Promise.resolve(jsonResponse(projectDetail('f-1', 'bracket.3mf')))
    }
    if (input.endsWith('/api/files/f-1/raw')) {
      return Promise.resolve(new Response(bytes, { status: 200 }))
    }
    return Promise.resolve(new Response('no', { status: 404 }))
  })
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const launch = await launcher.open('f-1', 'p-1', { mode: 'new-project', slicerId: 'orca' })

  assert.deepEqual(seen, [
    'https://library.invalid/api/projects/p-1',
    'https://library.invalid/api/files/f-1/raw',
  ])
  const copy = join(sessionsDir, launch.launchId, 'bracket.3mf')
  // The path that was spawned, not that a spawn happened.
  assert.deepEqual(spawns, [{ args: [copy] }])
  assert.equal(existsSync(copy), true)
  // Stripped in place: the download is gone and what is left is not the bytes that arrived.
  assert.equal(launch.stripped, true)
  assert.deepEqual(readdirSync(join(sessionsDir, launch.launchId)).sort(), [
    'bracket.3mf',
    'launch.json',
  ])
  assert.notDeepEqual(new Uint8Array(readFileSync(copy)), bytes)
  const record = readRecordAt(join(sessionsDir, launch.launchId))
  assert.equal(record.projectId, 'p-1')
  assert.equal(record.fileId, 'f-1')
  assert.equal(record.sourceSlicer, 'cura')
  // Which library this came out of. In remote mode that is an origin, and two servers with a
  // project of the same id are otherwise indistinguishable in `slicer-sessions/`.
  assert.equal(record.library, 'remote:https://library.invalid')
})

test('a remote launch of an .stl also goes through a launch directory', async () => {
  const bytes = new TextEncoder().encode('solid cube\nendsolid cube\n')
  const remote = new RemoteHost('https://library.invalid', (input) =>
    Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', 'cube.stl', 'model'))
        : new Response(bytes, { status: 200 }),
    ),
  )
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const launch = await launcher.open('f-1', 'p-1', { mode: 'new-project', slicerId: 'orca' })

  // Local mode launches a mesh where it lies, because the slicer then proposes its project beside
  // it in the project folder. In remote mode there is no project folder on this machine, so the
  // in-place argument does not exist and every launch has a directory.
  const copy = join(sessionsDir, launch.launchId, 'cube.stl')
  assert.deepEqual(spawns, [{ args: [copy] }])
  assert.deepEqual(new Uint8Array(readFileSync(copy)), bytes)
  assert.equal(launch.stripped, false)
})

test('a remote as-is launch hands over exactly what the library holds', async () => {
  const bytes = new Uint8Array(readFileSync(sample('as-is-source.3mf', curaProject)))
  const remote = new RemoteHost('https://library.invalid', (input) =>
    Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', 'bracket.3mf', 'slicer_project', 'cura'))
        : new Response(bytes, { status: 200 }),
    ),
  )
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const launch = await launcher.open('f-1', 'p-1', { mode: 'as-is' })

  // `as-is` means the user's own project, unchanged. It still needs a directory in remote mode —
  // there is no library path on this machine — but the bytes in it are the bytes on the server,
  // and stripping them would be the opposite of what the mode is for.
  const copy = join(sessionsDir, launch.launchId, 'bracket.3mf')
  assert.deepEqual(spawns, [{ args: [copy] }])
  assert.equal(launch.stripped, false)
  assert.deepEqual(new Uint8Array(readFileSync(copy)), bytes)
  // The slicer the *server's* index says wrote it, exactly as local `as-is` reads the slicer out
  // of the local index — and not the configured default, which is Orca on this fixture machine.
  assert.equal(launch.slicerId, 'cura')
})

test('a remote as-is launch of a mesh refuses before a byte is downloaded', async () => {
  const seen: string[] = []
  const remote = new RemoteHost('https://library.invalid', (input) => {
    seen.push(input)
    return Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', 'cube.stl', 'model'))
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    )
  })
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const error = await rejection(launcher.open('f-1', 'p-1', { mode: 'as-is' }))

  assert.equal(error.code, 'Validation')
  assert.match(error.message, /only a slicer project can be opened as it is/)
  // The cheap refusal runs first: nothing was downloaded and no directory was made.
  assert.deepEqual(seen, ['https://library.invalid/api/projects/p-1'])
  assert.deepEqual(readdirSync(sessionsDir), [])
  assert.equal(spawns.length, 0)
})

test('launching Cura in remote mode still spawns, and says nothing will come back', async () => {
  const remote = new RemoteHost('https://library.invalid', (input) =>
    Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', 'bracket.3mf'))
        : new Response(new Uint8Array(readFileSync(sample('cura-source.3mf', curaProject))), {
            status: 200,
          }),
    ),
  )
  const { launcher, spawns } = remoteLauncher(remote)

  const launch = await launcher.open('f-1', 'p-1', { mode: 'new-project', slicerId: 'cura' })

  assert.equal(spawns.length, 1, 'the launch must still happen; the limit is stated, not enforced')
  const notice = launch.notices.find((line) => line.includes('uploaded by hand'))
  assert.ok(notice, `no round-trip notice in ${JSON.stringify(launch.notices)}`)
  assert.match(notice, /never saves back over the file it was given/)
})

test('a remote import declares its length, because the server answers 411 without one', async () => {
  const outgoing: { url: string; init: RequestInit | undefined }[] = []
  const remote = new RemoteHost('https://library.invalid', (input, init) => {
    outgoing.push({ url: input, init })
    if (input.endsWith('/api/projects/p-9')) {
      return Promise.resolve(jsonResponse(projectDetail('f-9', 'bracket.3mf')))
    }
    return Promise.resolve(jsonResponse({ id: 'new-1', name: 'bracket (cura).3mf' }))
  })
  const h = harness({ isRemote: true, remote })
  const { path } = launchDirectory(h, 'launch-u', 'bracket.3mf', curaProject, {
    projectId: 'p-9',
    fileId: 'f-9',
    launchedHash: 'not-what-is-there',
  })
  const sizeBytes = readFileSync(path).byteLength

  const added = (await h.sessions.resolve('launch-u', 'import', {})) as FileDto

  assert.equal(added.name, 'bracket (cura).3mf')
  const upload = outgoing.find((call) => call.init?.method === 'POST')
  assert.ok(upload, 'nothing was posted')
  const headers = new Headers(upload.init?.headers)
  // The trap. `RemoteHost` turns `x-spm-content-length` into the real one; without it the body
  // reaches the server as `Transfer-Encoding: chunked` and it refuses with 411 before writing a
  // byte, because the quota check has to know the size first.
  assert.equal(headers.get('content-length'), String(sizeBytes))
  assert.equal(headers.get('x-spm-file-name'), 'bracket%20(cura).3mf')

  // The same proxy, the same body, with the header left off — which is what the assertion above
  // is worth something against. Nothing declares a length, so nothing sets one.
  outgoing.length = 0
  await remote.proxy(
    new Request('spm://app/api/projects/p-9/files', {
      method: 'POST',
      body: 'some bytes',
      // @ts-expect-error `duplex` is required by undici for a body and is not in lib.dom's type.
      duplex: 'half',
    }),
  )
  assert.equal(new Headers(outgoing[0]?.init?.headers).get('content-length'), null)
})

test('a remote launch names the file it was asked for, and refuses a pair that is not one', async () => {
  const seen: string[] = []
  const detail = projectDetail('f-1', 'first.3mf')
  detail.files.push({ ...detail.files[0]!, id: 'f-2', name: 'second.3mf' })
  const remote = new RemoteHost('https://library.invalid', (input) => {
    seen.push(input)
    return Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(detail)
        : new Response(new Uint8Array(readFileSync(sample('second.3mf', curaProject))), {
            status: 200,
          }),
    )
  })
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  // The second file, not the first. A launcher that took whatever the project listed first would
  // hand the slicer a file the user did not choose, and record it under the id of one they did.
  const launch = await launcher.open('f-2', 'p-1', { mode: 'new-project', slicerId: 'orca' })
  assert.ok(seen.includes('https://library.invalid/api/files/f-2/raw'))
  assert.deepEqual(spawns, [{ args: [join(sessionsDir, launch.launchId, 'second.3mf')] }])
  assert.equal(readRecordAt(join(sessionsDir, launch.launchId)).fileId, 'f-2')

  // And the pair check itself: in remote mode this lookup is the only thing that makes one, so a
  // renderer naming a file that is not in the project it named is refused before any bytes move.
  seen.length = 0
  const error = await rejection(launcher.open('f-9', 'p-1', { mode: 'new-project' }))
  assert.equal(error.code, 'NotFound')
  assert.deepEqual(seen, ['https://library.invalid/api/projects/p-1'])
})

test('a download that fails leaves no launch directory behind', async () => {
  const remote = new RemoteHost('https://library.invalid', (input) =>
    Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', 'bracket.3mf'))
        : new Response(JSON.stringify({ error: { code: 'NotFound', message: 'gone' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  )
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const error = await rejection(launcher.open('f-1', 'p-1', { mode: 'new-project' }))

  assert.equal(error.code, 'NotFound')
  assert.equal(spawns.length, 0)
  // Nothing was handed to anything and no record exists, so this directory could explain nothing
  // and no slicer could put anything back into it — which is why removing it does not touch
  // constraint 10, and why leaving it would be litter nothing would ever sweep.
  assert.deepEqual(readdirSync(sessionsDir), [])
})

test('a remote failure keeps its code across the wire', async () => {
  const remote = new RemoteHost('https://library.invalid', () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'QuotaExceeded', message: 'no room' } }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  const { launcher } = remoteLauncher(remote)

  const error = await rejection(launcher.open('f-1', 'p-1', { mode: 'as-is' }))

  assert.equal(error.code, 'QuotaExceeded')
  assert.equal(error.message, 'no room')
})

test('a 200 that is not a project is a sentence, not a TypeError dressed as one', async () => {
  // A proxy's idea of an error page, or a server this app is not actually talking to. Cast
  // unchecked, this reached `detail.files.find` and arrived at the user as `Internal` carrying a
  // Node message about reading a property of undefined.
  const remote = new RemoteHost('https://library.invalid', () => Promise.resolve(jsonResponse({})))
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const error = await rejection(launcher.open('f-1', 'p-1', { mode: 'new-project' }))

  assert.equal(error.code, 'Internal')
  assert.match(error.message, /did not answer with a project/)
  assert.doesNotMatch(error.message, /undefined|Cannot read/)
  assert.equal(spawns.length, 0)
  assert.deepEqual(readdirSync(sessionsDir), [])
})

test('a remote server naming a file something unusable is refused before anything is written', async () => {
  const remote = new RemoteHost('https://library.invalid', (input) =>
    Promise.resolve(
      input.endsWith('/api/projects/p-1')
        ? jsonResponse(projectDetail('f-1', '../../escaped.3mf'))
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ),
  )
  const { launcher, spawns, sessionsDir } = remoteLauncher(remote)

  const error = await rejection(launcher.open('f-1', 'p-1', { mode: 'new-project' }))

  assert.equal(error.code, 'Validation')
  assert.equal(spawns.length, 0)
  assert.deepEqual(readdirSync(sessionsDir), [])
})

/* -------------------------------------------------------------------------------------------
 * The pieces the tests above lean on
 * ---------------------------------------------------------------------------------------- */

type FakeChild = { pid: number; once(event: 'exit', listener: () => void): unknown; exit(): void }

/** Registers a launch with the session host, and hands back the child so a test can exit it. */
function trackLaunch(
  h: Harness,
  launchId: string,
  directory: string,
  path: string,
  launchedHash: string,
): FakeChild {
  let onExit: (() => void) | null = null
  const child: FakeChild = {
    pid: 4242,
    once: (_event, listener) => {
      onExit = listener
      return child
    },
    exit: () => onExit?.(),
  }
  const launch: LaunchedSession = { launchId, directory, path, launchedHash, child }
  h.sessions.track(launch)
  return child
}

/** A file built once somewhere outside a launch directory, so its bytes can be compared later. */
function sample(name: string, build: (path: string) => void): string {
  seq += 1
  const path = join(root, `sample-${seq}`, name)
  mkdirSync(join(root, `sample-${seq}`), { recursive: true })
  build(path)
  return path
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function projectDetail(
  fileId: string,
  name: string,
  kind: 'slicer_project' | 'model' = 'slicer_project',
  slicer: SlicerId | null = null,
): ProjectDetailDto {
  return {
    id: 'p-1',
    name: 'Remote project',
    tags: [],
    isArchived: false,
    createdAt: 0,
    updatedAt: 0,
    fileCount: 1,
    state: 'ok',
    files: [
      {
        id: fileId,
        name,
        kind,
        ...(slicer === null ? {} : { slicer }),
        sizeBytes: 0,
        rawUrl: `/api/files/${fileId}/raw`,
      },
    ],
  } as unknown as ProjectDetailDto
}

/** A `RemoteProxy` that records what it was asked and answers plausibly. */
function recordingRemote(): { proxy: RemoteProxy; calls: { method: string; path: string }[] } {
  const calls: { method: string; path: string }[] = []
  return {
    calls,
    proxy: {
      origin: 'https://library.invalid',
      proxy: (request: Request) => {
        const url = new URL(request.url)
        calls.push({ method: request.method, path: url.pathname })
        if (request.method === 'POST') {
          return Promise.resolve(jsonResponse({ id: 'new-1', name: basename(url.pathname) }))
        }
        return Promise.resolve(jsonResponse(projectDetail('file-1', 'bracket.3mf')))
      },
    },
  }
}

/** One install of every product, all bound — the same machine `slicers-launch.test.ts` uses. */
function remoteMachine(): SlicersConfig {
  return {
    version: SLICERS_CONFIG_VERSION,
    installs: [
      {
        id: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
        slicerId: 'orca',
        label: 'OrcaSlicer',
        origin: { kind: 'msix', packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g' },
        version: null,
        pathHint: 'C:\\Program Files\\WindowsApps\\OrcaSlicer\\orca-slicer.exe',
        addedAt: 1,
      },
      {
        id: 'registry:HKLM:Cura',
        slicerId: 'cura',
        label: 'UltiMaker Cura 5.13.0',
        origin: { kind: 'registry', hive: 'HKLM', key: 'Cura' },
        version: '5.13.0',
        pathHint: 'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
        addedAt: 1,
      },
    ],
    bindings: { orca: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g', cura: 'registry:HKLM:Cura' },
    defaultSlicerId: 'orca',
  }
}

/**
 * A launcher in remote mode: no library at all, a real `RemoteHost` with its `fetch` injected.
 *
 * `session: () => null` on purpose. Remote mode has no library, and a launcher that quietly read
 * one would pass every assertion here while doing the wrong thing on a real machine that happens
 * to have a folder open as well.
 */
function remoteLauncher(remote: RemoteHost): {
  launcher: SlicerLauncher
  spawns: { args: readonly string[] }[]
  sessionsDir: string
} {
  seq += 1
  const home = join(root, `remote-${seq}`)
  const sessionsDir = join(home, 'slicer-sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const configFile = join(home, SLICERS_FILE_NAME)
  writeConfig(configFile, remoteMachine())
  const spawns: { args: readonly string[] }[] = []
  const launcher = new SlicerLauncher({
    sessionsDir,
    slicers: new SlicersHost({
      configFile,
      platform: 'win32',
      isRegularFile: () => true,
      run: () => Promise.resolve('[]'),
      io: { isRegularFile: () => true },
    }),
    session: () => null,
    isRemote: () => true,
    remote: () => remote,
    spawn: (_command, args) => {
      spawns.push({ args })
      return { pid: 7 }
    },
    now: () => 1_756_000_000_000,
  })
  return { launcher, spawns, sessionsDir }
}
