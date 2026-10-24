import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import type { SlicerId } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import {
  closeLibrary,
  createProject,
  ensureLocalUser,
  entryDigests,
  entryHash,
  classifyFile,
  openLibrary,
  resolveFilePath,
  uploadFile,
  type Ctx,
  type Library,
} from '@spm/core'
import {
  bambuLineageProject,
  curaProject,
  plainMesh3mf,
  prusaProject,
  sliceInfo,
  writeZip,
} from '../../core/test/fixtures/make-3mf.ts'
import { patchZipHeaders } from '../../core/test/fixtures/patch-zip.ts'
import {
  SLICERS_CONFIG_VERSION,
  SLICERS_FILE_NAME,
  writeConfig,
  type SlicersConfig,
  type StoredInstall,
} from '../src/slicers/config.ts'
import { SlicersHost } from '../src/slicers/host.ts'
import {
  LAUNCH_RECORD_NAME,
  notices,
  SlicerLauncher,
  SLICER_CWD_DIR,
  SLICER_SESSIONS_DIR,
  type SlicerLaunchRecord,
  type SpawnSlicer,
} from '../src/slicers/launch.ts'
import { SLICERS, SLICER_IDS } from '../src/slicers/registry.ts'

/**
 * Both local launch paths, end to end against a real library and a real `slicers.json`, with the
 * spawn injected.
 *
 * **Every assertion here is about the path that was spawned, not about a spawn having happened**
 * (constraint 7). That is the whole difference between a test that would have caught the
 * data-loss defect in the first draft of the spec and one that would have gone green through it:
 * a `model`-kind `.3mf` launched at its library path spawns exactly as successfully as one
 * launched from a copy.
 *
 * **And about the working directory it was spawned in**, for the same reason: a slicer was measured
 * resolving an export path against its process cwd and writing into this repository, and a launch
 * with no `cwd` at all spawns exactly as successfully as one with the right one.
 *
 * Nothing here needs Electron, a slicer, or Windows.
 */

let root: string
let lib: Library
let ctx: Ctx
let libDir: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-launch-'))
  libDir = join(root, 'library')
  mkdirSync(libDir, { recursive: true })
  lib = openLibrary(libDir)
  ctx = ensureLocalUser(lib)
})

