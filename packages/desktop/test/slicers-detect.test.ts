import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  detectInstalls,
  detectionScript,
  encodedDetectionCommand,
  executableFromDisplayIcon,
  isSafeScriptLiteral,
  parseDetection,
  powerShellPath,
  type DetectIo,
  type DetectedInstall,
} from '../src/slicers/detect.ts'
import { SLICERS, SLICER_IDS } from '../src/slicers/registry.ts'

/**
 * Parsing what the detection subprocess said, with no PowerShell anywhere.
 *
 * The fixture is the spike's own output, reduced to the rows that matter and byte-verbatim in
 * each of them: the five uninstall keys the machine really has, the MSIX Orca package, and one
 * real non-slicer row that is there for two reasons — it proves a haystack of unrelated programs
 * is filtered out, and its `DisplayName` is genuinely `Fork` followed by fifteen NUL characters,
 * which is what a `REG_SZ` written with its declared length looks like when it reaches JSON.
 *
 * Every other case is its own one-row document built inline. That is deliberate after task 1,
 * where two cases in one fixture each masked the other and two mutations came back green: a row
 * that must produce nothing and a row that must produce something cannot share a document,
 * because the assertion about the count is then satisfiable two ways.
 */

const fixture = readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'slicer-detection.json'),
  'utf8',
)

/**
 * The files that "exist" for a test, spelled as they are on the machine the spike ran on.
 *
 * **`CuraEngine.exe` and the uninstallers are in here on purpose.** They are real files sitting
 * beside the real executables, so if they were absent the basename check would look like it was
 * working when it was the existence check doing the job.
 */
const REAL_FILES = new Set(
  [
    'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
    'C:\\Program Files\\UltiMaker Cura 5.12.0\\CuraEngine.exe',
    'C:\\Program Files\\UltiMaker Cura 5.12.0\\uninstall.exe',
    'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
    'C:\\Program Files\\UltiMaker Cura 5.13.0\\CuraEngine.exe',
    'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe',
    'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe',
    'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-gcodeviewer.exe',
    'C:\\Program Files\\Prusa3D\\PrusaSlicer\\unins000.exe',
    'C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe',
    'C:\\Program Files\\AnycubicSlicerNext\\Uninstall.exe',
    'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
    'C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe',
    'C:\\Users\\masch\\AppData\\Local\\Fork\\current\\Fork.exe',
  ].map((path) => path.toLowerCase()),
)

const io: DetectIo = { isRegularFile: (path) => REAL_FILES.has(path.toLowerCase()) }

/** One document, so a case cannot be satisfied by a row that belongs to another case. */
function oneRow(row: Record<string, string>): string {
  return JSON.stringify({ registry: [row], msix: [] })
}

function curaRow(overrides: Record<string, string>): string {
  return oneRow({
    hive: 'HKLM\\WOW6432Node',
    key: 'UltiMaker Cura 5.12.0-5.12.0',
    displayName: 'UltiMaker Cura 5.12.0',
    displayVersion: '5.12.0',
    displayIcon: 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
    ...overrides,
  })
}

function idsOf(installs: DetectedInstall[]): string[] {
  return installs.map((install) => install.id)
}

/* -------------------------------------------------------------------------------------------
 * The machine the spike ran on
 * ---------------------------------------------------------------------------------------- */

test('the real document yields six installs, one per install and not one per product', () => {
  const installs = parseDetection(fixture, io)

  assert.deepEqual(idsOf(installs).sort(), [
    'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
    'registry:HKLM:AnycubicSlicerNext',
    'registry:HKLM:Bambu Studio',
    'registry:HKLM:PrusaSlicer_is1',
    'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.12.0-5.12.0',
    'registry:HKLM\\WOW6432Node:UltiMaker Cura 5.13.0-5.13.0',
  ])
})

/**
 * **The case the whole design exists for.**
 *
 * Two Curas, side by side, both working, both able to run at once. A parser that keyed installs
 * on `SlicerId`, or that took the newer of two rows the way the rejected file-association
 * mechanism does, produces one row here and this goes red on all three assertions.
 */
test('the two Cura installs stay two, with distinct ids, paths and versions', () => {
  const cura = parseDetection(fixture, io).filter((install) => install.slicerId === 'cura')

  assert.equal(cura.length, 2)
  assert.deepEqual(
    cura.map((install) => install.version).sort(),
    ['5.12.0', '5.13.0'],
    'the version comes from DisplayVersion; the executables have no version resource at all',
  )
  assert.deepEqual(cura.map((install) => install.path).sort(), [
    'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
    'C:\\Program Files\\UltiMaker Cura 5.13.0\\UltiMaker-Cura.exe',
  ])
  assert.equal(new Set(idsOf(cura)).size, 2)
})

