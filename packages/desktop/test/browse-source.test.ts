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

/* -------------------------------------------------------------------------------------------
 * Constraint 2: the Deno server does not change, and packages/core is not edited
 * ---------------------------------------------------------------------------------------- */

/**
 * **What these two tests can see, and what they cannot** — said first, because a boundary test that
 * overstates its reach is worse than none.
 *
 * They see an **added route**, an **added or removed module** under `packages/core/src` or
 * `packages/server/test`, and **any mention of the model browser** inside either package. That
 * covers the three ways E could have reached into the server: a `/api/browse/...` route, a new core
 * module for it to call, and a core or server file that names one of E's own things.
 *
 * They do **not** see an edit to the body of an existing core function. Nothing in this repository
 * can, short of pinning a content hash of forty-one files in a desktop test — which would turn every
 * later, legitimate core change into a red test in the wrong package, with a message about a
 * subsystem that had nothing to do with it. What covers that is core's own suite, which runs
 * unchanged in `deno task verify`, and the diff a reviewer reads.
 *
 * Subsystem D's equivalent is `packages/core/test/server-boundary.test.ts`, and this is deliberately
 * not there: E may not edit `packages/core` **at all**, its test directory included.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * Every route the Deno server serves, as `METHOD path`.
 *
 * Pinned as a list rather than counted: a count is satisfied by a route that was swapped for
 * another, and the question is whether *this* set is still the set. Read out of the route modules'
 * source rather than imported, because `packages/server` is Deno-only — `router.ts` names
 * `Deno.ServeHandlerInfo` in a type position, which the desktop `tsc` project has no lib for.
 */
const SERVER_ROUTES = [
  'DELETE /api/files/:id',
  'DELETE /api/projects/:id',
  'DELETE /api/projects/:id/tags/:name',
  'DELETE /api/users/:id',
  'GET /api/account',
  'GET /api/account/settings',
  'GET /api/auth/activation/:token',
  'GET /api/capabilities',
  'GET /api/files/:id/raw',
  'GET /api/files/:id/thumb',
  'GET /api/projects',
  'GET /api/projects/:id',
  'GET /api/users',
  'PATCH /api/account',
  'PATCH /api/files/:id',
  'PATCH /api/projects/:id',
  'PATCH /api/users/:id',
  'POST /api/account/password',
  'POST /api/auth/activation/:token',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/import/curamanager',
  'POST /api/projects',
  'POST /api/projects/:id/files',
  'POST /api/projects/:id/tags',
  'POST /api/projects/rescan',
  'POST /api/users',
  'POST /api/users/:id/invite',
  'PUT /api/account/settings',
]

/** The modules `packages/core/src` holds. E adds none and removes none (spec 7.5). */
const CORE_MODULES = [
  'auth/activation.ts',
  'auth/login.ts',
  'auth/password.ts',
  'auth/sessions.ts',
  'auth/tokens.ts',
  'ctx.ts',
  'db/ids.ts',
  'db/migrate.ts',
  'db/open.ts',
  'files/chunks.ts',
  'files/classify.ts',
  'files/entry-hash.ts',
  'files/hash.ts',
  'files/paths.ts',
  'files/strip3mf.ts',
  'files/usecases.ts',
  'files/zip-write.ts',
  'files/zip.ts',
  'index.ts',
  'log.ts',
  'previews/embedded.ts',
  'previews/handlers.ts',
  'previews/mesh-handler.ts',
  'previews/mesh/limits.ts',
  'previews/mesh/mesh.ts',
  'previews/mesh/obj.ts',
  'previews/mesh/stl.ts',
  'previews/mesh/threemf.ts',
  'previews/png.ts',
  'previews/queue.ts',
  'previews/raster.ts',
  'projects/import-curamanager.ts',
  'projects/import-zip.ts',
  'projects/queries.ts',
  'projects/rescan.ts',
  'projects/usecases.ts',
  'users/account.ts',
  'users/admin.ts',
  'users/bootstrap.ts',
  'users/repo.ts',
  'users/usage.ts',
]

