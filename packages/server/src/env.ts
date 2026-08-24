import { AppError } from '@spm/contract/errors.ts'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_MESH_BYTES,
  LOG_LEVELS,
  parseLogLevel,
  type LogLevelSetting,
} from '@spm/core'
import { resolveDevUiOrigin } from './dev-proxy.ts'
import { normalizePublicOrigin } from './routes/users.ts'
import { resolveWebRoot } from './static.ts'

/**
 * Every environment variable the `packages/server/main.ts` server reads, validated in one place
 * at startup.
 *
 * Each resolver is a pure function of the raw string, which is the whole reason this is a module
 * and not a run of `Deno.env.get` calls in `main.ts`: a validator that reads the environment
 * itself can only be tested by mutating the process's environment, so in practice it was not
 * tested at all — which is how `SPM_PORT=abc` came to hand `NaN` to `Deno.serve`, binding
 * nothing and reporting nothing.
 *
 * The resolvers *throw*; they do not print or exit. Deciding what an operator sees belongs to
 * `main.ts`, which runs before the logger exists and answers with one sentence and a non-zero
 * exit rather than a stack trace.
 *
 * **Every read has to be here, not merely most of them.** `SPM_PUBLIC_ORIGIN` and `SPM_WEB_ROOT`
 * were read at module scope in `routes/users.ts` and `static.ts`; because `main.ts` imports the
 * routes, those reads ran before `main.ts`'s own first statement, so a malformed
 * `SPM_PUBLIC_ORIGIN` escaped as an uncaught error with a stack trace and pre-empted the message
 * for every other variable. Validators still live beside the feature they configure — this
 * module *calls* `normalizePublicOrigin`, `resolveWebRoot` and `resolveDevUiOrigin` rather than
 * absorbing them — but nothing else may reach for `Deno.env` on this entry point's import graph.
 *
 * `packages/server/import-curamanager.ts` is a separate entry point and keeps its own
 * `SPM_LOG_LEVEL` parse; it is a one-shot CLI that never constructs a server, so it shares
 * nothing with this and is deliberately not routed through here.
 */

export const DEFAULT_PORT = 8000
export const DEFAULT_PREVIEW_INTERVAL_MS = 30_000

/** setInterval's delay is clamped to a signed 32-bit int; beyond it, a long delay silently
 *  becomes a 1 ms one and the preview queue would run flat out. Refused instead. */
export const MAX_INTERVAL_MS = 2_147_483_647

/**
 * A plain run of decimal digits, and nothing else.
 *
 * Deliberately stricter than `Number()`, which accepts several spellings that are almost
 * certainly mistakes in a compose file or a shell export: `''` is 0, `' 1000 '` is 1000, `'1e3'`
 * is 1000, `'0x1f'` is 31, `'Infinity'` is infinite. None of those are how anyone means to write
 * a port or a duration, and the ones that "work" are worse than the ones that don't — an
 * operator who typed a stray space or an exponent gets a value that happens to be right today
 * and no signal at all that the config is not saying what they think it says. Refusing them
 * costs nothing (the canonical spelling is always available) and the error message quotes the
 * raw value, so invisible whitespace becomes visible at exactly the moment it matters.
 *
 * Leading zeros pass: `08000` is unambiguous in decimal and reads as deliberate padding.
 * A sign passes nowhere, so `-1` and `+8000` are both refused; neither variable has a use for
 * one, and `-1` in particular is the classic "disable it" guess that must not silently mean 0.
 */
const DIGITS = /^[0-9]+$/

function requireWholeNumber(name: string, raw: string, wanted: string, max: number): number {
  const value = DIGITS.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('Validation', `${name}="${raw}" is not ${wanted}`)
  }
  return value
}

/** The library root. Required: there is no sensible default, and guessing one would have the
 *  server quietly create a library somewhere the operator never looks. */
export function resolveLibraryDir(raw: string | undefined): string {
  // Whitespace-only is treated as unset rather than as a directory named " ": it is what an
  // empty line in an env file expands to, and the "is required" message is the useful one.
  if (raw === undefined || raw.trim().length === 0) {
    throw new AppError('Validation', 'SPM_LIBRARY_DIR is required')
  }
  return raw
}

/**
 * Refused rather than ignored: a typo'd level that silently fell back to the default would look
 * like the logging itself was broken. Unset is not a typo, so it takes the default in silence.
 */
export function resolveLogLevel(raw: string | undefined): LogLevelSetting {
  if (raw === undefined) return DEFAULT_LOG_LEVEL
  const level = parseLogLevel(raw)
  if (level === null) {
    throw new AppError(
      'Validation',
      `SPM_LOG_LEVEL="${raw}" is not a log level. Use one of: silent, ${LOG_LEVELS.join(', ')}`,
    )
  }
  return level
}

/**
 * The TCP port to listen on.
 *
 * 0 is refused even though `Deno.serve` accepts it as "pick any free port": an operator who
 * wrote 0 meant a port, and a server that came up on an unpredictable one would look like it
 * had not come up at all.
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  return requireWholeNumber(
    'SPM_PORT',
    raw,
    'a TCP port. Expected a whole number from 1 to 65535',
    65535,
  )
}

/**
 * How often the preview queue runs. Overridable mainly because 30 seconds is a bad edit-refresh
 * loop for anyone working on previews, and because the e2e suite has to watch a thumbnail
 * actually appear rather than sit out a tick to do it.
 */