test('Orca comes from the MSIX half, keyed on the family and not the versioned full name', () => {
  const [orca] = parseDetection(fixture, io).filter((install) => install.slicerId === 'orca')

  // The id must survive an update. The *path* below embeds `2.4.3.0` and the id must not.
  assert.equal(orca?.id, 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g')
  assert.equal(orca?.version, '2.4.3.0')
  assert.equal(
    orca?.path,
    'C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g\\orca-slicer.exe',
  )
  assert.deepEqual(orca?.origin, {
    kind: 'msix',
    packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
  })
  assert.equal(orca?.id.includes('2.4.3.0'), false, 'the id must not carry the version')
})

test('a program that is not a slicer is not an install, however real its executable is', () => {
  // `Fork.exe` exists in `REAL_FILES`, so the only thing rejecting this row is the name.
  assert.equal(
    parseDetection(fixture, io).some((install) => install.path.includes('Fork')),
    false,
  )
})

test('every install carries the hive it was found in, because the key alone is not unique', () => {
  for (const install of parseDetection(fixture, io)) {
    if (install.origin.kind !== 'registry') continue
    assert.equal(install.id, `registry:${install.origin.hive}:${install.origin.key}`)
  }
  // Cura is under WOW6432Node despite being 64-bit; a detector reading two hives misses both.
  assert.equal(
    parseDetection(fixture, io).filter(
      (install) => install.origin.kind === 'registry' && install.origin.hive.includes('WOW6432'),
    ).length,
    2,
  )
})

/* -------------------------------------------------------------------------------------------
 * DisplayIcon, which is a field for an icon and not a promise about a binary
 * ---------------------------------------------------------------------------------------- */

test('a DisplayIcon naming CuraEngine.exe produces no install at all', () => {
  const engine = 'C:\\Program Files\\UltiMaker Cura 5.12.0\\CuraEngine.exe'
  // It is a real file, it is 21 MB, and "the biggest exe in the folder" picks it over Cura.
  assert.equal(io.isRegularFile(engine), true)

  assert.deepEqual(parseDetection(curaRow({ displayIcon: engine }), io), [])
})

test('the other four things that sit beside a real executable are refused as well', () => {
  const beside: [string, string][] = [
    ['UltiMaker Cura 5.12.0', 'C:\\Program Files\\UltiMaker Cura 5.12.0\\uninstall.exe'],
    ['PrusaSlicer', 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-gcodeviewer.exe'],
    // The headless twin, with the *same* version resource as the real one.
    ['PrusaSlicer', 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe'],
    ['AnycubicSlicerNext 1.4.1.2', 'C:\\Program Files\\AnycubicSlicerNext\\Uninstall.exe'],
  ]
  for (const [displayName, displayIcon] of beside) {
    assert.equal(io.isRegularFile(displayIcon), true, displayIcon)
    assert.deepEqual(
      parseDetection(
        oneRow({ hive: 'HKLM', key: 'k', displayName, displayVersion: '1', displayIcon }),
        io,
      ),
      [],
      displayIcon,
    )
  }
})

test('a quoted DisplayIcon with a trailing icon index resolves to the bare path', () => {
  const bare = 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe'
  for (const written of [`"${bare}",0`, `${bare},0`, `"${bare}"`, `${bare},-101`, ` ${bare} `]) {
    const [install] = parseDetection(curaRow({ displayIcon: written }), io)
    assert.equal(install?.path, bare, written)
  }
})

test('a comma that is part of the path is not an icon index', () => {
  // Not measured — all five values here were bare paths — so this is the conservative reading of
  // the documented `path[,index]` form rather than a claim about a real vendor.
  assert.equal(
    executableFromDisplayIcon('C:\\Tools\\Slicer,v2\\x.exe'),
    'C:\\Tools\\Slicer,v2\\x.exe',
  )
  assert.equal(executableFromDisplayIcon('C:\\Tools\\x.exe,0'), 'C:\\Tools\\x.exe')
  assert.equal(executableFromDisplayIcon(''), null)
  assert.equal(executableFromDisplayIcon(',0'), null)
})

/**
 * `spawn` resolves a relative path against the main process's working directory, which on a
 * packaged app is wherever the user happened to launch it from.
 *
 * **The `io` here answers yes to everything**, on purpose. With the suite's normal `io` this test
 * passed for the wrong reason — measured, by deleting the `isAbsolute` check and watching it stay
 * green: a relative path is not in `REAL_FILES` either, so the existence check was doing the work
 * and the assertion could not tell the two apart. Every one of these has the right basename and
 * "exists", so nothing but the absolute check can refuse them.
 */
test('a relative DisplayIcon is refused, whatever it is called', () => {
  const alwaysExists: DetectIo = { isRegularFile: () => true }
  for (const relative of [
    'UltiMaker-Cura.exe',
    '.\\UltiMaker-Cura.exe',
    '..\\UltiMaker-Cura.exe',
    'Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe',
    // A drive-relative path: `C:UltiMaker-Cura.exe` means "the current directory on C:".
    'C:UltiMaker-Cura.exe',
  ]) {
    assert.equal(alwaysExists.isRegularFile(relative), true, relative)
    assert.deepEqual(parseDetection(curaRow({ displayIcon: relative }), alwaysExists), [], relative)
  }

  // And the check is not simply refusing everything: the absolute spelling of the same file, with
  // the same permissive `io`, is accepted.
  assert.equal(
    parseDetection(
      curaRow({ displayIcon: 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe' }),
      alwaysExists,
    ).length,
    1,
  )
})

test('a DisplayIcon naming a file that is not there is refused', () => {
  const gone = 'C:\\Program Files\\UltiMaker Cura 9.9.9\\UltiMaker-Cura.exe'
  assert.equal(io.isRegularFile(gone), false)
  assert.deepEqual(parseDetection(curaRow({ displayIcon: gone }), io), [])
})

/* -------------------------------------------------------------------------------------------
 * Documents that are not the happy one
 * ---------------------------------------------------------------------------------------- */

/**
 * The path the spike could not exercise against a real negative, and so the one most likely to be
 * wrong: a machine with no slicers on it.
 */
test('a document with nothing detected is an empty list, not a failure', () => {
  assert.deepEqual(parseDetection(JSON.stringify({ registry: [], msix: [] }), io), [])
})

test('a document that is not the shape asked for degrades to nothing', () => {
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]): void => void warnings.push(args)
  try {
    // Unparseable is the one worth a word: the subprocess did not do what it was asked.
    assert.deepEqual(parseDetection('not json at all', io), [])
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /did not return JSON/)

    // These are shapes, not failures, and say nothing.
    for (const document of ['{}', '[]', 'null', '{"registry":"nope","msix":3}']) {
      assert.deepEqual(parseDetection(document, io), [], document)
    }
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = original
  }
})

test('a row that is missing what identifies it is dropped, and the rest of the document is not', () => {
  const good = {
    hive: 'HKLM',
    key: 'Bambu Studio',
    displayName: 'Bambu Studio',
    displayVersion: '02.08.02.61',
    displayIcon: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  }
  for (const broken of [
    { ...good, hive: '' },
    { ...good, key: '' },
    { ...good, displayIcon: '' },
    { displayName: 'Bambu Studio' },
    'a string where a row should be',
    null,
  ]) {
    const document = JSON.stringify({ registry: [broken, good], msix: [] })
    // One survivor and it is the good row: dropping the *document* over one bad key would take
    // out a scan on a machine with two hundred of them.
    assert.deepEqual(idsOf(parseDetection(document, io)), ['registry:HKLM:Bambu Studio'])
  }
})

test('a version that is only NUL padding reads as no version rather than as padding', () => {
  const [install] = parseDetection(curaRow({ displayVersion: '5.12.0\u0000\u0000\u0000' }), io)
  assert.equal(install?.version, '5.12.0')

  const [none] = parseDetection(curaRow({ displayVersion: '\u0000\u0000' }), io)
  assert.equal(none?.version, null, 'no version is null, and the install is still reported')
  assert.equal(none?.path, 'C:\\Program Files\\UltiMaker Cura 5.12.0\\UltiMaker-Cura.exe')
})

test('an MSIX package this app does not know about is not an install', () => {
  const document = JSON.stringify({
    registry: [],
    msix: [
      {
        packageFamily: 'Microsoft.Microsoft3DViewer_8wekyb3d8bbwe',
        packageFullName: 'Microsoft.Microsoft3DViewer_7.2107.7012.0_x64__8wekyb3d8bbwe',
        version: '7.2107.7012.0',
        installLocation: 'C:\\Program Files\\WindowsApps\\Microsoft.Microsoft3DViewer_x64',
      },
    ],
  })
  // It claims `.3mf` and `.stl` on this machine (§2c). It is still not a slicer.
  assert.deepEqual(parseDetection(document, io), [])
})

test('an MSIX package whose executable is not where the manifest says is not an install', () => {
  const document = JSON.stringify({
    registry: [],
    msix: [
      {
        packageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
        packageFullName: 'OrcaSlicer.OrcaSlicer_9.9.9.9_x64__3qd7h69xpne0g',
        version: '9.9.9.9',
        // The shape an update takes: same family, a directory that has moved.
        installLocation:
          'C:\\Program Files\\WindowsApps\\OrcaSlicer.OrcaSlicer_9.9.9.9_x64__3qd7h69xpne0g',
      },
    ],
  })
  assert.deepEqual(parseDetection(document, io), [])
})

test('one install seen twice is one install', () => {
  const row = {
    hive: 'HKLM',
    key: 'Bambu Studio',
    displayName: 'Bambu Studio',
    displayVersion: '02.08.02.61',
    displayIcon: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  }
  assert.deepEqual(idsOf(parseDetection(JSON.stringify({ registry: [row, row], msix: [] }), io)), [
    'registry:HKLM:Bambu Studio',
  ])
})

/* -------------------------------------------------------------------------------------------
 * The script, and the seam it is behind
 * ---------------------------------------------------------------------------------------- */

/**
 * The guard around everything interpolated into the script, driven directly.
 *
 * `detectionScript` refuses to build a script around a literal that fails this — but both of its
 * operands are module-private constants, so nothing a test can pass reaches that `throw` and
 * **deleting the whole loop stayed green**. Exporting the predicate is what makes the guard
 * falsifiable: these are the strings a careless edit to `msixPackageFamily` would introduce.
 */
test('the script-literal guard refuses everything that could close a PowerShell literal', () => {
  for (const hostile of [
    "Orca'; Start-Process calc; '",
    'Orca"; Start-Process calc',
    'Orca$(Start-Process calc)',
    'Orca`nStart-Process calc',
    'Orca; Start-Process calc',
    'Orca | Start-Process calc',
    'Orca & calc',
    'Orca_with a space',
    `Orca${String.fromCharCode(10)}Slicer`,
    '',
  ]) {
    assert.equal(isSafeScriptLiteral(hostile), false, JSON.stringify(hostile))
  }

  // And it is not simply refusing everything: every literal the table really carries passes.
  for (const id of SLICER_IDS) {
    const family = SLICERS[id].windows.msixPackageFamily
    if (family) assert.equal(isSafeScriptLiteral(family), true, family)
  }
  assert.equal(
    isSafeScriptLiteral(
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    ),
    true,
  )
})

/**
 * The script crosses the process boundary base64-encoded, so its punctuation cannot matter.
 *
 * This replaced an assertion that the script contained no `"` — true, and the thing that made
 * `-Command <script>` safe, but an invariant a future editor had to be told about. Round-tripping
 * the encoding is the whole of what is left to check.
 */
test('the script is handed over as base64 UTF-16LE, and survives the round trip', () => {
  const encoded = encodedDetectionCommand()
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), detectionScript())
  // A script that really does need a quote now costs nothing.
  assert.equal(
    Buffer.from(encodedDetectionCommand('echo "hi"'), 'base64').toString('utf16le'),
    'echo "hi"',
  )
})

