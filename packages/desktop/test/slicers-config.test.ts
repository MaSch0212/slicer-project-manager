import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  emptyConfig,
  mergeDetected,
  NODE_RESOLVE_FILE_CHECK,
  readConfig,
  resolveInstallPath,
  SLICERS_CONFIG_VERSION,
  SLICERS_FILE_NAME,
  toConfigDto,
  writeConfig,
  type ResolveIo,
  type SlicersConfig,
  type StoredInstall,
} from '../src/slicers/config.ts'
import { NODE_DETECT_IO, type DetectedInstall } from '../src/slicers/detect.ts'

/**
 * `slicers.json`: what a scan does to it, what an unreadable one does to the app, and how a
 * stored path becomes a path worth spawning.
 *
 * Real temporary files throughout, and real executables where a `stat` is what is being tested —
 * `resolveInstallPath` is checked against files this suite creates and deletes, not against an
 * injected predicate, because "the hint went stale" is a filesystem event.
 */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-slicers-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fileFor(): string {
  seq += 1
  return join(root, `case-${seq}`, SLICERS_FILE_NAME)
}

/** A real executable-shaped file, so a `stat` has something to find. */
function realExe(name: string): string {
  const dir = join(root, `exe-${(seq += 1)}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, 'MZ')
  return path
}

const CURA_12: DetectedInstall = {
  id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0',
  slicerId: 'cura',
  label: 'UltiMaker Cura 5.12.0',
  origin: {
    kind: 'registry',
    hive: 'HKLM\\WOW6432Node',
    key: 'UltiMaker Cura 5.12.0-5.12.0',
  },
  version: '5.12.0',
  path: 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
}

const CURA_13: DetectedInstall = {
  id: 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0',
  slicerId: 'cura',
  label: 'UltiMaker Cura 5.13.0',
  origin: {
    kind: 'registry',
    hive: 'HKLM\\WOW6432Node',
    key: 'UltiMaker Cura 5.13.0-5.13.0',
  },
  version: '5.13.0',
  path: 'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
}

const ORCA: DetectedInstall = {
  id: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
  slicerId: 'orca',
  label: 'OrcaSlicer',
  origin: { kind: 'msix', packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g' },
  version: '2.4.3.0',
  path: 'C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe',
}

/* -------------------------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------------------------- */

test('a file that is not there is first run: nothing configured, and writable', () => {
  const read = readConfig(fileFor())
  assert.deepEqual(read.config, emptyConfig())
  assert.equal(read.writable, true)
})

test('what is written comes back, whole', () => {
  const file = fileFor()
  const config = mergeDetected(emptyConfig(), [CURA_12, CURA_13, ORCA], 1756382400000)
  writeConfig(file, config)
  assert.deepEqual(readConfig(file).config, config)
})

test('an unreadable file degrades to no configuration, with a warning, and stays writable', () => {
  for (const contents of ['{ half', '[]', 'null', '"a string"', '']) {
    const file = fileFor()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, contents)

    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]): void => void warnings.push(args)
    let read
    try {
      read = readConfig(file)
    } finally {
      console.warn = original
    }
    assert.deepEqual(read.config, emptyConfig(), contents)
    // Writable: there is nothing here worth protecting, and the next scan is the only way back.
    assert.equal(read.writable, true, contents)
    assert.equal(warnings.length, 1, contents)
    assert.match(String(warnings[0]?.[0]), /unreadable slicers\.json/, contents)
  }
})

/**
 * **A downgrade must not eat a newer configuration.**
 *
 * The assertion that matters is on the bytes: a version check that returned an empty config and
 * then let the next write through would pass every assertion about the *return value* and still
 * destroy the file.
 */
test('a version this build does not know reads as nothing and is not writable', () => {
  const file = fileFor()
  mkdirSync(join(file, '..'), { recursive: true })
  const future = JSON.stringify(
    {
      version: 2,
      installs: [{ id: 'something:new', shape: 'this build cannot read' }],
      somethingElse: true,
    },
    null,
    2,
  )
  writeFileSync(file, future)

  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]): void => void warnings.push(args)
  let read
  try {
    read = readConfig(file)
  } finally {
    console.warn = original
  }

  assert.deepEqual(read.config.installs, [])
  assert.deepEqual(read.config.bindings, {})
  assert.equal(read.writable, false)
  assert.match(String(warnings[0]?.[0]), /version 2/)
  // And the bytes are exactly what they were.
  assert.equal(readFileSync(file, 'utf8'), future)
})

test('a row that is not a stored install is dropped; the rest of the file is kept', () => {
  const file = fileFor()
  mkdirSync(join(file, '..'), { recursive: true })
  const good = {
    id: 'manual:one',
    slicerId: 'cura',
    label: 'Portable Cura',
    origin: { kind: 'manual', id: 'one' },
    version: null,
    pathHint: 'D:\\portable\\UltiMaker-Cura.exe',
    addedAt: 1,
  }
  writeFileSync(
    file,
    JSON.stringify({
      version: SLICERS_CONFIG_VERSION,
      installs: [
        good,
        { ...good, id: 'manual:two', slicerId: 'superslicer' },
        { ...good, id: 'manual:three', origin: { kind: 'nonsense' } },
        { ...good, id: 'manual:four', pathHint: '' },
        { ...good, id: 'manual:five', addedAt: 'yesterday' },
        'not a row',
      ],
      bindings: { cura: 'manual:one', superslicer: 'manual:two', orca: 'manual:gone' },
      defaultSlicerId: 'nonsense',
    }),
  )

  const { config } = readConfig(file)
  assert.deepEqual(
    config.installs.map((install) => install.id),
    ['manual:one'],
  )
  // A binding to an install that is not in the file is not a binding.
  assert.deepEqual(config.bindings, { cura: 'manual:one' })
  assert.equal(config.defaultSlicerId, null)
})

/* -------------------------------------------------------------------------------------------
 * Merging
 * ---------------------------------------------------------------------------------------- */

test('nothing detected on a machine with nothing installed is an empty configuration', () => {
  const merged = mergeDetected(emptyConfig(), [], 1756382400000)
  assert.deepEqual(merged, emptyConfig())
  assert.deepEqual(toConfigDto(merged, true), {
    installs: [],
    bindings: {},
    defaultSlicerId: null,
    detectionSupported: true,
  })
})

test('a product with one install is bound to it; a product with two is left for the user', () => {
  const merged = mergeDetected(emptyConfig(), [CURA_12, CURA_13, ORCA], 1756382400000)

  // Orca: nothing to choose.
  assert.equal(merged.bindings.orca, ORCA.id)
  // Cura: two installs, so the app says nothing. Preferring 5.13.0 here is exactly what the
  // rejected file-association mechanism does, and it is what this asserts against.
  assert.equal(merged.bindings.cura, undefined)
  assert.equal(merged.defaultSlicerId, null, 'a scan does not choose a default either')
})

/**
 * **The assertion the plan singles out.** Three things at once, and each can fail alone.
 */
test('a scan adds, marks the vanished missing, and leaves a user binding exactly as it was', () => {
  const first = mergeDetected(emptyConfig(), [CURA_12, CURA_13], 1000)
  // The one decision the app asks the user to make.
  const chosen: SlicersConfig = { ...first, bindings: { ...first.bindings, cura: CURA_12.id } }

  // 5.12.0 has been uninstalled and Orca has appeared.
  const second = mergeDetected(chosen, [CURA_13, ORCA], 2000)

  assert.equal(second.bindings.cura, CURA_12.id, 'the binding was re-pointed')
  assert.deepEqual(second.bindings, { cura: CURA_12.id, orca: ORCA.id })

  const byId = new Map(second.installs.map((install) => [install.id, install]))
  assert.equal(byId.size, 3, 'the vanished install was dropped instead of marked')
  assert.equal(byId.get(CURA_12.id)?.missing, true)
  assert.equal(byId.get(CURA_13.id)?.missing, undefined)
  assert.equal(byId.get(ORCA.id)?.addedAt, 2000, 'a new install is stamped with the scan')
  assert.equal(byId.get(CURA_13.id)?.addedAt, 1000, 'a re-detected one keeps the time it had')
})

test('an install that comes back stops being missing, and its hint is refreshed', () => {
  const gone = mergeDetected(mergeDetected(emptyConfig(), [ORCA], 1000), [], 2000)
  assert.equal(gone.installs[0]?.missing, true)

  // The shape an Orca update takes: same family, a directory that now names a new version.
  const moved = { ...ORCA, version: '2.5.0.0', path: ORCA.path.replace('2.4.3.0', '2.5.0.0') }
  const back = mergeDetected(gone, [moved], 3000)
  assert.equal(back.installs[0]?.missing, undefined)
  assert.equal(back.installs[0]?.pathHint, moved.path)
  assert.equal(back.installs[0]?.version, '2.5.0.0')
  assert.equal(back.installs[0]?.addedAt, 1000, 'the same install, not a new one')
})

test('a manual entry is not marked missing by a scan that cannot see it', () => {
  const manual: StoredInstall = {
    id: 'manual:portable',
    slicerId: 'prusaslicer',
    label: 'PrusaSlicer (added by hand)',
    origin: { kind: 'manual', id: 'portable' },
    version: null,
    pathHint: 'D:\\portable\\prusa-slicer.exe',
    addedAt: 500,
  }
  const before = { ...emptyConfig(), installs: [manual] }

  const after = mergeDetected(before, [], 2000)
  // Detection did not find it because detection never could. That is not evidence of anything.
  assert.deepEqual(after.installs, [manual])
})

test('a manual entry counts as the one install a product is auto-bound to', () => {
  const manual: StoredInstall = {
    id: 'manual:portable',
    slicerId: 'bambu',
    label: 'Bambu Studio (added by hand)',
    origin: { kind: 'manual', id: 'portable' },
    version: null,
    pathHint: 'D:\\portable\\bambu-studio.exe',
    addedAt: 500,
  }
  const merged = mergeDetected({ ...emptyConfig(), installs: [manual] }, [], 2000)
  assert.equal(merged.bindings.bambu, 'manual:portable')
})

test('a missing install is not what a product gets auto-bound to', () => {
  const gone = mergeDetected(mergeDetected(emptyConfig(), [ORCA], 1000), [], 2000)
  // The binding made on the first scan stays — it is the user's, or as good as — but nothing new
  // is bound to an install that is not there.
  const withoutBinding: SlicersConfig = { ...gone, bindings: {} }
  assert.deepEqual(mergeDetected(withoutBinding, [], 3000).bindings, {})
})

/* -------------------------------------------------------------------------------------------
 * Resolving
 * ---------------------------------------------------------------------------------------- */

function storedFor(path: string, overrides: Partial<StoredInstall> = {}): SlicersConfig {
  return {
    ...emptyConfig(),
    installs: [
      {
        id: ORCA.id,
        slicerId: 'orca',
        label: 'OrcaSlicer',
        origin: { kind: 'msix', packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g' },
        version: '2.4.3.0',
        pathHint: path,
        addedAt: 1000,
        ...overrides,
      },
    ],
  }
}

function countingIo(answer: string | null): ResolveIo & { calls: number } {
  const io = {
    calls: 0,
    // **`NODE_RESOLVE_FILE_CHECK` itself**, not a re-implementation of it.
    //
    // It was `readFileSync(path).length >= 0` at first, which refuses a directory by way of
    // `EISDIR` rather than by being the predicate its name claims — and measured: with the real
    // check weakened to `statSync(path) !== null`, the directory case below stayed green, because
    // it was driving the double. The double is now the thing being relied on in production, so
    // there is one predicate and the test cannot disagree with it.
    isRegularFile: NODE_RESOLVE_FILE_CHECK,
    reresolve: (): Promise<string | null> => {
      io.calls += 1
      return Promise.resolve(answer)
    },
  }
  return io
}

/**
 * The production predicate itself, driven on all three answers.
 *
 * It is the check `addManual` makes before storing a path and the check that stands between a
 * stale hint and a `spawn`, and everything else in this file reaches it through an `io`. Asserted
 * here directly so the three cases are stated once rather than inferred from callers.
 */
test('a regular file is a regular file; a directory and a missing path are not', () => {
  const exe = realExe('orca-slicer.exe')
  const directory = join(root, `plain-dir-${(seq += 1)}`)
  mkdirSync(directory, { recursive: true })

  assert.equal(NODE_RESOLVE_FILE_CHECK(exe), true)
  assert.equal(NODE_RESOLVE_FILE_CHECK(directory), false, 'a directory is not a regular file')
  assert.equal(NODE_RESOLVE_FILE_CHECK(join(root, 'nothing-here', 'x.exe')), false)
  // The same question the parse asks, and it must answer the same way.
  assert.equal(NODE_DETECT_IO.isRegularFile(exe), true)
  assert.equal(NODE_DETECT_IO.isRegularFile(directory), false)
})

test('a good hint costs one stat and no subprocess at all', async () => {
  const exe = realExe('orca-slicer.exe')
  const io = countingIo('should not be reached')

  const result = await resolveInstallPath(storedFor(exe), ORCA.id, io)

  assert.equal(io.calls, 0, 'the re-resolver was called for a hint that was fine')
  assert.deepEqual(result, { ok: true, path: exe, config: storedFor(exe), changed: false })
})

test('a stale hint is re-resolved once, and the hint is rewritten', async () => {
  const gone = join(root, 'no-such-dir', 'orca-slicer.exe')
  const found = realExe('orca-slicer.exe')
  const io = countingIo(found)

  const result = await resolveInstallPath(storedFor(gone), ORCA.id, io)

  assert.equal(io.calls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.path, found)
  assert.equal(result.changed, true)
  assert.equal(result.config.installs[0]?.pathHint, found, 'the hint was not rewritten')
})

/**
 * The check that stops a hint from becoming a spawn of something else.
 *
 * A file *is* there, so the existence check passes and the basename check is the only thing that
 * can refuse it. Without it, an install whose folder had been repopulated with a different
 * executable of the same path would launch that instead.
 */
test('a hint that exists but is not the right executable is re-resolved', async () => {
  const wrong = realExe('CuraEngine.exe')
  const right = realExe('orca-slicer.exe')
  const io = countingIo(right)

  const result = await resolveInstallPath(storedFor(wrong), ORCA.id, io)

  assert.equal(io.calls, 1)
  assert.equal(result.ok && result.path, right)
})

test('a directory where the executable should be is not a hint worth spawning', async () => {
  // `mkdirSync` a path whose *name* passes the basename check, so the only thing that can refuse
  // it is "is it a regular file". This is what `statSync().isFile()` buys over "can I read it".
  const asDirectory = join(root, `dir-${(seq += 1)}`, 'orca-slicer.exe')
  mkdirSync(asDirectory, { recursive: true })
  const found = realExe('orca-slicer.exe')
  const io = countingIo(found)

  const result = await resolveInstallPath(storedFor(asDirectory), ORCA.id, io)

  assert.equal(io.calls, 1)
  assert.equal(result.ok && result.path, found)
})

test('a manual entry is never re-resolved, because there is nothing to re-resolve it from', async () => {
  const gone = join(root, 'no-such-dir', 'whatever.exe')
  const io = countingIo('a path that should never be used')
  const config = storedFor(gone, {
    id: 'manual:portable',
    origin: { kind: 'manual', id: 'portable' },
  })

  const result = await resolveInstallPath(config, 'manual:portable', io)

  assert.equal(io.calls, 0)
  assert.deepEqual(
    { ok: result.ok, reason: result.ok ? null : result.reason, changed: result.changed },
    { ok: false, reason: 'missing', changed: true },
  )
  assert.equal(result.config.installs[0]?.missing, true)
})

test('a manual entry whose file is still there launches, whatever it is called', async () => {
  // The `exeName` check does not apply: the user named this path, so the app has no better idea
  // than they do about what it should be called.
  const odd = realExe('my-slicer-build.exe')
  const io = countingIo(null)
  const config = storedFor(odd, { id: 'manual:portable', origin: { kind: 'manual', id: 'p' } })

  const result = await resolveInstallPath(config, 'manual:portable', io)

  assert.equal(io.calls, 0)
  assert.equal(result.ok && result.path, odd)
})

test('an install that re-resolution cannot find becomes missing, and says so', async () => {
  const gone = join(root, 'no-such-dir', 'orca-slicer.exe')
  const io = countingIo(null)

  const result = await resolveInstallPath(storedFor(gone), ORCA.id, io)

  assert.equal(io.calls, 1)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'missing')
  assert.equal(result.changed, true)
  assert.equal(result.config.installs[0]?.missing, true)
  // The hint is left as it was: it is the last place this install was seen, and overwriting it
  // with nothing would lose the only clue the next scan has to compare against.
  assert.equal(result.config.installs[0]?.pathHint, gone)
})

test('an install id that is not in the file is unknown, and changes nothing', async () => {
  const exe = realExe('orca-slicer.exe')
  const io = countingIo(exe)
  const config = storedFor(exe)

  const result = await resolveInstallPath(config, 'registry:HKLM:Nothing', io)

  assert.equal(io.calls, 0)
  assert.equal(!result.ok && result.reason, 'unknown')
  assert.equal(result.changed, false)
  assert.equal(result.config, config)
})

/* -------------------------------------------------------------------------------------------
 * The wire shape
 * ---------------------------------------------------------------------------------------- */

test('the DTO says where an install came from and whether it is there', () => {
  const gone = mergeDetected(mergeDetected(emptyConfig(), [CURA_12, ORCA], 1000), [ORCA], 2000)
  const dto = toConfigDto(gone, true)

  assert.deepEqual(
    dto.installs.map((install) => [install.id, install.origin, install.state]),
    [
      [CURA_12.id, 'registry', 'missing'],
      [ORCA.id, 'msix', 'ok'],
    ],
  )
  assert.equal(dto.detectionSupported, true)
  assert.equal(toConfigDto(gone, false).detectionSupported, false)
})