after(() => {
  closeLibrary(lib)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/* -------------------------------------------------------------------------------------------
 * The machine a launch runs on
 * ---------------------------------------------------------------------------------------- */

const CURA_13 = 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0'
const CURA_12 = 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0'
const ORCA = 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g'
const BAMBU = 'registry:HKLM:Bambu Studio-02.08.02.61'
const ANYCUBIC = 'registry:HKLM:AnycubicSlicerNext 1.4.1.2-1.4.1.2'
const PRUSA = 'registry:HKLM:PrusaSlicer-2.9.6'

const CURA_13_EXE = 'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe'
const CURA_12_EXE = 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe'
const ORCA_EXE = 'C:\\Program Files\\WindowsApps\\OrcaSlicer_2.4.3.0_x64\\orca-slicer.exe'
const BAMBU_EXE = 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'
const ANYCUBIC_EXE = 'C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe'
const PRUSA_EXE = 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe'

function install(id: string, slicerId: SlicerId, label: string, pathHint: string): StoredInstall {
  return {
    id,
    slicerId,
    label,
    origin: id.startsWith('msix:')
      ? { kind: 'msix', packageFamily: id.slice('msix:'.length) }
      : { kind: 'registry', hive: 'HKLM', key: id },
    version: null,
    pathHint,
    addedAt: 1_700_000_000_000,
  }
}

/** The machine the spike ran on, minus the second Cura: one install per product, all bound. */
function machine(overrides: Partial<SlicersConfig> = {}): SlicersConfig {
  const installs = [
    install(CURA_13, 'cura', 'UltiMaker Cura 5.13.0', CURA_13_EXE),
    install(ORCA, 'orca', 'OrcaSlicer', ORCA_EXE),
    install(BAMBU, 'bambu', 'Bambu Studio', BAMBU_EXE),
    install(ANYCUBIC, 'anycubic', 'AnycubicSlicerNext 1.4.1.2', ANYCUBIC_EXE),
    install(PRUSA, 'prusaslicer', 'PrusaSlicer', PRUSA_EXE),
  ]
  return {
    version: SLICERS_CONFIG_VERSION,
    installs,
    bindings: {
      cura: CURA_13,
      orca: ORCA,
      bambu: BAMBU,
      anycubic: ANYCUBIC,
      prusaslicer: PRUSA,
    },
    defaultSlicerId: 'orca',
    ...overrides,
  }
}

/**
 * One recorded spawn, **including the working directory the child was given**.
 *
 * `options` is captured because nothing forces it to be: a two-parameter recorder stays assignable
 * to the three-parameter `SpawnSlicer`, so this file would typecheck with the `cwd` unrecorded and
 * unasserted — which is the shipped defect with a type annotation over it.
 *
 * `cwdExisted` is `existsSync(options.cwd)` evaluated **inside the recorder, at the moment of the
 * spawn**, because that is the only moment at which the answer is interesting: a `mkdirSync` moved
 * to the launcher's constructor, or to the end of `open`, passes an after-the-fact check in the
 * test body and fails this one. It is recorded rather than asserted in place because an assertion
 * thrown inside the spawn is caught by `#spawnOrClean` and re-thrown as
 * `AppError('Internal', 'could not start …')`, which would report every such failure as the wrong
 * defect.
 */
type Spawned = {
  command: string
  args: readonly string[]
  options: { cwd: string }
  cwdExisted: boolean
}

type Harness = {
  launcher: SlicerLauncher
  spawns: Spawned[]
  sessionsDir: string
  /** `<userData>/slicer-cwd`, deliberately not created here — the launcher must make it. */
  scratchCwdDir: string
  /** Every directory under `slicer-sessions`, or `[]` when nothing ever created it. */
  sessions(): string[]
}

type HarnessOptions = {
  config?: SlicersConfig
  /** Which executables are on this machine. Defaults to all five. */
  present?: ReadonlySet<string>
  isRemote?: boolean
  hasLibrary?: boolean
  now?: number
  launchId?: string
  spawn?: SpawnSlicer
}

function harness(options: HarnessOptions = {}): Harness {
  seq += 1
  const home = join(root, `case-${seq}`)
  const sessionsDir = join(home, 'slicer-sessions')
  // Never created by the harness. Every `cwdExisted` assertion below is a claim about the
  // launcher's own `mkdirSync`, and a directory this function made would answer for it.
  const scratchCwdDir = join(home, 'slicer-cwd')
  const configFile = join(home, SLICERS_FILE_NAME)
  writeConfig(configFile, options.config ?? machine())

  const present = options.present
  const spawns: Spawned[] = []
  const launcher = new SlicerLauncher({
    sessionsDir,
    scratchCwdDir,
    slicers: new SlicersHost({
      configFile,
      platform: 'win32',
      // Every hint is a real file unless the case says otherwise. Off by default rather than on
      // would make every launch fail for the same reason and hide the ones that should.
      isRegularFile: (path) => (present ? present.has(path) : true),
      // A re-resolution that finds nothing, which is what marks a vanished install `missing`.
      run: () => Promise.resolve('[]'),
      io: { isRegularFile: () => true },
    }),
    session: () => (options.hasLibrary === false ? null : { lib, ctx }),
    isRemote: () => options.isRemote === true,
    // Local mode throughout this file. `test/slicers-sessions.test.ts` owns the remote launch,
    // where there is a proxy to answer with; a null one here is what makes a stray remote-mode
    // launch fail loudly rather than silently reading a library that is not the one being served.
    remote: () => null,
    spawn:
      options.spawn ??
      ((command, args, spawnOptions) => {
        spawns.push({
          command,
          args,
          options: spawnOptions,
          cwdExisted: existsSync(spawnOptions.cwd),
        })
        return { pid: 4242 }
      }),
    now: () => options.now ?? 1_756_382_400_000,
    newLaunchId: () => options.launchId ?? `launch-${seq}`,
  })

  return {
    launcher,
    spawns,
    sessionsDir,
    scratchCwdDir,
    sessions: () => (existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : []),
  }
}

/* -------------------------------------------------------------------------------------------
 * The library a launch reads
 * ---------------------------------------------------------------------------------------- */

async function addFile(
  projectId: string,
  name: string,
  build: (path: string) => void,
): Promise<{ id: string; absPath: string }> {
  seq += 1
  const staging = join(root, `staging-${seq}`, name)
  mkdirSync(dirname(staging), { recursive: true })
  build(staging)
  const bytes = readFileSync(staging)
  const dto = await uploadFile(lib, ctx, projectId, name, {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    sizeBytes: bytes.byteLength,
  })
  return { id: dto.id, absPath: resolveFilePath(lib, ctx, dto.id).absPath }
}

function project(name: string): string {
  seq += 1
  return createProject(lib, ctx, { name: `${name} ${seq}` }).id
}

function stlBytes(path: string): void {
  // An ASCII STL, which is what `classifyFile` calls a model on its extension alone.
  writeFileSync(path, 'solid cube\nendsolid cube\n')
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

/* -------------------------------------------------------------------------------------------
 * The data-loss rule (constraint 8)
 * ---------------------------------------------------------------------------------------- */

test('a model-kind .3mf is copied into a launch directory and its own path is never spawned', async () => {
  const h = harness()
  const projectId = project('Mesh')
  const file = await addFile(projectId, 'mesh.3mf', plainMesh3mf)

  // The trap this exists for: `classifyFile` calls this a `model`, exactly as it calls an `.stl`
  // one, and the reference library holds 28 of them.
  assert.deepEqual(classifyFile(file.absPath), { kind: 'model', slicer: null })

  const before = { bytes: readFileSync(file.absPath), mtimeMs: statSync(file.absPath).mtimeMs }

  const result = await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  assert.equal(h.spawns.length, 1)
  const spawned = h.spawns[0]!.args[0]
  assert.equal(spawned, join(h.sessionsDir, result.launchId, 'mesh.3mf'))
  assert.notEqual(spawned, file.absPath)
  assert.ok(existsSync(spawned), 'the copy the slicer was handed is not there')

  // The source is untouched — bytes and mtime both. The slicer's first save proposes
  // `<basename>.3mf`, which for this source *is* the source, so "we did not launch it in place"
  // and "the source is unchanged" are two different claims and both are worth making.
  assert.deepEqual(readFileSync(file.absPath), before.bytes)
  assert.equal(statSync(file.absPath).mtimeMs, before.mtimeMs)
})

test('an .stl is launched in place, and no launch directory is created at all', async () => {
  const h = harness()
  const projectId = project('Stl')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  const result = await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  assert.deepEqual(
    h.spawns.map((call) => call.args[0]),
    [file.absPath],
  )
  assert.deepEqual(h.sessions(), [], 'a mesh launched in place must leave no launch directory')
  assert.equal(result.stripped, false)
})

test('an .obj is launched in place too', async () => {
  const h = harness()
  const projectId = project('Obj')
  const file = await addFile(projectId, 'cube.obj', (path) => writeFileSync(path, 'v 0 0 0\n'))

  await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  assert.deepEqual(
    h.spawns.map((call) => call.args[0]),
    [file.absPath],
  )
  assert.deepEqual(h.sessions(), [])
})

/* -------------------------------------------------------------------------------------------
 * Path A — open as-is
 * ---------------------------------------------------------------------------------------- */

test('a slicer project opened as-is is spawned at the library path, with no copy and no strip', async () => {
  const h = harness()
  const projectId = project('AsIs')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)
  const before = { bytes: readFileSync(file.absPath), mtimeMs: statSync(file.absPath).mtimeMs }

  const result = await h.launcher.open(file.id, projectId, { mode: 'as-is' })

  assert.deepEqual(h.spawns, [
    {
      command: CURA_13_EXE,
      args: [file.absPath],
      // No launch directory on this path, so the scratch directory is the whole of the answer.
      options: { cwd: h.scratchCwdDir },
      cwdExisted: true,
    },
  ])
  assert.deepEqual(h.sessions(), [])
  assert.equal(result.stripped, false)
  // The file's own slicer, not the configured default (`orca`).
  assert.equal(result.slicerId, 'cura')
  assert.equal(result.installLabel, 'UltiMaker Cura 5.13.0')
  assert.equal(result.pid, 4242)
  assert.deepEqual(readFileSync(file.absPath), before.bytes)
  assert.equal(statSync(file.absPath).mtimeMs, before.mtimeMs)
})

test('as-is on a file that names no slicer falls back to the default and says so', async () => {
  const h = harness()
  const projectId = project('Unattributed')
  // Rule 4: saved but never sliced, so it is a project with no slicer the app can name.
  const file = await addFile(projectId, 'saved.3mf', (path) =>
    writeZip(path, [
      { name: '3D/3dmodel.model', data: '<model/>', deflate: true },
      { name: 'Metadata/project_settings.config', data: '{}' },
    ]),
  )
  assert.deepEqual(classifyFile(file.absPath), { kind: 'slicer_project', slicer: null })

  const result = await h.launcher.open(file.id, projectId, { mode: 'as-is' })

  assert.equal(result.slicerId, 'orca')
  assert.ok(
    result.notices.some((line) =>
      line.includes('does not say which slicer wrote it, so your default (OrcaSlicer) was used'),
    ),
    `notices did not explain the choice: ${JSON.stringify(result.notices)}`,
  )
})

test('as-is refuses a file that is not a slicer project, and points at the other path', async () => {
  const h = harness()
  const projectId = project('AsIsMesh')
  const file = await addFile(projectId, 'mesh.3mf', plainMesh3mf)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'as-is' }))

  assert.equal(error.code, 'Validation')
  assert.match(error.message, /start a new slicer project from this file instead/)
  assert.equal(h.spawns.length, 0)
})

