import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeLibrary,
  ensureLocalUser,
  openLibrary,
  rescan,
  type Ctx,
  type Library,
  type PreviewHandler,
  type PreviewJob,
} from '@spm/core'
import {
  startPreviewTicker,
  type PreviewTicker,
  type PreviewTickerOptions,
} from '../src/previews.ts'

/**
 * The preview ticker, against a real library on disk and with no Electron anywhere.
 *
 * Every assertion here is about something the *shell* owns rather than something core does: that
 * a freshly opened folder is drained without waiting for the first interval, that a slow run does
 * not pile up ticks behind it, that `stop()` really waits for the run in flight, and that the
 * default concurrency is the one the memory budget was written for. Core's own tests cover the
 * queue's semantics — claiming, leases, the retry budget — and are not repeated.
 */

let dir: string
let lib: Library
let ctx: Ctx

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spm-ticker-'))
  for (const name of ['Widget', 'Gadget', 'Doodad']) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'part.stl'), 'solid part\nendsolid part\n')
  }
  lib = openLibrary(dir)
  ctx = ensureLocalUser(lib)
  const result = await rescan(lib, ctx)
  assert.equal(result.previewsQueued, 3, 'the fixture must leave three pending previews')
})

after(() => {
  closeLibrary(lib)
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Every ticker a test started, and every gate it left closed.
 *
 * Not tidiness. A failed assertion skips whatever `stop()` the test was going to call, the
 * 60-second interval stays armed, and `node --test` then hangs for ever instead of reporting the
 * failure — which is exactly what happened while the mutations for this suite were being run, so
 * the failure mode is measured rather than imagined.
 */
const running: { stop(): Promise<void> }[] = []
const gates: (() => void)[] = []

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  for (const ticker of running.splice(0)) await ticker.stop()
})

/** Re-pends every row, so each test starts from the same three claimable jobs. */
function repend(): void {
  lib.db
    .prepare(
      "UPDATE previews SET state = 'pending', attempts = 0, claimed_at = NULL, png_path = NULL",
    )
    .run()
}

function states(): string[] {
  return (lib.db.prepare('SELECT state FROM previews').all() as { state: string }[])
    .map((row) => row.state)
    .sort()
}

/** A 1x1 PNG, so `runOne` writes a real file and the row can go `ready`. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

type Controlled = {
  handler: PreviewHandler
  entered: PreviewJob[]
  /** Currently inside `run`, which is how overlap is observed at all. */
  peakInFlight: () => number
  release: () => void
}

/** A handler that blocks until it is released, and records how many runs overlapped. */
function controlledHandler(): Controlled {
  const entered: PreviewJob[] = []
  let inFlight = 0
  let peak = 0
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  gates.push(() => release())
  return {
    entered,
    peakInFlight: () => peak,
    release: () => release(),
    handler: {
      kinds: ['model'],
      run: async (job) => {
        entered.push(job)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await gate
        inFlight -= 1
        return { bytes: PNG, width: 1, height: 1, source: 'rasterized' }
      },
    },
  }
}

/** `startPreviewTicker`, with the ticker registered for the cleanup above. */
function start(opts: PreviewTickerOptions): PreviewTicker {
  const ticker = startPreviewTicker(lib, opts)
  running.push(ticker)
  return ticker
}

test('the first tick runs immediately, without waiting for the interval', async () => {
  repend()
  const controlled = controlledHandler()
  // An interval far longer than this test: anything that happens here happened on the first tick.
  const ticker = start({
    intervalMs: 60_000,
    handlers: [controlled.handler],
    limit: 3,
  })
  try {
    // One turn of the loop is enough — the tick is synchronous up to the handler's first await.
    await Promise.resolve()
    assert.equal(controlled.entered.length, 1, 'the run should already be under way')
  } finally {
    controlled.release()
    await ticker.stop()
  }
  assert.deepEqual(states(), ['ready', 'ready', 'ready'])
  for (const row of lib.db.prepare('SELECT file_id AS id FROM previews').all() as {
    id: string
  }[]) {
    assert.ok(existsSync(join(dir, '.spm', 'previews', `${row.id}.png`)), 'the png was written')
  }
})

test('a run slower than the interval does not pile ticks up behind it', async () => {
  repend()
  const controlled = controlledHandler()
  const ticker = start({
    // 5 ms against a run that cannot finish until it is released: without the in-flight guard
    // this is a new `runPreviewQueue` every 5 ms.
    intervalMs: 5,
    handlers: [controlled.handler],
    limit: 1,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(
      controlled.entered.length,
      1,
      'the guard should have skipped every tick while the first run was in flight',
    )
  } finally {
    controlled.release()
    await ticker.stop()
  }
})

test('stop() resolves only after the run in flight has finished', async () => {
  repend()
  const controlled = controlledHandler()
  const ticker = start({
    intervalMs: 60_000,
    handlers: [controlled.handler],
    limit: 3,
  })
  await Promise.resolve()
  assert.equal(controlled.entered.length, 1)

  let stopped = false
  const stopping = ticker.stop().then(() => {
    stopped = true
  })
  // Several turns of the microtask and timer queues, and it must still be waiting: this is the
  // property `LibraryHost` relies on before it closes a library the user has switched away from.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(stopped, false, 'stop() resolved while a preview run was still writing')
  assert.equal(states().includes('pending'), true, 'the run really had not finished yet')

  controlled.release()
  await stopping
  assert.equal(stopped, true)
  assert.deepEqual(states(), ['ready', 'ready', 'ready'])
})

test('a stopped ticker never runs again', async () => {
  repend()
  const controlled = controlledHandler()
  controlled.release()
  const ticker = start({
    intervalMs: 5,
    handlers: [controlled.handler],
    limit: 1,
  })
  await ticker.stop()
  const afterStop = controlled.entered.length
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(controlled.entered.length, afterStop, 'the interval kept firing after stop()')
})

test('the default concurrency renders one preview at a time', async () => {
  repend()
  const controlled = controlledHandler()
  // Released from the start, so the three jobs are only serialised by the queue itself and not
  // by the gate. With `concurrency` left at its default, the peak overlap must be one.
  controlled.release()
  const ticker = start({
    intervalMs: 60_000,
    handlers: [controlled.handler],
    limit: 3,
  })
  await ticker.stop()
  assert.equal(controlled.entered.length, 3)
  assert.equal(controlled.peakInFlight(), 1, 'two meshes were in memory at once')
})

test('a handler that throws is logged and does not stop the ticker', async () => {
  repend()
  const boom: PreviewHandler = {
    kinds: ['model'],
    run: () => Promise.reject(new Error('no mesh here')),
  }
  const ticker = start({ intervalMs: 60_000, handlers: [boom], limit: 3 })
  await ticker.stop()
  // core marks each row `failed` rather than letting the run reject; the point of the assertion
  // is that the ticker survived it and drained the batch.
  assert.deepEqual(states(), ['failed', 'failed', 'failed'])
})
