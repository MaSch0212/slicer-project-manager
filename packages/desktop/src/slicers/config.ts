import { readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { SlicerConfigDto, SlicerId, SlicerInstallDto } from '@spm/contract/dtos.ts'
import { writeJsonFile } from '../json-store.ts'
import type { DetectedInstall, InstallOrigin } from './detect.ts'
import { isSlicerId, SLICERS } from './registry.ts'

/**
 * `slicers.json` — what the shell knows about the slicers on this machine.
 *
 * **Its own file, beside `state.json` and not inside it** (D decision 4). `state.json` is three
 * keys written when a user answers a question about which library there is; this is a list
 * rewritten by every detection scan and every binding change. They share a writer —
 * `json-store.ts` — and not a file, so one corrupt write costs the user their slicer bindings or
 * their library choice, never both.
 *
 * **The stored identity of an install is its origin key; the path is a hint** (spec 4.4).
 * OrcaSlicer's install path embeds its version, so a cached path breaks silently the next time
 * Orca updates and the failure mode is a spawn of a path that no longer exists — which looks to
 * a user exactly like "the slicer did nothing". Every launch `stat`s the hint first and
 * re-resolves from the origin key on any mismatch; see `resolveInstallPath`.
 *
 * Nothing here imports `electron`, so `test/slicers-config.test.ts` drives the whole lifecycle
 * under plain `node --test` against real temporary files.
 */

/** The file under `app.getPath('userData')`. */
export const SLICERS_FILE_NAME = 'slicers.json'

/**
 * The only shape this build can read.
 *
 * A file written by a newer build is *recognised as unreadable* rather than misread: the app runs
 * with no configured installs, says so, and refuses to write over the file until the user
 * explicitly resets it. A downgrade quietly overwriting a newer config is worse than a feature
 * being unavailable for one launch.
 */
export const SLICERS_CONFIG_VERSION = 1

export type StoredInstall = {
  id: string
  slicerId: SlicerId
  label: string
  origin: InstallOrigin
  version: string | null
  /** The last known path. A hint, re-checked before every use — never the identity. */
  pathHint: string
  addedAt: number
  /**
   * Set when the hint failed and re-resolution found nothing. **Absent, not `false`, when the
   * install is fine**, so a healthy file is byte-identical to one written before this field
   * existed and a scan that changes nothing changes no bytes.
   */
  missing?: true
}

export type SlicersConfig = {
  version: number
  installs: StoredInstall[]
  bindings: Partial<Record<SlicerId, string>>
  defaultSlicerId: SlicerId | null
}

/**
 * What a read produced, and whether the file may be written back.
 *
 * `writable` is false for exactly one reason — an unrecognised `version` — and it is the whole
 * point of reading the version at all. Every other degradation (no file, unparseable, a member of
 * the wrong type) produces an empty config that *is* writable, because there is nothing there
 * worth protecting.
 */
export type ConfigRead = { config: SlicersConfig; writable: boolean }

export function emptyConfig(): SlicersConfig {
  return { version: SLICERS_CONFIG_VERSION, installs: [], bindings: {}, defaultSlicerId: null }
}

/* -------------------------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------------------------- */

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseOrigin(value: unknown): InstallOrigin | null {
  const origin = asObject(value)
  if (!origin) return null
  const { kind, hive, key, packageFamily, id } = origin
  if (kind === 'registry' && typeof hive === 'string' && typeof key === 'string') {
    return { kind, hive, key }
  }
  if (kind === 'msix' && typeof packageFamily === 'string') return { kind, packageFamily }
  if (kind === 'manual' && typeof id === 'string') return { kind, id }
  return null
}

/**
 * One stored install, or null if it is not one.
 *
 * Every member is checked, and a row that fails any check is dropped rather than repaired. This
 * file is in the user's own `userData` and is hand-editable; a half-understood row would flow
 * straight into a `spawn` argument. Dropping one row rather than the file is the same choice
 * `readState` makes for the same reason — a hand-edited file must not stop the app.
 */
function parseInstall(value: unknown): StoredInstall | null {
  const row = asObject(value)
  if (!row) return null
  const origin = parseOrigin(row['origin'])
  if (
    !origin ||
    typeof row['id'] !== 'string' ||
    row['id'] === '' ||
    !isSlicerId(row['slicerId']) ||
    typeof row['label'] !== 'string' ||
    typeof row['pathHint'] !== 'string' ||
    row['pathHint'] === '' ||
    typeof row['addedAt'] !== 'number'
  ) {
    return null
  }
  const version = row['version']
  const install: StoredInstall = {
    id: row['id'],
    slicerId: row['slicerId'],
    label: row['label'],
    origin,
    version: typeof version === 'string' && version !== '' ? version : null,
    pathHint: row['pathHint'],
    addedAt: row['addedAt'],
  }
  if (row['missing'] === true) install.missing = true
  return install
}

function parseBindings(
  value: unknown,
  installs: StoredInstall[],
): Partial<Record<SlicerId, string>> {
  const raw = asObject(value)
  if (!raw) return {}
  const bindings: Partial<Record<SlicerId, string>> = {}
  for (const [slicerId, installId] of Object.entries(raw)) {
    if (!isSlicerId(slicerId) || typeof installId !== 'string') continue
    // A binding to an install that is not in the file is not a binding — it would make
    // `resolveInstall` answer `NotFound` for a slicer the UI shows as configured.
    const target = installs.find((install) => install.id === installId)
    if (target?.slicerId === slicerId) bindings[slicerId] = installId
  }
  return bindings
}

/**
 * Reads `slicers.json`, degrading rather than throwing.
 *
 * Three degradations, and they are not the same:
 *
 * - **Missing** is first run and says nothing. Everything else about a read failure —`EACCES`,
 *   `EISDIR`, an I/O error — reaches the log, because it leaves the user's configuration
 *   apparently forgotten and a silent catch would leave that with no explanation anywhere.
 * - **Unparseable** degrades to no configuration with a warning, exactly as `readState` does, and
 *   for the same reason: a hand-edited file must not stop the app. It stays writable — the next
 *   scan replaces it, which is the only way back.
 * - **A version this build does not know** degrades to no configuration and is **not writable**.
 */
export function readConfig(file: string): ConfigRead {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`desktop: could not read ${SLICERS_FILE_NAME}`, error)
    }
    return { config: emptyConfig(), writable: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn(`desktop: ignoring an unreadable ${SLICERS_FILE_NAME}`, error)
    return { config: emptyConfig(), writable: true }
  }

  const document = asObject(parsed)
  if (!document) {
    console.warn(`desktop: ignoring an unreadable ${SLICERS_FILE_NAME}`)
    return { config: emptyConfig(), writable: true }
  }
  if (document['version'] !== SLICERS_CONFIG_VERSION) {
    console.warn(
      `desktop: ${SLICERS_FILE_NAME} is version ${JSON.stringify(document['version'])}, ` +
        `and this build reads version ${SLICERS_CONFIG_VERSION}; running with no configured ` +
        'slicers and leaving the file alone',
    )
    return { config: emptyConfig(), writable: false }
  }

  const rawInstalls = Array.isArray(document['installs']) ? document['installs'] : []
  const installs: StoredInstall[] = []
  for (const row of rawInstalls) {
    const install = parseInstall(row)
    if (install) installs.push(install)
  }
  const defaultSlicerId = document['defaultSlicerId']
  return {
    config: {
      version: SLICERS_CONFIG_VERSION,
      installs,
      bindings: parseBindings(document['bindings'], installs),
      defaultSlicerId: isSlicerId(defaultSlicerId) ? defaultSlicerId : null,
    },
    writable: true,
  }
}