/** The server's own suite, unchanged in membership. */
const SERVER_TESTS = [
  'auth.test.ts',
  'dev-proxy.test.ts',
  'env.test.ts',
  'files.test.ts',
  'harness.ts',
  'import.test.ts',
  'logging.test.ts',
  'progress.test.ts',
  'projects.test.ts',
  'rate-limit.test.ts',
  'static.test.ts',
  'users.test.ts',
]

/**
 * Names that belong to the model browser and to nothing else.
 *
 * `browse` on its own is not on this list and must not be: `packages/server` says "browser" about
 * the thing at the other end of an HTTP request in six places, and `canBrowseModelSites` is a
 * contract field the server's capability route legitimately answers `false` for. Each of these is a
 * whole identifier or a whole file name from E's own modules.
 */
const BROWSER_NAMES = [
  'BrowseDownload',
  'BrowseLanding',
  'MODEL_DOWNLOADS_DIR',
  'model-downloads',
  'download.json',
  'WebContentsView',
  'will-download',
  'browse.land',
  'stagedFileName',
  'vouchesForTheBytes',
]

function relativeNames(dir: string): string[] {
  return typescriptFilesUnder(dir)
    .map((file) => relative(dir, file).split(sep).join('/'))
    .sort()
}

test('subsystem E added no route to the Deno server', () => {
  const found: string[] = []
  const routesDir = join(REPO_ROOT, 'packages/server/src/routes')
  for (const file of typescriptFilesUnder(routesDir)) {
    const text = readFileSync(file, 'utf8')
    // Every route in this server is an object literal with these two adjacent fields, in this
    // order — `Route` in `router.ts` declares them that way and all eight modules write them that
    // way. A route added in some other shape would not be found by this, and would be found by the
    // `index.ts` assertion below instead: a new array has to be spread into that list to be served.
    for (const match of text.matchAll(/method: '([A-Z]+)',\s*\n\s*path: '([^']+)'/g)) {
      found.push(`${match[1]} ${match[2]}`)
    }
  }

  // The positive control, and it is not decoration: a reader that matched nothing would otherwise
  // pass this test by finding no routes at all, which is the "search of an empty room" failure the
  // preload test above names.
  assert.ok(
    found.includes('POST /api/projects/:id/files'),
    'the route reader found no upload route, so it found nothing',
  )
  assert.deepEqual(found.sort(), SERVER_ROUTES)

  // And the table that decides which of them are served. A ninth route module would have to be
  // spread in here, which the regex above would only see if it also used the same literal shape.
  const index = readFileSync(join(routesDir, 'index.ts'), 'utf8')
  assert.deepEqual(
    [...index.matchAll(/\.\.\.(\w+),/g)].map((match) => match[1]),
    [
      'capabilityRoutes',
      'authRoutes',
      'accountRoutes',
      'userRoutes',
      'projectRoutes',
      'fileRoutes',
      'importRoutes',
    ],
  )
})

test('subsystem E added no module to packages/core, and neither package names it', () => {
  assert.deepEqual(relativeNames(join(REPO_ROOT, 'packages/core/src')), CORE_MODULES)
  assert.deepEqual(relativeNames(join(REPO_ROOT, 'packages/server/test')), SERVER_TESTS)

  const offenders: string[] = []
  let sawUploadFile = false
  const roots = [
    join(REPO_ROOT, 'packages/core/src'),
    join(REPO_ROOT, 'packages/server/src'),
    join(REPO_ROOT, 'packages/server/test'),
  ]
  for (const root of roots) {
    for (const file of typescriptFilesUnder(root)) {
      const text = readFileSync(file, 'utf8')
      // The positive control again, and this one is the point rather than the instrument's alibi:
      // `uploadFile` is the core function a landing calls, and it is there, unchanged, called by
      // the server's own upload route. E lands *through* it and adds nothing beside it.
      if (text.includes('export async function uploadFile')) sawUploadFile = true
      for (const name of BROWSER_NAMES) {
        if (text.includes(name)) offenders.push(`${relative(REPO_ROOT, file)}: ${name}`)
      }
    }
  }

  assert.equal(sawUploadFile, true, 'the walk never read the core function a landing uploads with')
  assert.deepEqual(
    offenders,
    [],
    'the model browser lives in packages/desktop; core and the server know nothing about it',
  )
})
