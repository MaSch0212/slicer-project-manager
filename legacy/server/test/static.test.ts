import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { contentTypeFor } from '@spm/core'
import { resolveWebRoot, serveStatic, staticFilePath } from '../src/static.ts'
import { withServer } from './harness.ts'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..')

function inCwd<T>(dir: string, run: () => T): T {
  const previous = Deno.cwd()
  Deno.chdir(dir)
  try {
    return run()
  } finally {
    Deno.chdir(previous)
  }
}

Deno.test('the default web root resolves next to this module, not next to the process cwd', () => {
  const expected = join(repoRoot, 'packages', 'web', 'dist', 'web', 'browser')

  // The documented command is `deno run -A packages/server/main.ts` from the repo root
  // (README). The old cwd-relative default ('../web/dist/web/browser') resolved to
  // <parent-of-repo>/web/dist/web/browser from there, so both the requested file and the
  // index.html fallback missed and the whole UI answered 404.
  assert.equal(
    inCwd(repoRoot, () => resolveWebRoot(undefined)),
    expected,
  )
  // Being cwd-independent, it is the same answer from anywhere.
  assert.equal(
    inCwd(tmpdir(), () => resolveWebRoot(undefined)),
    expected,
  )
})

Deno.test('an explicit SPM_WEB_ROOT stays relative to the process cwd', () => {
  // playwright.config.ts passes SPM_WEB_ROOT=dist/web/browser with cwd=packages/web, so
  // that form must keep working exactly as before.
  assert.equal(
    inCwd(join(repoRoot, 'packages', 'web'), () => resolveWebRoot('dist/web/browser')),
    join(repoRoot, 'packages', 'web', 'dist', 'web', 'browser'),
  )
})

Deno.test('staticFilePath refuses any candidate that escapes the web root', () => {
  const root = join(repoRoot, 'packages', 'web', 'dist', 'web', 'browser')

  assert.equal(staticFilePath(root, 'index.html'), join(root, 'index.html'))
  assert.equal(staticFilePath(root, 'assets/app.js'), join(root, 'assets', 'app.js'))

  // The server runs with -A, so this must be refused outright rather than left to depend on
  // WHATWG URL normalisation happening to strip dot segments before pathname is read.
  assert.throws(() => staticFilePath(root, '../../../secrets.env'), { code: 'Forbidden' })
  assert.throws(() => staticFilePath(root, 'assets/../../secrets.env'), { code: 'Forbidden' })
  assert.throws(() => staticFilePath(root, '/etc/passwd'), { code: 'Forbidden' })
})

Deno.test('serveStatic serves files and falls back to index.html for client routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spm-static-'))
  const secret = join(root, '..', 'spm-static-secret.txt')
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html>root')
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(secret, 'do not serve me')

    const at = (path: string) => serveStatic(new URL(`http://localhost${path}`), root)

    const index = await at('/')
    assert.equal(index.status, 200)
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(await index.text(), '<!doctype html>root')

    const asset = await at('/assets/app.js')
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')

    const deepLink = await at('/projects/abc')
    assert.equal(deepLink.status, 200)
    assert.equal(await deepLink.text(), '<!doctype html>root')

    // A refused candidate is not a 500: it falls through to the SPA fallback like any
    // other miss.
    const traversal = await at('/%2e%2e/spm-static-secret.txt')
    assert.equal(traversal.status, 200)
    assert.equal(await traversal.text(), '<!doctype html>root')

    // An empty root would make every candidate a miss; a root that exists but has no
    // index.html is the only 404 path left.
    const empty = mkdtempSync(join(tmpdir(), 'spm-static-empty-'))
    try {
      const missing = await serveStatic(new URL('http://localhost/'), empty)
      assert.equal(missing.status, 404)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(secret, { force: true })
  }
})

Deno.test('makeHandler serves non-API requests from the web root it was given', async () => {
  // `SPM_WEB_ROOT` used to be read at module load in static.ts and baked into serveStatic's
  // default parameter, so no test could vary it and the path from the variable to a served byte
  // was never exercised. main.ts resolves it now and passes it through Env; this covers the
  // handoff.
  const root = mkdtempSync(join(tmpdir(), 'spm-webroot-'))
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html>from the configured root')
    await withServer(
      async (server) => {
        const response = await server.fetch('/projects/abc')
        assert.equal(response.status, 200)
        assert.equal(await response.text(), '<!doctype html>from the configured root')
      },
      { env: { webRoot: root } },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

Deno.test('the icon assets are served as themselves, not as octet-stream', async () => {
  // Measured before this existed, against the real `packages/web/dist/web/browser`: `favicon.svg`,
  // `favicon.ico` and `manifest.webmanifest` all came back **200 application/octet-stream**,
  // because `serveStatic` knew three extensions by name and handed everything else to core's
  // library-file map, which knows none of these.
  //
  // Two of those three are real breakage rather than untidiness. Chromium does not sniff SVG for
  // an `<img>` — it requires `image/svg+xml` — so the brand mark in the app header was a broken
  // image in the browser while rendering correctly in the Electron shell, whose own map already
  // had `.svg`. And Chromium refuses a manifest that is not served as JSON, so the Android
  // home-screen icon the manifest exists for would not have been used.
  //
  // Files written here rather than read from `dist/`: this suite must not need a built bundle,
  // and the assertion is about the *mapping*, which does not care what is in the file.
  const root = mkdtempSync(join(tmpdir(), 'spm-static-types-'))
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html>root')
    for (const name of ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'icon-192.png']) {
      writeFileSync(join(root, name), 'x')
    }
    const at = (path: string) => serveStatic(new URL(`http://localhost${path}`), root)
    const types: Record<string, string | null> = {}
    for (const name of ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'icon-192.png']) {
      types[name] = (await at(`/${name}`)).headers.get('content-type')
    }
    assert.deepEqual(types, {
      'favicon.svg': 'image/svg+xml',
      'favicon.ico': 'image/vnd.microsoft.icon',
      'manifest.webmanifest': 'application/manifest+json',
      // Already correct before the icons arrived — core's map has `png` — and here so a rewrite
      // of the lookup that dropped the fallback to `contentTypeFor` fails rather than passing.
      'icon-192.png': 'image/png',
    })

    // Core's map must not learn `svg`. `packages/desktop/src/app.ts` carries a measured table of
    // what each type in it does when navigated to at the renderer's origin, and an SVG document
    // both commits *and* can run script — the one entry that would invalidate it. This asserts
    // the separation rather than trusting a comment to preserve it.
    assert.equal(contentTypeFor('drawing.svg'), 'application/octet-stream')
    assert.equal(contentTypeFor('anything.webmanifest'), 'application/octet-stream')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
