import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { SlicerId } from '@spm/contract/dtos.ts'
import { SLICER_IDS, SLICERS } from './registry.ts'

/**
 * Finding the slicers that are installed, in one subprocess.
 *
 * Node has no registry API and no MSIX API, and this project ships no native dependencies, so
 * detection is **one** `powershell -NoProfile -NonInteractive -Command` child process emitting a
 * single JSON document that covers both mechanisms (D decision 5). One process rather than two
 * because `Get-AppxPackage` forces PowerShell anyway, because `reg.exe`'s output is a positional
 * text format with no way to express the MSIX half, and because one subprocess is one failure
 * mode, one timeout and one parse to test.
 *
 * **On demand, never at app start.** Measured on the developer's machine: 880 ms wall clock for
 * the run below, 222 uninstall keys and 43 KB of JSON. The app has no reason to pay that before a
 * user opens `/settings/slicers`, and a stale path is caught by a `stat` before every spawn
 * regardless (`config.ts`, `resolveInstallPath`).
 *
 * **The subprocess is injected** — `RunDetection` is "a function that returns the JSON document"
 * — so everything below the process boundary runs under plain `node --test` with no PowerShell,
 * no Electron and no Windows. It is the same seam `remote.ts` puts around `fetch`.
 *
 * **The document is untrusted input.** It names paths this app will later execute. Nothing
 * reaches `DetectedInstall` that has not been checked absolute, existing, a regular file, and —
 * for the two automatic origins — named exactly like the registry row's `exeName`.
 */

/* -------------------------------------------------------------------------------------------
 * What the subprocess is asked for, and what it answers
 * ---------------------------------------------------------------------------------------- */

/** One uninstall key, reduced to the three values that are worth reading. */
export type RegistryRow = {
  /** `HKLM`, `HKLM\WOW6432Node` or `HKCU` — half of the install's stable identity. */
  hive: string
  /** The subkey name (`PSChildName`), the other half. Not the `DisplayName`. */
  key: string
  displayName: string
  displayVersion: string
  displayIcon: string
}

/** One MSIX package. `installLocation` is the only path; it embeds the version (§2g). */
export type MsixRow = {
  packageFamily: string
  packageFullName: string
  version: string
  installLocation: string
}

export type DetectionDocument = { registry: RegistryRow[]; msix: MsixRow[] }

/** Where an install came from, and the key that identifies it across updates (spec 4.4). */
export type InstallOrigin =
  | { kind: 'registry'; hive: string; key: string }
  | { kind: 'msix'; packageFamily: string }
  | { kind: 'manual'; id: string }

/** An install detection is prepared to vouch for: it exists, and it is the right executable. */
export type DetectedInstall = {
  /** `registry:<hive>:<key>` or `msix:<packageFamily>` — the origin key, never the path. */
  id: string
  slicerId: SlicerId
  label: string
  origin: InstallOrigin
  version: string | null
  path: string
}

/** The injected subprocess: run it, get the JSON text back. */
export type RunDetection = () => Promise<string>

/** The one filesystem question the parse asks, injected so a fixture needs no real executables. */
export type DetectIo = { isRegularFile(path: string): boolean }

export const NODE_DETECT_IO: DetectIo = {
  isRegularFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
}

/* -------------------------------------------------------------------------------------------
 * The script
 * ---------------------------------------------------------------------------------------- */

/**
 * The three hives, spelled the way `Get-ItemProperty` wants them.
 *
 * **All three, and `WOW6432Node` is not optional**: Cura registers there despite being 64-bit
 * (§2a), so a detector that reads the two obvious hives finds four installs and misses both
 * Curas — which is to say it misses the case the whole design exists for.
 */
