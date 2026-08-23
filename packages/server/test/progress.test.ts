import assert from 'node:assert/strict'
import {
  createProgress,
  NON_TTY_INTERVAL_MS,
  TTY_INTERVAL_MS,
  type Progress,
} from '../src/progress.ts'

function harness(isTerminal: boolean): {
  progress: Progress
  out: string[]
  tick: (ms: number) => void
} {
  const out: string[] = []
  let clock = 0
  const progress = createProgress({
    isTerminal,
    write: (text) => out.push(text),
    now: () => clock,
  })
  return { progress, out, tick: (ms) => (clock += ms) }
}

Deno.test('a terminal gets one in-place line, redrawn no faster than the interval', () => {
  const { progress, out, tick } = harness(true)
  progress.update('first')
  progress.update('too soon')
  tick(TTY_INTERVAL_MS)
  progress.update('second')

  // First draw, then erase + redraw for the second. "too soon" never reaches the terminal.
  assert.deepEqual(out, ['first', '\r\x1b[K', 'second'])
})

Deno.test('force bypasses the throttle so a phase change is never swallowed', () => {
  const { progress, out } = harness(true)
  progress.update('indexing')
  progress.update('applying sidecars', true)
  assert.ok(out.includes('applying sidecars'), out.join('|'))
})

Deno.test('clear erases the live line exactly once, so a log line starts clean', () => {
  const { progress, out } = harness(true)
  progress.update('working')
  progress.clear()
  progress.clear()
  assert.deepEqual(out, ['working', '\r\x1b[K'])
})

Deno.test('clear before anything is drawn writes nothing', () => {
  const { progress, out } = harness(true)
  progress.clear()
  assert.deepEqual(out, [])
})

Deno.test('a redraw after a clear does not erase a line that is no longer there', () => {
  const { progress, out, tick } = harness(true)
  progress.update('one')
  progress.clear()
  out.length = 0
  tick(TTY_INTERVAL_MS)
  progress.update('two')
  // No stray escape: the line was already gone, so 'two' is written straight out.
  assert.deepEqual(out, ['two'])
})

Deno.test('a pipe gets appended lines at a slower cadence and no escape codes', () => {
  const { progress, out, tick } = harness(false)
  progress.update('first')
  tick(TTY_INTERVAL_MS)
  progress.update('swallowed, a pipe does not want 40k of these')
  tick(NON_TTY_INTERVAL_MS)
  progress.update('second')

  assert.deepEqual(out, ['first\n', 'second\n'])
  assert.ok(!out.join('').includes('\x1b'), 'an escape code reached a non-terminal stream')
})

Deno.test('done leaves the terminal clean and lets the next update draw immediately', () => {
  const { progress, out } = harness(true)
  progress.update('working')
  progress.done()
  assert.deepEqual(out, ['working', '\r\x1b[K'])

  out.length = 0
  // No clock advance: done() resets the throttle, so a fresh run is not held back by it.
  progress.update('next run')
  assert.deepEqual(out, ['next run'])
})