export function resolvePreviewIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PREVIEW_INTERVAL_MS
  return requireWholeNumber(
    'SPM_PREVIEW_INTERVAL_MS',
    raw,
    `a duration. Expected a whole number of milliseconds from 1 to ${MAX_INTERVAL_MS}`,
    MAX_INTERVAL_MS,
  )
}

/**
 * How many preview jobs run at once, and therefore how many meshes may be in memory at once.
 *
 * This and `SPM_MAX_MESH_MB` are the two halves of one number: a worker's peak is one mesh plus a
 * fixed reader window, so the queue's peak is roughly `concurrency × (mesh + 80 MB) + 120 MB` —
 * about 46 MB of that constant is Deno's own baseline and the rest is V8 heap the allocator has
 * touched and not given back. The README carries the measured table the formula is fitted to.
 *
 * The default is core's `DEFAULT_CONCURRENCY` read directly, not copied: a server-side constant
 * holding the same number is a second place for it to live and a place for it to drift, and there
 * is no test that can see the drift while the two agree. The ceiling of 64 is not a memory
 * judgement — it is where "a whole number of workers" stops being plausible and starts being a
 * typo.
 */
export function resolvePreviewConcurrency(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONCURRENCY
  return requireWholeNumber(
    'SPM_PREVIEW_CONCURRENCY',
    raw,
    'a worker count. Expected a whole number from 1 to 64',
    64,
  )
}

/**
 * The ceiling on one model's geometry arrays, in megabytes of 1 000 000 bytes.
 *
 * A backstop, not a filter: every read is streamed, so the biggest file in the reference library
 * needs 208.8 MB and the default permits 256. What this refuses is input whose size is a function
 * of an attacker rather than of a printer — a model declaring a billion degenerate triangles asks
 * for 36 GB, and asking is all it takes.
 *
 * Megabytes rather than bytes because the number an operator arrives at is "about 300 MB", and
 * `SPM_MAX_MESH_MB=300` is a value they can check at a glance where `300000000` is not. A megabyte
 * is 1 000 000 bytes here, which is the same reading the refusal message prints, so the number in
 * the message and the number to write into the variable are directly comparable.
 *
 * **`MAX_MESH_MB` is 2 048, and the number is structural rather than a taste judgement.** A
 * ceiling is a promise that a mesh under it will be *allocated*, and `positions` is one
 * `Float32Array`: at 2 GB it is 512 million elements, comfortably inside V8's 2³²−1 element limit,
 * where a ceiling in the tens of gigabytes would let a file ask for an array the engine cannot
 * construct at all. The allocation is guarded regardless — `allocateMesh` turns a failed
 * `new Float32Array` into an `AppError` rather than letting a bare `RangeError` escape the queue's
 * failure contract — but offering an operator a ceiling that cannot be honoured is not a ceiling.
 * 2 GB is also eight times the default and four times the reference library's worst model, so
 * nothing real is anywhere near it.
 */
export const MAX_MESH_MB = 2_048
export const DEFAULT_MAX_MESH_MB = DEFAULT_MAX_MESH_BYTES / 1_000_000

export function resolveMaxMeshBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_MESH_BYTES
  const mb = requireWholeNumber(
    'SPM_MAX_MESH_MB',
    raw,
    `a size. Expected a whole number of megabytes from 1 to ${MAX_MESH_MB}`,
    MAX_MESH_MB,
  )
  return mb * 1_000_000
}

/**
 * The origin activation links are built on, normalised to a bare origin, or `undefined` to use
 * the origin of the request that asked for the link.
 *
 * Blank is treated as unset rather than as an origin, matching the `?.trim()` the old
 * module-level read did, so a leftover empty line in an env file does not produce
 * `/activate#tok` with no host at all.
 */
export function resolvePublicOrigin(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? normalizePublicOrigin(trimmed) : undefined
}

export type ServerEnv = {
  libraryDir: string
  level: LogLevelSetting
  port: number
  previewIntervalMs: number
  previewConcurrency: number
  maxMeshBytes: number
  devUiOrigin: string | null
  publicOrigin: string | undefined
  webRoot: string
}

/**
 * Reads and validates the whole environment, throwing `AppError('Validation', …)` on the first
 * unusable variable.
 *
 * `get` is a parameter rather than a direct `Deno.env.get` so a test can hand it a plain object;
 * `main.ts` passes the real one.
 */
export function readServerEnv(get: (name: string) => string | undefined): ServerEnv {
  return {
    libraryDir: resolveLibraryDir(get('SPM_LIBRARY_DIR')),
    level: resolveLogLevel(get('SPM_LOG_LEVEL')),
    port: resolvePort(get('SPM_PORT')),
    previewIntervalMs: resolvePreviewIntervalMs(get('SPM_PREVIEW_INTERVAL_MS')),
    previewConcurrency: resolvePreviewConcurrency(get('SPM_PREVIEW_CONCURRENCY')),
    maxMeshBytes: resolveMaxMeshBytes(get('SPM_MAX_MESH_MB')),
    // These three already had validators of their own, next to the features they configure.
    // Called from here so that one function is the answer to "what does this server read from
    // the environment", without moving code that is happier where it is.
    devUiOrigin: resolveDevUiOrigin(get('SPM_DEV_UI_ORIGIN')),
    publicOrigin: resolvePublicOrigin(get('SPM_PUBLIC_ORIGIN')),
    // Cannot fail: any string is a path, and whether it exists is not knowable here (the bundle
    // may be built after the server starts). Read here anyway, so the list is complete.
    webRoot: resolveWebRoot(get('SPM_WEB_ROOT')),
  }
}