const UNINSTALL_HIVES: readonly (readonly [string, string])[] = [
  ['HKLM', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'],
  [
    'HKLM\\WOW6432Node',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  ],
  ['HKCU', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'],
]

/**
 * Nothing may be interpolated into the script that is not one of these characters.
 *
 * The script is built from this module's own constants and from `SLICERS`, so there is no user
 * input anywhere near it — but "there is no user input in it today" is what every injection was
 * before it was one, and a `msixPackageFamily` is a string somebody will edit. A family name is
 * an MSIX identity: letters, digits, dots, dashes and one underscore.
 */
const SAFE_LITERAL = /^[A-Za-z0-9._\\:*\-]+$/

/**
 * The PowerShell that produces `DetectionDocument`.
 *
 * **It contains no double-quote character, and `scriptContainsNoDoubleQuote` in the test suite
 * says so.** That is what makes passing it as one `-Command` argument safe: `child_process`
 * quotes an argument for `CreateProcess` with MSVCRT rules, PowerShell then re-parses the command
 * line with its own, and the two agree on a string with no `"` in it. Measured through a real
 * `execFile` on this machine: 43 265 bytes of valid JSON back, no stderr.
 *
 * Notes on the shape, each of which is a real behaviour of Windows PowerShell 5.1:
 *
 * - `$ErrorActionPreference = 'SilentlyContinue'` so an unreadable uninstall key, or a machine
 *   with no `Get-AppxPackage` at all, produces a shorter document rather than no document.
 * - The `$null` guard inside each loop is load-bearing: `foreach ($x in $null)` iterates **once**
 *   with `$x = $null` in 5.1 (it iterates zero times in 7). Verified against a family name that
 *   matches nothing — the `msix` array comes back `[]` and not `[null]`.
 * - Arrays are built by `+=` into a `@()` rather than collected from the pipeline, because a
 *   one-element pipeline result is not an array and `ConvertTo-Json` would emit an object.
 * - `Get-AppxPackage -Name` takes the package *name*, which is the family up to the last `_`;
 *   the result is then filtered on the family, because a name can be published by two publishers.
 * - `ConvertTo-Json` in 5.1 escapes every non-ASCII character as `\uXXXX`, so the pipe carries
 *   pure ASCII whatever the console encoding is. The `OutputEncoding` line makes that true rather
 *   than lucky.
 */
export function detectionScript(): string {
  const families = SLICER_IDS.map((id) => SLICERS[id].windows.msixPackageFamily).filter(
    (family): family is string => family !== undefined,
  )
  for (const literal of [...families, ...UNINSTALL_HIVES.flat()]) {
    if (!SAFE_LITERAL.test(literal)) {
      throw new Error(`refusing to build a detection script around ${JSON.stringify(literal)}`)
    }
  }
  const hives = UNINSTALL_HIVES.map(([hive, path]) => `@('${hive}', '${path}')`).join(', ')
  const familyList = families.map((family) => `'${family}'`).join(', ')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false`,
    `$registry = @()`,
    `foreach ($h in @(${hives})) {`,
    `  foreach ($item in Get-ItemProperty -Path $h[1]) {`,
    `    if ($null -eq $item.DisplayName) { continue }`,
    `    $registry += [pscustomobject]@{ hive = $h[0]; key = [string]$item.PSChildName; displayName = [string]$item.DisplayName; displayVersion = [string]$item.DisplayVersion; displayIcon = [string]$item.DisplayIcon }`,
    `  }`,
    `}`,
    `$msix = @()`,
    `foreach ($family in @(${familyList})) {`,
    `  foreach ($pkg in Get-AppxPackage -Name $family.Substring(0, $family.LastIndexOf('_'))) {`,
    `    if ($pkg.PackageFamilyName -ne $family) { continue }`,
    `    $msix += [pscustomobject]@{ packageFamily = [string]$pkg.PackageFamilyName; packageFullName = [string]$pkg.PackageFullName; version = [string]$pkg.Version; installLocation = [string]$pkg.InstallLocation }`,
    `  }`,
    `}`,
    `[pscustomobject]@{ registry = @($registry); msix = @($msix) } | ConvertTo-Json -Depth 4 -Compress`,
  ].join('\n')
}

/** 20 s, and the process is killed when it expires. See `runPowerShellDetection`. */
export const DETECTION_TIMEOUT_MS = 20_000

/**
 * Runs the script in a real PowerShell and answers with its stdout.
 *
 * `execFile` and not `spawn` with a shell: there is no shell in the chain, so nothing between
 * this argument list and `CreateProcess` re-interprets the script. `timeout` makes Node send
 * `killSignal` when it expires — the default `SIGTERM`, which on Windows terminates the process
 * rather than signalling it — so a PowerShell wedged on a corrupt registry hive costs 20 seconds
 * and not the rest of the session.
 *
 * `maxBuffer` is 32 MiB against a measured 43 KB. That is not caution for its own sake: the
 * document carries every uninstall key on the machine, the default is 1 MiB, and exceeding it
 * kills the child and fails the call — a failure mode that would only ever appear on somebody
 * else's much fuller machine.
 */
export const runPowerShellDetection: RunDetection = () =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', detectionScript()],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: DETECTION_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })

/* -------------------------------------------------------------------------------------------
 * The parse
 * ---------------------------------------------------------------------------------------- */

/**
 * Registry string values are not guaranteed to be what they look like.
 *
 * Measured on this machine: one `DisplayName` reads `Fork\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0` and its
 * `DisplayVersion` `2.21.0` with thirteen more — a `REG_SZ` written with its declared length
 * including the padding. Left alone they would reach the UI, and a version compared for equality
 * would never match. Trailing NULs are cut here, once, for every string that arrives.
 */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').trim() : ''
}

/**
 * The executable a `DisplayIcon` names, or null.
 *
 * `DisplayIcon` is documented as `path[,index]` and may be quoted. All five values on this
 * machine were bare paths, and five files is not a specification, so both forms are handled. The
 * index is cut from the *end* only, and only when it is digits: a path may legitimately contain a
 * comma, and `C:\Tools\Slicer,v2\slicer.exe` must not become `C:\Tools\Slicer`.
 */
export function executableFromDisplayIcon(displayIcon: string): string | null {
  let text = clean(displayIcon)
  const comma = text.lastIndexOf(',')
  if (comma >= 0 && /^-?\d+$/.test(text.slice(comma + 1).trim())) text = text.slice(0, comma).trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1)
  return text === '' ? null : text
}

/**
 * Whether a path is one this app is prepared to hand to `spawn`.
 *
 * Four checks, and the fourth is the one that earns its place: **the basename must be the
 * registry row's `exeName`**. `DisplayIcon` is a field a vendor fills in for the Programs and
 * Features icon, not a promise about which binary to run, and the folders it points into are full
 * of things that are not the slicer — `CuraEngine.exe`, `prusa-gcodeviewer.exe`,
 * `prusa-slicer-console.exe`, four uninstallers (§1).
 *
 * `win32` semantics regardless of the host platform, because the document describes a Windows
 * machine by construction: detection does not run anywhere else. On a POSIX host `win32.isAbsolute`
 * is what recognises `C:\Program Files\…`, and `win32.basename` splits on both separators. The
 * comparison is case-insensitive because NTFS is.
 */
function validatedExecutable(path: string, exeName: string, io: DetectIo): string | null {
  if (!win32.isAbsolute(path)) return null
  if (win32.basename(path).toLowerCase() !== exeName.toLowerCase()) return null
  if (!io.isRegularFile(path)) return null
  return path
}

/** The `SlicerId` whose `displayNamePattern` claims this uninstall key, or null. */
function slicerForDisplayName(displayName: string): SlicerId | null {
  for (const id of SLICER_IDS) {
    if (SLICERS[id].windows.displayNamePattern.test(displayName)) return id
  }
  return null
}

function rowsOf(value: unknown, key: 'registry' | 'msix'): unknown[] {
  if (!value || typeof value !== 'object') return []
  const rows = (value as Record<string, unknown>)[key]
  return Array.isArray(rows) ? rows : []
}

function field(row: unknown, name: string): string {
  return row && typeof row === 'object' ? clean((row as Record<string, unknown>)[name]) : ''
}

/**
 * Turns the subprocess's JSON into the installs the app will offer, discarding everything it
 * cannot vouch for.
 *
 * Unparseable JSON, a missing array, a row that is not an object and a row whose path does not
 * check out are all the same answer — that install is not reported — because the alternative is
 * a detector that fails the whole scan over one malformed uninstall key on a machine with two
 * hundred of them. What is *not* silent is the parse failure itself, which means the subprocess
 * did not do what it was asked and is worth a line in the log.
 *
 * **Versions come from `DisplayVersion` or the MSIX package, never from the executable.** Cura's
 * and Orca's version resources are empty (§1), so an implementation that read the file would
 * report the two Curas as one unversioned product — the exact collapse this design exists to
 * prevent. A row with no version keeps `null` rather than being dropped: an install that runs is
 * more useful than a version string.
 */
export function parseDetection(json: string, io: DetectIo = NODE_DETECT_IO): DetectedInstall[] {
  let document: unknown
  try {
    document = JSON.parse(json)
  } catch (error) {
    console.warn('desktop: the slicer detection subprocess did not return JSON', error)
    return []
  }

  const installs: DetectedInstall[] = []

  for (const row of rowsOf(document, 'registry')) {
    const displayName = field(row, 'displayName')
    const slicerId = slicerForDisplayName(displayName)
    if (!slicerId) continue
    const icon = executableFromDisplayIcon(field(row, 'displayIcon'))
    if (!icon) continue
    const path = validatedExecutable(icon, SLICERS[slicerId].windows.exeName, io)
    if (!path) continue
    const hive = field(row, 'hive')
    const key = field(row, 'key')
    if (hive === '' || key === '') continue
    const version = field(row, 'displayVersion')
    installs.push({
      id: `registry:${hive}:${key}`,
      slicerId,
      // The vendor's own words, which carry the version for three of the five and are what the
      // user will recognise from Programs and Features.
      label: displayName,
      origin: { kind: 'registry', hive, key },
      version: version === '' ? null : version,
      path,
    })
  }

  for (const row of rowsOf(document, 'msix')) {
    const packageFamily = field(row, 'packageFamily')
    const slicerId = SLICER_IDS.find(
      (id) => SLICERS[id].windows.msixPackageFamily === packageFamily,
    )
    if (packageFamily === '' || !slicerId) continue
    const location = field(row, 'installLocation')
    if (location === '') continue
    const exeName = SLICERS[slicerId].windows.exeName
    const path = validatedExecutable(win32.join(location, exeName), exeName, io)
    if (!path) continue
    const version = field(row, 'version')
    installs.push({
      id: `msix:${packageFamily}`,
      slicerId,
      label: SLICERS[slicerId].displayName,
      origin: { kind: 'msix', packageFamily },
      version: version === '' ? null : version,
      path,
    })
  }

  // Two uninstall keys can name the same executable — an upgrade that left the old key behind
  // would — and the id is what identifies an install, so a duplicate id is one install seen
  // twice. First wins, in hive order: HKLM before WOW6432Node before HKCU.
  const seen = new Set<string>()
  return installs.filter((install) => {
    if (seen.has(install.id)) return false
    seen.add(install.id)
    return true
  })
}

/**
 * Detection, end to end: run the subprocess, parse what it said.
 *
 * Off Windows this is not called at all — see `SlicersHost`, where `detectionSupported` is false
 * and manual entry is the only mechanism. Nothing about macOS or Linux detection is designed
 * here: `.app` bundles and `CFBundleIdentifier` on one side, `.desktop` files, AppImage, Flatpak
 * and Snap on the other, sharing nothing with the above.
 */
export async function detectInstalls(
  run: RunDetection = runPowerShellDetection,
  io: DetectIo = NODE_DETECT_IO,
): Promise<DetectedInstall[]> {
  return parseDetection(await run(), io)
}