/** Replaces `slicers.json` through the shared atomic writer. */
export function writeConfig(file: string, config: SlicersConfig): void {
  writeJsonFile(file, config)
}

/* -------------------------------------------------------------------------------------------
 * Merging a scan into what is already there
 * ---------------------------------------------------------------------------------------- */

/**
 * The result of a scan, folded into the existing configuration.
 *
 * Four rules, and each is a decision rather than an implementation detail:
 *
 * - **New installs are added.** Their `addedAt` is the moment of the scan; a re-detected install
 *   keeps the one it had, so the list does not reorder itself under the user on every scan.
 * - **An install that no longer resolves is marked `missing`, never dropped.** A binding to it
 *   survives, so `/settings/slicers` can say "the install you chose is gone" instead of silently
 *   showing an unbound slicer. This is the case an uninstalled Cura 5.12.0 produces, and spec 4.4
 *   argues at length that surfacing it beats repairing it by guesswork.
 * - **Manual entries are never touched.** Detection has no opinion about a path the user named:
 *   it did not find it, and its absence from a scan is not evidence of anything.
 * - **An existing binding is never re-pointed.** A scan that silently moved a binding would undo
 *   the one decision D asks the user to make.
 *
 * And one more that is a *change*: a `SlicerId` with exactly one usable install and no binding is
 * bound to it, because there is nothing to choose. A `SlicerId` with two is left unbound and the
 * UI asks. **The app offers; it does not guess** — preferring the newer of two Curas is precisely
 * what the rejected file-association mechanism does (§2c).
 */