/* -------------------------------------------------------------------------------------------
 * Path B — the launch directory
 * ---------------------------------------------------------------------------------------- */

test('a slicer project handed to another slicer is stripped into a launch directory', async () => {
  const h = harness({ launchId: 'strip-me' })
  const projectId = project('Strip')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const result = await h.launcher.open(file.id, projectId, {
    mode: 'new-project',
    slicerId: 'anycubic',
  })

  const copy = join(h.sessionsDir, 'strip-me', 'bracket.3mf')
  assert.deepEqual(h.spawns, [
    {
      command: ANYCUBIC_EXE,
      args: [copy],
      options: { cwd: join(h.sessionsDir, 'strip-me') },
      cwdExisted: true,
    },
  ])
  assert.equal(result.stripped, true)
  // The copy keeps the source's basename, because that is what four of five slicers propose on
  // the first save and what Cura carries into its Save-As dialog.
  assert.equal(basename(copy), basename(file.absPath))
  // Stripped means stripped: nothing in the copy still says Cura.
  assert.deepEqual(classifyFile(copy), { kind: 'model', slicer: null })
  assert.notEqual(entryHash(copy), entryHash(file.absPath))
})

test('a source with nothing to strip is copied verbatim, and says it was not stripped', async () => {
  const h = harness({ launchId: 'verbatim' })
  const projectId = project('Verbatim')
  const file = await addFile(projectId, 'mesh.3mf', plainMesh3mf)

  const result = await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  const copy = join(h.sessionsDir, 'verbatim', 'mesh.3mf')
  assert.equal(h.spawns[0]!.args[0], copy)
  assert.equal(result.stripped, false)
  assert.deepEqual(readFileSync(copy), readFileSync(file.absPath))
})

test('a source called launch.json is refused rather than overwritten by its own record', async () => {
  const h = harness()
  const projectId = project('Collision')
  // `.json` takes the plain-copy branch, and the copy keeps the source's basename — which for this
  // one name is the name of the record written beside it a moment later. Left alone, the record
  // replaces the copy, and the slicer is handed a record whose `launchedHash` describes the file it
  // has just overwritten.
  const file = await addFile(projectId, 'launch.json', (path) =>
    writeFileSync(path, '{"mine": true}'),
  )

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.code, 'Validation')
  assert.match(error.message, /a file called launch\.json cannot be prepared for a new project/)
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.sessions(), [], 'the refusal must not leave a launch directory behind')
  // And the user's own file is exactly as it was.
  assert.equal(readFileSync(file.absPath, 'utf8'), '{"mine": true}')

  // Spelled differently, and on the platform this ships to it is the same file. The comparison is
  // case-insensitive for that reason, and refusing it on a case-sensitive filesystem too costs
  // nothing: it is one basename, and no slicer can do anything with a `.json` anyway.
  const other = project('CollisionCase')
  const shouty = await addFile(other, 'Launch.JSON', (path) => writeFileSync(path, '{}'))
  const second = await rejection(h.launcher.open(shouty.id, other, { mode: 'new-project' }))
  assert.equal(second.code, 'Validation')
  assert.equal(h.spawns.length, 0)
})

