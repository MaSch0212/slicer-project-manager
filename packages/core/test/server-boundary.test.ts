import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.ts'

/**
 * Subsystem D's global constraint 2: **the Deno server's behaviour does not change.** Its new core
 * modules are imported by no route, so no route can call them, so no response can move.
 *
 * "Transitively imports" needs stating carefully, because the naive form of it is trivially true
 * and therefore worthless: `packages/core/src/index.ts` is a re-export hub, so *every* server file
 * that imports `@spm/core` reaches every module in core through it. The question worth asking is
 * whether any **binding the server actually imports** resolves into one of the three, so the walk
 * below goes: server files → the `@spm/core` names they import → the barrel line each name comes
 * from → that module's own relative imports, transitively.
 *
 * `import.meta.dirname` is typed for Node but not for a Deno workspace member, hence the URL form.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '../../..')
const coreSrc = join(repoRoot, 'packages/core/src')
const serverDir = join(repoRoot, 'packages/server')

const FORBIDDEN = ['files/zip-write.ts', 'files/strip3mf.ts', 'files/entry-hash.ts']
/**
 * The exports subsystem D adds. None of them may be named anywhere under `packages/server`.
 *
 * The last three are task 5's, and `readsAsZip` is the one that needs a word: it lives in
 * `files/zip.ts`, which the server reaches legitimately through the importer, so it cannot be
 * caught by the module list above. The name check is what covers it.
 */
const FORBIDDEN_NAMES = [
  'strip3mf',
  'stripRefusalReason',
  'entryHash',
  'entryDiff',
  'rewriteZip',
  'entryDigests',
  'diffDigests',
  'readsAsZip',
]

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) out.push(...walkFiles(path))
    else if (item.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Every `.ts` the server ships, excluding its own test suite. */
function serverFiles(): string[] {
  return [
    join(serverDir, 'main.ts'),
    join(serverDir, 'import-curamanager.ts'),
    ...walkFiles(join(serverDir, 'src')),
  ]
}

const SPECIFIER = /(?:from|import)\s*'([^']+)'/g
// `[^{}]*` rather than a lazy `[\s\S]*?`: the lazy form happily starts at one `import {` and
// finishes at a later `} from '@spm/core'`, swallowing everything between two import statements.
const CORE_IMPORT = /import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'@spm\/core'/g
const BARREL_LINE = /export\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'([^']+)'/g

/** `type Ctx`, `resolveSession`, `a as b` — the name as the *importing* side writes it. */
function importedNames(list: string): string[] {
  return list
    .split(',')
    .map(
      (item) =>
        item
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim() ?? '',
    )
    .filter((name) => name.length > 0)
}

/** The same list on the *exporting* side, where `a as b` publishes `b`. */
function exportedNames(list: string): string[] {
  return list
    .split(',')
    .map(
      (item) =>
        item
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? '',
    )
    .filter((name) => name.length > 0)
}

/** Core module paths, relative to `packages/core/src`, reachable from `entry` by relative import. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const path = queue.pop()!
    const key = relative(coreSrc, path).split('\\').join('/')
    if (seen.has(key)) continue
    seen.add(key)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1]!
      if (!specifier.startsWith('.')) continue
      queue.push(resolve(dirname(path), specifier))
    }
  }
  return seen
}

test('no file the server ships imports task 1s modules by path', () => {
  for (const path of serverFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1]!
      for (const forbidden of FORBIDDEN) {
        assert.equal(
          specifier.includes(forbidden.replace('files/', '').replace('.ts', '')),
          false,
          `${relative(repoRoot, path)} imports ${specifier}`,
        )
      }
    }
  }
})

test('no file the server ships names strip3mf, entryHash, entryDiff or the rewriter', () => {
  for (const path of serverFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const name of FORBIDDEN_NAMES) {
      assert.equal(
        new RegExp(`\\b${name}\\b`).test(source),
        false,
        `${relative(repoRoot, path)} names ${name}`,
      )
    }
  }
})

test('every @spm/core binding the server imports resolves away from task 1s modules', () => {
  // Which barrel line publishes which name.
  const barrel = readFileSync(join(coreSrc, 'index.ts'), 'utf8')
  const home = new Map<string, string>()
  for (const match of barrel.matchAll(BARREL_LINE)) {
    for (const name of exportedNames(match[1]!)) home.set(name, match[2]!)
  }
  assert.ok(home.size > 40, `the barrel parse found only ${home.size} exports`)

  const wanted = new Set<string>()
  for (const path of serverFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(CORE_IMPORT)) {
      for (const name of importedNames(match[1]!)) wanted.add(name)
    }
  }
  assert.ok(wanted.size > 20, `the server import scan found only ${wanted.size} names`)

  const reached = new Set<string>()
  for (const name of wanted) {
    const specifier = home.get(name)
    assert.ok(specifier, `@spm/core exports no ${name}; the barrel parse is wrong`)
    for (const module of reachableFrom(resolve(coreSrc, specifier!))) reached.add(module)
  }

  // The walk really does cross the barrel and follow relative edges — without this the assertion
  // below would pass on an empty set. `classifyFile` is a server import and `files/classify.ts`
  // imports `files/zip.ts`, so both must be in there.
  assert.ok(reached.has('files/classify.ts'), 'the walk did not reach files/classify.ts')
  assert.ok(reached.has('files/zip.ts'), 'the walk did not reach files/zip.ts')

  for (const forbidden of FORBIDDEN) {
    assert.equal(reached.has(forbidden), false, `the server reaches ${forbidden}`)
  }
})