export function mergeDetected(
  existing: SlicersConfig,
  detected: readonly DetectedInstall[],
  now: number,
): SlicersConfig {
  const byId = new Map(existing.installs.map((install) => [install.id, install]))
  const detectedIds = new Set(detected.map((install) => install.id))

  const installs: StoredInstall[] = existing.installs.map((install) => {
    if (install.origin.kind === 'manual') return install
    if (detectedIds.has(install.id)) return install
    return { ...install, missing: true }
  })

  for (const found of detected) {
    const previous = byId.get(found.id)
    const merged: StoredInstall = {
      id: found.id,
      slicerId: found.slicerId,
      label: found.label,
      origin: found.origin,
      version: found.version,
      pathHint: found.path,
      addedAt: previous?.addedAt ?? now,
    }
    const at = installs.findIndex((install) => install.id === found.id)
    if (at === -1) installs.push(merged)
    else installs[at] = merged
  }

  return {
    version: SLICERS_CONFIG_VERSION,
    installs,
    bindings: autoBind(existing.bindings, installs),
    defaultSlicerId: existing.defaultSlicerId,
  }
}

/**
 * Fills in the bindings there is no choice about, and touches nothing else.
 *
 * The existing entries are copied through by identity, so a binding the user made is the same
 * string in the same key after a scan as before it — which is what the "byte-identical" assertion
 * in the test suite actually measures.
 */
function autoBind(
  existing: Partial<Record<SlicerId, string>>,
  installs: readonly StoredInstall[],
): Partial<Record<SlicerId, string>> {
  const bindings: Partial<Record<SlicerId, string>> = { ...existing }
  for (const slicerId of Object.keys(SLICERS) as SlicerId[]) {
    if (bindings[slicerId] !== undefined) continue
    const candidates = installs.filter(
      (install) => install.slicerId === slicerId && install.missing !== true,
    )
    if (candidates.length === 1) bindings[slicerId] = candidates[0]!.id
  }
  return bindings
}

/* -------------------------------------------------------------------------------------------
 * Resolving an install to a path that can be spawned
 * ---------------------------------------------------------------------------------------- */

export type ResolveIo = {
  isRegularFile(path: string): boolean
  /** Re-runs detection and answers with the path this install's origin key resolves to now. */
  reresolve(install: StoredInstall): Promise<string | null>
}

export const NODE_RESOLVE_FILE_CHECK = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export type ResolveResult =
  | { ok: true; path: string; config: SlicersConfig; changed: boolean }
  | { ok: false; reason: 'unknown' | 'missing'; config: SlicersConfig; changed: boolean }

