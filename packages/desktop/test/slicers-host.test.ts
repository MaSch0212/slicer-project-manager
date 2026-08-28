import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AppError } from '@spm/contract/errors.ts'
import { SLICERS_CONFIG_VERSION, SLICERS_FILE_NAME } from '../src/slicers/config.ts'
import type { DetectIo } from '../src/slicers/detect.ts'
import { SlicersHost, type SlicersHostOptions } from '../src/slicers/host.ts'

/**
 * The seven configuration operations, end to end against a real `slicers.json`, with the
 * subprocess and the native dialog injected.
 *
 * Nothing here needs Electron, PowerShell or Windows: the whole point of both seams. The document
 * the fake subprocess returns is the fixture the parse suite uses, so a change that breaks the
 * parse breaks this too rather than being papered over by a hand-built install list.
 */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-slicers-host-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'slicer-detection.json'), 'utf8')

/** Every path the fixture names, as though it were on the machine the spike ran on. */
const io: DetectIo = { isRegularFile: (path) => path.toLowerCase().endsWith('.exe') }

const CURA_12 = 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0'
const CURA_13 = 'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0'
const ORCA = 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g'

function hostFor(options: Partial<SlicersHostOptions> = {}): {
  host: SlicersHost
  file: string
} {
  seq += 1
  const file = join(root, `case-${seq}`, SLICERS_FILE_NAME)
  return {
    file,
    host: new SlicersHost({
      configFile: file,
      run: () => Promise.resolve(fixture),
      io,
      platform: 'win32',
      now: () => 1756382400000,
      ...options,
    }),
  }
}