test('a launch directory holds the copy and the record, and nothing named like the other', async () => {
  const h = harness({ launchId: 'two-entries' })
  const projectId = project('TwoEntries')
  const file = await addFile(projectId, 'plate.3mf', curaProject)

  await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  const directory = join(h.sessionsDir, 'two-entries')
  assert.deepEqual(readdirSync(directory).sort(), ['launch.json', 'plate.3mf'])
  // The invariant the refusal above exists to keep: the record still describes the copy.
  const record = JSON.parse(
    readFileSync(join(directory, LAUNCH_RECORD_NAME), 'utf8'),
  ) as SlicerLaunchRecord
  assert.equal(record.launchedHash, entryHash(join(directory, record.fileName)))
})

test('a file that is neither a mesh nor a 3MF is copied into a launch directory unchanged', async () => {
  const h = harness({ launchId: 'other' })
  const projectId = project('Other')
  const file = await addFile(projectId, 'notes.gcode', (path) => writeFileSync(path, ';G-code\n'))

  const result = await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  const copy = join(h.sessionsDir, 'other', 'notes.gcode')
  assert.equal(h.spawns[0]!.args[0], copy)
  assert.equal(result.stripped, false)
  assert.deepEqual(readFileSync(copy), readFileSync(file.absPath))
})

/* -------------------------------------------------------------------------------------------
 * The launch record
 * ---------------------------------------------------------------------------------------- */

test('launch.json records the launch, with launchedHash equal to entryHash of what was launched', async () => {
  const h = harness({ launchId: 'recorded', now: 1_756_400_000_123 })
  const projectId = project('Recorded')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const result = await h.launcher.open(file.id, projectId, {
    mode: 'new-project',
    slicerId: 'orca',
  })

  const directory = join(h.sessionsDir, 'recorded')
  const record = JSON.parse(
    readFileSync(join(directory, LAUNCH_RECORD_NAME), 'utf8'),
  ) as SlicerLaunchRecord
  assert.deepEqual(record, {
    launchId: 'recorded',
    mode: 'new-project',
    projectId,
    fileId: file.id,
    slicerId: 'orca',
    installId: ORCA,
    fileName: 'bracket.3mf',
    launchedHash: entryHash(join(directory, 'bracket.3mf')),
    startedAt: 1_756_400_000_123,
    // Which library this came out of. `slicer-sessions/` is per-machine and every id above is
    // per-library, so without this a session survives a folder switch as an unanswerable row.
    // `realpathSync.native` here too, computed independently rather than borrowed from the code
    // under test: on Windows a temporary directory can carry an 8.3 short name, and `resolve`
    // alone would then disagree with what the launcher records for the very same folder.
    library: `local:${realpathSync.native(libDir)}`,
    // Task 5's three, and each one is a fact the reconcile cannot recover afterwards: four of
    // five slicers save back *over* this file, so once the first Ctrl+S lands nothing on disk can
    // still say what it was, how big it was, or what was in it.
    sourceSlicer: 'cura',
    sourceSizeBytes: statSync(join(directory, 'bracket.3mf')).size,
    launchedEntries: Object.fromEntries(entryDigests(join(directory, 'bracket.3mf'))),
  })
  // Not the source's digests: the copy was stripped, so a diff against the original would blame
  // the slicer for entries this app removed.
  assert.notDeepEqual(
    record.launchedEntries,
    Object.fromEntries(entryDigests(file.absPath)),
    'the record kept the source digests rather than those of the launched copy',
  )
  assert.equal(record.launchId, result.launchId)
  // The hash is of the *stripped copy*, which is the file the slicer has — not of the source.
  assert.notEqual(record.launchedHash, entryHash(file.absPath))
  // The directory holds the file and the record, and nothing else.
  assert.deepEqual(readdirSync(directory).sort(), ['bracket.3mf', 'launch.json'])
})

test('an in-place launch writes no record, because there is no directory to put one in', async () => {
  const h = harness()
  const projectId = project('NoRecord')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  await h.launcher.open(file.id, projectId, { mode: 'new-project' })

  assert.deepEqual(h.sessions(), [])
})

/* -------------------------------------------------------------------------------------------
 * Refusals
 * ---------------------------------------------------------------------------------------- */

test('a strip that would leave configuration behind refuses, names the reason, and never spawns', async () => {
  const h = harness()
  const projectId = project('TwoFlavours')
  // Both a Cura tree and a PrusaSlicer config. `classify3mf` calls it `cura` (first match wins),
  // so it gets the Cura strip set — and what comes out still classifies `prusaslicer`.
  const file = await addFile(projectId, 'mixed.3mf', (path) =>
    writeZip(path, [
      { name: '3D/3dmodel.model', data: '<model/>', deflate: true },
      { name: 'Cura/preferences.cfg', data: '[general]' },
      { name: 'Metadata/Slic3r_PE.config', data: '; generated by PrusaSlicer' },
    ]),
  )

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.code, 'Validation')
  assert.equal(error.details?.['reason'], 'configuration-left-behind')
  assert.match(error.message, /stripping it left slicer configuration behind/)
  // Constraint 9: it says the other path is still open, rather than quietly taking it.
  assert.match(error.message, /Opening it as it is, without stripping, is still available/)
  // The count, not only the throw: a fallback to the original would have thrown nothing at all.
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.sessions(), [], 'a refused strip left its launch directory behind')
})

test('a 3MF that is not a readable archive refuses as unreadable rather than being handed over', async () => {
  const h = harness()
  const projectId = project('Corrupt')
  const file = await addFile(projectId, 'torn.3mf', (path) => writeFileSync(path, 'not a zip'))

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.details?.['reason'], 'unreadable')
  assert.match(error.message, /could not be read as a 3MF archive/)
  assert.equal(h.spawns.length, 0)
})