/**
 * Whether the stored hint still names the executable this install is supposed to be.
 *
 * The `exeName` check applies to the two automatic origins and **not to a manual entry**: the
 * user named that path, so the app has no better idea than they do about what it should be
 * called. The file-exists check still applies to all three — a path that is not there is not
 * launchable whoever chose it.
 */
function hintStillGood(install: StoredInstall, io: ResolveIo): boolean {
  if (!io.isRegularFile(install.pathHint)) return false
  if (install.origin.kind === 'manual') return true
  const exeName = SLICERS[install.slicerId].windows.exeName
  return win32.basename(install.pathHint).toLowerCase() === exeName.toLowerCase()
}

/**
 * The path to spawn for `installId`, re-resolving from the origin key when the hint has gone bad.
 *
 * **The common case costs one `stat` and no subprocess.** That is the whole reason the hint is
 * stored: PowerShell is 880 ms and a launch should not pay it. The uncommon case — an Orca update
 * that moved the install, or a slicer uninstalled since the last scan — costs one PowerShell run
 * at the moment of the next launch and is invisible to the user.
 *
 * A manual install is never re-resolved: there is nothing to re-resolve it *from*. Its origin key
 * is a generated id, not a machine fact, so a manual entry whose file has gone is `missing`
 * immediately.
 *
 * Returns the configuration rather than writing it, and says whether it changed, so that the one
 * place that owns the file is the one place that writes it.
 */
export async function resolveInstallPath(
  config: SlicersConfig,
  installId: string,
  io: ResolveIo,
): Promise<ResolveResult> {
  const install = config.installs.find((candidate) => candidate.id === installId)
  if (!install) return { ok: false, reason: 'unknown', config, changed: false }

  if (hintStillGood(install, io)) {
    // Nothing to write, even if the install was marked missing by an earlier scan and has come
    // back: clearing the mark is a scan's job, and a launch that rewrote the file would make
    // every launch a write.
    return { ok: true, path: install.pathHint, config, changed: false }
  }

  const reresolved = install.origin.kind === 'manual' ? null : await io.reresolve(install)
  // **`stat`ed again, and the same `stat` the hint got.** In production the re-resolver's answer
  // has already been through `parseDetection`'s four checks, so this is belt and braces — but
  // this is the last line before a `spawn`, the answer came out of a subprocess, and a future
  // mechanism that forgot to validate would otherwise turn a stale hint into a spawn of nothing.
  const found = reresolved !== null && io.isRegularFile(reresolved) ? reresolved : null
  let replaced: StoredInstall
  if (found === null) {
    replaced = { ...install, missing: true }
  } else {
    replaced = { ...install, pathHint: found }
    // Deleted rather than set to `false`: a healthy install carries no `missing` key at all.
    delete replaced.missing
  }

  const next: SlicersConfig = {
    ...config,
    installs: config.installs.map((candidate) =>
      candidate.id === installId ? replaced : candidate,
    ),
  }
  return found === null
    ? { ok: false, reason: 'missing', config: next, changed: true }
    : { ok: true, path: found, config: next, changed: true }
}

/* -------------------------------------------------------------------------------------------
 * The wire shape
 * ---------------------------------------------------------------------------------------- */

export function toInstallDto(install: StoredInstall): SlicerInstallDto {
  return {
    id: install.id,
    slicerId: install.slicerId,
    label: install.label,
    version: install.version,
    path: install.pathHint,
    origin: install.origin.kind,
    state: install.missing === true ? 'missing' : 'ok',
  }
}

export function toConfigDto(config: SlicersConfig, detectionSupported: boolean): SlicerConfigDto {
  return {
    installs: config.installs.map(toInstallDto),
    bindings: { ...config.bindings },
    defaultSlicerId: config.defaultSlicerId,
    detectionSupported,
  }
}
