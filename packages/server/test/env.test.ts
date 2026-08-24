import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import { DEFAULT_CONCURRENCY } from '@spm/core'
import {
  DEFAULT_MAX_MESH_MB,
  DEFAULT_PORT,
  DEFAULT_PREVIEW_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MAX_MESH_MB,
  readServerEnv,
  resolveLibraryDir,
  resolveLogLevel,
  resolveMaxMeshBytes,
  resolvePort,
  resolvePreviewConcurrency,
  resolvePreviewIntervalMs,
  resolvePublicOrigin,
} from '../src/env.ts'
import { resolveWebRoot } from '../src/static.ts'

/** The AppError the call threw. Fails the test if it returned, or threw something else. */
function caught(call: () => unknown): AppError {
  try {
    call()
  } catch (error) {
    // Never a bare TypeError or RangeError: main.ts prints `.message` and exits, so anything
    // without a written-for-an-operator message reaches them as noise.
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' })
}

/** Asserts the call throws an AppError whose message names the variable and quotes the input. */
function refuses(variable: string, raw: string, call: () => unknown): void {
  const error = caught(call)
  assert.equal(error.code, 'Validation')
  assert.ok(
    error.message.startsWith(variable),
    `message should lead with the variable name: ${error.message}`,
  )
  // The raw value is echoed back in quotes, which is the only way an operator sees that their
  // value has a stray space in it.
  assert.ok(error.message.includes(`"${raw}"`), `message should quote the value: ${error.message}`)
}

Deno.test('SPM_LIBRARY_DIR is required and otherwise taken verbatim', () => {
  assert.equal(resolveLibraryDir('/srv/library'), '/srv/library')
  assert.equal(resolveLibraryDir('C:\\models'), 'C:\\models')

  // Unset and blank are the same mistake from the operator's side -- an env file line with
  // nothing after the `=` -- so both get the message that says what to do about it.
  for (const raw of [undefined, '', '   ']) {
    const error = caught(() => resolveLibraryDir(raw))
    assert.equal(error.message, 'SPM_LIBRARY_DIR is required')
  }
})

Deno.test('SPM_LOG_LEVEL takes the default when unset and refuses a typo', () => {
  assert.equal(resolveLogLevel(undefined), 'info')
  assert.equal(resolveLogLevel('debug'), 'debug')
  assert.equal(resolveLogLevel('silent'), 'silent')
  // parseLogLevel folds case and trims, and that is a deliberate difference from the numeric
  // variables: a level is a word an operator types, not a value copied from a table.
  assert.equal(resolveLogLevel(' TRACE '), 'trace')

  refuses('SPM_LOG_LEVEL', 'verbose', () => resolveLogLevel('verbose'))
  refuses('SPM_LOG_LEVEL', '', () => resolveLogLevel(''))
  // The message has to list the alternatives, or the operator's next guess is another typo.
  const error = caught(() => resolveLogLevel('verbose'))
  assert.ok(error.message.includes('silent, error, warn, info, debug, trace'), error.message)
})

Deno.test('SPM_PORT accepts a plain decimal port and nothing else', () => {
  assert.equal(resolvePort(undefined), DEFAULT_PORT)
  assert.equal(resolvePort('8000'), 8000)
  assert.equal(resolvePort('1'), 1)
  assert.equal(resolvePort('65535'), 65535)
  // Unambiguous in decimal, and padding is deliberate often enough to be worth allowing.
  assert.equal(resolvePort('08000'), 8000)

  // The bug this whole module exists for: Number('abc') is NaN, and Deno.serve took it.
  refuses('SPM_PORT', 'abc', () => resolvePort('abc'))

  // Every spelling Number() quietly accepts. Each would have "worked" -- which is worse than
  // failing, because the operator would never learn their config does not say what they think.
  refuses('SPM_PORT', '', () => resolvePort('')) // Number('') === 0
  refuses('SPM_PORT', ' 8000 ', () => resolvePort(' 8000 ')) // Number trims
  refuses('SPM_PORT', '8e3', () => resolvePort('8e3')) // Number('8e3') === 8000
  refuses('SPM_PORT', '0x1f', () => resolvePort('0x1f')) // Number('0x1f') === 31
  refuses('SPM_PORT', 'Infinity', () => resolvePort('Infinity'))
  refuses('SPM_PORT', '80.5', () => resolvePort('80.5'))
  refuses('SPM_PORT', '+8000', () => resolvePort('+8000'))
  refuses('SPM_PORT', '-1', () => resolvePort('-1'))

  // In range, but not a port anyone means: 0 tells Deno.serve to pick a free one, so the server
  // would come up somewhere unpredictable and look like it had not come up at all.
  refuses('SPM_PORT', '0', () => resolvePort('0'))
  refuses('SPM_PORT', '65536', () => resolvePort('65536'))
})

Deno.test(
  'SPM_PREVIEW_INTERVAL_MS accepts a whole number of milliseconds in setInterval range',
  () => {
    assert.equal(resolvePreviewIntervalMs(undefined), DEFAULT_PREVIEW_INTERVAL_MS)
    assert.equal(resolvePreviewIntervalMs('250'), 250)
    assert.equal(resolvePreviewIntervalMs('1'), 1)
    // Literals, not `String(MAX_INTERVAL_MS)`: expressing the boundary in terms of the constant
    // makes the pair of assertions below move with it, so raising the limit past what
    // setInterval can hold would keep them green and prove nothing.
    assert.equal(MAX_INTERVAL_MS, 2_147_483_647)
    assert.equal(resolvePreviewIntervalMs('2147483647'), 2_147_483_647)

    refuses('SPM_PREVIEW_INTERVAL_MS', '', () => resolvePreviewIntervalMs(''))
    refuses('SPM_PREVIEW_INTERVAL_MS', ' 1000 ', () => resolvePreviewIntervalMs(' 1000 '))
    refuses('SPM_PREVIEW_INTERVAL_MS', '1e3', () => resolvePreviewIntervalMs('1e3'))
    refuses('SPM_PREVIEW_INTERVAL_MS', '1.5', () => resolvePreviewIntervalMs('1.5'))
    refuses('SPM_PREVIEW_INTERVAL_MS', '-1', () => resolvePreviewIntervalMs('-1'))
    // Zero would busy-loop the preview queue.
    refuses('SPM_PREVIEW_INTERVAL_MS', '0', () => resolvePreviewIntervalMs('0'))

    // Past 2^31-1 setInterval clamps the delay to 1 ms, so "run it once a month" would become
    // "run it a thousand times a second". Refusing it is the only way that is not silent.
    refuses('SPM_PREVIEW_INTERVAL_MS', '2147483648', () => resolvePreviewIntervalMs('2147483648'))
  },
)

Deno.test('SPM_PREVIEW_CONCURRENCY accepts a worker count and refuses the rest', () => {
  // Against core's constant, not against the literal 1. The number itself is core's to decide and
  // is pinned in `previews.test.ts` beside the measurement that chose it; what this pins is the
  // *coupling* -- that the server reads it rather than keeping its own copy. A literal here would
  // stay green while core moved, which is precisely the drift worth catching.
  assert.equal(resolvePreviewConcurrency(undefined), DEFAULT_CONCURRENCY)
  assert.equal(resolvePreviewConcurrency('2'), 2)
  assert.equal(resolvePreviewConcurrency('64'), 64)

  refuses('SPM_PREVIEW_CONCURRENCY', '', () => resolvePreviewConcurrency(''))
  refuses('SPM_PREVIEW_CONCURRENCY', ' 2 ', () => resolvePreviewConcurrency(' 2 '))
  refuses('SPM_PREVIEW_CONCURRENCY', '2.5', () => resolvePreviewConcurrency('2.5'))
  refuses('SPM_PREVIEW_CONCURRENCY', '-1', () => resolvePreviewConcurrency('-1'))
  // Zero workers is not "pause the queue", it is a queue that silently never runs. And 65 is
  // 65 meshes in memory at once, which no machine this ships to survives.
  refuses('SPM_PREVIEW_CONCURRENCY', '0', () => resolvePreviewConcurrency('0'))
  refuses('SPM_PREVIEW_CONCURRENCY', '65', () => resolvePreviewConcurrency('65'))
})

Deno.test('SPM_MAX_MESH_MB accepts whole megabytes and converts them to bytes', () => {
  assert.equal(resolveMaxMeshBytes(undefined), DEFAULT_MAX_MESH_MB * 1_000_000)
  // The measured default: the largest mesh in the reference library needs 208.8 MB, so a
  // default below that would refuse a file the user owns. Pinned for the same reason as above.
  assert.equal(DEFAULT_MAX_MESH_MB, 256)
  assert.equal(resolveMaxMeshBytes('300'), 300_000_000)
  assert.equal(resolveMaxMeshBytes('1'), 1_000_000)
  // 2 GB, and the bound is structural: past it a single `Float32Array` for `positions` would
  // exceed what V8 can construct, so a larger ceiling would be a promise the engine cannot keep.
  assert.equal(MAX_MESH_MB, 2_048)
  assert.equal(resolveMaxMeshBytes('2048'), 2_048_000_000)

  refuses('SPM_MAX_MESH_MB', '', () => resolveMaxMeshBytes(''))
  refuses('SPM_MAX_MESH_MB', ' 300 ', () => resolveMaxMeshBytes(' 300 '))
  refuses('SPM_MAX_MESH_MB', '256MB', () => resolveMaxMeshBytes('256MB'))
  refuses('SPM_MAX_MESH_MB', '2.5', () => resolveMaxMeshBytes('2.5'))
  refuses('SPM_MAX_MESH_MB', '-1', () => resolveMaxMeshBytes('-1'))
  // Zero permits no mesh at all, which would fail every preview with a message about sizes.
  refuses('SPM_MAX_MESH_MB', '0', () => resolveMaxMeshBytes('0'))
  refuses('SPM_MAX_MESH_MB', '2049', () => resolveMaxMeshBytes('2049'))
})

Deno.test('SPM_PUBLIC_ORIGIN is normalised to a bare origin, and blank means unset', () => {
  assert.equal(
    resolvePublicOrigin('https://print.example.com/spm?x=1'),
    'https://print.example.com',
  )
  assert.equal(
    resolvePublicOrigin('https://print.example.com:8443'),
    'https://print.example.com:8443',
  )

  // Unset and blank both fall back to the request's own origin. Treating blank as an origin
  // would build `/activate#tok` with no host in it at all.
  assert.equal(resolvePublicOrigin(undefined), undefined)
  assert.equal(resolvePublicOrigin(''), undefined)
  assert.equal(resolvePublicOrigin('   '), undefined)

  // Loud at startup beats quietly emitting http:// activation links nobody notices until the
  // Secure session cookie is dropped and the user is activated but not signed in.
  //
  // Not `refuses`: this message and SPM_DEV_UI_ORIGIN's append the offending URL bare rather
  // than in quotes, which is consistent between the two URL-valued variables and loses nothing,
  // since both are trimmed before validation and so cannot carry invisible whitespace.
  for (const raw of ['print.example.com', 'ftp://print.example.com', 'not a url at all']) {
    const error = caught(() => resolvePublicOrigin(raw))
    assert.equal(error.code, 'Validation')
    assert.ok(error.message.startsWith('SPM_PUBLIC_ORIGIN'), error.message)
    assert.ok(error.message.includes(raw), error.message)
  }
})

Deno.test('readServerEnv resolves every variable, defaulting the optional ones', () => {
  const bundled = resolveWebRoot(undefined)
  assert.deepEqual(
    readServerEnv((name) => ({ SPM_LIBRARY_DIR: '/srv/library' })[name]),
    {
      libraryDir: '/srv/library',
      level: 'info',
      port: DEFAULT_PORT,
      previewIntervalMs: DEFAULT_PREVIEW_INTERVAL_MS,
      previewConcurrency: DEFAULT_CONCURRENCY,
      maxMeshBytes: DEFAULT_MAX_MESH_MB * 1_000_000,
      devUiOrigin: null,
      publicOrigin: undefined,
      webRoot: bundled,
    },
  )
  // Not a tautology against the line above: the default is an absolute path pointing at the
  // built Angular bundle, resolved against `src/static.ts` rather than the process cwd.
  assert.ok(bundled.endsWith(join('web', 'dist', 'web', 'browser')), bundled)
  assert.notEqual(bundled, resolve('web/dist/web/browser'))

  const full: Record<string, string> = {
    SPM_LIBRARY_DIR: '/srv/library',
    SPM_LOG_LEVEL: 'debug',
    SPM_PORT: '9001',
    SPM_PREVIEW_INTERVAL_MS: '250',
    SPM_PREVIEW_CONCURRENCY: '4',
    SPM_MAX_MESH_MB: '512',
    SPM_DEV_UI_ORIGIN: 'http://localhost:4200/ignored/path',
    SPM_PUBLIC_ORIGIN: 'https://print.example.com/ignored/path',
    SPM_WEB_ROOT: 'dist/web/browser',
  }
  assert.deepEqual(
    readServerEnv((name) => full[name]),
    {
      libraryDir: '/srv/library',
      level: 'debug',
      port: 9001,
      previewIntervalMs: 250,
      previewConcurrency: 4,
      maxMeshBytes: 512_000_000,
      // Each of these three proves the variable is routed through its own validator rather than
      // passed raw: a stray path is dropped, and a relative web root becomes absolute.
      devUiOrigin: 'http://localhost:4200',
      publicOrigin: 'https://print.example.com',
      webRoot: resolve('dist/web/browser'),
    },
  )
})

Deno.test('readServerEnv reports the first unusable variable, and reports it as AppError', () => {
  const env: Record<string, string> = {
    SPM_LIBRARY_DIR: '/srv/library',
    SPM_PORT: 'abc',
    SPM_PREVIEW_INTERVAL_MS: 'also-bad',
  }
  const error = caught(() => readServerEnv((name) => env[name]))
  // main.ts prints `error.message` and exits; anything that is not an AppError would reach the
  // operator as a stack trace instead of a sentence.
  assert.equal(error.code, 'Validation')
  assert.ok(error.message.startsWith('SPM_PORT='), error.message)

  // A missing library dir is caught even though the numeric variables are fine.
  assert.equal(caught(() => readServerEnv(() => undefined)).message, 'SPM_LIBRARY_DIR is required')
  // And a library dir alone is not enough to make the rest pass unchecked.
  caught(() => readServerEnv((name) => (name === 'SPM_LIBRARY_DIR' ? '/x' : 'nonsense')))
})
