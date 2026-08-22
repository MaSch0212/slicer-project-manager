import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Two maps describe the same package for two runtimes: `exports` in package.json is what Node
 * and every bundler read, `imports` in deno.json is what Deno reads. An import map bypasses
 * `exports` entirely, so a subpath missing from either map is invisible from the other side —
 * which is how `./api-client.ts` stayed unexported for weeks: nothing outside Deno imported it.
 */
const contractDir = join(import.meta.dirname, '..')
const repoRoot = join(contractDir, '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

const exportsMap = readJson(join(contractDir, 'package.json'))['exports'] as Record<string, string>
const importsMap =
  (readJson(join(repoRoot, 'deno.json'))['imports'] as Record<string, string>) ?? {}

/** `.` and `./errors.ts` in exports are `@spm/contract` and `@spm/contract/errors.ts` in deno. */
function toSpecifier(subpath: string): string {
  return subpath === '.' ? '@spm/contract' : `@spm/contract/${subpath.slice('./'.length)}`
}

test('every contract export is also in the Deno import map, and points at the same file', () => {
  for (const [subpath, target] of Object.entries(exportsMap)) {
    const specifier = toSpecifier(subpath)
    const mapped = importsMap[specifier]
    assert.ok(mapped, `deno.json is missing an import for ${specifier}`)
    assert.equal(
      mapped,
      `./packages/contract/${target.slice('./'.length)}`,
      `${specifier} resolves to a different file in deno.json than in package.json`,
    )
  }
})

test('the Deno import map declares no contract subpath the package does not export', () => {
  const exported = new Set(Object.keys(exportsMap).map(toSpecifier))
  for (const specifier of Object.keys(importsMap)) {
    if (!specifier.startsWith('@spm/contract')) continue
    assert.ok(
      exported.has(specifier),
      `${specifier} works under Deno but not under Node: add it to package.json exports`,
    )
  }
})

test('every module in src is exported, so a new one cannot stay unreachable', () => {
  const exported = new Set(Object.values(exportsMap))
  for (const file of readdirSync(join(contractDir, 'src'))) {
    if (!file.endsWith('.ts')) continue
    assert.ok(
      exported.has(`./src/${file}`),
      `src/${file} is not in package.json exports (the barrel re-exporting it is not enough)`,
    )
  }
})