test('an encrypted entry refuses as encrypted, which is a different next move from unreadable', async () => {
  const h = harness()
  const projectId = project('Encrypted')
  const file = await addFile(projectId, 'locked.3mf', (path) => {
    curaProject(path)
    // General-purpose bit 0, in both headers: the entry is encrypted, so the rewriter cannot
    // reproduce bytes it cannot read. The archive is otherwise perfectly well-formed, which is what
    // separates this from the `unreadable` case.
    patchZipHeaders(path, ({ name, file: view, centralAt, localAt }) => {
      if (name !== '3D/3dmodel.model') return
      view.setUint16(centralAt + 8, 1, true)
      view.setUint16(localAt + 6, 1, true)
    })
  })

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.details?.['reason'], 'encrypted')
  assert.match(error.message, /it is an encrypted archive/)
  assert.match(error.message, /Opening it as it is, without stripping, is still available/)
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.sessions(), [])
})

test('a launch whose bound install has vanished reports it as gone and does not spawn', async () => {
  // Every executable is there except Cura's, and the re-resolution finds nothing.
  const h = harness({
    present: new Set([ORCA_EXE, BAMBU_EXE, ANYCUBIC_EXE, PRUSA_EXE]),
  })
  const projectId = project('Gone')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'as-is' }))

  assert.equal(error.code, 'NotFound')
  assert.match(error.message, /no longer installed where it was/)
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.sessions(), [], 'a vanished install must not leave a launch directory')
})

test('a product with two installs and no binding refuses, naming the choice rather than making it', async () => {
  const config = machine()
  const h = harness({
    config: {
      ...config,
      installs: [
        ...config.installs,
        install(CURA_12, 'cura', 'UltiMaker Cura 5.12.0', CURA_12_EXE),
      ],
      bindings: { ...config.bindings, cura: undefined },
    },
  })
  const projectId = project('TwoCuras')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'as-is' }))

  assert.equal(error.code, 'Conflict')
  assert.match(error.message, /2 installs of UltiMaker Cura/)
  assert.match(error.message, /UltiMaker Cura 5\.13\.0/)
  assert.match(error.message, /UltiMaker Cura 5\.12\.0/)
  assert.equal(h.spawns.length, 0)
})

test('a product with one unbound install is not described as a choice between installs', async () => {
  const config = machine()
  const h = harness({
    config: {
      ...config,
      // A second Cura that is gone. The count the message may quote is the *usable* one, which is
      // one — and "1 installs … choose which one" is both broken English and a false question.
      installs: [
        ...config.installs,
        { ...install(CURA_12, 'cura', 'UltiMaker Cura 5.12.0', CURA_12_EXE), missing: true },
      ],
      bindings: { ...config.bindings, cura: undefined },
    },
  })
  const projectId = project('OneUnbound')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'as-is' }))

  assert.equal(error.code, 'Conflict')
  assert.match(
    error.message,
    /UltiMaker Cura is installed \(UltiMaker Cura 5\.13\.0\) but not chosen/,
  )
  assert.doesNotMatch(error.message, /installs of/)
  assert.equal(h.spawns.length, 0)
})

test('a product with no install at all is reported as not set up, not as an ambiguous choice', async () => {
  const config = machine()
  const h = harness({
    config: {
      ...config,
      installs: config.installs.filter((row) => row.slicerId !== 'cura'),
      bindings: { ...config.bindings, cura: undefined },
    },
  })
  const projectId = project('NoCura')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'as-is' }))

  assert.equal(error.code, 'NotFound')
  assert.match(error.message, /UltiMaker Cura is not set up on this machine/)
  assert.equal(h.spawns.length, 0)
})

test('a file that belongs to another project is not launchable through this one', async () => {
  const h = harness()
  const mine = project('Mine')
  const theirs = project('Theirs')
  const file = await addFile(theirs, 'bracket.3mf', curaProject)
  // A file of its own in the project being named, which is what makes this a *pair* check rather
  // than an "is this project empty" check. Without it, a launcher that took whichever file the
  // project happened to list first would refuse here for the wrong reason and pass.
  const decoy = await addFile(mine, 'decoy.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, mine, { mode: 'as-is' }))

  assert.equal(error.code, 'NotFound')
  assert.equal(h.spawns.length, 0)

  // And the same project does launch its own file, so the refusal above is not this fixture
  // refusing everything.
  await h.launcher.open(decoy.id, mine, { mode: 'as-is' })
  assert.deepEqual(h.spawns[0]?.args, [decoy.absPath])
})

test('no library open is a refusal, and so is remote mode with no server attached', async () => {
  const closed = await rejection(
    harness({ hasLibrary: false }).launcher.open('f', 'p', { mode: 'as-is' }),
  )
  assert.equal(closed.code, 'Conflict')
  assert.match(closed.message, /no library folder is open/)

  // Remote mode reaches a different refusal now that it is built: there is no *server*, which is
  // not the same failure as there being no folder, and the message has to say which it was.
  const remote = await rejection(
    harness({ isRemote: true }).launcher.open('f', 'p', { mode: 'as-is' }),
  )
  assert.equal(remote.code, 'Conflict')
  assert.match(remote.message, /not connected to a server/)
})

test('no default slicer and nothing chosen is a refusal, not a guess', async () => {
  const h = harness({ config: { ...machine(), defaultSlicerId: null } })
  const projectId = project('NoDefault')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.code, 'Conflict')
  assert.match(error.message, /no default slicer is set/)
  assert.equal(h.spawns.length, 0)
})

test('a spawn that throws takes its launch directory with it', async () => {
  const h = harness({
    launchId: 'doomed',
    spawn: () => {
      throw new Error('ENOENT')
    },
  })
  const projectId = project('Doomed')
  const file = await addFile(projectId, 'bracket.3mf', curaProject)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.code, 'Internal')
  assert.deepEqual(h.sessions(), [])
})

/* -------------------------------------------------------------------------------------------
 * argv
 * ---------------------------------------------------------------------------------------- */

test('argv is exactly the registry row, which is one bare positional argument', async () => {
  const h = harness()
  const projectId = project('Argv')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'prusaslicer' })

  assert.deepEqual(h.spawns, [
    {
      command: PRUSA_EXE,
      args: [file.absPath],
      options: { cwd: h.scratchCwdDir },
      cwdExisted: true,
    },
  ])
})