/** A real file, so the manual entry's existence check has something to find. */
function realExe(name: string): string {
  const dir = join(root, `exe-${(seq += 1)}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, 'MZ')
  return path
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
 * get and scan
 * ---------------------------------------------------------------------------------------- */

test('before any scan there is nothing configured, and no subprocess has run', () => {
  let runs = 0
  const { host } = hostFor({
    run: () => {
      runs += 1
      return Promise.resolve(fixture)
    },
  })

  assert.deepEqual(host.get(), {
    installs: [],
    bindings: {},
    defaultSlicerId: null,
    detectionSupported: true,
  })
  // Detection is on demand and never at start-up: 880 ms before the user has asked for anything.
  assert.equal(runs, 0)
})

test('a scan writes what it found, and reads back the same', async () => {
  const { host, file } = hostFor()
  const scanned = await host.scan()

  assert.equal(scanned.installs.length, 6)
  assert.deepEqual(host.get(), scanned)

  const onDisk: unknown = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal((onDisk as { version: number }).version, SLICERS_CONFIG_VERSION)
})

test('a scan binds the products with one install and leaves Cura for the user', async () => {
  const { host } = hostFor()
  const config = await host.scan()

  // Before the whole-object comparison: `assert.deepEqual` is a type assertion, so afterwards
  // the compiler believes `bindings` has exactly the four keys named below and `.cura` is an
  // error rather than an assertion.
  assert.equal(config.bindings.cura, undefined, 'two Curas is a question, not an answer')
  assert.deepEqual(config.bindings, {
    anycubic: 'registry:HKLM:AnycubicSlicerNext',
    bambu: 'registry:HKLM:Bambu Studio',
    prusaslicer: 'registry:HKLM:PrusaSlicer_is1',
    orca: ORCA,
  })
})

/**
 * The machine with no slicers on it — the path the spike could not exercise against a real
 * negative, and so the one most likely to be wrong. Every consumer is driven, not just `scan`.
 */
test('a machine with nothing installed produces an empty configuration that everything survives', async () => {
  const { host, file } = hostFor({
    run: () => Promise.resolve(JSON.stringify({ registry: [], msix: [] })),
  })

  const empty = {
    installs: [],
    bindings: {},
    defaultSlicerId: null,
    detectionSupported: true,
  }
  assert.deepEqual(await host.scan(), empty)
  assert.deepEqual(host.get(), empty)
  assert.deepEqual(host.resetConfig(), empty)
  assert.deepEqual(host.setDefault('cura'), { ...empty, defaultSlicerId: 'cura' })
  assert.equal(
    (await rejection(Promise.resolve().then(() => host.remove('anything')))).code,
    'NotFound',
  )
  assert.equal(
    (await rejection(Promise.resolve().then(() => host.bind('cura', 'anything')))).code,
    'NotFound',
  )
  assert.equal((await rejection(host.resolveInstall('anything'))).code, 'NotFound')
  // A cancelled dialog is not an error, and an empty file is not a reason to make one.
  assert.equal(await host.addManual('cura'), null)
  // The file is real and readable after all of that.
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, SLICERS_CONFIG_VERSION)
})

test('off Windows detection does not run, and the UI is told so', async () => {
  let runs = 0
  const { host } = hostFor({
    platform: 'linux',
    run: () => {
      runs += 1
      return Promise.resolve(fixture)
    },
  })

  assert.equal(host.get().detectionSupported, false)
  const scanned = await host.scan()
  assert.equal(runs, 0, 'nothing must be spawned on a platform with no mechanism')
  assert.deepEqual(scanned.installs, [])
  assert.equal(scanned.detectionSupported, false)
})

/* -------------------------------------------------------------------------------------------
 * The file this build cannot read
 * ---------------------------------------------------------------------------------------- */

/**
 * **A downgrade must not eat a newer configuration**, and the assertion is on the bytes.
 *
 * A `scan` that returned an empty config and then wrote it would satisfy every assertion about
 * the return value while destroying the file.
 */
test('a slicers.json from a newer build survives a scan, byte for byte', async () => {
  const { host, file } = hostFor()
  mkdirSync(join(file, '..'), { recursive: true })
  const future = `${JSON.stringify({ version: 2, installs: [{ shape: 'unknown' }] }, null, 2)}\n`
  writeFileSync(file, future)

  const error = await rejection(host.scan())
  assert.equal(error.code, 'Conflict')
  assert.match(error.message, /newer version/)
  assert.equal(readFileSync(file, 'utf8'), future, 'the file was overwritten')

  // And it is not just `scan`: every write refuses.
  for (const call of [
    (): unknown => host.setDefault('cura'),
    (): unknown => host.bind('cura', CURA_12),
    (): unknown => host.remove(CURA_12),
  ]) {
    await rejection(Promise.resolve().then(call))
    assert.equal(readFileSync(file, 'utf8'), future)
  }

  // `get` says there is nothing configured rather than throwing: the app runs, the feature does
  // not, and the user is told which.
  assert.deepEqual(host.get().installs, [])

  // `resetConfig` is the way out, and the only one.
  assert.deepEqual(host.resetConfig().installs, [])
  assert.notEqual(readFileSync(file, 'utf8'), future)
  assert.equal((await host.scan()).installs.length, 6)
})

/* -------------------------------------------------------------------------------------------
 * bind, setDefault, remove
 * ---------------------------------------------------------------------------------------- */

test('binding a product to one of its installs, and a rescan leaving that alone', async () => {
  const { host } = hostFor()
  await host.scan()

  const bound = host.bind('cura', CURA_12)
  assert.equal(bound.bindings.cura, CURA_12)

  // A second scan sees both Curas again and must not prefer the newer one.
  assert.equal((await host.scan()).bindings.cura, CURA_12)
  assert.equal(host.bind('cura', CURA_13).bindings.cura, CURA_13, 'the user may change their mind')
})

test('a product cannot be bound to another product install, or to one that is not there', async () => {
  const { host } = hostFor()
  await host.scan()

  const wrongProduct = await rejection(Promise.resolve().then(() => host.bind('orca', CURA_12)))
  assert.equal(wrongProduct.code, 'Validation')
  assert.match(wrongProduct.message, /is cura, not orca/)

  const missing = await rejection(Promise.resolve().then(() => host.bind('cura', 'manual:nope')))
  assert.equal(missing.code, 'NotFound')
  // Neither wrote anything.
  assert.equal(host.get().bindings.cura, undefined)
})

test('the default is a product and is not gated on a binding existing', async () => {
  const { host } = hostFor()
  await host.scan()
  assert.equal(host.setDefault('cura').defaultSlicerId, 'cura')
  // Cura has two installs and so no binding — the default is still allowed, and the honest
  // refusal comes at launch rather than at the moment of a setting that would not stick.
  assert.equal(host.get().bindings.cura, undefined)
  assert.equal(host.setDefault('orca').defaultSlicerId, 'orca')
})

test('removing an install takes its binding with it and leaves the default alone', async () => {
  const { host } = hostFor()
  await host.scan()
  host.setDefault('orca')

  const after = host.remove(ORCA)
  assert.equal(
    after.installs.some((install) => install.id === ORCA),
    false,
  )
  assert.equal(after.bindings.orca, undefined, 'a binding to an install that is gone is not one')
  // The default names a *product*, and the user may bind that product to something else next.
  assert.equal(after.defaultSlicerId, 'orca')
  // Other bindings are untouched.
  assert.equal(after.bindings.bambu, 'registry:HKLM:Bambu Studio')
})

test('removing something that is not there is NotFound, not a silent success', async () => {
  const { host } = hostFor()
  await host.scan()
  assert.equal(
    (await rejection(Promise.resolve().then(() => host.remove('manual:never')))).code,
    'NotFound',
  )
})

/* -------------------------------------------------------------------------------------------
 * Manual entry
 * ---------------------------------------------------------------------------------------- */

test('a manual entry records the path the user chose, verbatim, and binds it if it is the only one', async () => {
  const exe = realExe('my-own-slicer-build.exe')
  const { host } = hostFor({ pickExecutable: () => Promise.resolve(exe) })

  const config = await host.addManual('prusaslicer')
  const [install] = config?.installs ?? []
  assert.equal(install?.path, exe, 'the path is used verbatim; the user named it')
  assert.equal(install?.origin, 'manual')
  assert.equal(install?.slicerId, 'prusaslicer')
  // Never read from the executable — Cura's and Orca's version resources are empty.
  assert.equal(install?.version, null)
  assert.ok(install?.id.startsWith('manual:'))
  assert.equal(config?.bindings.prusaslicer, install?.id)
})

test('a cancelled dialog is null and writes nothing at all', async () => {
  const { host, file } = hostFor({ pickExecutable: () => Promise.resolve(null) })

  assert.equal(await host.addManual('cura'), null)
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
})

test('a picked file that is not there is refused rather than stored', async () => {
  const gone = join(root, 'no-such-dir', 'slicer.exe')
  const { host } = hostFor({ pickExecutable: () => Promise.resolve(gone) })

  assert.equal((await rejection(host.addManual('cura'))).code, 'NotFound')
  assert.deepEqual(host.get().installs, [])
})

test('a manual entry does not re-point a binding the user already made', async () => {
  const exe = realExe('another-cura.exe')
  const { host } = hostFor({ pickExecutable: () => Promise.resolve(exe) })
  await host.scan()
  host.bind('cura', CURA_13)

  const config = await host.addManual('cura')
  assert.equal(config?.bindings.cura, CURA_13)
  assert.equal(config?.installs.length, 7)
})

/**
 * The renderer can call this in a loop; nothing between it and the dialog serializes anything.
 * Unbounded native dialogs are how a user is trained to dismiss the one question that matters.
 */
test('two dialogs cannot be stacked: the same product waits, a different one is refused', async () => {
  const exe = realExe('portable-cura.exe')
  let opened = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { host } = hostFor({
    pickExecutable: async () => {
      opened += 1
      await gate
      return exe
    },
  })

  const first = host.addManual('cura')
  const second = host.addManual('cura')
  const other = host.addManual('orca')

  // Released *before* anything is awaited. With the guard gone, `other` opens its own dialog and
  // waits on this gate — measured: awaiting the refusal first deadlocks the whole suite instead
  // of failing it, and a mutation that hangs CI is a worse signal than one that goes red.
  release?.()
  assert.equal((await rejection(other)).code, 'Conflict')
  const [a, b] = await Promise.all([first, second])
  assert.equal(opened, 1, 'only one dialog was ever opened')
  assert.deepEqual(a, b)
  assert.equal(a?.installs.length, 1)

  // And the guard is released: a later call opens a dialog again.
  await host.addManual('orca')
  assert.equal(opened, 2)
})

/* -------------------------------------------------------------------------------------------
 * resolveInstall
 * ---------------------------------------------------------------------------------------- */

test('resolveInstall re-resolves a stale hint through one subprocess and rewrites the file', async () => {
  const exe = realExe('orca-slicer.exe')
  let runs = 0
  // A document that names a path this suite actually created, so the whole chain — subprocess,
  // parse, validation, rewrite — runs rather than being stubbed in the middle.
  const document = JSON.stringify({
    registry: [],
    msix: [
      {
        packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
        packageFullName: 'OrcaSlicer.OrcaSlicer_2.5.0.0_x64__3qd7h69xpne0g',
        version: '2.5.0.0',
        installLocation: join(exe, '..'),
      },
    ],
  })
  const { host, file } = hostFor({
    run: () => {
      runs += 1
      return Promise.resolve(document)
    },
    io: { isRegularFile: (path) => path === exe },
  })
  await host.scan()
  assert.equal(runs, 1)

  // Now the install moves: rewrite the stored hint to somewhere that is not there.
  const stored = JSON.parse(readFileSync(file, 'utf8')) as {
    installs: { pathHint: string }[]
  }
  stored.installs[0]!.pathHint = join(root, 'gone', 'orca-slicer.exe')
  writeFileSync(file, JSON.stringify(stored))

  const resolved = await host.resolveInstall(ORCA)
  assert.equal(resolved.path, exe)
  assert.equal(runs, 2, 'exactly one more subprocess')
  assert.equal(
    (JSON.parse(readFileSync(file, 'utf8')) as { installs: { pathHint: string }[] }).installs[0]
      ?.pathHint,
    exe,
    'the rewritten hint was not persisted',
  )

  // And the next launch is free.
  assert.equal((await host.resolveInstall(ORCA)).path, exe)
  assert.equal(runs, 2, 'a good hint must not spawn anything')
})

/**
 * The case detection cannot catch: a slicer uninstalled since the last scan.
 *
 * The paths here are under this suite's own temporary root and are never created, deliberately.
 * An earlier version of this test used the fixture's `C:\Program Files\Bambu Studio\…` and passed
 * for the wrong reason on the machine that has Bambu Studio installed — `resolveInstall` uses the
 * **real** filesystem for its `stat`, which is the whole point of it, so a fixture path that
 * happens to exist makes the test say the opposite of what it means.
 */
test('an install that is gone is reported as gone rather than spawned into a hole', async () => {
  const imagined = join(root, 'never-created', 'bambu-studio.exe')
  const document = JSON.stringify({
    registry: [
      {
        hive: 'HKLM',
        key: 'Bambu Studio',
        displayName: 'Bambu Studio',
        displayVersion: '02.08.02.61',
        displayIcon: imagined,
      },
    ],
    msix: [],
  })
  const { host, file } = hostFor({
    run: () => Promise.resolve(document),
    // True at scan time — this stands in for a machine where it really was installed.
    io: { isRegularFile: () => true },
  })
  await host.scan()
  assert.equal(host.get().installs[0]?.path, imagined)

  const error = await rejection(host.resolveInstall('registry:HKLM:Bambu Studio'))
  assert.equal(error.code, 'NotFound')
  assert.match(error.message, /no longer installed/)
  assert.deepEqual(error.details, { installId: 'registry:HKLM:Bambu Studio' })

  const stored = JSON.parse(readFileSync(file, 'utf8')) as {
    installs: { id: string; missing?: boolean }[]
  }
  assert.equal(stored.installs.find((i) => i.id === 'registry:HKLM:Bambu Studio')?.missing, true)
  assert.equal(host.get().installs[0]?.state, 'missing')
})

/**
 * Defence in depth at the last seam before a spawn.
 *
 * Re-resolution answers with a path a *subprocess* named, and in production that path has already
 * been through `parseDetection`'s four checks. This is the belt for that brace: the path handed
 * back is `stat`ed here too, so a re-resolver that answered with something that is not there — a
 * detection path that stopped validating, a future non-Windows mechanism — cannot turn a stale
 * hint into a spawn of nothing.
 */
test('a re-resolved path that is not there is missing, not a path to spawn', async () => {
  const imagined = join(root, 'never-created', 'orca-slicer.exe')
  const document = JSON.stringify({
    registry: [],
    msix: [
      {
        packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
        packageFullName: 'OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g',
        version: '2.4.3.0',
        installLocation: join(imagined, '..'),
      },
    ],
  })
  const { host } = hostFor({
    run: () => Promise.resolve(document),
    io: { isRegularFile: () => true },
  })
  await host.scan()

  const error = await rejection(host.resolveInstall(ORCA))
  assert.equal(error.code, 'NotFound')
})
