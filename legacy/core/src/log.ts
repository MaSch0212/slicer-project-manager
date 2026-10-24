/**
 * A tiny level-filtered logger.
 *
 * It lives in `core` rather than `server` because the things most worth logging -- the
 * preview queue, rescan, authentication -- are core behaviour, and the desktop app (spec 2.5)
 * runs that same code with no HTTP server around it. Core stays runtime-neutral, so nothing
 * here reads an environment variable or touches a filesystem: the *level* arrives as a value
 * and the *destination* arrives as a sink. `packages/server/main.ts` is what turns
 * `SPM_LOG_LEVEL` into that value.
 */

/** Ordered most severe first. A logger at level L emits every level at or above it in this list. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]
/** `silent` is a configuration choice, not something you can call: there is no `log.silent()`. */
export type LogLevelSetting = LogLevel | 'silent'

export const DEFAULT_LOG_LEVEL: LogLevelSetting = 'info'

const SEVERITY: Record<LogLevelSetting, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

export type LogFields = Record<string, unknown>

export type LogRecord = {
  level: LogLevel
  /** Epoch milliseconds, injectable via `createLogger({ now })` so tests get stable output. */
  time: number
  message: string
  fields: LogFields
}

export type LogSink = (record: LogRecord) => void

export type Logger = {
  readonly level: LogLevelSetting
  error(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  trace(message: string, fields?: LogFields): void
  /** True when a record at `level` would be emitted. Guard genuinely expensive field-building
   *  with this; ordinary calls need no guard, since the level check happens before formatting. */
  enabled(level: LogLevel): boolean
  /** A logger that merges `fields` into everything it emits -- a request id, a user id. */
  child(fields: LogFields): Logger
}

/** Accepts any case; returns null for anything unrecognised so the caller can complain. */
export function parseLogLevel(raw: string | null | undefined): LogLevelSetting | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return normalized in SEVERITY ? (normalized as LogLevelSetting) : null
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`)
  if (typeof value === 'string') {
    // Quote only when the bare form would be ambiguous, so the common case stays readable.
    return /^[\w.:/@+-]+$/.test(value) && value.length > 0 ? value : JSON.stringify(value)
  }
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // A circular object must not take the process down on the way to a log line.
    return '[unserializable]'
  }
}

/** `<iso> LEVEL message key=value` -- greppable, and readable without a log viewer. */
export function formatRecord(record: LogRecord): string {
  const head = `${new Date(record.time).toISOString()} ${record.level.toUpperCase().padEnd(5)} ${record.message}`
  const entries = Object.entries(record.fields)
  if (entries.length === 0) return head
  return `${head} ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')}`
}

/**
 * Writes formatted lines to the console, splitting by severity so that `error` and `warn`
 * reach stderr: a shell pipeline that keeps only stdout should still surface failures.
 */
export const consoleSink: LogSink = (record) => {
  const line = formatRecord(record)
  if (record.level === 'error') console.error(line)
  else if (record.level === 'warn') console.warn(line)
  else console.log(line)
}

export type LoggerOptions = {
  level?: LogLevelSetting
  sink?: LogSink
  fields?: LogFields
  now?: () => number
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL
  const sink = options.sink ?? consoleSink
  const bound = options.fields ?? {}
  const now = options.now ?? Date.now
  const threshold = SEVERITY[level]

  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (SEVERITY[recordLevel] > threshold) return
    sink({
      level: recordLevel,
      time: now(),
      message,
      // Call-site fields win over bound ones, so a child's default can be overridden per call.
      fields: fields ? { ...bound, ...fields } : { ...bound },
    })
  }

  return {
    level,
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    trace: (message, fields) => emit('trace', message, fields),
    enabled: (candidate) => SEVERITY[candidate] <= threshold,
    child: (fields) =>
      createLogger({ ...options, level, sink, now, fields: { ...bound, ...fields } }),
  }
}

/**
 * The default for every `openLibrary` that does not ask for logging. Library code must be
 * silent unless its host opted in -- a unit test importing core should not print.
 */
export const NOOP_LOGGER: Logger = createLogger({ level: 'silent', sink: () => {} })
