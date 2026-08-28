import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

/**
 * **The main process never registers a preload on a session** (E constraint 10, spec 3.9.4).
 *
 * This is the leg of the containment that no runtime assertion can reach, because the defect it
 * guards is *invisible at the call site*. Measured: `session.registerPreloadScript({type:'frame',
 * filePath})` on `defaultSession` reached a `WebContentsView` created **afterwards** on that
 * session — a preload registered on a session is inherited by every webContents on it, embedded
 * browser included. And `ses.setPreloads` is marked deprecated **in favour of
 * `registerPreloadScript`** in this Electron's own type definitions, so the plausible route into
 * the defect is somebody tidying up after a deprecation notice, in a file nowhere near
 * `browse/host.ts`, with every other test in the repo staying green.
 *
 * Neither identifier occurs in the tree today. This asserts they never do.
 *
 * **A source walk and not a CI grep** (E decision 10). CI's four existing grep pairs check *built
 * web bundles* for an exported class name; these are main-process identifiers that are not in
 * those bundles under any circumstances, so the established instrument answers a different
 * question. It also runs in `deno task verify`, which is where a developer meets it before a
 * pipeline does.
 *
 * A walk that found no files would pass for the same reason a search of an empty room finds no
 * weapons, so the file list is asserted too — a count, a known member, and a positive control that
 * proves this reader can find an identifier when there is one to find.
 */

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * The two identifiers, spelled as they would be called.
 *
 * `registerPreloadScript` is the one measured to reach the browse view. `setPreloads` is its
 * deprecated predecessor and is here because it does the same thing — banning only the modern
 * spelling would leave the old one available to anyone who noticed the ban.
 */
const FORBIDDEN = ['registerPreloadScript', 'setPreloads'] as const

function typescriptFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...typescriptFilesUnder(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

test('no module in packages/desktop/src registers a preload on a session', () => {
  const files = typescriptFilesUnder(SRC)
  const named = files.map((file) => relative(SRC, file).split(sep).join('/'))

  // The walk found the tree, not an empty room. Both halves matter: a bare count would survive a
  // walker that listed one directory, and a bare membership check would survive one that returned
  // a hard-coded list.
  assert.ok(files.length >= 20, `expected the desktop sources, found ${files.length}`)
  for (const expected of ['app.ts', 'preload.ts', 'browse/host.ts', 'slicers/host.ts']) {
    assert.ok(named.includes(expected), `${expected} was not walked`)
  }

  const offenders: string[] = []
  let sawAPreloadPath = false
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // The positive control, in the same read as the assertion: `app.ts` really does configure a
    // preload — on `webPreferences`, where it belongs and where it follows one webContents — so a
    // reader that returned empty strings would fail here rather than pass everything below.
    if (text.includes('preload: preloadPath()')) sawAPreloadPath = true
    for (const identifier of FORBIDDEN) {
      if (text.includes(identifier)) offenders.push(`${relative(SRC, file)}: ${identifier}`)
    }
  }

  assert.equal(sawAPreloadPath, true, 'the walk read no file that configures the window preload')
  assert.deepEqual(
    offenders,
    [],
    'a session-scoped preload reaches every webContents on that session, the browse view included',
  )
})