/**
 * The one subprocess this app starts before a launch, named outright rather than found.
 *
 * `execFile('powershell.exe', …)` lets the process `PATH` decide which binary runs. Nothing about
 * that is exotic to exploit if an attacker can already write to a directory on `PATH`, but it is
 * a free thing to take away.
 */
test('PowerShell is named by absolute path, out of SystemRoot rather than off PATH', () => {
  assert.equal(
    powerShellPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  // A Windows installed somewhere else is followed; an environment that says nothing is not.
  assert.equal(
    powerShellPath({ SystemRoot: 'D:\\Win' }),
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.equal(win32.isAbsolute(powerShellPath({})), true)
  assert.equal(
    powerShellPath({}),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'an environment that names no Windows still gets an absolute path, not a bare name',
  )
  // Never a bare name, which is the whole point.
  assert.notEqual(powerShellPath({}), 'powershell.exe')
})

test('the script reads all three hives and every MSIX family in the registry table', () => {
  const script = detectionScript()
  for (const hive of ['HKLM:\\SOFTWARE\\Microsoft', 'WOW6432Node', 'HKCU:\\SOFTWARE\\Microsoft']) {
    assert.ok(script.includes(hive), hive)
  }
  for (const id of SLICER_IDS) {
    const family = SLICERS[id].windows.msixPackageFamily
    if (family) assert.ok(script.includes(family), family)
  }
  // The registry half reads `DisplayIcon` and **not** `InstallLocation`: the latter is empty for
  // four of the five uninstall keys, so a detector built on it finds PrusaSlicer and nothing
  // else. The MSIX half does read an install location, and legitimately — it is the only path an
  // MSIX package has — so the assertion is on the registry item and not on the word.
  assert.equal(script.includes('$item.InstallLocation'), false)
  assert.ok(script.includes('$item.DisplayIcon'))
  assert.ok(script.includes('$pkg.InstallLocation'))
})

test('detectInstalls runs the injected subprocess exactly once and parses what it said', async () => {
  let runs = 0
  const installs = await detectInstalls(() => {
    runs += 1
    return Promise.resolve(fixture)
  }, io)

  assert.equal(runs, 1)
  assert.equal(installs.length, 6)
})