/* -------------------------------------------------------------------------------------------
 * The working directory the child inherits (F-7)
 * ---------------------------------------------------------------------------------------- */

test('a launch that builds a directory hands the slicer that directory as its cwd', async () => {
  const h = harness({ launchId: 'cwd-directory' })
  const projectId = project('CwdDirectory')
  const file = await addFile(projectId, 'plate.3mf', curaProject)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'orca' })

  const directory = join(h.sessionsDir, 'cwd-directory')
  assert.equal(h.spawns[0]?.options.cwd, directory)
  assert.equal(h.spawns[0]?.cwdExisted, true)
  // The whole point of preferring the launch directory: a cwd-relative write lands beside the
  // copy, where `#scan` can see it, rather than anywhere else on the machine.
  assert.equal(dirname(h.spawns[0]!.args[0]!), directory)
})

test('a launch that builds no directory hands the slicer the scratch directory, created first', async () => {
  const h = harness()
  const projectId = project('CwdScratch')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  // Nothing has created it yet. This is the fresh-profile shape, and it is the one the earlier
  // draft of the design would have failed on.
  assert.equal(existsSync(h.scratchCwdDir), false)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'anycubic' })

  assert.equal(h.spawns[0]?.options.cwd, h.scratchCwdDir)
  // Existed *at the moment of the spawn*, not merely by the time this line runs.
  assert.equal(h.spawns[0]?.cwdExisted, true)
  // Not the two answers the spec rejected. `sessionsDir` is created lazily, so a `spawn` pointed
  // at it on a fresh profile throws `ENOENT` and every in-place launch fails; and a stray landing
  // loose in it is surfaced to the user as an orphan session they never made.
  assert.notEqual(h.spawns[0]?.options.cwd, h.sessionsDir)
  assert.deepEqual(h.sessions(), [], 'the scratch directory must not be under slicer-sessions')
})

test('the scratch directory is remade for the next launch after the user deletes it', async () => {
  const h = harness()
  const projectId = project('CwdRemade')
  const file = await addFile(projectId, 'cube.stl', stlBytes)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'anycubic' })
  // A profile the user has cleaned out between two launches. Creating the directory once, at
  // construction, survives the test above and dies here.
  rmSync(h.scratchCwdDir, { recursive: true, force: true })
  assert.equal(existsSync(h.scratchCwdDir), false)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'anycubic' })

  assert.equal(h.spawns.length, 2)
  assert.equal(h.spawns[1]?.options.cwd, h.scratchCwdDir)
  assert.equal(h.spawns[1]?.cwdExisted, true)
})

/**
 * **The one `SpawnSlicer` this app ever runs is the one nothing above can call.**
 *
 * `new SlicerLauncher` has three call sites: `app.ts` and the two test harnesses. Every assertion
 * in this file is therefore about a recorder, and the closure that starts a real process is
 * reached only by launching a slicer — which no test here may do.
 *
 * And the type does not hold it. A closure that declares two parameters is assignable to a
 * three-parameter function type, so reverting `spawn: (command, args, { cwd }) => …` to
 * `spawn: (command, args) => …` and dropping `cwd` from the spawn options **typechecks, leaves
 * both suites green, and restores the defect that wrote 2 456 984 bytes into this repository**.
 *
 * So this is a source walk — the instrument `browse-source.test.ts` added for exactly this class,
 * the leg of a containment no runtime assertion can reach — and it carries that file's positive
 * control for that file's reason: a reader that came back with nothing would otherwise pass by
 * finding no offending call either.
 */
test('the spawn in app.ts passes the cwd, and joins the two directories side by side', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'app.ts'), 'utf8')

  // The positive control, in the same read as the assertions: the launcher really is constructed
  // in this file, so a reader that returned an empty string dies here rather than passing
  // everything below it vacuously.
  assert.ok(source.includes('new SlicerLauncher({'), 'app.ts does not construct the launcher')

  // The options object of the one `spawn` call, matched rather than searched for the word `cwd`
  // anywhere in the file — the comment above that call says `cwd` three times, and a comment is
  // exactly what survives deleting the argument.
  const call = source.match(/spawn\(command, \[\.\.\.args\], \{([^}]*)\}\)/)
  assert.ok(call, 'no spawn call of the expected shape was found in app.ts')
  const options = (call[1] ?? '').split(',').map((part) => part.trim())
  assert.ok(options.includes('cwd'), `the child is spawned without a cwd: {${call[1]}}`)

  // The other half of "not `sessionsDir`". The harness pins that the launcher was handed two
  // different directories; this pins that the two *the app* hands it are these two constants,
  // each joined onto `userData` — the same parent, side by side, neither inside the other.
  assert.ok(source.includes("join(app.getPath('userData'), SLICER_SESSIONS_DIR)"))
  assert.ok(source.includes("join(app.getPath('userData'), SLICER_CWD_DIR)"))
  assert.notEqual(SLICER_CWD_DIR, SLICER_SESSIONS_DIR)
  for (const name of [SLICER_CWD_DIR, SLICER_SESSIONS_DIR]) {
    // Single segments, so "same parent" really does make them siblings: a constant that grew a
    // separator could put the scratch directory under `slicer-sessions` with both lines above
    // still reading exactly as they do now.
    assert.doesNotMatch(name, /[\\/]/, `${name} is a path, not a directory name`)
  }
  const userData = join(root, 'userData-for-this-assertion-only')
  assert.notEqual(join(userData, SLICER_CWD_DIR), join(userData, SLICER_SESSIONS_DIR))
})

/* -------------------------------------------------------------------------------------------
 * STEP, and the one product that cannot read it (F-4, F-5)
 * ---------------------------------------------------------------------------------------- */

