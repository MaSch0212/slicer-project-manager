import {
  createLogger,
  formatRecord,
  LOG_LEVELS,
  NOOP_LOGGER,
  parseLogLevel,
  type LogRecord,
} from '../src/log.ts'
import { assert, test } from './harness.ts'

function collector(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = []
  return { records, sink: (record) => records.push(record) }
}

const FIXED = Date.UTC(2026, 7, 23, 14, 11, 2, 123)

test('a logger emits its own level and everything more severe, and drops the rest', () => {
  for (const level of LOG_LEVELS) {
    const { records, sink } = collector()
    const log = createLogger({ level, sink })
    for (const candidate of LOG_LEVELS) log[candidate](candidate)

    const expected = LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1)
    assert.deepEqual(
      records.map((record) => record.level),
      [...expected],
      `at level ${level}`,
    )
    // Every level must be a real boundary: the next one down has to actually be excluded.
    const dropped = LOG_LEVELS.slice(LOG_LEVELS.indexOf(level) + 1)
    for (const missing of dropped) {
      assert.ok(
        !records.some((record) => record.level === missing),
        `${missing} leaked at ${level}`,
      )
    }
  }
})

test('silent emits nothing at all', () => {
  const { records, sink } = collector()
  const log = createLogger({ level: 'silent', sink })
  for (const level of LOG_LEVELS) log[level]('nope')
  assert.equal(records.length, 0)
  assert.equal(log.enabled('error'), false)
})

test('the default level is info', () => {
  const { records, sink } = collector()
  const log = createLogger({ sink })
  log.info('shown')
  log.debug('hidden')
  assert.deepEqual(
    records.map((record) => record.message),
    ['shown'],
  )
})

test('enabled() agrees with what is actually emitted', () => {
  const { records, sink } = collector()
  const log = createLogger({ level: 'warn', sink })
  for (const level of LOG_LEVELS) {
    records.length = 0
    log[level]('x')
    assert.equal(log.enabled(level), records.length === 1, `enabled(${level}) disagreed`)
  }
})

test('child() merges bound fields and the call site wins on a clash', () => {
  const { records, sink } = collector()
  const log = createLogger({ sink, fields: { app: 'spm' } }).child({
    requestId: 'r1',
    app: 'child',
  })
  log.info('hello', { userId: 'u1', requestId: 'override' })
  assert.deepEqual(records[0]?.fields, {
    app: 'child',
    requestId: 'override',
    userId: 'u1',
  })
})

test('child() inherits the level rather than resetting it to the default', () => {
  const { records, sink } = collector()
  const log = createLogger({ level: 'error', sink }).child({ requestId: 'r1' })
  log.info('must not appear')
  log.error('must appear')
  assert.deepEqual(
    records.map((record) => record.message),
    ['must appear'],
  )
})

test('a parent logger is unaffected by its child', () => {
  const { records, sink } = collector()
  const parent = createLogger({ sink, fields: { app: 'spm' } })
  parent.child({ requestId: 'r1' })
  parent.info('plain')
  assert.deepEqual(records[0]?.fields, { app: 'spm' })
})

test('parseLogLevel accepts the known names in any case and rejects the rest', () => {
  assert.equal(parseLogLevel('DEBUG'), 'debug')
  assert.equal(parseLogLevel('  warn '), 'warn')
  assert.equal(parseLogLevel('silent'), 'silent')
  assert.equal(parseLogLevel('verbose'), null)
  assert.equal(parseLogLevel(''), null)
  assert.equal(parseLogLevel(undefined), null)
  assert.equal(parseLogLevel(null), null)
})

test('formatRecord renders the timestamp, level, message and fields', () => {
  const line = formatRecord({
    level: 'info',
    time: FIXED,
    message: 'request',
    fields: { method: 'GET', path: '/api/projects', ms: 12, ok: true },
  })
  assert.equal(
    line,
    '2026-08-23T14:11:02.123Z INFO  request method=GET path=/api/projects ms=12 ok=true',
  )
})

test('formatRecord quotes values that would otherwise be ambiguous', () => {
  const line = formatRecord({
    level: 'warn',
    time: FIXED,
    message: 'odd',
    fields: { name: 'two words', empty: '', err: new Error('boom'), nested: { a: 1 } },
  })
  assert.equal(
    line,
    '2026-08-23T14:11:02.123Z WARN  odd name="two words" empty="" err="Error: boom" nested={"a":1}',
  )
})

test('formatRecord survives a circular field instead of throwing', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const line = formatRecord({ level: 'info', time: FIXED, message: 'm', fields: { circular } })
  assert.ok(line.endsWith('circular=[unserializable]'), line)
})

test('a record carries the injected clock', () => {
  const { records, sink } = collector()
  createLogger({ sink, now: () => FIXED }).info('m')
  assert.equal(records[0]?.time, FIXED)
})

test('NOOP_LOGGER is silent and still safe to call', () => {
  NOOP_LOGGER.error('nothing happens')
  assert.equal(NOOP_LOGGER.level, 'silent')
  assert.equal(NOOP_LOGGER.enabled('error'), false)
})