/**
 * Bytes, not a model, and no fixture.
 *
 * Nothing on this path parses a STEP file: the launcher copies it and spawns a recorder. The
 * ISO-10303 magic is the whole of the input, the same way this suite already makes its `.stl`.
 */
function stepBytes(path: string): void {
  writeFileSync(path, 'ISO-10303-21;')
}

test('a .step handed to Cura is refused, and nothing is spawned', async () => {
  const h = harness()
  const projectId = project('StepCura')
  const file = await addFile(projectId, 'part.step', stepBytes)

  const error = await rejection(
    h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'cura' }),
  )

  assert.equal(error.code, 'Validation')
  assert.deepEqual(error.details, { slicerId: 'cura', extension: '.step' })
  // The sentence the user actually sees, spelled out rather than rebuilt from the registry the
  // code reads — a message derived here would agree with a table that had every row wrong.
  assert.equal(
    error.message,
    'UltiMaker Cura cannot open STEP files. ' +
      'Choose one of PrusaSlicer, Anycubic Slicer Next, Bambu Studio, OrcaSlicer instead.',
  )
  // The assertion, not the throw: launching Cura at a STEP file is the measured failure — a
  // healthy process, an empty plate and a warning in a log nobody opens.
  assert.equal(h.spawns.length, 0)
  assert.deepEqual(h.sessions(), [], 'the refusal must come before anything is written')
})

test('a .stp is the same refusal, and says which extension it was', async () => {
  const h = harness()
  const projectId = project('StpCura')
  const file = await addFile(projectId, 'part.stp', stepBytes)

  const error = await rejection(
    h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'cura' }),
  )

  assert.equal(error.code, 'Validation')
  assert.deepEqual(error.details, { slicerId: 'cura', extension: '.stp' })
  assert.equal(h.spawns.length, 0)
})

test('an uppercase .STEP is refused too, which is the spelling in the user library', async () => {
  const h = harness()
  const projectId = project('UpperStepCura')
  // `Nozzle Wiper Guard.STEP`, the real file Cura's own log shows silently dropped nine minutes
  // before the spike opened anything.
  const file = await addFile(projectId, 'Wiper Guard.STEP', stepBytes)

  const error = await rejection(
    h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'cura' }),
  )

  assert.equal(error.code, 'Validation')
  assert.deepEqual(error.details, { slicerId: 'cura', extension: '.step' })
  assert.equal(h.spawns.length, 0)
})

test('the common shape: Cura is the default and nothing was chosen', async () => {
  // No `slicerId` on the call, because the UI has no per-launch picker. This is how a user
  // actually reaches the refusal.
  const h = harness({ config: machine({ defaultSlicerId: 'cura' }) })
  const projectId = project('StepDefault')
  const file = await addFile(projectId, 'part.step', stepBytes)

  const error = await rejection(h.launcher.open(file.id, projectId, { mode: 'new-project' }))

  assert.equal(error.code, 'Validation')
  assert.deepEqual(error.details, { slicerId: 'cura', extension: '.step' })
  assert.equal(h.spawns.length, 0)
})

// Four, one per product, and named individually: a refusal keyed on the wrong side of the boolean
// passes a suite that only ever asks about Cura, and an assertion satisfied by refusing everything
// is not an assertion.
for (const slicerId of ['prusaslicer', 'anycubic', 'bambu', 'orca'] as const) {
  test(`a .step opens in ${slicerId}, which was measured reading both extensions`, async () => {
    const h = harness({ launchId: `step-${slicerId}` })
    const projectId = project(`Step-${slicerId}`)
    const file = await addFile(projectId, 'part.step', stepBytes)

    const result = await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId })

    assert.equal(h.spawns.length, 1)
    assert.equal(result.slicerId, slicerId)
  })
}

test('a .step goes through a launch directory, keeping its own basename', async () => {
  const h = harness({ launchId: 'step-copied' })
  const projectId = project('StepCopied')
  const file = await addFile(projectId, 'bracket.step', stepBytes)

  await h.launcher.open(file.id, projectId, { mode: 'new-project', slicerId: 'prusaslicer' })

  // Asserted as a path rather than trusted as a paragraph: a STEP moved onto the in-place branch
  // would spawn exactly as successfully from the library path, and nothing has measured what the
  // four capable slicers propose on the first save from a STEP input.
  const copy = join(h.sessionsDir, 'step-copied', 'bracket.step')
  assert.equal(h.spawns[0]?.args[0], copy)
  assert.notEqual(h.spawns[0]?.args[0], file.absPath)
  assert.equal(basename(copy), basename(file.absPath))
  assert.equal(h.spawns[0]?.options.cwd, join(h.sessionsDir, 'step-copied'))
  assert.deepEqual(readFileSync(copy), readFileSync(file.absPath))
})

test('the registry says which products open STEP, one row at a time', () => {
  // Individually, not as a filter over the table, so a row that flips is named in the failure.
  assert.equal(SLICERS.cura.behaviour.opensStep, false, 'cura ships no STEP reader (spike §1d)')
  assert.equal(SLICERS.prusaslicer.behaviour.opensStep, true, 'prusaslicer opens .step and .stp')
  assert.equal(SLICERS.anycubic.behaviour.opensStep, true, 'anycubic opens .step and .stp')
  assert.equal(SLICERS.bambu.behaviour.opensStep, true, 'bambu opens .step and .stp')
  assert.equal(SLICERS.orca.behaviour.opensStep, true, 'orca opens .step and .stp')
  // And the refusal's list of alternatives is every capable row, in registry order.
  assert.deepEqual(
    SLICER_IDS.filter((id) => SLICERS[id].behaviour.opensStep).map((id) => SLICERS[id].displayName),
    ['PrusaSlicer', 'Anycubic Slicer Next', 'Bambu Studio', 'OrcaSlicer'],
  )
})

/* -------------------------------------------------------------------------------------------
 * The notices table, driven as a triple
 * ---------------------------------------------------------------------------------------- */

const ALWAYS = [
  'A slicer can take up to a minute to show a window (measured 2 s to 35 s).',
  'It may open a configuration wizard or an update prompt in front of your model.',
]

/** A `.3mf` project written by `slicer`, as `classify3mf` would label it. */
function projectFrom(slicer: SlicerId) {
  return { classification: { kind: 'slicer_project' as const, slicer }, is3mf: true }
}

const MESH_3MF = { classification: { kind: 'model' as const, slicer: null }, is3mf: true }
const MESH_STL = { classification: { kind: 'model' as const, slicer: null }, is3mf: false }

test('PrusaSlicer warns about its dialog for any .3mf, stripped or not, and never for an .stl', () => {
  for (const stripped of [false, true]) {
    for (const source of [projectFrom('cura'), MESH_3MF]) {
      assert.deepEqual(notices('prusaslicer', source, stripped), [
        'It will ask what to do with the file before opening it, and nothing loads until you answer.',
        ...ALWAYS,
      ])
    }
  }
  // A config-less `.3mf` and an `.stl` classify identically; only the extension separates them,
  // which is why `is3mf` is part of the input at all.
  assert.deepEqual(notices('prusaslicer', MESH_STL, false), ALWAYS)
})

test('Bambu warns for a project it did not author, and for its own once stripped', () => {
  const modal = 'It will say the config is invalid and load geometry only.'

  assert.deepEqual(notices('bambu', projectFrom('cura'), false), [modal, ...ALWAYS])
  assert.deepEqual(notices('bambu', projectFrom('cura'), true), [modal, ...ALWAYS])
  // The row a slicer-keyed table cannot produce: stripping is what *creates* the modal here.
  assert.deepEqual(notices('bambu', projectFrom('bambu'), true), [modal, ...ALWAYS])
  // And the negative that makes the positive mean something.
  assert.deepEqual(notices('bambu', projectFrom('bambu'), false), ALWAYS)
  assert.deepEqual(notices('bambu', MESH_STL, false), ALWAYS)
})

test('Anycubic warns about a silent discard only for an unstripped Bambu-lineage project', () => {
  const discard = 'It may discard the file without telling you.'

  assert.deepEqual(notices('anycubic', projectFrom('bambu'), false), [discard, ...ALWAYS])
  assert.deepEqual(notices('anycubic', projectFrom('orca'), false), [discard, ...ALWAYS])
  // Stripping is what fixes it — that is the headline measurement — so the notice goes.
  assert.deepEqual(notices('anycubic', projectFrom('bambu'), true), ALWAYS)
  // Its own project, and a lineage whose header its version check does not read.
  assert.deepEqual(notices('anycubic', projectFrom('anycubic'), false), ALWAYS)
  assert.deepEqual(notices('anycubic', projectFrom('cura'), false), ALWAYS)
})

test('Orca says two different things about a foreign project, and nothing about its own', () => {
  assert.deepEqual(notices('orca', projectFrom('bambu'), false), [
    'It will warn about the version and may rewrite print settings.',
    ...ALWAYS,
  ])
  assert.deepEqual(notices('orca', projectFrom('bambu'), true), [
    'It will show one informational notice, "loading geometry data only".',
    ...ALWAYS,
  ])
  assert.deepEqual(notices('orca', projectFrom('orca'), false), ALWAYS)
  assert.deepEqual(notices('orca', MESH_3MF, false), ALWAYS)
})

test('Cura is told nothing beyond the two that apply to every launch', () => {
  assert.deepEqual(notices('cura', projectFrom('prusaslicer'), false), ALWAYS)
  assert.deepEqual(notices('cura', MESH_STL, true), ALWAYS)
})

test('the notices a real launch carries are the ones its own triple produces', async () => {
  const h = harness()
  const projectId = project('Notices')
  const file = await addFile(projectId, 'plate.3mf', (path) =>
    bambuLineageProject(path, ['X-BBL-Client-Type']),
  )
  assert.deepEqual(classifyFile(file.absPath), { kind: 'slicer_project', slicer: 'bambu' })

  // Unstripped, straight to Anycubic: the silent-discard case, and the one the strip exists for.
  const asIs = await h.launcher.open(file.id, projectId, {
    mode: 'as-is',
    slicerId: 'anycubic',
  })
  assert.deepEqual(asIs.notices, notices('anycubic', projectFrom('bambu'), false))
  assert.ok(asIs.notices.includes('It may discard the file without telling you.'))

  // The same file through the new-project path is stripped, and the warning is gone.
  const stripped = await h.launcher.open(file.id, projectId, {
    mode: 'new-project',
    slicerId: 'anycubic',
  })
  assert.equal(stripped.stripped, true)
  assert.deepEqual(stripped.notices, notices('anycubic', projectFrom('bambu'), true))
  assert.ok(!stripped.notices.includes('It may discard the file without telling you.'))
})

test('a PrusaSlicer project launched in PrusaSlicer still draws the extension-driven warning', async () => {
  const h = harness()
  const projectId = project('PrusaOwn')
  const file = await addFile(projectId, 'own.3mf', prusaProject)

  const result = await h.launcher.open(file.id, projectId, { mode: 'as-is' })

  assert.equal(result.slicerId, 'prusaslicer')
  assert.ok(
    result.notices.includes(
      'It will ask what to do with the file before opening it, and nothing loads until you answer.',
    ),
  )
})

test('the sliceInfo fixture still labels the lineage the way classify3mf reads it', () => {
  // Guards the two Bambu-lineage assertions above against a fixture that silently stopped
  // producing the header they are about.
  assert.match(sliceInfo(['X-BBL-Client-Type']), /X-BBL-Client-Type/)
})
