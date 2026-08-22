# Slicer Project Manager — Subsystem A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build subsystem A of Slicer Project Manager — the runtime-agnostic core (SQLite, auth, projects, files), the Deno HTTP server, and the Angular web client — so a multi-user browser build can browse, tag, and manage a library of 3D-printing project folders.

**Architecture:** All behaviour lives in `packages/core`, written against Web-standard and `node:` APIs only, so the identical code runs under Deno (HTTP server) and under Node (Electron main process, subsystem C). `packages/contract` holds the DTOs, Zod schemas, and the single `ApiClient` interface that both transports implement and the Angular app codes against. The Deno server is a thin adapter: cookie sessions in, `Ctx` to `core`, DTOs decorated with `/api/...` URLs out. Ownership and admin checks are enforced inside `core`, never in a transport.

**Tech Stack:** pnpm workspace · TypeScript strict · `node:sqlite` · Web Crypto (PBKDF2) · Deno (`Deno.serve`, `URLPattern`) · Angular 22 (zoneless, signals, signal forms) · Zod 4 (Standard Schema) · `@awdlab/jig` + `@awdlab/jig-themes` · `@ngneers/signal-translate` · `node:test` (core, dual-runtime) · Vitest (web) · Playwright (e2e) · GitHub Actions

**Spec:** [`docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md)

---

## Scope

The spec covers five subsystems (§1.1). **This plan implements subsystem A only**, plus the
seams the later specs plug into:

| Subsystem                        | In this plan?                                                                                                                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** core + server + web client | **Yes, in full**                                                                                                                                                                                                                                                            |
| **B** previews                   | Seam only: `previews` table, state machine, bounded queue, `thumbUrl` in DTOs, **and** the embedded-thumbnail extraction path, which §7.1 says lands first because it covers essentially every slicer project file. The mesh rasterizer and the three.js viewer are spec B. |
| **C** Electron shell             | No. `packages/desktop` is **not created**. `ApiClient`, the capability model, and `core`'s dual-runtime test suite are the seams.                                                                                                                                           |
| **D** slicers                    | No. Seam: `files.slicer`, populated by the §3.4 detector.                                                                                                                                                                                                                   |
| **E** model browser              | No. Seam: `projects.website`, `files.upload`.                                                                                                                                                                                                                               |

Do not start `packages/desktop` from this plan. If a task tempts you toward Electron, IPC,
slicer launching, or a mesh rasterizer, stop — that is a later spec.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Runtime floors:** Node **>= 24.4** (stable `node:sqlite`, native TS type-stripping), Deno **>= 2.5**, pnpm **>= 10**.
- **`core` and `contract` have zero runtime dependencies.** Web-standard globals and `node:*` builtins only (§2.2). Zod is a `contract` dependency and is the sole exception; `core` must never import Zod.
- **`core` must run unmodified on Deno and on Node.** Its test suite runs under both in CI — the design's central bet (§8.1). No `process.*`, no `Deno.*`, no npm packages inside `core/src`.
- **Ownership and authorisation are enforced inside `core`, never in a transport** (§2.2). Every project/file/tag query is scoped by `ctx.userId`; there is no unscoped variant for a transport to call by mistake. `users.*` checks `ctx.isAdmin` in `core`.
- **Raw tokens are never persisted** (§3.3). Only `sha256(raw)` reaches the database — sessions and activation tokens alike.
- **No default password exists anywhere** — not in code, not in config, not in docs (§5.4).
- **One environment variable: `SPM_LIBRARY_DIR`** (§3.1), plus optional `SPM_PORT` (default `8000`) — see Decision 2.
- **SQLite uses default settings** (§3.1) except `PRAGMA foreign_keys = ON`, a per-connection pragma the schema's `ON DELETE CASCADE` requires (Decision 6).
- **PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte salt, 32-byte key**, parameters stored per user (§5.1).
- **Scans skip dot-folders at every level** (§3.1, §3.5), so `.spm/` is never adopted as a project.
- **3MF detection is first-match-wins, and `OrcaSlicer-Version` must be tested before `X-BBL-Client-Type`** (§3.4). Match on header-item **keys**, never version values. Unknown -> `slicer = null`, never a guess.
- **TypeScript:** `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`. Relative imports inside `core`/`contract` carry the **`.ts` extension** — both Deno and Node type-stripping require it.
- **Angular 22:** `provideZonelessChangeDetection()`, standalone components, no NgModules, signal stores, `resource()` for async reads (§6.1).
- **Commits:** Conventional Commits, matching existing history (`docs:`, `feat:`, `test:`, `chore:`).
- **Never log a raw token, a password, or a session cookie value.**

---

## Decisions this plan makes where the spec is silent

Recorded here so an executor need not re-derive them, and a reviewer can challenge them as a
set rather than one task at a time.

1. **`settings` is added to `ApiClient`.** §6.3/§6.4 require a runtime language switch and a persisted theme in `user_settings`, but §4.1 has no endpoint for it. Added: `settings.get()` / `settings.put(patch)`, and `GET`/`PUT /api/account/settings`.
2. **The activation URL base is derived from the request, not configured.** `core` returns the raw token; the server builds `${origin}/activate#${token}` from the request's own origin. Keeps §3.1's "one environment variable" true. `SPM_PORT` is the single addition, optional.
3. **Embedded thumbnails are stored verbatim, not downscaled.** §7.1 says "extract, downscale", but downscaling needs a PNG decoder _and_ encoder, and §7.2 puts the encoder in the rasterizer, which is spec B. Every measured embedded thumbnail is 256–512 px and 3.6–18.8 KB, so storing as-is is correct now; B adds a resize pass. `previews.width`/`height` record real dimensions and no DTO promises a fixed size.
4. **Model files keep `previewState: 'pending'` in subsystem A.** The queue selects only rows it has a handler for, so `.stl`/`.obj`/plain-mesh `.3mf` stay `pending` (the UI shows a placeholder) rather than being wrongly marked `unsupported`. Spec B registers the rasterizer handler and they drain with no migration.
5. **Sessions live 30 days, sliding** — `expires_at = now + 30d`, pushed forward when a session is used more than a day after it was last extended. §5.2 fixes the token shape but not the lifetime.
6. **`PRAGMA foreign_keys = ON`** on every connection open.
7. **Upload carries its filename in an `X-Spm-File-Name` header (URL-encoded) with a required `Content-Length`.** The body is the raw stream — bulk bytes never enter a JSON envelope (§4.2) — and the quota check needs the size _before_ writing (§5.6).
8. **Password policy: 10–200 characters, no composition rules.** The spec fixes the hashing but not the policy. Long-and-simple beats short-and-gnarly, and 600k PBKDF2 iterations carry the rest.
9. **A `tags` filter is AND, not OR.** A project must carry every tag listed; filtering is for narrowing.
10. **The cover thumbnail falls back to a slicer-project preview.** §4.2 says the cover is the first _model_ file whose preview is ready, but model previews stay `pending` until spec B, so a strict reading leaves every grid tile blank. The query prefers a ready model preview and falls back to a ready slicer-project thumbnail.
11. **Transports may call `core` functions outside `ApiClient`.** `ApiClient` is the _client-facing_ surface. Streaming raw bytes needs an absolute path, so `core` also exports `resolveFilePath(ctx, id)` and `resolvePreviewPath(ctx, fileId)`, used by the server now and by Electron's `spm://` handler later. Both are still `ctx`-scoped.

---

## File Structure

```
pnpm-workspace.yaml
package.json                          root scripts only
tsconfig.base.json                    strict + erasableSyntaxOnly, shared by all packages
deno.json                             one import map for the core tests and the server
eslint.config.js  .prettierrc.json  .gitignore
.github/workflows/ci.yml

packages/contract/                    types + schemas + ApiClient. Zod only.
  src/index.ts                        barrel
  src/dtos.ts                         Capabilities, UserDto, ProjectDto, FileDto, ...
  src/errors.ts                       AppError + typed codes (incl. QuotaExceeded)
  src/schemas.ts                      Zod schemas shared by form and backend
  src/api-client.ts                   the ApiClient interface
  test/schemas.test.ts

packages/core/                        all behaviour. node: + Web APIs only.
  src/index.ts                        barrel: the use-case surface transports call
  src/ctx.ts                          Ctx
  src/db/open.ts                      openDb(libraryDir) -> Db
  src/db/migrate.ts                   user_version-driven runner
  src/db/migrations/001_init.sql      the whole §3.3 schema
  src/db/ids.ts                       newId()
  src/auth/password.ts                pbkdf2 derive / verify / needsRehash
  src/auth/tokens.ts                  randomToken, sha256Bytes, timingSafeEqual
  src/auth/sessions.ts                create / resolve / delete / prune
  src/auth/activation.ts              issue / check / consume
  src/auth/login.ts                   login use case (+ hash upgrade)
  src/users/repo.ts                   row <-> UserDto mapping
  src/users/account.ts                me, changePassword, updateProfile, settings
  src/users/admin.ts                  list/create/reissue/update/delete + last-admin guard
  src/users/bootstrap.ts              first-run admin, local-mode single user
  src/users/usage.ts                  derived disk usage + quota assertion
  src/files/paths.ts                  library layout, safeJoin
  src/files/zip.ts                    central-directory reader + entry inflate
  src/files/classify.ts               §3.4 detector + slicer registry
  src/files/hash.ts                   streaming sha256 of a file
  src/files/usecases.ts               upload / rename / delete / resolveFilePath
  src/projects/queries.ts             list + get, DTO assembly
  src/projects/usecases.ts            create / update / delete / tags
  src/projects/rescan.ts              §3.5 reconciliation
  src/projects/import-curamanager.ts  metadata.json sidecar reader
  src/previews/png.ts                 IHDR size reader
  src/previews/embedded.ts            embedded-thumbnail extractor
  src/previews/queue.ts               bounded-concurrency queue + state machine
  test/harness.ts                     Deno.test / node:test shim
  test/tmp-library.ts                 temp library + seeded db helper
  test/fixtures/make-3mf.ts           builds synthetic slicer 3MFs
  test/fixtures/make-png.ts           builds valid PNGs for the preview tests
  test/*.test.ts

packages/server/                      Deno adapter. Thin. (Uses the root deno.json.)
  main.ts                             entry: env, db, bootstrap, Deno.serve
  src/router.ts                       URLPattern route table
  src/session.ts                      cookie <-> Ctx
  src/decorate.ts                     DTO URL decoration
  src/errors.ts                       AppError -> Response
  src/static.ts                       serves the web bundle
  src/routes/{capabilities,auth,account,users,projects,files}.ts
  test/*.test.ts                      integration over HTTP

packages/web/                         Angular 22
  angular.json  package.json  tsconfig.app.json
  src/app/app.ts  app.config.ts
  src/app/core/api/{api-client.token.ts,http-api-client.ts}
  src/app/core/{capabilities.store.ts,auth.store.ts,guards.ts}
  src/app/core/i18n/{translate.service.ts,locales/en.json,locales/de.json}
  src/app/routes.ts                   web routes
  src/app/routes.electron.ts          + desktop routes, swapped by fileReplacements
  src/app/features/auth/{login.page.ts,activate.page.ts}
  src/app/features/projects/{projects.page.ts,project-detail.page.ts,projects.store.ts}
  src/app/features/settings/settings.page.ts
  src/app/features/admin/users.page.ts
  src/app/features/desktop/.gitkeep   spec C/D/E land here; excluded from the web build
  e2e/smoke.spec.ts
```

`core/src/index.ts` is the only entry a transport imports. Files that change together live
together: each `core` subdirectory owns one table cluster and its use cases.

## Task order

Tasks 1–12 build `core` bottom-up; 13–16 wrap it in HTTP; 17–22 build the client; 23 closes
CI. Each task ends green and committed.

| #   | Task                                                                    |
| --- | ----------------------------------------------------------------------- |
| 1   | Workspace scaffolding and the dual-runtime smoke test                   |
| 2   | `contract`: DTOs, errors, Zod schemas, `ApiClient`                      |
| 3   | `core/db`: migration runner and the §3.3 schema                         |
| 4   | `core/auth`: passwords, tokens, sessions, activation                    |
| 5   | `core`: library paths, bootstrap, login, account self-service, settings |
| 6   | `core/users`: admin management, last-admin guard, usage                 |
| 7   | `core/files`: zip reader, §3.4 classification, content hashing          |
| 8   | `core/projects`: CRUD, tags, list query                                 |
| 9   | `core/projects`: rescan / reconciliation (§3.5)                         |
| 10  | `core/files`: upload, rename, delete, quota enforcement (§5.6)          |
| 11  | `core/previews`: embedded extraction and the queue                      |
| 12  | `core`: CuraManager `metadata.json` importer (§3.6)                     |
| 13  | `server`: foundation, capabilities, cookie sessions, auth routes        |
| 14  | `server`: account and admin user routes                                 |
| 15  | `server`: project, tag, and rescan routes                               |
| 16  | `server`: file routes and byte streaming                                |
| 17  | `web`: Angular scaffold, transport, capabilities, two build targets     |
| 18  | `web`: i18n and the settings page                                       |
| 19  | `web`: login and activation pages                                       |
| 20  | `web`: project list                                                     |
| 21  | `web`: project detail                                                   |
| 22  | `web`: admin users page                                                 |
| 23  | CI: full pipeline and e2e smoke                                         |

---

### Task 1: Workspace scaffolding and the dual-runtime smoke test

The first task proves the design's central bet (§2.2) before a single line of behaviour is
written: `node:sqlite` and Web Crypto PBKDF2 both work, under Node **and** under Deno, from
one source file. If this task cannot go green, stop and report — nothing later is salvageable.

**Files:**

- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `deno.json`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `.github/workflows/ci.yml`
- Test: `packages/core/test/harness.ts`, `packages/core/test/runtime.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `test(name, fn)` and `assert` from `packages/core/test/harness.ts` — every `core` test file in Tasks 3–12 imports exactly these two. Root scripts `pnpm test:core:node`, `pnpm test:core:deno`, `pnpm verify`.

- [ ] **Step 1: Gate on the toolchain floors**

```bash
node -v && deno -v && pnpm -v
```

Expected: Node >= 24.4.0, Deno >= 2.5.0, pnpm >= 10. If any is lower, install the newer
version before continuing — do not downgrade the plan to fit an old runtime. Node < 24 lacks
unflagged `node:sqlite` and native TypeScript type-stripping; Deno < 2.2 lacks `node:sqlite`
entirely.

- [ ] **Step 2: Create the workspace files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
```

`package.json`:

```json
{
  "name": "slicer-project-manager",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.4.0", "pnpm": ">=10" },
  "scripts": {
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test:contract": "node --test \"packages/contract/test/**/*.test.ts\"",
    "test:core:node": "node --test \"packages/core/test/**/*.test.ts\"",
    "test:core:deno": "deno test --allow-read --allow-write --allow-env packages/core/test/",
    "test:server": "deno test --allow-all packages/server/test/",
    "test:web": "pnpm --filter @spm/web test",
    "verify": "pnpm lint && pnpm format:check && pnpm test:contract && pnpm test:core:node && pnpm test:core:deno"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "eslint": "^9.34.0",
    "prettier": "^3.6.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.40.0"
  }
}
```

`tsconfig.base.json` — `erasableSyntaxOnly` is what keeps Node's type-stripping working, so
**no `enum`, no `namespace`, and no constructor parameter properties anywhere**:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@spm/contract": ["packages/contract/src/index.ts"],
      "@spm/contract/*": ["packages/contract/src/*"],
      "@spm/core": ["packages/core/src/index.ts"]
    }
  }
}
```

`deno.json` at the repo root — one import map serves the `core` tests and the server, because
Deno resolves every module against the nearest root config. Subpaths are listed explicitly:
Deno import maps do not read Node `exports` maps.

```json
{
  "imports": {
    "@spm/contract": "./packages/contract/src/index.ts",
    "@spm/contract/errors.ts": "./packages/contract/src/errors.ts",
    "@spm/contract/dtos.ts": "./packages/contract/src/dtos.ts",
    "@spm/contract/schemas.ts": "./packages/contract/src/schemas.ts",
    "@spm/core": "./packages/core/src/index.ts",
    "zod": "npm:zod@^4.0.0"
  },
  "nodeModulesDir": "auto",
  "fmt": { "exclude": ["**"] },
  "lint": { "exclude": ["**"] }
}
```

Note the `.ts` suffix in the subpath keys. Every cross-package import in this plan is written
as `@spm/contract/errors.ts`, which resolves under Deno via the map above and under Node via
the `exports` map added in Task 2. Deno's own `fmt`/`lint` are switched off; Prettier and
ESLint own that job for the whole repo.

`packages/core/package.json`:

```json
{
  "name": "@spm/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@spm/contract": "workspace:*" }
}
```

`packages/core/tsconfig.json` (the same shape in every package):

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`eslint.config.js`:

```js
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.angular/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
```

`.prettierrc.json`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

`.gitignore`:

```
node_modules/
dist/
.angular/
coverage/
*.tsbuildinfo
.spm/
test-tmp/
```

Then install:

```bash
pnpm install
```

- [ ] **Step 3: Write the cross-runtime test harness**

`packages/core/test/harness.ts` — the one place that knows which runtime it is on. Deno's
resource and op sanitizers are off because SQLite handles and temp directories are opened and
closed inside test bodies and would otherwise produce spurious failures.

```ts
import assert from 'node:assert/strict'

export type TestBody = () => void | Promise<void>
export type TestFn = (name: string, body: TestBody) => void

type DenoTestOptions = {
  name: string
  fn: TestBody
  sanitizeResources: boolean
  sanitizeOps: boolean
}
type DenoGlobal = { test: (options: DenoTestOptions) => void }

const deno = (globalThis as { Deno?: DenoGlobal }).Deno

export const test: TestFn = deno
  ? (name, body) => deno.test({ name, fn: body, sanitizeResources: false, sanitizeOps: false })
  : ((await import('node:test')).test as unknown as TestFn)

export { assert }
```

- [ ] **Step 4: Write the failing smoke test**

`packages/core/test/runtime.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { assert, test } from './harness.ts'

test('node:sqlite is present and round-trips a BLOB', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, payload BLOB NOT NULL)')
  db.prepare('INSERT INTO t (id, payload) VALUES (?, ?)').run('a', new Uint8Array([1, 2, 3]))
  const row = db.prepare('SELECT payload FROM t WHERE id = ?').get('a') as { payload: Uint8Array }
  assert.deepEqual([...row.payload], [1, 2, 3])
  db.close()
})

test('node:sqlite enforces foreign keys once the pragma is on', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)')
  db.exec(
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE)',
  )
  assert.throws(() => db.prepare('INSERT INTO child VALUES (?, ?)').run('c', 'nope'))
  db.close()
})

test('crypto.subtle derives a 32-byte PBKDF2-SHA256 key', async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('correct horse'),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 1000, hash: 'SHA-256' },
    key,
    256,
  )
  assert.equal(new Uint8Array(bits).byteLength, 32)
})
```

- [ ] **Step 5: Run it on Node**

```bash
pnpm test:core:node
```

Expected: 3 passing. If Node reports `node:sqlite` as unavailable, re-run with
`node --experimental-sqlite --test ...` and add that flag to the script — some 24.x builds
still gate it. A TypeScript syntax error here means the file used non-erasable syntax.

- [ ] **Step 6: Run the same file on Deno**

```bash
pnpm test:core:deno
```

Expected: the same 3 passing, from the identical source file. If Deno cannot resolve
`node:sqlite`, upgrade Deno — do not shim it and do not branch on the runtime. The whole
architecture rests on one SQLite binding serving both.

- [ ] **Step 7: Lint and format**

```bash
pnpm lint && pnpm format:check
```

Expected: clean. Run `pnpm format` first if Prettier reports differences.

- [ ] **Step 8: Add the CI workflow**

`.github/workflows/ci.yml` — Tasks 13, 17, and 23 add jobs to this file:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check

  core-node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:core:node

  core-deno:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: pnpm }
      - uses: denoland/setup-deno@v2
        with: { deno-version: v2.x }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:core:deno
```

`core-node` and `core-deno` are deliberately two jobs rather than a matrix step: when the core
stops being runtime-agnostic, the failing job names the runtime that broke.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace, dual-runtime core test harness, CI skeleton"
```

---

### Task 2: `contract` — DTOs, errors, Zod schemas, `ApiClient`

One definition of every payload, validated identically in the Angular form and on the backend
(§2.3). This is the package the whole rest of the plan imports types from, so its names are
load-bearing — later tasks reference these exact identifiers.

**Files:**

- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`
- Create: `packages/contract/src/dtos.ts`, `src/errors.ts`, `src/schemas.ts`, `src/api-client.ts`, `src/index.ts`
- Test: `packages/contract/test/schemas.test.ts`

**Interfaces:**

- Consumes: the workspace and root scripts from Task 1.
- Produces: everything below. `core` imports `AppError` from `@spm/contract/errors.ts` and DTO types from `@spm/contract/dtos.ts`; it must never import `schemas.ts` or the barrel, so Zod stays out of `core`'s runtime graph.

**Password policy** (spec is silent): 10–200 characters, no composition rules. Long-and-simple
beats short-and-gnarly, and PBKDF2 at 600k iterations carries the rest.

- [ ] **Step 1: Create the package**

`packages/contract/package.json` — the `exports` subpaths are what make
`@spm/contract/errors.ts` resolve under Node:

```json
{
  "name": "@spm/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./errors.ts": "./src/errors.ts",
    "./dtos.ts": "./src/dtos.ts",
    "./schemas.ts": "./src/schemas.ts"
  },
  "dependencies": { "zod": "^4.0.0" }
}
```

`packages/contract/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
pnpm install
```

- [ ] **Step 2: Write the DTOs**

`packages/contract/src/dtos.ts` — §4.2 verbatim, plus `SettingsDto` (Decision 1):

```ts
export type Capabilities = {
  requiresAuth: boolean
  canManageUsers: boolean
  canPickLocalFolder: boolean
  canLaunchSlicer: boolean
  canConfigureSlicers: boolean
  canBrowseModelSites: boolean
}

export type UserStatus = 'pending' | 'active' | 'disabled'

export type UserDto = {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  status: UserStatus
  diskUsageBytes: number
  quotaBytes: number | null
  createdAt: number
  activatedAt?: number
}

export type FileKind = 'model' | 'slicer_project' | 'other'
export type SlicerId = 'cura' | 'prusaslicer' | 'anycubic' | 'bambu' | 'orca'
export type PreviewState = 'pending' | 'ready' | 'failed' | 'unsupported'

export type FileDto = {
  id: string
  name: string
  kind: FileKind
  slicer?: SlicerId
  sizeBytes: number
  previewState: PreviewState
  thumbUrl?: string
  rawUrl: string
}

export type ProjectDto = {
  id: string
  name: string
  website?: string
  notes?: string
  isArchived: boolean
  state: 'ok' | 'missing'
  tags: string[]
  fileCounts: { model: number; slicerProject: number; other: number }
  coverThumbUrl?: string
  createdAt: number
  updatedAt: number
}

export type ProjectDetailDto = ProjectDto & { files: FileDto[] }

export type ProjectQuery = {
  search?: string
  tags?: string[]
  includeArchived?: boolean
  sort?: 'name' | 'createdAt' | 'updatedAt'
  dir?: 'asc' | 'desc'
}

export type RescanResultDto = {
  adopted: number
  markedMissing: number
  filesAdded: number
  filesRemoved: number
  previewsQueued: number
}

export type SettingsDto = {
  theme: 'light' | 'dark' | 'system'
  language: 'en' | 'de'
  viewMode: 'grid' | 'list'
  sort: 'name' | 'createdAt' | 'updatedAt'
  dir: 'asc' | 'desc'
}

export const DEFAULT_SETTINGS: SettingsDto = {
  theme: 'system',
  language: 'en',
  viewMode: 'grid',
  sort: 'updatedAt',
  dir: 'desc',
}

/**
 * What core returns: IDs, never URLs (spec 4.2). Only a transport knows its own scheme, so
 * it decorates these into the DTOs above — /api/files/:id/thumb over HTTP,
 * spm://file/:id/thumb in Electron.
 */
export type CoreFileDto = Omit<FileDto, 'thumbUrl' | 'rawUrl'>
export type CoreProjectDto = Omit<ProjectDto, 'coverThumbUrl'> & { coverFileId?: string }
export type CoreProjectDetailDto = CoreProjectDto & { files: CoreFileDto[] }
```

- [ ] **Step 3: Write the error type**

`packages/contract/src/errors.ts`. Note the explicit field declarations: constructor parameter
properties are banned by `erasableSyntaxOnly`.

```ts
export type AppErrorCode =
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'Conflict'
  | 'Validation'
  | 'QuotaExceeded'
  | 'LengthRequired'
  | 'InvalidToken'
  | 'TokenExpired'
  | 'LastActiveAdmin'
  | 'Internal'

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export type QuotaExceededDetails = {
  usageBytes: number
  quotaBytes: number
  incomingBytes: number
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
```

- [ ] **Step 4: Write the Zod schemas**

`packages/contract/src/schemas.ts`:

```ts
import { z } from 'zod'

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters, digits, dot, dash and underscore only')

export const passwordSchema = z.string().min(10).max(200)

export const displayNameSchema = z.string().min(1).max(100)

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const activateSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    message: 'passwords do not match',
    path: ['confirm'],
  })

export const changePasswordSchema = z.object({
  current: z.string().min(1),
  next: passwordSchema,
})

export const profilePatchSchema = z.object({ displayName: displayNameSchema.optional() })

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  isAdmin: z.boolean().default(false),
  quotaBytes: z.number().int().positive().nullable().default(null),
})

export const updateUserSchema = z.object({
  isAdmin: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  quotaBytes: z.number().int().positive().nullable().optional(),
})

export const tagNameSchema = z.string().trim().min(1).max(60)

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().url().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  tags: z.array(tagNameSchema).optional(),
})

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  website: z.string().url().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  isArchived: z.boolean().optional(),
})

// Rejects path separators, the Windows-reserved set, and traversal.
export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // Spaces are legal in a file name; path separators and the Windows-reserved set are not.
  .regex(/^[^"*/:<>?\\|]+$/, 'invalid characters in file name')
  .refine((v) => !v.includes(String.fromCharCode(0)), 'file name must not contain a null byte')
  .refine(
    (v) => v !== '.' && v !== '..' && !v.startsWith('.'),
    'file name must not start with a dot',
  )

export const settingsPatchSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  language: z.enum(['en', 'de']).optional(),
  viewMode: z.enum(['grid', 'list']).optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
})

export const projectQuerySchema = z.object({
  search: z.string().max(200).optional(),
  tags: z.array(tagNameSchema).optional(),
  includeArchived: z.boolean().optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
})

export type LoginInput = z.infer<typeof loginSchema>
export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
export type CreateProjectInput = z.infer<typeof createProjectSchema>
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>
```

- [ ] **Step 5: Write the `ApiClient` interface**

`packages/contract/src/api-client.ts` — §4.1, with `settings` added (Decision 1) and `upload`
carrying an explicit `sizeBytes` so the quota check can run before any bytes are written
(Decision 7):

```ts
import type {
  Capabilities,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RescanResultDto,
  SettingsDto,
  UserDto,
} from './dtos.ts'
import type {
  CreateProjectInput,
  CreateUserInput,
  ProjectPatchInput,
  SettingsPatchInput,
  UpdateUserInput,
} from './schemas.ts'

export type UploadBody = { stream: ReadableStream<Uint8Array>; sizeBytes: number }

export interface ApiClient {
  capabilities(): Promise<Capabilities>

  auth: {
    login(username: string, password: string): Promise<UserDto>
    logout(): Promise<void>
    checkToken(token: string): Promise<{ valid: boolean; username?: string }>
    activate(token: string, newPassword: string): Promise<UserDto>
  }

  account: {
    me(): Promise<UserDto>
    changePassword(current: string, next: string): Promise<void>
    updateProfile(patch: { displayName?: string }): Promise<UserDto>
  }

  settings: {
    get(): Promise<SettingsDto>
    put(patch: SettingsPatchInput): Promise<SettingsDto>
  }

  users: {
    list(): Promise<UserDto[]>
    create(dto: CreateUserInput): Promise<{ user: UserDto; activationUrl: string }>
    reissueInvite(id: string): Promise<{ activationUrl: string }>
    update(id: string, patch: UpdateUserInput): Promise<UserDto>
    delete(id: string): Promise<void>
  }

  projects: {
    list(query: ProjectQuery): Promise<ProjectDto[]>
    get(id: string): Promise<ProjectDetailDto>
    create(dto: CreateProjectInput): Promise<ProjectDto>
    update(id: string, patch: ProjectPatchInput): Promise<ProjectDto>
    delete(id: string, opts: { deleteFiles: boolean }): Promise<void>
    addTag(id: string, name: string): Promise<void>
    removeTag(id: string, name: string): Promise<void>
    rescan(): Promise<RescanResultDto>
  }

  files: {
    upload(projectId: string, name: string, body: UploadBody): Promise<FileDto>
    rename(id: string, name: string): Promise<FileDto>
    delete(id: string): Promise<void>
  }
}
```

`packages/contract/src/index.ts`:

```ts
export * from './dtos.ts'
export * from './errors.ts'
export * from './schemas.ts'
export * from './api-client.ts'
```

- [ ] **Step 6: Write the failing schema tests**

`packages/contract/test/schemas.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateSchema,
  createUserSchema,
  fileNameSchema,
  projectPatchSchema,
  usernameSchema,
} from '../src/schemas.ts'

test('usernameSchema rejects a leading dash and accepts dots', () => {
  assert.equal(usernameSchema.safeParse('-nope').success, false)
  assert.equal(usernameSchema.safeParse('marc.schmidt').success, true)
})

test('activateSchema requires the confirmation to match', () => {
  const bad = activateSchema.safeParse({ password: 'longenoughpw', confirm: 'other' })
  assert.equal(bad.success, false)
  assert.deepEqual(bad.error?.issues[0]?.path, ['confirm'])
  assert.equal(
    activateSchema.safeParse({ password: 'longenoughpw', confirm: 'longenoughpw' }).success,
    true,
  )
})

test('activateSchema enforces the 10 character floor', () => {
  assert.equal(activateSchema.safeParse({ password: 'short', confirm: 'short' }).success, false)
})

test('createUserSchema defaults isAdmin to false and quota to unlimited', () => {
  const parsed = createUserSchema.parse({ username: 'anna', displayName: 'Anna' })
  assert.equal(parsed.isAdmin, false)
  assert.equal(parsed.quotaBytes, null)
})

test('fileNameSchema rejects separators, traversal and dotfiles', () => {
  for (const bad of ['../evil.stl', 'a/b.stl', 'a\\b.stl', '..', '.hidden']) {
    assert.equal(fileNameSchema.safeParse(bad).success, false, bad)
  }
  assert.equal(fileNameSchema.safeParse('benchy.stl').success, true)
})

test('projectPatchSchema allows clearing website with null but not with a bad url', () => {
  assert.equal(projectPatchSchema.safeParse({ website: null }).success, true)
  assert.equal(projectPatchSchema.safeParse({ website: 'not a url' }).success, false)
})
```

- [ ] **Step 7: Run the tests to verify they fail**

```bash
pnpm test:contract
```

Expected: FAIL — `Cannot find module '../src/schemas.ts'` if Step 4 was skipped. If Steps 2–5
are already written, the tests pass on the first run; that is acceptable here because the
schemas _are_ the specification and there is no behaviour to drive out. Reverse the order for
every behavioural task from Task 3 on.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm test:contract && pnpm lint
```

Expected: 6 passing, lint clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(contract): DTOs, typed errors, shared Zod schemas and ApiClient"
```

---

### Task 3: `core/db` — migration runner and the §3.3 schema

**Files:**

- Create: `packages/core/src/ctx.ts`, `src/db/ids.ts`, `src/db/migrate.ts`, `src/db/open.ts`, `src/db/migrations/001_init.sql`
- Test: `packages/core/test/tmp-library.ts`, `packages/core/test/db.test.ts`

**Interfaces:**

- Consumes: the harness from Task 1.
- Produces:
  - `type Ctx = { userId: string; isAdmin: boolean }` from `src/ctx.ts`
  - `type Db = DatabaseSync`, `type Library = { dir: string; db: Db }`, `openLibrary(libraryDir: string): Library`, `closeLibrary(lib: Library): void` from `src/db/open.ts`
  - `runMigrations(db: Db): number` from `src/db/migrate.ts`
  - `newId(): string` from `src/db/ids.ts`
  - `withLibrary(run: (lib: Library) => void | Promise<void>): Promise<void>` from `test/tmp-library.ts` — every later `core` test wraps its body in this.

- [ ] **Step 1: Write the failing test**

`packages/core/test/tmp-library.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, openLibrary, type Library } from '../src/db/open.ts'

export async function withLibrary(run: (lib: Library) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-test-'))
  const lib = openLibrary(dir)
  try {
    await run(lib)
  } finally {
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
}
```

`packages/core/test/db.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '../src/db/ids.ts'
import { runMigrations } from '../src/db/migrate.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

const TABLES = [
  'users',
  'activation_tokens',
  'sessions',
  'projects',
  'tags',
  'project_tags',
  'files',
  'previews',
  'user_settings',
]

test('openLibrary creates .spm/app.db and .spm/previews', async () => {
  await withLibrary((lib) => {
    assert.ok(existsSync(join(lib.dir, '.spm', 'app.db')))
    assert.ok(existsSync(join(lib.dir, '.spm', 'previews')))
  })
})

test('migrations create every table and set user_version', async () => {
  await withLibrary((lib) => {
    const names = lib.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`)
    const { user_version } = lib.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    assert.equal(user_version, 1)
  })
})

test('runMigrations is idempotent', async () => {
  await withLibrary((lib) => {
    assert.equal(runMigrations(lib.db), 1)
    assert.equal(runMigrations(lib.db), 1)
  })
})

test('usernames are unique case-insensitively', async () => {
  await withLibrary((lib) => {
    const insert = lib.db.prepare(
      "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', 0)",
    )
    insert.run(newId(), 'Marc', 'Marc', 'marc')
    assert.throws(() => insert.run(newId(), 'marc', 'Marc again', 'marc2'))
  })
})

test('deleting a user cascades to projects, files and previews', async () => {
  await withLibrary((lib) => {
    const userId = newId()
    const projectId = newId()
    const fileId = newId()
    lib.db
      .prepare(
        "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, 'marc', 'Marc', 'marc', 0, 'active', 0)",
      )
      .run(userId)
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run(projectId, userId, 'Benchy', 'Benchy')
    lib.db
      .prepare(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES (?, ?, 'benchy.stl', 'model', 10, 0)",
      )
      .run(fileId, projectId)
    lib.db
      .prepare("INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', 0)")
      .run(fileId)

    lib.db.prepare('DELETE FROM users WHERE id = ?').run(userId)

    for (const table of ['projects', 'files', 'previews']) {
      const { n } = lib.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      assert.equal(n, 0, `${table} was not cascaded`)
    }
  })
})

test('a project folder name is unique per owner', async () => {
  await withLibrary((lib) => {
    const userId = newId()
    lib.db
      .prepare(
        "INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, 'marc', 'Marc', 'marc', 0, 'active', 0)",
      )
      .run(userId)
    const insert = lib.db.prepare(
      'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
    )
    insert.run(newId(), userId, 'Benchy', 'Benchy')
    assert.throws(() => insert.run(newId(), userId, 'Benchy again', 'Benchy'))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/db/open.ts'`.

- [ ] **Step 3: Write the migration SQL**

`packages/core/src/db/migrations/001_init.sql` — §3.3, with the indexes §3.8's `LIKE`-based
search needs:

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  library_dir   TEXT NOT NULL UNIQUE,
  pw_hash       BLOB,
  pw_salt       BLOB,
  pw_iterations INTEGER,
  pw_algo       TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  quota_bytes   INTEGER,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER
);

CREATE TABLE activation_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activation_tokens_user ON activation_tokens(user_id);
CREATE UNIQUE INDEX idx_activation_tokens_hash ON activation_tokens(token_hash);

CREATE TABLE sessions (
  token_hash   BLOB PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  dir_name    TEXT NOT NULL,
  website     TEXT,
  notes       TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'missing')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (owner_id, dir_name)
);
CREATE INDEX idx_projects_owner ON projects(owner_id, is_archived);
CREATE INDEX idx_projects_name ON projects(owner_id, name COLLATE NOCASE);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (owner_id, name COLLATE NOCASE)
);

CREATE TABLE project_tags (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);
CREATE INDEX idx_project_tags_tag ON project_tags(tag_id);

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('model', 'slicer_project', 'other')),
  slicer       TEXT,
  size_bytes   INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  content_hash BLOB,
  UNIQUE (project_id, rel_path)
);
CREATE INDEX idx_files_project ON files(project_id);

CREATE TABLE previews (
  file_id     TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'unsupported')),
  source      TEXT,
  png_path    TEXT,
  width       INTEGER,
  height      INTEGER,
  source_hash BLOB,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_previews_state ON previews(state);

CREATE TABLE user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
```

`CHECK` constraints on `status`, `state`, `kind`, and preview `state` are additions to the
spec's column list: the spec names the legal values, and the database is the cheapest place to
stop a typo from persisting an illegal one.

- [ ] **Step 4: Write the migration runner**

`packages/core/src/db/migrate.ts`:

```ts
import { readFileSync } from 'node:fs'
import type { Db } from './open.ts'

const MIGRATIONS: ReadonlyArray<{ version: number; file: string }> = [
  { version: 1, file: '001_init.sql' },
]

/** Applies every migration newer than PRAGMA user_version. Returns the resulting version. */
export function runMigrations(db: Db): number {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = user_version

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    const url = new URL(`./migrations/${migration.file}`, import.meta.url)
    const sql = readFileSync(url, 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      // PRAGMA cannot be parameterised; the value comes from the frozen list above.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    version = migration.version
  }

  return version
}
```

Migrations stay as numbered `.sql` files on disk (§3.3) and are read through a `file:` URL
relative to the module, which works identically on Deno and Node. When subsystem C packages
this into an Electron asar, that read must be checked — note it in spec C, do not pre-solve it
here.

- [ ] **Step 5: Write the connection opener and id generator**

`packages/core/src/db/ids.ts`:

```ts
/** Opaque primary key. randomUUID exists on both runtimes' global crypto. */
export function newId(): string {
  return crypto.randomUUID()
}
```

`packages/core/src/db/open.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrate.ts'

export type Db = DatabaseSync
export type Library = { dir: string; db: Db }

export const SPM_DIR = '.spm'
export const PREVIEWS_DIR = 'previews'
export const DB_FILE = 'app.db'

/**
 * Opens (creating if needed) the library at `libraryDir`. The database lives inside the
 * library so the folder is wholly self-describing (spec 3.1).
 */
export function openLibrary(libraryDir: string): Library {
  mkdirSync(join(libraryDir, SPM_DIR, PREVIEWS_DIR), { recursive: true })
  const db = new DatabaseSync(join(libraryDir, SPM_DIR, DB_FILE))
  // Per-connection pragma: ON DELETE CASCADE in the schema is inert without it.
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return { dir: libraryDir, db }
}

export function closeLibrary(lib: Library): void {
  lib.db.close()
}
```

`packages/core/src/ctx.ts`:

```ts
/** Every use case takes one of these. Ownership is scoped by userId inside core (spec 2.2). */
export type Ctx = { userId: string; isAdmin: boolean }
```

- [ ] **Step 6: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 6 new tests passing under each runtime, 9 in total per run.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): SQLite schema, migration runner and library opener"
```

---

### Task 4: `core/auth` — passwords, tokens, sessions, activation

Four primitives that share one rule: raw secrets are never stored, only their SHA-256 (§3.3).

**Files:**

- Create: `packages/core/src/auth/password.ts`, `src/auth/tokens.ts`, `src/auth/sessions.ts`, `src/auth/activation.ts`
- Test: `packages/core/test/auth.test.ts`

**Interfaces:**

- Consumes: `Db`, `Ctx`, `newId`, `withLibrary`.
- Produces:
  - `PW_ALGO = 'pbkdf2-sha256'`, `PW_ITERATIONS = 600_000`, `type PasswordHash = { hash: Uint8Array; salt: Uint8Array; iterations: number; algo: string }`, `hashPassword(password: string, iterations?: number): Promise<PasswordHash>`, `verifyPassword(password: string, stored: PasswordHash): Promise<boolean>`, `needsRehash(stored: { iterations: number; algo: string }): boolean`
  - `randomToken(byteLength?: number): string`, `sha256Bytes(input: string | Uint8Array): Promise<Uint8Array>`, `timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean`
  - `SESSION_TTL_MS`, `createSession(db, userId, userAgent: string | null, now?: number): Promise<{ token: string; expiresAt: number }>`, `resolveSession(db, token: string, now?: number): Promise<Ctx | null>`, `deleteSession(db, token: string): Promise<void>`, `pruneExpiredSessions(db, now?: number): number`
  - `ACTIVATION_TTL_MS`, `issueActivationToken(db, userId, now?): Promise<string>`, `checkActivationToken(db, token, now?): Promise<{ valid: boolean; username?: string; userId?: string }>`, `consumeActivationToken(db, token, now?): Promise<string>`

- [ ] **Step 1: Write the failing test**

`packages/core/test/auth.test.ts`. Tests pass a low iteration count for speed; one test pins
the production constant.

```ts
import {
  PW_ALGO,
  PW_ITERATIONS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/auth/password.ts'
import { randomToken, sha256Bytes, timingSafeEqual } from '../src/auth/tokens.ts'
import {
  checkActivationToken,
  consumeActivationToken,
  issueActivationToken,
} from '../src/auth/activation.ts'
import {
  createSession,
  deleteSession,
  pruneExpiredSessions,
  resolveSession,
} from '../src/auth/sessions.ts'
import { newId } from '../src/db/ids.ts'
import type { Db } from '../src/db/open.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

const FAST = 1000

function seedUser(db: Db, over: { admin?: boolean; status?: string } = {}): string {
  const id = newId()
  db.prepare(
    'INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)',
  ).run(
    id,
    `u-${id.slice(0, 8)}`,
    'User',
    `dir-${id.slice(0, 8)}`,
    over.admin ? 1 : 0,
    over.status ?? 'active',
  )
  return id
}

test('the production PBKDF2 parameters are the ones the spec fixes', () => {
  assert.equal(PW_ITERATIONS, 600_000)
  assert.equal(PW_ALGO, 'pbkdf2-sha256')
})

test('hashPassword verifies the right password and rejects the wrong one', async () => {
  const stored = await hashPassword('correct horse battery', FAST)
  assert.equal(stored.hash.byteLength, 32)
  assert.equal(stored.salt.byteLength, 16)
  assert.equal(await verifyPassword('correct horse battery', stored), true)
  assert.equal(await verifyPassword('correct horse batterz', stored), false)
})

test('two hashes of the same password differ by salt', async () => {
  const a = await hashPassword('same password', FAST)
  const b = await hashPassword('same password', FAST)
  assert.equal(timingSafeEqual(a.hash, b.hash), false)
})

test('needsRehash flags weaker stored parameters only', async () => {
  const weak = await hashPassword('pw', FAST)
  assert.equal(needsRehash(weak), true)
  assert.equal(needsRehash({ iterations: PW_ITERATIONS, algo: PW_ALGO }), false)
})

test('randomToken is url-safe and 256 bits wide', () => {
  const token = randomToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(token, randomToken())
})

test('sha256Bytes is stable and 32 bytes', async () => {
  const a = await sha256Bytes('abc')
  assert.equal(a.byteLength, 32)
  assert.equal(timingSafeEqual(a, await sha256Bytes('abc')), true)
})

test('a session resolves to its user and stores only the hash', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { admin: true })
    const { token } = await createSession(db, userId, 'test-agent')
    const ctx = await resolveSession(db, token)
    assert.deepEqual(ctx, { userId, isAdmin: true })

    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: Uint8Array }[]
    assert.equal(rows.length, 1)
    assert.equal(timingSafeEqual(rows[0]!.token_hash, await sha256Bytes(token)), true)
  })
})

test('an expired session does not resolve and is pruned', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token, expiresAt } = await createSession(db, userId, null)
    assert.equal(await resolveSession(db, token, expiresAt + 1), null)
    assert.equal(pruneExpiredSessions(db, expiresAt + 1), 1)
  })
})

test('a disabled user cannot resolve a live session', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token } = await createSession(db, userId, null)
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId)
    assert.equal(await resolveSession(db, token), null)
  })
})

test('deleteSession revokes immediately', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db)
    const { token } = await createSession(db, userId, null)
    await deleteSession(db, token)
    assert.equal(await resolveSession(db, token), null)
  })
})

test('an activation token checks out once, then is consumed', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId)
    const check = await checkActivationToken(db, token)
    assert.equal(check.valid, true)
    assert.equal(check.userId, userId)

    assert.equal(await consumeActivationToken(db, token), userId)
    assert.equal((await checkActivationToken(db, token)).valid, false)
    await assert.rejects(() => consumeActivationToken(db, token))
  })
})

test('an expired activation token is invalid', async () => {
  await withLibrary(async ({ db }) => {
    const userId = seedUser(db, { status: 'pending' })
    const token = await issueActivationToken(db, userId, 0)
    const eightDays = 8 * 24 * 60 * 60 * 1000
    assert.equal((await checkActivationToken(db, token, eightDays)).valid, false)
  })
})

test('an unknown token is invalid rather than an error', async () => {
  await withLibrary(async ({ db }) => {
    assert.equal((await checkActivationToken(db, randomToken())).valid, false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/auth/password.ts'`.

- [ ] **Step 3: Implement tokens**

`packages/core/src/auth/tokens.ts`:

```ts
/** base64url without padding, so a token is safe in a URL fragment and a cookie. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

/** Length-independent early exit, then constant time over the common length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
```

- [ ] **Step 4: Implement password hashing**

`packages/core/src/auth/password.ts`:

```ts
import { timingSafeEqual } from './tokens.ts'

export const PW_ALGO = 'pbkdf2-sha256'
export const PW_ITERATIONS = 600_000
export const PW_SALT_BYTES = 16
export const PW_KEY_BITS = 256

export type PasswordHash = {
  hash: Uint8Array
  salt: Uint8Array
  iterations: number
  algo: string
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    // NFKC first: the same typed password must hash the same on every platform.
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PW_KEY_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(
  password: string,
  iterations: number = PW_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(PW_SALT_BYTES))
  return { hash: await derive(password, salt, iterations), salt, iterations, algo: PW_ALGO }
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.algo !== PW_ALGO) return false
  const candidate = await derive(password, stored.salt, stored.iterations)
  return timingSafeEqual(candidate, stored.hash)
}

/** True when the stored parameters are weaker than today's policy (spec 5.1). */
export function needsRehash(stored: { iterations: number; algo: string }): boolean {
  return stored.algo !== PW_ALGO || stored.iterations < PW_ITERATIONS
}
```

- [ ] **Step 5: Implement sessions**

`packages/core/src/auth/sessions.ts`:

```ts
import type { Ctx } from '../ctx.ts'
import type { Db } from '../db/open.ts'
import { sha256Bytes } from './tokens.ts'
import { randomToken } from './tokens.ts'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Only push the expiry forward once a day, so a busy client is not a write per request. */
export const SESSION_SLIDE_MS = 24 * 60 * 60 * 1000

export async function createSession(
  db: Db,
  userId: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken()
  const expiresAt = now + SESSION_TTL_MS
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(await sha256Bytes(token), userId, now, now, expiresAt, userAgent)
  return { token, expiresAt }
}

export async function resolveSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<Ctx | null> {
  const hash = await sha256Bytes(token)
  const row = db
    .prepare(
      `SELECT s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt,
              u.id AS userId, u.is_admin AS isAdmin, u.status AS status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | { expiresAt: number; lastSeenAt: number; userId: string; isAdmin: number; status: string }
    | undefined

  if (!row) return null
  if (row.expiresAt <= now) return null
  if (row.status !== 'active') return null

  if (now - row.lastSeenAt > SESSION_SLIDE_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
      now,
      now + SESSION_TTL_MS,
      hash,
    )
  } else {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash)
  }

  return { userId: row.userId, isAdmin: row.isAdmin === 1 }
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(await sha256Bytes(token))
}

export function pruneExpiredSessions(db: Db, now: number = Date.now()): number {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes)
}
```

- [ ] **Step 6: Implement activation tokens**

`packages/core/src/auth/activation.ts`:

```ts
import { AppError } from '@spm/contract/errors.ts'
import type { Db } from '../db/open.ts'
import { newId } from '../db/ids.ts'
import { randomToken, sha256Bytes } from './tokens.ts'

export const ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Returns the raw token exactly once; only its hash is stored (spec 5.3). */
export async function issueActivationToken(
  db: Db,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const token = randomToken()
  db.prepare(
    'INSERT INTO activation_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), userId, await sha256Bytes(token), now + ACTIVATION_TTL_MS, now)
  return token
}

type TokenRow = { userId: string; username: string; expiresAt: number; consumedAt: number | null }

async function findToken(db: Db, token: string): Promise<TokenRow | undefined> {
  return db
    .prepare(
      `SELECT t.user_id AS userId, u.username AS username,
              t.expires_at AS expiresAt, t.consumed_at AS consumedAt
       FROM activation_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .get(await sha256Bytes(token)) as TokenRow | undefined
}

/** Read-only check, so an expired link errors before the user types a password (spec 5.3). */
export async function checkActivationToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<{ valid: boolean; username?: string; userId?: string }> {
  const row = await findToken(db, token)
  if (!row || row.consumedAt !== null || row.expiresAt <= now) return { valid: false }
  return { valid: true, username: row.username, userId: row.userId }
}

export async function consumeActivationToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): Promise<string> {
  const row = await findToken(db, token)
  if (!row || row.consumedAt !== null)
    throw new AppError('InvalidToken', 'activation token is not usable')
  if (row.expiresAt <= now) throw new AppError('TokenExpired', 'activation token has expired')
  db.prepare('UPDATE activation_tokens SET consumed_at = ? WHERE token_hash = ?').run(
    now,
    await sha256Bytes(token),
  )
  return row.userId
}
```

- [ ] **Step 7: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 13 new tests passing under each.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): PBKDF2 password hashing, opaque sessions, activation tokens"
```

---

### Task 5: `core/users` — library paths, bootstrap, login, account self-service, settings

Everything a single user can do to their own account, plus the two ways a `users` row comes
into existence without an admin: first-run bootstrap (§5.4) and local mode (§2.6).

**Files:**

- Create: `packages/core/src/files/paths.ts`, `src/users/repo.ts`, `src/users/usage.ts`, `src/users/bootstrap.ts`, `src/users/account.ts`, `src/auth/login.ts`
- Test: `packages/core/test/account.test.ts`

**Interfaces:**

- Consumes: `Library`, `Db`, `Ctx`, `newId`, `hashPassword`, `verifyPassword`, `needsRehash`, `createSession`, `issueActivationToken`, `consumeActivationToken`, `AppError`, `UserDto`, `SettingsDto`, `DEFAULT_SETTINGS`.
- Produces:
  - `src/files/paths.ts`: `userRoot(lib: Library, libraryDir: string): string`, `projectDir(lib, libraryDir, dirName): string`, `previewPath(lib: Library, fileId: string): string`, `safeJoin(base: string, ...segments: string[]): string`
  - `src/users/repo.ts`: `type UserRow`, `findUserById(db, id): UserRow | undefined`, `findUserByUsername(db, username): UserRow | undefined`, `requireUserRow(db, id): UserRow`, `toUserDto(row: UserRow, diskUsageBytes: number): UserDto`
  - `src/users/usage.ts`: `diskUsageBytes(db, userId): number`, `diskUsageByUser(db): Map<string, number>`
  - `src/users/bootstrap.ts`: `ensureBootstrapAdmin(lib, now?): Promise<{ username: string; token: string } | null>`, `ensureLocalUser(lib, now?): Ctx`
  - `src/users/account.ts`: `me(lib, ctx): UserDto`, `changePassword(lib, ctx, current, next): Promise<void>`, `updateProfile(lib, ctx, patch): UserDto`, `getSettings(lib, ctx): SettingsDto`, `putSettings(lib, ctx, patch): SettingsDto`
  - `src/auth/login.ts`: `login(lib, username, password, userAgent, now?): Promise<{ user: UserDto; token: string; expiresAt: number }>`, `activateAccount(lib, token, newPassword, userAgent, now?): Promise<{ user: UserDto; token: string; expiresAt: number }>`

- [ ] **Step 1: Write the failing test**

`packages/core/test/account.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import { activateAccount, login } from '../src/auth/login.ts'
import { PW_ITERATIONS, hashPassword } from '../src/auth/password.ts'
import {
  changePassword,
  getSettings,
  me,
  putSettings,
  updateProfile,
} from '../src/users/account.ts'
import { ensureBootstrapAdmin, ensureLocalUser } from '../src/users/bootstrap.ts'
import { safeJoin, userRoot } from '../src/files/paths.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

test('safeJoin refuses to escape its base', async () => {
  // resolve(), not join(): the comparison must hold on Windows too.
  const base = resolve('/lib/marc')
  assert.equal(safeJoin(base, 'Benchy', 'a.stl'), resolve(base, 'Benchy', 'a.stl'))
  assert.throws(
    () => safeJoin(base, '..', 'anna'),
    (e: unknown) => (e as AppError).code === 'Forbidden',
  )
})

test('userRoot flattens the library when library_dir is "."', async () => {
  await withLibrary((lib) => {
    assert.equal(userRoot(lib, '.'), lib.dir)
    assert.equal(userRoot(lib, 'marc'), join(lib.dir, 'marc'))
  })
})

test('bootstrap creates a pending admin with no password and returns the token once', async () => {
  await withLibrary(async (lib) => {
    const first = await ensureBootstrapAdmin(lib)
    assert.ok(first)
    assert.equal(first.username, 'admin')
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)

    const row = lib.db.prepare('SELECT * FROM users').get() as Record<string, unknown>
    assert.equal(row.status, 'pending')
    assert.equal(row.is_admin, 1)
    assert.equal(row.pw_hash, null)
    assert.ok(existsSync(join(lib.dir, 'admin')))

    assert.equal(await ensureBootstrapAdmin(lib), null)
  })
})

test('a pending account cannot log in', async () => {
  await withLibrary(async (lib) => {
    await ensureBootstrapAdmin(lib)
    await assert.rejects(
      () => login(lib, 'admin', 'anything at all', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
  })
})

test('activation sets the password, activates, and logs the user straight in', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const result = await activateAccount(lib, boot!.token, 'a good long password', 'agent')
    assert.equal(result.user.status, 'active')
    assert.ok(result.user.activatedAt)
    assert.ok(result.token)

    const after = await login(lib, 'admin', 'a good long password', null)
    assert.equal(after.user.username, 'admin')
    assert.equal(after.user.isAdmin, true)
    assert.equal(after.user.diskUsageBytes, 0)
    assert.equal(after.user.quotaBytes, null)
  })
})

test('activation cannot be replayed', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)
    await assert.rejects(() => activateAccount(lib, boot!.token, 'another password', null))
  })
})

test('login rejects a wrong password and a disabled account identically', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)

    await assert.rejects(
      () => login(lib, 'admin', 'wrong password', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
    lib.db.prepare("UPDATE users SET status = 'disabled'").run()
    await assert.rejects(
      () => login(lib, 'admin', 'a good long password', null),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
  })
})

test('login upgrades a hash stored with weaker parameters', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    await activateAccount(lib, boot!.token, 'a good long password', null)

    const weak = await hashPassword('a good long password', 1000)
    lib.db
      .prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?')
      .run(weak.hash, weak.salt, weak.iterations, weak.algo)

    await login(lib, 'admin', 'a good long password', null)
    const { pw_iterations } = lib.db.prepare('SELECT pw_iterations FROM users').get() as {
      pw_iterations: number
    }
    assert.equal(pw_iterations, PW_ITERATIONS)
  })
})

test('changePassword requires the current one and invalidates nothing else', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    await assert.rejects(
      () => changePassword(lib, ctx, 'not it', 'a new long password'),
      (e: unknown) => (e as AppError).code === 'Unauthorized',
    )
    await changePassword(lib, ctx, 'a good long password', 'a new long password')
    assert.ok(await login(lib, 'admin', 'a new long password', null))
  })
})

test('updateProfile changes the display name only', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }
    assert.equal(updateProfile(lib, ctx, { displayName: 'Marc S' }).displayName, 'Marc S')
    assert.equal(me(lib, ctx).username, 'admin')
  })
})

test('settings return defaults, then merge a patch', async () => {
  await withLibrary(async (lib) => {
    const boot = await ensureBootstrapAdmin(lib)
    const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
    const ctx = { userId: user.id, isAdmin: true }

    assert.deepEqual(getSettings(lib, ctx), {
      theme: 'system',
      language: 'en',
      viewMode: 'grid',
      sort: 'updatedAt',
      dir: 'desc',
    })
    assert.equal(putSettings(lib, ctx, { language: 'de' }).language, 'de')
    assert.equal(putSettings(lib, ctx, { theme: 'dark' }).language, 'de')
    assert.equal(getSettings(lib, ctx).theme, 'dark')
  })
})

test('ensureLocalUser makes one flat-library user and is idempotent', async () => {
  await withLibrary((lib) => {
    const ctx = ensureLocalUser(lib)
    assert.equal(ctx.isAdmin, false)
    assert.deepEqual(ensureLocalUser(lib), ctx)
    const { library_dir, n } = lib.db
      .prepare('SELECT library_dir, (SELECT COUNT(*) FROM users) AS n FROM users')
      .get() as { library_dir: string; n: number }
    assert.equal(library_dir, '.')
    assert.equal(n, 1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/files/paths.ts'`.

- [ ] **Step 3: Implement the path helpers**

`packages/core/src/files/paths.ts`:

```ts
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import type { Library } from '../db/open.ts'
import { PREVIEWS_DIR, SPM_DIR } from '../db/open.ts'

/**
 * Joins under `base` and refuses anything that escapes it. Every path built from
 * user-supplied text goes through here.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || isAbsolute(segment) || normalize(segment).split(sep).includes('..')) {
      throw new AppError('Forbidden', `illegal path segment: ${segment}`)
    }
  }
  const target = resolve(base, ...segments)
  const root = resolve(base)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new AppError('Forbidden', 'path escapes the library')
  }
  return target
}

/** `library_dir` of '.' means a flat library: project folders sit at the root (spec 2.6). */
export function userRoot(lib: Library, libraryDir: string): string {
  return libraryDir === '.' ? resolve(lib.dir) : safeJoin(lib.dir, libraryDir)
}

export function projectDir(lib: Library, libraryDir: string, dirName: string): string {
  return safeJoin(userRoot(lib, libraryDir), dirName)
}

export function previewPath(lib: Library, fileId: string): string {
  return join(lib.dir, SPM_DIR, PREVIEWS_DIR, `${fileId}.png`)
}
```

- [ ] **Step 4: Implement the user row mapping and usage aggregate**

`packages/core/src/users/repo.ts`:

```ts
import { AppError } from '@spm/contract/errors.ts'
import type { UserDto, UserStatus } from '@spm/contract/dtos.ts'
import type { Db } from '../db/open.ts'

export type UserRow = {
  id: string
  username: string
  display_name: string
  library_dir: string
  pw_hash: Uint8Array | null
  pw_salt: Uint8Array | null
  pw_iterations: number | null
  pw_algo: string | null
  is_admin: number
  status: UserStatus
  quota_bytes: number | null
  created_at: number
  activated_at: number | null
}

const SELECT_USER = 'SELECT * FROM users'

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE id = ?`).get(id) as UserRow | undefined
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE username = ? COLLATE NOCASE`).get(username) as
    UserRow | undefined
}

export function requireUserRow(db: Db, id: string): UserRow {
  const row = findUserById(db, id)
  if (!row) throw new AppError('NotFound', 'user not found')
  return row
}

export function toUserDto(row: UserRow, diskUsageBytes: number): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    status: row.status,
    diskUsageBytes,
    quotaBytes: row.quota_bytes,
    createdAt: row.created_at,
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
  }
}
```

`packages/core/src/users/usage.ts` — the §5.6 aggregate, derived and never stored:

```ts
import type { Db } from '../db/open.ts'

const USAGE_SQL = `SELECT p.owner_id AS ownerId, COALESCE(SUM(f.size_bytes), 0) AS bytes
                   FROM files f JOIN projects p ON p.id = f.project_id
                   WHERE p.state = 'ok'
                   GROUP BY p.owner_id`

export function diskUsageBytes(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes
       FROM files f JOIN projects p ON p.id = f.project_id
       WHERE p.state = 'ok' AND p.owner_id = ?`,
    )
    .get(userId) as { bytes: number }
  return Number(row.bytes)
}

export function diskUsageByUser(db: Db): Map<string, number> {
  const rows = db.prepare(USAGE_SQL).all() as { ownerId: string; bytes: number }[]
  return new Map(rows.map((r) => [r.ownerId, Number(r.bytes)]))
}
```

`state = 'ok'` is load-bearing: a `missing` project keeps its file rows (§3.5) but its bytes
are not on the disk being metered.

- [ ] **Step 5: Implement bootstrap and local mode**

`packages/core/src/users/bootstrap.ts`:

```ts
import { mkdirSync } from 'node:fs'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { newId } from '../db/ids.ts'
import { issueActivationToken } from '../auth/activation.ts'
import { userRoot } from '../files/paths.ts'

const BOOTSTRAP_USERNAME = 'admin'

/**
 * First run against an empty users table: create a pending admin and hand back its raw
 * activation token for the caller to log (spec 5.4). No password exists at any point.
 * Returns null when the table already has rows.
 */
export async function ensureBootstrapAdmin(
  lib: Library,
  now: number = Date.now(),
): Promise<{ username: string; token: string } | null> {
  const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (n > 0) return null

  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 1, 'pending', ?)`,
    )
    .run(id, BOOTSTRAP_USERNAME, 'Administrator', BOOTSTRAP_USERNAME, now)
  mkdirSync(userRoot(lib, BOOTSTRAP_USERNAME), { recursive: true })

  return { username: BOOTSTRAP_USERNAME, token: await issueActivationToken(lib.db, id, now) }
}

/**
 * Electron local mode (spec 2.6): exactly one user, flat library, no password, no session.
 * Ctx still needs a userId, so the row exists; canManageUsers stays false.
 */
export function ensureLocalUser(lib: Library, now: number = Date.now()): Ctx {
  const existing = lib.db.prepare('SELECT id FROM users LIMIT 1').get() as
    { id: string } | undefined
  if (existing) return { userId: existing.id, isAdmin: false }

  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at, activated_at)
       VALUES (?, 'local', 'Local', '.', 0, 'active', ?, ?)`,
    )
    .run(id, now, now)
  return { userId: id, isAdmin: false }
}
```

- [ ] **Step 6: Implement login and activation**

`packages/core/src/auth/login.ts`:

```ts
import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Library } from '../db/open.ts'
import { diskUsageBytes } from '../users/usage.ts'
import { findUserByUsername, requireUserRow, toUserDto } from '../users/repo.ts'
import { consumeActivationToken } from './activation.ts'
import { hashPassword, needsRehash, verifyPassword } from './password.ts'
import { createSession } from './sessions.ts'

export type LoginResult = { user: UserDto; token: string; expiresAt: number }

const UNAUTHORIZED = 'username or password is not correct'

export async function login(
  lib: Library,
  username: string,
  password: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<LoginResult> {
  const row = findUserByUsername(lib.db, username)
  // One message for every failure mode: unknown user, pending, disabled, wrong password.
  if (!row || row.status !== 'active' || !row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    throw new AppError('Unauthorized', UNAUTHORIZED)
  }

  const stored = {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  }
  if (!(await verifyPassword(password, stored))) throw new AppError('Unauthorized', UNAUTHORIZED)

  if (needsRehash(stored)) {
    const upgraded = await hashPassword(password)
    lib.db
      .prepare(
        'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
      )
      .run(upgraded.hash, upgraded.salt, upgraded.iterations, upgraded.algo, row.id)
  }

  const session = await createSession(lib.db, row.id, userAgent, now)
  return {
    user: toUserDto(requireUserRow(lib.db, row.id), diskUsageBytes(lib.db, row.id)),
    ...session,
  }
}

/** Consumes the token, sets the first password, and issues a session in one step (spec 5.3). */
export async function activateAccount(
  lib: Library,
  token: string,
  newPassword: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<LoginResult> {
  const userId = await consumeActivationToken(lib.db, token, now)
  const pw = await hashPassword(newPassword)
  lib.db
    .prepare(
      `UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ?,
                        status = 'active', activated_at = ?
       WHERE id = ?`,
    )
    .run(pw.hash, pw.salt, pw.iterations, pw.algo, now, userId)

  const session = await createSession(lib.db, userId, userAgent, now)
  return {
    user: toUserDto(requireUserRow(lib.db, userId), diskUsageBytes(lib.db, userId)),
    ...session,
  }
}
```

- [ ] **Step 7: Implement account self-service and settings**

`packages/core/src/users/account.ts`:

```ts
import { DEFAULT_SETTINGS, type SettingsDto, type UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { requireUserRow, toUserDto } from './repo.ts'
import { diskUsageBytes } from './usage.ts'

export function me(lib: Library, ctx: Ctx): UserDto {
  return toUserDto(requireUserRow(lib.db, ctx.userId), diskUsageBytes(lib.db, ctx.userId))
}

export async function changePassword(
  lib: Library,
  ctx: Ctx,
  current: string,
  next: string,
): Promise<void> {
  const row = requireUserRow(lib.db, ctx.userId)
  if (!row.pw_hash || !row.pw_salt || !row.pw_iterations) {
    throw new AppError('Forbidden', 'account has no password to change')
  }
  const ok = await verifyPassword(current, {
    hash: row.pw_hash,
    salt: row.pw_salt,
    iterations: row.pw_iterations,
    algo: row.pw_algo ?? '',
  })
  if (!ok) throw new AppError('Unauthorized', 'current password is not correct')

  const pw = await hashPassword(next)
  lib.db
    .prepare(
      'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, pw_algo = ? WHERE id = ?',
    )
    .run(pw.hash, pw.salt, pw.iterations, pw.algo, ctx.userId)
}

export function updateProfile(lib: Library, ctx: Ctx, patch: { displayName?: string }): UserDto {
  if (patch.displayName !== undefined) {
    lib.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(patch.displayName, ctx.userId)
  }
  return me(lib, ctx)
}

const SETTING_KEYS = ['theme', 'language', 'viewMode', 'sort', 'dir'] as const
type SettingKey = (typeof SETTING_KEYS)[number]

export function getSettings(lib: Library, ctx: Ctx): SettingsDto {
  const rows = lib.db
    .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .all(ctx.userId) as { key: string; value: string | null }[]

  const stored: Record<string, string> = {}
  for (const row of rows) if (row.value !== null) stored[row.key] = row.value
  // Unknown or stale keys fall back to the default rather than corrupting the DTO.
  const merged = { ...DEFAULT_SETTINGS }
  for (const key of SETTING_KEYS) {
    const value = stored[key]
    if (value !== undefined) (merged as Record<string, string>)[key] = value
  }
  return merged
}

export function putSettings(
  lib: Library,
  ctx: Ctx,
  patch: Partial<Record<SettingKey, string>>,
): SettingsDto {
  const upsert = lib.db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  )
  for (const key of SETTING_KEYS) {
    const value = patch[key]
    if (value !== undefined) upsert.run(ctx.userId, key, value)
  }
  return getSettings(lib, ctx)
}
```

- [ ] **Step 8: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 12 new tests passing under each. These tests hash at the real 600,000 iterations in
several places, so expect the file to take a few seconds — that is the cost being bought.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): library paths, first-run bootstrap, login, account self-service, settings"
```

---

### Task 6: `core/users` — admin management and the last-active-admin guard

**Files:**

- Create: `packages/core/src/users/admin.ts`
- Test: `packages/core/test/admin.test.ts`

**Interfaces:**

- Consumes: `Library`, `Ctx`, `newId`, `issueActivationToken`, `userRoot`, `findUserByUsername`, `requireUserRow`, `toUserDto`, `diskUsageByUser`, `diskUsageBytes`, `AppError`, and the input types `CreateUserInput` / `UpdateUserInput` from `@spm/contract/schemas.ts` (**`import type` only** — a value import would drag Zod into `core`).
- Produces: `requireAdmin(ctx): void`, `listUsers(lib, ctx): UserDto[]`, `createUser(lib, ctx, input): Promise<{ user: UserDto; token: string }>`, `reissueInvite(lib, ctx, id): Promise<{ token: string }>`, `updateUser(lib, ctx, id, patch): UserDto`, `deleteUser(lib, ctx, id): void`

**Deleting a user does not delete their files.** The row cascades (projects, files, previews,
tags, sessions all go), but the folder under the library root is left on disk. This follows
§3.5's rule that metadata is never the thing that destroys files, and an admin who truly wants
the bytes gone can remove the folder.

- [ ] **Step 1: Write the failing test**

`packages/core/test/admin.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import { activateAccount } from '../src/auth/login.ts'
import { ensureBootstrapAdmin } from '../src/users/bootstrap.ts'
import { createUser, deleteUser, listUsers, reissueInvite, updateUser } from '../src/users/admin.ts'
import type { Ctx } from '../src/ctx.ts'
import type { Library } from '../src/db/open.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

async function activeAdmin(lib: Library): Promise<Ctx> {
  const boot = await ensureBootstrapAdmin(lib)
  const { user } = await activateAccount(lib, boot!.token, 'a good long password', null)
  return { userId: user.id, isAdmin: true }
}

const NOT_ADMIN: Ctx = { userId: 'someone', isAdmin: false }

test('every users.* operation is refused to a non-admin', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const forbidden = (e: unknown) => (e as AppError).code === 'Forbidden'

    assert.throws(() => listUsers(lib, NOT_ADMIN), forbidden)
    await assert.rejects(
      () =>
        createUser(lib, NOT_ADMIN, {
          username: 'anna',
          displayName: 'Anna',
          isAdmin: false,
          quotaBytes: null,
        }),
      forbidden,
    )
    assert.throws(() => updateUser(lib, NOT_ADMIN, admin.userId, { isAdmin: false }), forbidden)
    assert.throws(() => deleteUser(lib, NOT_ADMIN, admin.userId), forbidden)
    await assert.rejects(() => reissueInvite(lib, NOT_ADMIN, admin.userId), forbidden)
  })
})

test('createUser makes a pending user, their folder, and one activation token', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user, token } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: 5_000_000,
    })

    assert.equal(user.status, 'pending')
    assert.equal(user.quotaBytes, 5_000_000)
    assert.equal(user.diskUsageBytes, 0)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(existsSync(join(lib.dir, 'anna')))
    assert.equal(listUsers(lib, admin).length, 2)
  })
})

test('a duplicate username is a conflict, case-insensitively', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    await assert.rejects(
      () =>
        createUser(lib, admin, {
          username: 'ANNA',
          displayName: 'Anna II',
          isAdmin: false,
          quotaBytes: null,
        }),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('reissueInvite hands out a fresh token and invalidates nothing else', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const created = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    const again = await reissueInvite(lib, admin, created.user.id)
    assert.notEqual(again.token, created.token)

    const { n } = lib.db
      .prepare('SELECT COUNT(*) AS n FROM activation_tokens WHERE user_id = ?')
      .get(created.user.id) as { n: number }
    assert.equal(n, 2)
  })
})

test('the last active admin cannot be deleted, disabled or demoted', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const lastAdmin = (e: unknown) => (e as AppError).code === 'LastActiveAdmin'

    assert.throws(() => deleteUser(lib, admin, admin.userId), lastAdmin)
    assert.throws(() => updateUser(lib, admin, admin.userId, { isDisabled: true }), lastAdmin)
    assert.throws(() => updateUser(lib, admin, admin.userId, { isAdmin: false }), lastAdmin)
  })
})

test('once a second admin is active, the first can be removed', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const second = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: true,
      quotaBytes: null,
    })

    // Still pending, so not yet an *active* admin.
    assert.throws(
      () => deleteUser(lib, admin, admin.userId),
      (e: unknown) => (e as AppError).code === 'LastActiveAdmin',
    )

    await activateAccount(lib, second.token, 'another long password', null)
    deleteUser(lib, admin, admin.userId)
    assert.deepEqual(
      listUsers(lib, { userId: second.user.id, isAdmin: true }).map((u) => u.username),
      ['anna'],
    )
  })
})

test('updateUser toggles admin, disabled and quota, and re-enabling respects pending', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })

    assert.equal(updateUser(lib, admin, user.id, { quotaBytes: 100 }).quotaBytes, 100)
    assert.equal(updateUser(lib, admin, user.id, { quotaBytes: null }).quotaBytes, null)
    assert.equal(updateUser(lib, admin, user.id, { isAdmin: true }).isAdmin, true)
    assert.equal(updateUser(lib, admin, user.id, { isDisabled: true }).status, 'disabled')
    // Never activates an account that has no password yet.
    assert.equal(updateUser(lib, admin, user.id, { isDisabled: false }).status, 'pending')
  })
})

test('deleting a user cascades their metadata but leaves their folder', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run('p1', user.id, 'Bin', 'Bin')

    deleteUser(lib, admin, user.id)

    const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    assert.equal(n, 0)
    assert.ok(existsSync(join(lib.dir, 'anna')))
  })
})

test('listUsers reports each user their own derived disk usage', async () => {
  await withLibrary(async (lib) => {
    const admin = await activeAdmin(lib)
    const { user } = await createUser(lib, admin, {
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })
    lib.db
      .prepare(
        'INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      )
      .run('p1', user.id, 'Bin', 'Bin')
    lib.db
      .prepare(
        "INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES ('f1', 'p1', 'a.stl', 'model', 4096, 0)",
      )
      .run()

    const byName = new Map(listUsers(lib, admin).map((u) => [u.username, u.diskUsageBytes]))
    assert.equal(byName.get('anna'), 4096)
    assert.equal(byName.get('admin'), 0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/users/admin.ts'`.

- [ ] **Step 3: Implement the admin use cases**

`packages/core/src/users/admin.ts`:

```ts
import { mkdirSync } from 'node:fs'
import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { CreateUserInput, UpdateUserInput } from '@spm/contract/schemas.ts'
import { issueActivationToken } from '../auth/activation.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Db, Library } from '../db/open.ts'
import { userRoot } from '../files/paths.ts'
import { findUserByUsername, requireUserRow, toUserDto, type UserRow } from './repo.ts'
import { diskUsageByUser, diskUsageBytes } from './usage.ts'

/** Admin authorisation lives in core, not in a transport (spec 2.2, 5.5). */
export function requireAdmin(ctx: Ctx): void {
  if (!ctx.isAdmin) throw new AppError('Forbidden', 'administrator rights are required')
}

function countOtherActiveAdmins(db: Db, excludeId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active' AND id <> ?")
    .get(excludeId) as { n: number }
  return Number(row.n)
}

/** Refuses the operation that would leave the installation with no way to manage users. */
function assertNotLastActiveAdmin(db: Db, row: UserRow): void {
  const isActiveAdmin = row.is_admin === 1 && row.status === 'active'
  if (isActiveAdmin && countOtherActiveAdmins(db, row.id) === 0) {
    throw new AppError('LastActiveAdmin', 'the last active administrator must remain')
  }
}

export function listUsers(lib: Library, ctx: Ctx): UserDto[] {
  requireAdmin(ctx)
  const usage = diskUsageByUser(lib.db)
  const rows = lib.db
    .prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE')
    .all() as UserRow[]
  return rows.map((row) => toUserDto(row, usage.get(row.id) ?? 0))
}

export async function createUser(
  lib: Library,
  ctx: Ctx,
  input: CreateUserInput,
): Promise<{ user: UserDto; token: string }> {
  requireAdmin(ctx)
  if (findUserByUsername(lib.db, input.username)) {
    throw new AppError('Conflict', `username "${input.username}" is already taken`)
  }

  const id = newId()
  const now = Date.now()
  // library_dir is stored, not derived, so a later username change is an explicit rename (3.3).
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, quota_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      input.username,
      input.displayName,
      input.username,
      input.isAdmin ? 1 : 0,
      input.quotaBytes,
      now,
    )
  mkdirSync(userRoot(lib, input.username), { recursive: true })

  const token = await issueActivationToken(lib.db, id, now)
  return { user: toUserDto(requireUserRow(lib.db, id), 0), token }
}

export async function reissueInvite(
  lib: Library,
  ctx: Ctx,
  id: string,
): Promise<{ token: string }> {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)
  if (row.status === 'active') throw new AppError('Conflict', 'account is already active')
  return { token: await issueActivationToken(lib.db, row.id) }
}

export function updateUser(lib: Library, ctx: Ctx, id: string, patch: UpdateUserInput): UserDto {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)

  if (patch.isAdmin === false || patch.isDisabled === true) assertNotLastActiveAdmin(lib.db, row)

  if (patch.isAdmin !== undefined) {
    lib.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(patch.isAdmin ? 1 : 0, id)
  }
  if (patch.isDisabled !== undefined) {
    // Re-enabling must not activate an account that never set a password.
    const status = patch.isDisabled ? 'disabled' : row.pw_hash ? 'active' : 'pending'
    lib.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id)
  }
  if (patch.quotaBytes !== undefined) {
    // Lowering below current usage is allowed: it blocks uploads, it does not delete (5.6).
    lib.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(patch.quotaBytes, id)
  }

  return toUserDto(requireUserRow(lib.db, id), diskUsageBytes(lib.db, id))
}

export function deleteUser(lib: Library, ctx: Ctx, id: string): void {
  requireAdmin(ctx)
  const row = requireUserRow(lib.db, id)
  assertNotLastActiveAdmin(lib.db, row)
  // Cascades projects, files, previews, tags and sessions. The folder on disk is left alone.
  lib.db.prepare('DELETE FROM users WHERE id = ?').run(id)
}
```

- [ ] **Step 4: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 9 new tests passing under each.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): admin user management with the last-active-admin guard"
```

---

### Task 7: `core/files` — zip reader, §3.4 slicer classification, content hashing

The one algorithm in this plan that was settled against real measurements. Get the registry
order wrong and every OrcaSlicer project is labelled `bambu`.

**Files:**

- Create: `packages/core/src/files/zip.ts`, `src/files/classify.ts`, `src/files/hash.ts`
- Test: `packages/core/test/fixtures/make-3mf.ts`, `packages/core/test/classify.test.ts`

**Interfaces:**

- Consumes: `AppError`, `FileKind`, `SlicerId`.
- Produces:
  - `src/files/zip.ts`: `type ZipEntry = { name: string; method: number; compressedSize: number; uncompressedSize: number; localHeaderOffset: number }`, `readZipEntries(path): ZipEntry[]`, `findZipEntry(entries, name): ZipEntry | undefined`, `readZipEntryBytes(path, entry): Uint8Array`, `readZipEntryText(path, entry): string`
  - `src/files/classify.ts`: `type Classification = { kind: FileKind; slicer: SlicerId | null }`, `SLICER_HEADER_REGISTRY`, `slicerFromSliceInfo(xml): SlicerId | null`, `classify3mf(absPath): Classification`, `classifyFile(absPath): Classification`
  - `src/files/hash.ts`: `fileContentHash(absPath): Promise<Uint8Array>`
  - `test/fixtures/make-3mf.ts`: `writeZip(path, entries)`, `crc32(bytes)`, `sliceInfo(keys)`, `curaProject(path)`, `prusaProject(path)`, `bambuLineageProject(path, headerKeys)`, `unslicedBambuProject(path)`, `plainMesh3mf(path)` — Task 11 reuses `writeZip` and `crc32`.

- [ ] **Step 1: Write the 3MF fixture builder**

`packages/core/test/fixtures/make-3mf.ts`. Real slicer files are not committed, so the tests
build zips whose entry layouts match the ones measured on 2026-08-22 (§3.4).

```ts
import { writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export type ZipInput = { name: string; data: string | Uint8Array; deflate?: boolean }

export function writeZip(path: string, entries: ZipInput[]): void {
  const encoder = new TextEncoder()
  const body: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const method = entry.deflate ? 8 : 0
    const stored = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const name = encoder.encode(entry.name)
    const checksum = crc32(raw)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(14, checksum, true)
    lv.setUint32(18, stored.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    body.push(local, stored)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, checksum, true)
    cv.setUint32(20, stored.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)

    offset += local.length + stored.length
  }

  const cdBytes = concatBytes(central)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdBytes.length, true)
  ev.setUint32(16, offset, true)

  writeFileSync(path, concatBytes([...body, cdBytes, eocd]))
}

/** A slice_info.config carrying the given header-item keys, values deliberately junk. */
export function sliceInfo(keys: string[]): string {
  const items = keys.map((key) => `    <header_item key="${key}" value="whatever"/>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n${items}\n  </header>\n  <plate>\n    <metadata key="printer_model_id" value="Anycubic Kobra X"/>\n  </plate>\n</config>\n`
}

const MODEL_XML = '<?xml version="1.0"?><model unit="millimeter"><resources/></model>'

export function curaProject(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Cura/plugin_metadata.json', data: '{}' },
    { name: 'Cura/preferences.cfg', data: '[general]' },
    ...(thumbnail ? [{ name: 'Metadata/thumbnail.png', data: thumbnail }] : []),
  ])
}

export function prusaProject(path: string, thumbnail?: Uint8Array): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/Slic3r_PE.config', data: '; generated by PrusaSlicer' },
    { name: 'Metadata/Slic3r_PE_model.config', data: '<config/>' },
    ...(thumbnail ? [{ name: 'Metadata/thumbnail.png', data: thumbnail }] : []),
  ])
}

/** Anycubic, Bambu and Orca share this layout exactly; only the header keys differ. */
export function bambuLineageProject(
  path: string,
  headerKeys: string[],
  thumbnail?: Uint8Array,
): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/project_settings.config', data: '{"version": "02.08.02.61"}' },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
    { name: 'Metadata/slice_info.config', data: sliceInfo(headerKeys) },
    ...(thumbnail
      ? [
          { name: 'Metadata/plate_1.png', data: thumbnail },
          { name: 'Metadata/plate_1_small.png', data: thumbnail },
          { name: 'Metadata/top_1.png', data: thumbnail },
        ]
      : []),
  ])
}

/** Saved but never sliced, so slice_info.config was never written (spec 3.4, rule 4). */
export function unslicedBambuProject(path: string): void {
  writeZip(path, [
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
    { name: 'Metadata/project_settings.config', data: '{"version": "02.06.00.51"}' },
    { name: 'Metadata/model_settings.config', data: '<config/>' },
  ])
}

export function plainMesh3mf(path: string): void {
  writeZip(path, [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '3D/3dmodel.model', data: MODEL_XML, deflate: true },
  ])
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/classify.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify3mf, classifyFile, slicerFromSliceInfo } from '../src/files/classify.ts'
import { fileContentHash } from '../src/files/hash.ts'
import { findZipEntry, readZipEntries, readZipEntryText } from '../src/files/zip.ts'
import { assert, test } from './harness.ts'
import {
  bambuLineageProject,
  curaProject,
  plainMesh3mf,
  prusaProject,
  sliceInfo,
  unslicedBambuProject,
} from './fixtures/make-3mf.ts'

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-zip-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('the zip reader lists entries and inflates a deflated one', async () => {
  await withDir((dir) => {
    const path = join(dir, 'p.3mf')
    plainMesh3mf(path)
    const entries = readZipEntries(path)
    assert.deepEqual(entries.map((e) => e.name).sort(), ['3D/3dmodel.model', '[Content_Types].xml'])
    const model = findZipEntry(entries, '3D/3dmodel.model')!
    assert.equal(model.method, 8)
    assert.match(readZipEntryText(path, model), /^<\?xml/)
  })
})

test('the zip reader rejects a file that is not a zip', async () => {
  await withDir((dir) => {
    const path = join(dir, 'not.3mf')
    writeFileSync(path, 'just some text, definitely not a zip archive')
    assert.throws(() => readZipEntries(path))
  })
})

test('Cura is identified by its Cura/ prefix', async () => {
  await withDir((dir) => {
    const path = join(dir, 'benchy.3mf')
    curaProject(path)
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'cura' })
  })
})

test('PrusaSlicer is identified by Metadata/Slic3r_PE.config', async () => {
  await withDir((dir) => {
    const path = join(dir, 'bracket.3mf')
    prusaProject(path)
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'prusaslicer' })
  })
})

test('Anycubic is identified by its X-ACNext header item', async () => {
  await withDir((dir) => {
    const path = join(dir, 'ac.3mf')
    bambuLineageProject(path, ['X-ACNext-Client-Type', 'X-ACNext-Client-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'anycubic' })
  })
})

test('Bambu Studio is identified by X-BBL-Client-Type', async () => {
  await withDir((dir) => {
    const path = join(dir, 'bbl.3mf')
    bambuLineageProject(path, ['X-BBL-Client-Type', 'X-BBL-Client-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'bambu' })
  })
})

test('OrcaSlicer wins over Bambu even though it carries the X-BBL keys too', async () => {
  await withDir((dir) => {
    const path = join(dir, 'orca.3mf')
    // Orca's header is a superset of Bambu's; registry order is what separates them.
    bambuLineageProject(path, ['X-BBL-Client-Type', 'X-BBL-Client-Version', 'OrcaSlicer-Version'])
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: 'orca' })
  })
})

test('an unsliced Bambu-lineage project is a slicer project of unknown slicer', async () => {
  await withDir((dir) => {
    const path = join(dir, 'unsliced.3mf')
    unslicedBambuProject(path)
    // Reported as null rather than guessed, so the UI falls back to the default slicer.
    assert.deepEqual(classify3mf(path), { kind: 'slicer_project', slicer: null })
  })
})

test('a slice_info.config with no known key yields a null slicer', async () => {
  assert.equal(slicerFromSliceInfo(sliceInfo(['X-Unknown-Client-Type'])), null)
})

test('the version value is never used as a discriminator', () => {
  // printer_model and version strings are traps (spec 3.4); only keys are matched.
  assert.equal(slicerFromSliceInfo(sliceInfo(['X-BBL-Client-Version'])), null)
})

test('a plain mesh 3MF is a model, not a slicer project', async () => {
  await withDir((dir) => {
    const path = join(dir, 'mesh.3mf')
    plainMesh3mf(path)
    assert.deepEqual(classify3mf(path), { kind: 'model', slicer: null })
  })
})

test('classifyFile routes by extension and falls back to other', async () => {
  await withDir((dir) => {
    for (const name of ['a.stl', 'b.STL', 'c.obj']) {
      writeFileSync(join(dir, name), 'solid x')
      assert.deepEqual(classifyFile(join(dir, name)), { kind: 'model', slicer: null })
    }
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    assert.deepEqual(classifyFile(join(dir, 'notes.txt')), { kind: 'other', slicer: null })

    const project = join(dir, 'x.3mf')
    curaProject(project)
    assert.deepEqual(classifyFile(project), { kind: 'slicer_project', slicer: 'cura' })
  })
})

test('an unreadable 3MF classifies as other rather than throwing', async () => {
  await withDir((dir) => {
    const path = join(dir, 'corrupt.3mf')
    writeFileSync(path, 'PK garbage')
    assert.deepEqual(classifyFile(path), { kind: 'other', slicer: null })
  })
})

test('fileContentHash is a stable 32-byte digest that follows content', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'a.stl')
    writeFileSync(path, 'solid one')
    const first = await fileContentHash(path)
    assert.equal(first.byteLength, 32)
    assert.deepEqual([...(await fileContentHash(path))], [...first])

    writeFileSync(path, 'solid two')
    assert.notDeepEqual([...(await fileContentHash(path))], [...first])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/files/classify.ts'`.

- [ ] **Step 4: Implement the zip reader**

`packages/core/src/files/zip.ts`. Reads the central directory rather than scanning forward, so
listing a 54 MB 3MF costs two small reads.

```ts
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { AppError } from '@spm/contract/errors.ts'

export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

function readAt(fd: number, position: number, length: number): Uint8Array {
  const buffer = new Uint8Array(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read)
    if (n === 0) break
    read += n
  }
  if (read !== length) throw new AppError('Validation', 'unexpected end of zip file')
  return buffer
}

export function readZipEntries(path: string): ZipEntry[] {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    if (size < EOCD_MIN) throw new AppError('Validation', 'file is too small to be a zip')

    const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT)
    const tail = readAt(fd, size - tailLength, tailLength)
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

    let eocd = -1
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tailView.getUint32(i, true) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new AppError('Validation', 'no zip end-of-central-directory record')

    const total = tailView.getUint16(eocd + 10, true)
    const cdSize = tailView.getUint32(eocd + 12, true)
    const cdOffset = tailView.getUint32(eocd + 16, true)
    if (cdOffset === 0xffffffff)
      throw new AppError('Validation', 'zip64 archives are not supported')

    const cd = readAt(fd, cdOffset, cdSize)
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const decoder = new TextDecoder()
    const entries: ZipEntry[] = []
    let p = 0

    for (let i = 0; i < total; i++) {
      if (view.getUint32(p, true) !== CD_SIG) {
        throw new AppError('Validation', 'corrupt zip central directory')
      }
      const nameLength = view.getUint16(p + 28, true)
      entries.push({
        method: view.getUint16(p + 10, true),
        compressedSize: view.getUint32(p + 20, true),
        uncompressedSize: view.getUint32(p + 24, true),
        localHeaderOffset: view.getUint32(p + 42, true),
        name: decoder.decode(cd.subarray(p + 46, p + 46 + nameLength)),
      })
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

export function findZipEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name)
}

export function readZipEntryBytes(path: string, entry: ZipEntry): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (view.getUint32(0, true) !== LOCAL_SIG) {
      throw new AppError('Validation', 'corrupt zip local header')
    }
    const dataOffset =
      entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
    const data = readAt(fd, dataOffset, entry.compressedSize)

    if (entry.method === 0) return data
    if (entry.method === 8) return new Uint8Array(inflateRawSync(data))
    throw new AppError('Validation', `unsupported zip compression method ${entry.method}`)
  } finally {
    closeSync(fd)
  }
}

export function readZipEntryText(path: string, entry: ZipEntry): string {
  return new TextDecoder().decode(readZipEntryBytes(path, entry))
}
```

- [ ] **Step 5: Implement the classifier**

`packages/core/src/files/classify.ts` — §3.4's algorithm, first match wins:

```ts
import type { FileKind, SlicerId } from '@spm/contract/dtos.ts'
import { findZipEntry, readZipEntries, readZipEntryText, type ZipEntry } from './zip.ts'

export type Classification = { kind: FileKind; slicer: SlicerId | null }

/**
 * Order is load-bearing (spec 3.4). OrcaSlicer's slice_info header is a SUPERSET of Bambu
 * Studio's — it keeps X-BBL-Client-Type and adds OrcaSlicer-Version — so Orca must be tested
 * first or every Orca project is labelled bambu. Another Orca derivative is one row above
 * X-BBL-Client-Type. Matching is on the KEY only; version values are never discriminators.
 */
export const SLICER_HEADER_REGISTRY: ReadonlyArray<{ key: string; slicer: SlicerId }> = [
  { key: 'X-ACNext-Client-Type', slicer: 'anycubic' },
  { key: 'OrcaSlicer-Version', slicer: 'orca' },
  { key: 'X-BBL-Client-Type', slicer: 'bambu' },
]

export function slicerFromSliceInfo(xml: string): SlicerId | null {
  const keys = new Set<string>()
  for (const match of xml.matchAll(/<header_item\s+key="([^"]+)"/g)) keys.add(match[1]!)
  for (const { key, slicer } of SLICER_HEADER_REGISTRY) if (keys.has(key)) return slicer
  return null
}

export function classify3mf(absPath: string): Classification {
  let entries: ZipEntry[]
  try {
    entries = readZipEntries(absPath)
  } catch {
    // A .3mf that is not a readable zip is not a model we can do anything with.
    return { kind: 'other', slicer: null }
  }

  // 1. Cura
  if (entries.some((entry) => entry.name.startsWith('Cura/'))) {
    return { kind: 'slicer_project', slicer: 'cura' }
  }
  // 2. PrusaSlicer
  if (findZipEntry(entries, 'Metadata/Slic3r_PE.config')) {
    return { kind: 'slicer_project', slicer: 'prusaslicer' }
  }
  // 3. Bambu lineage: identified only by the slice_info.config header items.
  const sliceInfo = findZipEntry(entries, 'Metadata/slice_info.config')
  if (sliceInfo) {
    let slicer: SlicerId | null = null
    try {
      slicer = slicerFromSliceInfo(readZipEntryText(absPath, sliceInfo))
    } catch {
      slicer = null
    }
    return { kind: 'slicer_project', slicer }
  }
  // 4. Saved but never sliced: still a project, slicer unknown rather than guessed.
  if (findZipEntry(entries, 'Metadata/project_settings.config')) {
    return { kind: 'slicer_project', slicer: null }
  }
  // 5. A plain 3MF mesh.
  return { kind: 'model', slicer: null }
}

export function classifyFile(absPath: string): Classification {
  const lower = absPath.toLowerCase()
  if (lower.endsWith('.stl') || lower.endsWith('.obj')) return { kind: 'model', slicer: null }
  if (lower.endsWith('.3mf')) return classify3mf(absPath)
  return { kind: 'other', slicer: null }
}
```

- [ ] **Step 6: Implement content hashing**

`packages/core/src/files/hash.ts`. `crypto.subtle.digest` cannot stream and a 54 MB 3MF must
not be buffered (§7.1), so this uses `node:crypto`'s streaming hash — a `node:` builtin, so
still runtime-agnostic.

```ts
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export async function fileContentHash(absPath: string): Promise<Uint8Array> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absPath)) {
    hash.update(chunk as Uint8Array)
  }
  return new Uint8Array(hash.digest())
}
```

- [ ] **Step 7: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 14 new tests passing under each. The Orca-over-Bambu test is the one that must never
be allowed to go red.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): zip reader, content-based 3MF slicer detection, streaming file hash"
```

---

### Task 8: `core/projects` — CRUD, tags, and the list query

**Files:**

- Create: `packages/core/src/projects/queries.ts`, `src/projects/usecases.ts`
- Test: `packages/core/test/projects.test.ts`

**Interfaces:**

- Consumes: `Library`, `Ctx`, `newId`, `projectDir`, `requireUserRow`, `AppError`, and the undecorated DTO types `CoreProjectDto` / `CoreProjectDetailDto` / `CoreFileDto` from `@spm/contract/dtos.ts`.
- Produces:
  - `src/projects/queries.ts`: `type ProjectRow`, `requireProjectRow(lib, ctx, id): ProjectRow`, `listProjects(lib, ctx, query: ProjectQuery): CoreProjectDto[]`, `getProject(lib, ctx, id): CoreProjectDetailDto`, `toCoreFileDto(row): CoreFileDto`
  - `src/projects/usecases.ts`: `sanitizeDirName(name): string`, `createProject(lib, ctx, input): CoreProjectDto`, `updateProject(lib, ctx, id, patch): CoreProjectDto`, `deleteProject(lib, ctx, id, opts): void`, `addTag(lib, ctx, id, name): void`, `removeTag(lib, ctx, id, name): void`

**Two semantics the spec leaves open, fixed here:**

- A `tags` filter is **AND**: a project must carry every tag listed. Filtering is for narrowing.
- The cover thumbnail prefers a **model** file's ready preview (§4.2) and falls back to a ready
  slicer-project thumbnail. Without the fallback, no grid tile would have a cover until spec B
  lands, because model previews stay `pending` in subsystem A (Decision 4).

- [ ] **Step 1: Write the failing test**

`packages/core/test/projects.test.ts`:

```ts
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { getProject, listProjects } from '../src/projects/queries.ts'
import {
  addTag,
  createProject,
  deleteProject,
  removeTag,
  sanitizeDirName,
  updateProject,
} from '../src/projects/usecases.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username: string): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  return { userId: id, isAdmin: false }
}

/** Adds a files row plus its preview row directly, standing in for a rescan. */
function seedFile(
  lib: Library,
  projectId: string,
  relPath: string,
  kind: 'model' | 'slicer_project' | 'other',
  previewState = 'pending',
): string {
  const id = newId()
  lib.db
    .prepare(
      'INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms) VALUES (?, ?, ?, ?, 100, 0)',
    )
    .run(id, projectId, relPath, kind)
  lib.db
    .prepare('INSERT INTO previews (file_id, state, updated_at) VALUES (?, ?, 0)')
    .run(id, previewState)
  return id
}

test('sanitizeDirName strips separators and trims', () => {
  assert.equal(sanitizeDirName('Gridfinity Bin'), 'Gridfinity Bin')
  assert.equal(sanitizeDirName('  a/b:c*d?  '), 'a-b-c-d')
  assert.equal(sanitizeDirName('...'), 'project')
})

test('createProject makes the folder and returns the DTO', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    assert.equal(project.name, 'Benchy')
    assert.equal(project.state, 'ok')
    assert.equal(project.isArchived, false)
    assert.deepEqual(project.tags, [])
    assert.deepEqual(project.fileCounts, { model: 0, slicerProject: 0, other: 0 })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy')))
  })
})

test('two projects with the same name get distinct folders', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: 'Benchy' })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy (2)')))
  })
})

test('createProject applies website, notes and tags', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, {
      name: 'Bracket',
      website: 'https://printables.com/model/1',
      notes: 'PETG only',
      tags: ['Functional', 'petg'],
    })
    assert.equal(project.website, 'https://printables.com/model/1')
    assert.deepEqual(project.tags, ['Functional', 'petg'])
  })
})

test('one user cannot see or fetch another user project', async () => {
  await withLibrary((lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const mine = createProject(lib, marc, { name: 'Benchy' })

    assert.deepEqual(listProjects(lib, anna, {}), [])
    assert.throws(
      () => getProject(lib, anna, mine.id),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
    assert.throws(() => updateProject(lib, anna, mine.id, { name: 'Stolen' }))
    assert.throws(() => deleteProject(lib, anna, mine.id, { deleteFiles: false }))
  })
})

test('updateProject patches only what is given and clears with null', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const created = createProject(lib, ctx, { name: 'Benchy', website: 'https://a.example' })
    const renamed = updateProject(lib, ctx, created.id, { name: 'Benchy v2' })
    assert.equal(renamed.name, 'Benchy v2')
    assert.equal(renamed.website, 'https://a.example')

    const cleared = updateProject(lib, ctx, created.id, { website: null, isArchived: true })
    assert.equal(cleared.website, undefined)
    assert.equal(cleared.isArchived, true)
    assert.ok(cleared.updatedAt >= created.updatedAt)
  })
})

test('renaming a project does not move its folder', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const created = createProject(lib, ctx, { name: 'Benchy' })
    updateProject(lib, ctx, created.id, { name: 'Something else' })
    // dir_name is independent of the display name, exactly as library_dir is of username.
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy')))
  })
})

test('deleteProject keeps the folder unless deleteFiles is set', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const keep = createProject(lib, ctx, { name: 'Keep' })
    const wipe = createProject(lib, ctx, { name: 'Wipe' })
    writeFileSync(join(lib.dir, 'marc', 'Wipe', 'a.stl'), 'solid')

    deleteProject(lib, ctx, keep.id, { deleteFiles: false })
    assert.ok(existsSync(join(lib.dir, 'marc', 'Keep')))

    deleteProject(lib, ctx, wipe.id, { deleteFiles: true })
    assert.equal(existsSync(join(lib.dir, 'marc', 'Wipe')), false)
    assert.deepEqual(listProjects(lib, ctx, {}), [])
  })
})

test('tags are per owner, case-insensitive, and cleaned up when orphaned', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })

    addTag(lib, ctx, project.id, 'Boat')
    addTag(lib, ctx, project.id, 'boat')
    assert.deepEqual(getProject(lib, ctx, project.id).tags, ['Boat'])

    removeTag(lib, ctx, project.id, 'BOAT')
    assert.deepEqual(getProject(lib, ctx, project.id).tags, [])
    const { n } = lib.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }
    assert.equal(n, 0)
  })
})

test('list filters by search across name, notes and tags', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: 'Bracket', notes: 'needs PETG' })
    const tagged = createProject(lib, ctx, { name: 'Bin' })
    addTag(lib, ctx, tagged.id, 'gridfinity')

    const names = (search: string) =>
      listProjects(lib, ctx, { search })
        .map((p) => p.name)
        .sort()
    assert.deepEqual(names('bench'), ['Benchy'])
    assert.deepEqual(names('PETG'), ['Bracket'])
    assert.deepEqual(names('GRIDFINITY'), ['Bin'])
    assert.deepEqual(names('nothing here'), [])
  })
})

test('a search term with LIKE wildcards is matched literally', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'Benchy' })
    createProject(lib, ctx, { name: '100% infill' })
    assert.deepEqual(
      listProjects(lib, ctx, { search: '%' }).map((p) => p.name),
      ['100% infill'],
    )
  })
})

test('a tags filter requires every tag', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const both = createProject(lib, ctx, { name: 'Both', tags: ['petg', 'functional'] })
    createProject(lib, ctx, { name: 'One', tags: ['petg'] })

    assert.deepEqual(
      listProjects(lib, ctx, { tags: ['petg', 'functional'] }).map((p) => p.id),
      [both.id],
    )
    assert.equal(listProjects(lib, ctx, { tags: ['petg'] }).length, 2)
  })
})

test('archived projects are hidden unless asked for', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Old' })
    updateProject(lib, ctx, project.id, { isArchived: true })

    assert.deepEqual(listProjects(lib, ctx, {}), [])
    assert.equal(listProjects(lib, ctx, { includeArchived: true }).length, 1)
  })
})

test('sort and direction are honoured', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    createProject(lib, ctx, { name: 'beta' })
    createProject(lib, ctx, { name: 'Alpha' })

    assert.deepEqual(
      listProjects(lib, ctx, { sort: 'name', dir: 'asc' }).map((p) => p.name),
      ['Alpha', 'beta'],
    )
    assert.deepEqual(
      listProjects(lib, ctx, { sort: 'name', dir: 'desc' }).map((p) => p.name),
      ['beta', 'Alpha'],
    )
  })
})

test('file counts and the cover file id come back on the list DTO', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    seedFile(lib, project.id, 'benchy.stl', 'model')
    seedFile(lib, project.id, 'notes.txt', 'other')
    const ready = seedFile(lib, project.id, 'benchy.3mf', 'slicer_project', 'ready')

    const [dto] = listProjects(lib, ctx, {})
    assert.deepEqual(dto!.fileCounts, { model: 1, slicerProject: 1, other: 1 })
    // No model preview is ready yet, so the slicer project thumbnail is the cover.
    assert.equal(dto!.coverFileId, ready)

    const modelReady = seedFile(lib, project.id, 'a-model.stl', 'model', 'ready')
    assert.equal(listProjects(lib, ctx, {})[0]!.coverFileId, modelReady)
  })
})

test('getProject returns its files with preview state', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib, 'marc')
    const project = createProject(lib, ctx, { name: 'Benchy' })
    seedFile(lib, project.id, 'benchy.stl', 'model')

    const detail = getProject(lib, ctx, project.id)
    assert.equal(detail.files.length, 1)
    assert.equal(detail.files[0]!.name, 'benchy.stl')
    assert.equal(detail.files[0]!.kind, 'model')
    assert.equal(detail.files[0]!.previewState, 'pending')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/projects/queries.ts'`.

- [ ] **Step 3: Implement the queries**

`packages/core/src/projects/queries.ts`:

```ts
import type {
  CoreFileDto,
  CoreProjectDetailDto,
  CoreProjectDto,
  FileKind,
  PreviewState,
  ProjectQuery,
  SlicerId,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Db, Library } from '../db/open.ts'

export type ProjectRow = {
  id: string
  owner_id: string
  name: string
  dir_name: string
  website: string | null
  notes: string | null
  is_archived: number
  state: 'ok' | 'missing'
  created_at: number
  updated_at: number
}

type FileRow = {
  id: string
  project_id: string
  rel_path: string
  kind: FileKind
  slicer: SlicerId | null
  size_bytes: number
  preview_state: PreviewState | null
}

const SORT_COLUMNS = {
  name: 'p.name COLLATE NOCASE',
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
} as const

/** Always scoped by ctx.userId: there is no unscoped variant to call by mistake (spec 2.2). */
export function requireProjectRow(lib: Library, ctx: Ctx, id: string): ProjectRow {
  const row = lib.db
    .prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
    .get(id, ctx.userId) as ProjectRow | undefined
  if (!row) throw new AppError('NotFound', 'project not found')
  return row
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/** % and _ are LIKE wildcards; a user searching for "100%" means the literal character. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function tagsByProject(db: Db, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT pt.project_id AS projectId, t.name AS name
       FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.project_id IN (${placeholders(ids.length)})
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all(...ids) as { projectId: string; name: string }[]
  for (const row of rows) {
    const list = map.get(row.projectId) ?? []
    list.push(row.name)
    map.set(row.projectId, list)
  }
  return map
}

function countsByProject(
  db: Db,
  ids: string[],
): Map<string, { model: number; slicerProject: number; other: number }> {
  const map = new Map<string, { model: number; slicerProject: number; other: number }>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT project_id AS projectId, kind, COUNT(*) AS n FROM files
       WHERE project_id IN (${placeholders(ids.length)}) GROUP BY project_id, kind`,
    )
    .all(...ids) as { projectId: string; kind: FileKind; n: number }[]
  for (const row of rows) {
    const entry = map.get(row.projectId) ?? { model: 0, slicerProject: 0, other: 0 }
    if (row.kind === 'model') entry.model = Number(row.n)
    else if (row.kind === 'slicer_project') entry.slicerProject = Number(row.n)
    else entry.other = Number(row.n)
    map.set(row.projectId, entry)
  }
  return map
}

/** Prefers a ready model preview, falls back to a ready slicer-project thumbnail. */
function coverByProject(db: Db, ids: string[]): Map<string, string> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT f.project_id AS projectId, f.id AS fileId
       FROM files f JOIN previews pv ON pv.file_id = f.id
       WHERE f.project_id IN (${placeholders(ids.length)}) AND pv.state = 'ready'
       ORDER BY (f.kind = 'model') DESC, f.rel_path COLLATE NOCASE`,
    )
    .all(...ids) as { projectId: string; fileId: string }[]
  for (const row of rows) if (!map.has(row.projectId)) map.set(row.projectId, row.fileId)
  return map
}

export function toCoreFileDto(row: FileRow): CoreFileDto {
  return {
    id: row.id,
    name: row.rel_path,
    kind: row.kind,
    ...(row.slicer ? { slicer: row.slicer } : {}),
    sizeBytes: Number(row.size_bytes),
    previewState: row.preview_state ?? 'pending',
  }
}

function toCoreProjectDto(
  row: ProjectRow,
  tags: string[],
  counts: { model: number; slicerProject: number; other: number },
  coverFileId: string | undefined,
): CoreProjectDto {
  return {
    id: row.id,
    name: row.name,
    ...(row.website ? { website: row.website } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    isArchived: row.is_archived === 1,
    state: row.state,
    tags,
    fileCounts: counts,
    ...(coverFileId ? { coverFileId } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listProjects(lib: Library, ctx: Ctx, query: ProjectQuery): CoreProjectDto[] {
  const where: string[] = ['p.owner_id = ?']
  const params: unknown[] = [ctx.userId]

  if (!query.includeArchived) where.push('p.is_archived = 0')

  if (query.search?.trim()) {
    const like = `%${escapeLike(query.search.trim())}%`
    where.push(
      `(p.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR IFNULL(p.notes, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (SELECT 1 FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
                   WHERE pt.project_id = p.id AND t.name LIKE ? ESCAPE '\\' COLLATE NOCASE))`,
    )
    params.push(like, like, like)
  }

  const tags = query.tags?.filter((t) => t.trim().length > 0) ?? []
  if (tags.length > 0) {
    // AND semantics: the project must carry every requested tag.
    where.push(
      `(SELECT COUNT(DISTINCT t.name COLLATE NOCASE) FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.project_id = p.id AND t.name COLLATE NOCASE IN (${placeholders(tags.length)})) = ?`,
    )
    params.push(...tags, tags.length)
  }

  const column = SORT_COLUMNS[query.sort ?? 'updatedAt']
  const direction = query.dir === 'asc' ? 'ASC' : 'DESC'

  const rows = lib.db
    .prepare(
      `SELECT p.* FROM projects p WHERE ${where.join(' AND ')} ORDER BY ${column} ${direction}`,
    )
    .all(...params) as ProjectRow[]

  const ids = rows.map((row) => row.id)
  const tagMap = tagsByProject(lib.db, ids)
  const countMap = countsByProject(lib.db, ids)
  const coverMap = coverByProject(lib.db, ids)

  return rows.map((row) =>
    toCoreProjectDto(
      row,
      tagMap.get(row.id) ?? [],
      countMap.get(row.id) ?? { model: 0, slicerProject: 0, other: 0 },
      coverMap.get(row.id),
    ),
  )
}

export function getProject(lib: Library, ctx: Ctx, id: string): CoreProjectDetailDto {
  const row = requireProjectRow(lib, ctx, id)
  const tags = tagsByProject(lib.db, [id]).get(id) ?? []
  const counts = countsByProject(lib.db, [id]).get(id) ?? { model: 0, slicerProject: 0, other: 0 }
  const cover = coverByProject(lib.db, [id]).get(id)

  const files = lib.db
    .prepare(
      `SELECT f.*, pv.state AS preview_state FROM files f
       LEFT JOIN previews pv ON pv.file_id = f.id
       WHERE f.project_id = ? ORDER BY f.rel_path COLLATE NOCASE`,
    )
    .all(id) as FileRow[]

  return {
    ...toCoreProjectDto(row, tags, counts, cover),
    files: files.map(toCoreFileDto),
  }
}
```

- [ ] **Step 4: Implement the use cases**

`packages/core/src/projects/usecases.ts`:

```ts
import { mkdirSync, rmSync } from 'node:fs'
import type { CoreProjectDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput, ProjectPatchInput } from '@spm/contract/schemas.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { projectDir } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'
import { getProject, requireProjectRow } from './queries.ts'

/** Folder names come from the project name but must survive every filesystem. */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'project'
}

function uniqueDirName(lib: Library, ctx: Ctx, base: string): string {
  const taken = lib.db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND dir_name = ?')
  let candidate = base
  for (let n = 2; taken.get(ctx.userId, candidate); n++) candidate = `${base} (${n})`
  return candidate
}

export function createProject(lib: Library, ctx: Ctx, input: CreateProjectInput): CoreProjectDto {
  const user = requireUserRow(lib.db, ctx.userId)
  const id = newId()
  const now = Date.now()
  const dirName = uniqueDirName(lib, ctx, sanitizeDirName(input.name))

  mkdirSync(projectDir(lib, user.library_dir, dirName), { recursive: true })
  lib.db
    .prepare(
      `INSERT INTO projects (id, owner_id, name, dir_name, website, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.userId, input.name, dirName, input.website ?? null, input.notes ?? null, now, now)

  for (const tag of input.tags ?? []) addTag(lib, ctx, id, tag)
  return getProject(lib, ctx, id)
}

export function updateProject(
  lib: Library,
  ctx: Ctx,
  id: string,
  patch: ProjectPatchInput,
): CoreProjectDto {
  requireProjectRow(lib, ctx, id)
  const sets: string[] = []
  const params: unknown[] = []

  // dir_name deliberately does not follow name: a rename must never move a folder.
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if (patch.website !== undefined) {
    sets.push('website = ?')
    params.push(patch.website)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    params.push(patch.notes)
  }
  if (patch.isArchived !== undefined) {
    sets.push('is_archived = ?')
    params.push(patch.isArchived ? 1 : 0)
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?')
    params.push(Date.now(), id, ctx.userId)
    lib.db
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
      .run(...params)
  }
  return getProject(lib, ctx, id)
}

export function deleteProject(
  lib: Library,
  ctx: Ctx,
  id: string,
  opts: { deleteFiles: boolean },
): void {
  const row = requireProjectRow(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  if (opts.deleteFiles) {
    rmSync(projectDir(lib, user.library_dir, row.dir_name), { recursive: true, force: true })
  }
  lib.db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, ctx.userId)
}

export function addTag(lib: Library, ctx: Ctx, projectId: string, name: string): void {
  requireProjectRow(lib, ctx, projectId)
  const trimmed = name.trim()
  if (!trimmed) return

  const existing = lib.db
    .prepare('SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.userId, trimmed) as { id: number } | undefined
  const tagId =
    existing?.id ??
    Number(
      lib.db
        .prepare('INSERT INTO tags (owner_id, name) VALUES (?, ?) RETURNING id')
        .get(ctx.userId, trimmed)!.id,
    )

  lib.db
    .prepare('INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)')
    .run(projectId, tagId)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)
}

export function removeTag(lib: Library, ctx: Ctx, projectId: string, name: string): void {
  requireProjectRow(lib, ctx, projectId)
  lib.db
    .prepare(
      `DELETE FROM project_tags WHERE project_id = ?
       AND tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE)`,
    )
    .run(projectId, ctx.userId, name.trim())
  // A tag that labels nothing is noise in the filter list.
  lib.db
    .prepare('DELETE FROM tags WHERE owner_id = ? AND id NOT IN (SELECT tag_id FROM project_tags)')
    .run(ctx.userId)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)
}
```

`INSERT ... RETURNING id` is used because `tags.id` is an `INTEGER PRIMARY KEY` and `RETURNING`
is portable across both runtimes' `node:sqlite`, unlike `lastInsertRowid` typing.

- [ ] **Step 5: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 16 new tests passing under each.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): project CRUD, tags and the scoped list query"
```

---

### Task 9: `core/projects` — rescan and reconciliation (§3.5)

Disk is the source of truth for which files exist; SQLite is the source of truth for metadata
(§3.2). This is the only place those two are reconciled, and §8.2 singles it out for test
attention: adopt, missing-folder, changed-file, and dot-folder skipping each get an explicit
case against a temp directory.

**Files:**

- Create: `packages/core/src/projects/rescan.ts`
- Test: `packages/core/test/rescan.test.ts`

**Interfaces:**

- Consumes: `Library`, `Ctx`, `newId`, `userRoot`, `requireUserRow`, `classifyFile`, `fileContentHash`, `sanitizeDirName`, `RescanResultDto`.
- Produces: `rescan(lib, ctx): Promise<RescanResultDto>`, `RELATIVE_PATH_SEPARATOR = '/'`

**`files.rel_path` is always stored with forward slashes**, whatever the host separator, so a
library copied between Windows and Linux keeps matching its rows.

- [ ] **Step 1: Write the failing test**

`packages/core/test/rescan.test.ts`:

```ts
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { listProjects } from '../src/projects/queries.ts'
import { rescan } from '../src/projects/rescan.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import { curaProject } from './fixtures/make-3mf.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  mkdirSync(join(lib.dir, username), { recursive: true })
  return { userId: id, isAdmin: false }
}

function root(lib: Library, username = 'marc'): string {
  return join(lib.dir, username)
}

test('a folder with no row is adopted, taking its name from the folder', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), 'Gridfinity Bin'))

    const result = await rescan(lib, ctx)
    assert.equal(result.adopted, 1)
    const [project] = listProjects(lib, ctx, {})
    assert.equal(project!.name, 'Gridfinity Bin')
    assert.equal(project!.state, 'ok')
  })
})

test('dot-folders are skipped at every level', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), '.git'), { recursive: true })
    mkdirSync(join(root(lib), 'Benchy', '.cache'), { recursive: true })
    writeFileSync(join(root(lib), 'Benchy', '.cache', 'junk.stl'), 'solid')
    writeFileSync(join(root(lib), 'Benchy', '.hidden.stl'), 'solid')
    writeFileSync(join(root(lib), 'Benchy', 'benchy.stl'), 'solid')

    await rescan(lib, ctx)
    const names = listProjects(lib, ctx, {}).map((p) => p.name)
    assert.deepEqual(names, ['Benchy'])
    const rows = lib.db.prepare('SELECT rel_path FROM files').all() as { rel_path: string }[]
    assert.deepEqual(
      rows.map((r) => r.rel_path),
      ['benchy.stl'],
    )
  })
})

test('the .spm folder is never adopted, even in a flat library', async () => {
  await withLibrary(async (lib) => {
    const id = newId()
    lib.db
      .prepare(
        `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
         VALUES (?, 'local', 'Local', '.', 0, 'active', 0)`,
      )
      .run(id)
    mkdirSync(join(lib.dir, 'Benchy'))

    await rescan(lib, { userId: id, isAdmin: false })
    assert.deepEqual(
      listProjects(lib, { userId: id, isAdmin: false }, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('files are indexed with their classification and a pending preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid benchy')
    writeFileSync(join(dir, 'notes.txt'), 'PETG')
    curaProject(join(dir, 'benchy.3mf'))

    const result = await rescan(lib, ctx)
    assert.equal(result.filesAdded, 3)
    assert.equal(result.previewsQueued, 3)

    const rows = lib.db
      .prepare('SELECT rel_path, kind, slicer FROM files ORDER BY rel_path')
      .all() as { rel_path: string; kind: string; slicer: string | null }[]
    assert.deepEqual(rows, [
      { rel_path: 'benchy.3mf', kind: 'slicer_project', slicer: 'cura' },
      { rel_path: 'benchy.stl', kind: 'model', slicer: null },
      { rel_path: 'notes.txt', kind: 'other', slicer: null },
    ])
    const { n } = lib.db
      .prepare("SELECT COUNT(*) AS n FROM previews WHERE state = 'pending'")
      .get() as {
      n: number
    }
    assert.equal(n, 3)
  })
})

test('nested files keep a forward-slash relative path', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    mkdirSync(join(root(lib), 'Benchy', 'variants'), { recursive: true })
    writeFileSync(join(root(lib), 'Benchy', 'variants', 'small.stl'), 'solid')

    await rescan(lib, ctx)
    const { rel_path } = lib.db.prepare('SELECT rel_path FROM files').get() as { rel_path: string }
    assert.equal(rel_path, 'variants/small.stl')
  })
})

test('a project whose folder disappeared is marked missing and keeps its files', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)

    rmSync(dir, { recursive: true, force: true })
    const result = await rescan(lib, ctx)

    assert.equal(result.markedMissing, 1)
    assert.equal(result.filesRemoved, 0)
    const [project] = listProjects(lib, ctx, {})
    assert.equal(project!.state, 'missing')
    // The drive may simply be unmounted: a thousand tags must not evaporate.
    assert.equal(project!.fileCounts.model, 1)
  })
})

test('a folder that comes back is marked ok again', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    await rescan(lib, ctx)
    rmSync(dir, { recursive: true, force: true })
    await rescan(lib, ctx)
    mkdirSync(dir)

    await rescan(lib, ctx)
    assert.equal(listProjects(lib, ctx, {})[0]!.state, 'ok')
  })
})

test('a file removed from a present project loses its row and preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)

    rmSync(join(dir, 'benchy.stl'))
    const result = await rescan(lib, ctx)

    assert.equal(result.filesRemoved, 1)
    const { files, previews } = lib.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM previews) AS previews',
      )
      .get() as { files: number; previews: number }
    assert.equal(files, 0)
    assert.equal(previews, 0)
  })
})

test('a changed file resets its preview to pending and updates its hash', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    const file = join(dir, 'benchy.stl')
    writeFileSync(file, 'solid one')
    await rescan(lib, ctx)

    // Stand in for a finished preview so the reset is observable.
    lib.db.prepare("UPDATE previews SET state = 'ready', source_hash = X'00'").run()

    writeFileSync(file, 'solid one but longer now')
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 1)
    const row = lib.db.prepare('SELECT state FROM previews').get() as { state: string }
    assert.equal(row.state, 'pending')
    const file_row = lib.db.prepare('SELECT content_hash, size_bytes FROM files').get() as {
      content_hash: Uint8Array
      size_bytes: number
    }
    assert.equal(file_row.size_bytes, 'solid one but longer now'.length)
    assert.equal(file_row.content_hash.byteLength, 32)
  })
})

test('an untouched file is not re-queued', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    await rescan(lib, ctx)
    lib.db.prepare("UPDATE previews SET state = 'ready'").run()

    const result = await rescan(lib, ctx)
    assert.equal(result.previewsQueued, 0)
    assert.equal(result.filesAdded, 0)
    assert.equal(
      (lib.db.prepare('SELECT state FROM previews').get() as { state: string }).state,
      'ready',
    )
  })
})

test('rescan indexes files even when the user is over quota', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    lib.db.prepare('UPDATE users SET quota_bytes = 1 WHERE id = ?').run(ctx.userId)
    const dir = join(root(lib), 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid and definitely over one byte')

    // Refusing to index existing files would hide a user's own files from them (5.6).
    const result = await rescan(lib, ctx)
    assert.equal(result.filesAdded, 1)
  })
})

test('rescan only ever touches the calling user library', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    mkdirSync(join(root(lib, 'anna'), 'Bin'))

    const result = await rescan(lib, marc)
    assert.equal(result.adopted, 0)
    assert.equal((await rescan(lib, anna)).adopted, 1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/projects/rescan.ts'`.

- [ ] **Step 3: Implement reconciliation**

`packages/core/src/projects/rescan.ts`:

```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { classifyFile } from '../files/classify.ts'
import { fileContentHash } from '../files/hash.ts'
import { userRoot } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'

export const RELATIVE_PATH_SEPARATOR = '/'

type DiskFile = { relPath: string; absPath: string; size: number; mtimeMs: number }

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** Depth-first walk that skips dot-entries at every level (spec 3.1, 3.5). */
function walkFiles(dir: string, prefix = ''): DiskFile[] {
  const found: DiskFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue
    const absPath = join(dir, entry.name)
    const relPath = prefix ? `${prefix}${RELATIVE_PATH_SEPARATOR}${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...walkFiles(absPath, relPath))
    } else if (entry.isFile()) {
      const stat = statSync(absPath)
      found.push({ relPath, absPath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    }
  }
  return found
}

function listProjectFolders(root: string): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // The library root itself is missing: report nothing rather than deleting.
  }
  return entries.filter((e) => e.isDirectory() && !isHidden(e.name)).map((e) => e.name)
}

export async function rescan(lib: Library, ctx: Ctx): Promise<RescanResultDto> {
  const user = requireUserRow(lib.db, ctx.userId)
  const root = userRoot(lib, user.library_dir)
  const now = Date.now()
  const result: RescanResultDto = {
    adopted: 0,
    markedMissing: 0,
    filesAdded: 0,
    filesRemoved: 0,
    previewsQueued: 0,
  }

  const onDisk = new Set(listProjectFolders(root))
  const rows = lib.db
    .prepare('SELECT id, dir_name, state FROM projects WHERE owner_id = ?')
    .all(ctx.userId) as { id: string; dir_name: string; state: string }[]
  const byDirName = new Map(rows.map((row) => [row.dir_name, row]))

  // Adopt every folder with no row.
  for (const dirName of onDisk) {
    if (byDirName.has(dirName)) continue
    const id = newId()
    lib.db
      .prepare(
        `INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.userId, dirName, dirName, now, now)
    byDirName.set(dirName, { id, dir_name: dirName, state: 'ok' })
    result.adopted++
  }

  const insertFile = lib.db.prepare(
    `INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertPreview = lib.db.prepare(
    "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)",
  )
  const resetPreview = lib.db.prepare(
    `UPDATE previews SET state = 'pending', source = NULL, png_path = NULL, width = NULL,
                         height = NULL, error = NULL, attempts = 0, updated_at = ?
     WHERE file_id = ?`,
  )

  for (const row of byDirName.values()) {
    if (!onDisk.has(row.dir_name)) {
      // Never delete metadata implicitly; the drive may just be unmounted (3.5).
      if (row.state !== 'missing') {
        lib.db
          .prepare("UPDATE projects SET state = 'missing', updated_at = ? WHERE id = ?")
          .run(now, row.id)
        result.markedMissing++
      }
      continue
    }
    if (row.state !== 'ok') {
      lib.db
        .prepare("UPDATE projects SET state = 'ok', updated_at = ? WHERE id = ?")
        .run(now, row.id)
    }

    const files = walkFiles(join(root, row.dir_name))
    const seen = new Set(files.map((file) => file.relPath))
    const existing = new Map(
      (
        lib.db
          .prepare('SELECT id, rel_path, size_bytes, mtime_ms FROM files WHERE project_id = ?')
          .all(row.id) as { id: string; rel_path: string; size_bytes: number; mtime_ms: number }[]
      ).map((f) => [f.rel_path, f]),
    )

    for (const file of files) {
      const known = existing.get(file.relPath)
      if (!known) {
        const id = newId()
        const classification = classifyFile(file.absPath)
        insertFile.run(
          id,
          row.id,
          file.relPath,
          classification.kind,
          classification.slicer,
          file.size,
          file.mtimeMs,
          await fileContentHash(file.absPath),
        )
        insertPreview.run(id, now)
        result.filesAdded++
        result.previewsQueued++
        continue
      }

      if (Number(known.size_bytes) === file.size && Number(known.mtime_ms) === file.mtimeMs)
        continue

      // Cheap stat mismatch, so pay for the hash and reclassify: a saved 3MF can change slicer.
      const hash = await fileContentHash(file.absPath)
      const classification = classifyFile(file.absPath)
      lib.db
        .prepare(
          'UPDATE files SET kind = ?, slicer = ?, size_bytes = ?, mtime_ms = ?, content_hash = ? WHERE id = ?',
        )
        .run(classification.kind, classification.slicer, file.size, file.mtimeMs, hash, known.id)

      const preview = lib.db
        .prepare('SELECT source_hash FROM previews WHERE file_id = ?')
        .get(known.id) as { source_hash: Uint8Array | null } | undefined
      const sameSource =
        preview?.source_hash != null &&
        preview.source_hash.length === hash.length &&
        preview.source_hash.every((byte, i) => byte === hash[i])
      if (!sameSource) {
        if (preview) resetPreview.run(now, known.id)
        else insertPreview.run(known.id, now)
        result.previewsQueued++
      }
    }

    for (const [relPath, known] of existing) {
      if (seen.has(relPath)) continue
      lib.db.prepare('DELETE FROM files WHERE id = ?').run(known.id)
      result.filesRemoved++
    }
  }

  return result
}
```

Quota is never consulted here: files already on disk are indexed regardless and the user is
simply reported over quota (§5.6).

- [ ] **Step 4: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 12 new tests passing under each.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): rescan reconciles disk against the index"
```

---

### Task 10: `core/files` — upload, rename, delete, and quota enforcement (§5.6)

**Files:**

- Create: `packages/core/src/files/usecases.ts`
- Test: `packages/core/test/files.test.ts`

**Interfaces:**

- Consumes: `Library`, `Ctx`, `newId`, `safeJoin`, `projectDir`, `previewPath`, `classifyFile`, `fileContentHash`, `requireProjectRow`, `toCoreFileDto`, `requireUserRow`, `diskUsageBytes`, `AppError`, `QuotaExceededDetails`, `RELATIVE_PATH_SEPARATOR`.
- Produces:
  - `assertWithinQuota(lib, ctx, incomingBytes): void`
  - `uploadFile(lib, ctx, projectId, name, body: { stream: ReadableStream<Uint8Array>; sizeBytes: number }): Promise<CoreFileDto>`
  - `renameFile(lib, ctx, id, name): CoreFileDto`
  - `deleteFile(lib, ctx, id): void`
  - `resolveFilePath(lib, ctx, id): { absPath: string; name: string; sizeBytes: number; contentType: string }`
  - `resolvePreviewPath(lib, ctx, fileId): { absPath: string } | null`
  - `contentTypeFor(name): string`

`resolveFilePath` and `resolvePreviewPath` are the two `core` functions that live outside
`ApiClient` (Decision 11): a transport needs an absolute path to stream bytes, and bulk bytes
never cross a JSON boundary (§4.2). Both are still `ctx`-scoped.

- [ ] **Step 1: Write the failing test**

`packages/core/test/files.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import type { QuotaExceededDetails } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import {
  assertWithinQuota,
  contentTypeFor,
  deleteFile,
  renameFile,
  resolveFilePath,
  uploadFile,
} from '../src/files/usecases.ts'
import { createProject } from '../src/projects/usecases.ts'
import { getProject } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  return { userId: id, isAdmin: false }
}

function streamOf(text: string): { stream: ReadableStream<Uint8Array>; sizeBytes: number } {
  const bytes = new TextEncoder().encode(text)
  return {
    sizeBytes: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

test('contentTypeFor maps the formats this app cares about', () => {
  assert.equal(contentTypeFor('a.stl'), 'model/stl')
  assert.equal(contentTypeFor('a.3MF'), 'model/3mf')
  assert.equal(contentTypeFor('a.png'), 'image/png')
  assert.equal(contentTypeFor('a.weird'), 'application/octet-stream')
})

test('upload writes the file, indexes it and queues a preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })

    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid benchy'))
    assert.equal(dto.name, 'benchy.stl')
    assert.equal(dto.kind, 'model')
    assert.equal(dto.previewState, 'pending')
    assert.equal(dto.sizeBytes, 'solid benchy'.length)

    const onDisk = join(lib.dir, 'marc', 'Benchy', 'benchy.stl')
    assert.equal(readFileSync(onDisk, 'utf8'), 'solid benchy')
    assert.equal(getProject(lib, ctx, project.id).files.length, 1)
  })
})

test('upload refuses a duplicate name in the same project', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid again')),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('upload refuses a path segment in the file name', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, '../escape.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'Forbidden',
    )
  })
})

test('upload into another user project is a NotFound', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const project = createProject(lib, marc, { name: 'Benchy' })
    await assert.rejects(
      () => uploadFile(lib, anna, project.id, 'a.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
  })
})

test('upload into a missing project is refused', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    lib.db.prepare("UPDATE projects SET state = 'missing' WHERE id = ?").run(project.id)
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'a.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('a null quota means unlimited', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib)
    assertWithinQuota(lib, ctx, Number.MAX_SAFE_INTEGER)
  })
})

test('quota is checked before writing and reports the numbers', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    lib.db.prepare('UPDATE users SET quota_bytes = 100 WHERE id = ?').run(ctx.userId)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await uploadFile(lib, ctx, project.id, 'a.stl', streamOf('x'.repeat(90)))

    let caught: AppError | undefined
    try {
      await uploadFile(lib, ctx, project.id, 'b.stl', streamOf('x'.repeat(20)))
    } catch (error) {
      caught = error as AppError
    }
    assert.equal(caught?.code, 'QuotaExceeded')
    const details = caught?.details as QuotaExceededDetails
    assert.deepEqual(details, { usageBytes: 90, quotaBytes: 100, incomingBytes: 20 })
    // Nothing was written.
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'b.stl')), false)
  })
})

test('a body longer than its declared size is rejected and cleaned up', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const body = streamOf('x'.repeat(50))

    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'a.stl', { stream: body.stream, sizeBytes: 10 }),
      (e: unknown) => (e as AppError).code === 'Validation',
    )
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'a.stl')), false)
    assert.equal(getProject(lib, ctx, project.id).files.length, 0)
  })
})

test('rename moves the file on disk and keeps its folder', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    const renamed = renameFile(lib, ctx, dto.id, 'benchy-v2.stl')
    assert.equal(renamed.name, 'benchy-v2.stl')
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy-v2.stl')))
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy.stl')), false)
  })
})

test('rename onto an existing name is a conflict', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const a = await uploadFile(lib, ctx, project.id, 'a.stl', streamOf('solid'))
    await uploadFile(lib, ctx, project.id, 'b.stl', streamOf('solid'))
    assert.throws(
      () => renameFile(lib, ctx, a.id, 'b.stl'),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('delete removes the bytes, the row and the preview png', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    const png = join(lib.dir, '.spm', 'previews', `${dto.id}.png`)
    writeFileSync(png, 'not really a png')
    lib.db
      .prepare("UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?")
      .run(`.spm/previews/${dto.id}.png`, dto.id)

    deleteFile(lib, ctx, dto.id)
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy.stl')), false)
    assert.equal(existsSync(png), false)
    assert.equal(getProject(lib, ctx, project.id).files.length, 0)
  })
})

test('resolveFilePath is scoped to the owner', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const project = createProject(lib, marc, { name: 'Benchy' })
    const dto = await uploadFile(lib, marc, project.id, 'benchy.stl', streamOf('solid'))

    const resolved = resolveFilePath(lib, marc, dto.id)
    assert.equal(resolved.absPath, join(lib.dir, 'marc', 'Benchy', 'benchy.stl'))
    assert.equal(resolved.contentType, 'model/stl')
    assert.equal(resolved.sizeBytes, 5)

    assert.throws(
      () => resolveFilePath(lib, anna, dto.id),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/files/usecases.ts'`.

- [ ] **Step 3: Implement the file use cases**

`packages/core/src/files/usecases.ts`:

```ts
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreFileDto, FileKind, PreviewState, SlicerId } from '@spm/contract/dtos.ts'
import { AppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { RELATIVE_PATH_SEPARATOR } from '../projects/rescan.ts'
import { requireProjectRow, toCoreFileDto } from '../projects/queries.ts'
import { requireUserRow } from '../users/repo.ts'
import { diskUsageBytes } from '../users/usage.ts'
import { classifyFile } from './classify.ts'
import { fileContentHash } from './hash.ts'
import { previewPath, projectDir, safeJoin } from './paths.ts'

const CONTENT_TYPES: Record<string, string> = {
  stl: 'model/stl',
  obj: 'model/obj',
  '3mf': 'model/3mf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  gcode: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
}

export function contentTypeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

type FileRowFull = {
  id: string
  project_id: string
  rel_path: string
  kind: FileKind
  slicer: SlicerId | null
  size_bytes: number
  preview_state: PreviewState | null
}

/** Joined against projects so ownership is part of the lookup, never a later check. */
function requireOwnedFile(lib: Library, ctx: Ctx, id: string): FileRowFull & { dir_name: string } {
  const row = lib.db
    .prepare(
      `SELECT f.*, pv.state AS preview_state, p.dir_name AS dir_name
       FROM files f
       JOIN projects p ON p.id = f.project_id
       LEFT JOIN previews pv ON pv.file_id = f.id
       WHERE f.id = ? AND p.owner_id = ?`,
    )
    .get(id, ctx.userId) as (FileRowFull & { dir_name: string }) | undefined
  if (!row) throw new AppError('NotFound', 'file not found')
  return row
}

/** Throws QuotaExceeded with the numbers the UI needs to render a real message (5.6). */
export function assertWithinQuota(lib: Library, ctx: Ctx, incomingBytes: number): void {
  const user = requireUserRow(lib.db, ctx.userId)
  if (user.quota_bytes === null) return
  const usageBytes = diskUsageBytes(lib.db, ctx.userId)
  if (usageBytes + incomingBytes <= user.quota_bytes) return
  const details: QuotaExceededDetails = {
    usageBytes,
    quotaBytes: user.quota_bytes,
    incomingBytes,
  }
  throw new AppError('QuotaExceeded', 'storage quota exceeded', details)
}

export async function uploadFile(
  lib: Library,
  ctx: Ctx,
  projectId: string,
  name: string,
  body: { stream: ReadableStream<Uint8Array>; sizeBytes: number },
): Promise<CoreFileDto> {
  const project = requireProjectRow(lib, ctx, projectId)
  if (project.state !== 'ok') {
    throw new AppError('Conflict', 'project folder is missing on disk')
  }
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, project.dir_name)
  // safeJoin rejects separators and traversal before anything is opened.
  const absPath = safeJoin(dir, name)

  const clash = lib.db
    .prepare('SELECT 1 FROM files WHERE project_id = ? AND rel_path = ?')
    .get(projectId, name)
  if (clash || existsSync(absPath)) throw new AppError('Conflict', `"${name}" already exists`)

  assertWithinQuota(lib, ctx, body.sizeBytes)

  const handle = await open(absPath, 'wx')
  try {
    const reader = body.stream.getReader()
    let written = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (written > body.sizeBytes) {
        throw new AppError('Validation', 'upload body is larger than its declared size')
      }
      await handle.write(value)
    }
  } catch (error) {
    await handle.close()
    rmSync(absPath, { force: true })
    throw error
  }
  await handle.close()

  const id = newId()
  const stat = statSync(absPath)
  const classification = classifyFile(absPath)
  lib.db
    .prepare(
      `INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      name,
      classification.kind,
      classification.slicer,
      stat.size,
      Math.round(stat.mtimeMs),
      await fileContentHash(absPath),
    )
  lib.db
    .prepare("INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)")
    .run(id, Date.now())
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)

  return toCoreFileDto({
    id,
    project_id: projectId,
    rel_path: name,
    kind: classification.kind,
    slicer: classification.slicer,
    size_bytes: stat.size,
    preview_state: 'pending',
  })
}

export function renameFile(lib: Library, ctx: Ctx, id: string, name: string): CoreFileDto {
  const row = requireOwnedFile(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, row.dir_name)

  const segments = row.rel_path.split(RELATIVE_PATH_SEPARATOR)
  const currentName = segments.pop()!
  const from = safeJoin(dir, ...segments, currentName)
  const to = safeJoin(dir, ...segments, name)
  const newRelPath = [...segments, name].join(RELATIVE_PATH_SEPARATOR)

  const clash = lib.db
    .prepare('SELECT 1 FROM files WHERE project_id = ? AND rel_path = ? AND id <> ?')
    .get(row.project_id, newRelPath, id)
  if (clash || existsSync(to)) throw new AppError('Conflict', `"${name}" already exists`)

  renameSync(from, to)
  lib.db.prepare('UPDATE files SET rel_path = ? WHERE id = ?').run(newRelPath, id)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), row.project_id)

  return toCoreFileDto({ ...row, rel_path: newRelPath })
}

export function deleteFile(lib: Library, ctx: Ctx, id: string): void {
  const row = requireOwnedFile(lib, ctx, id)
  const { absPath } = resolveFilePath(lib, ctx, id)
  rmSync(absPath, { force: true })
  rmSync(previewPath(lib, id), { force: true })
  lib.db.prepare('DELETE FROM files WHERE id = ?').run(id)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), row.project_id)
}

export function resolveFilePath(
  lib: Library,
  ctx: Ctx,
  id: string,
): { absPath: string; name: string; sizeBytes: number; contentType: string } {
  const row = requireOwnedFile(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, row.dir_name)
  const segments = row.rel_path.split(RELATIVE_PATH_SEPARATOR)
  const name = segments[segments.length - 1]!
  return {
    absPath: safeJoin(dir, ...segments),
    name,
    sizeBytes: Number(row.size_bytes),
    contentType: contentTypeFor(name),
  }
}

export function resolvePreviewPath(
  lib: Library,
  ctx: Ctx,
  fileId: string,
): { absPath: string } | null {
  requireOwnedFile(lib, ctx, fileId)
  const row = lib.db
    .prepare("SELECT png_path FROM previews WHERE file_id = ? AND state = 'ready'")
    .get(fileId) as { png_path: string | null } | undefined
  if (!row?.png_path) return null
  const absPath = join(lib.dir, ...row.png_path.split(RELATIVE_PATH_SEPARATOR))
  return existsSync(absPath) ? { absPath } : null
}
```

- [ ] **Step 4: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 13 new tests passing under each.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): file upload with quota enforcement, rename, delete, path resolution"
```

---

### Task 11: `core/previews` — embedded thumbnail extraction and the queue

§7.1's measurement reframes the pipeline: all five slicers embed a usable thumbnail, so
extraction covers essentially every project file and lands first. The rasterizer — needed only
for `.stl`, `.obj`, and plain 3MF meshes — is spec B. This task builds the extractor, the state
machine, and the bounded queue B plugs a second handler into.

**Files:**

- Create: `packages/core/src/previews/png.ts`, `src/previews/embedded.ts`, `src/previews/queue.ts`
- Test: `packages/core/test/fixtures/make-png.ts`, `packages/core/test/previews.test.ts`

**Interfaces:**

- Consumes: `Library`, `readZipEntries`, `findZipEntry`, `readZipEntryBytes`, `previewPath`, `RELATIVE_PATH_SEPARATOR`, `SlicerId`.
- Produces:
  - `src/previews/png.ts`: `readPngSize(bytes): { width: number; height: number } | null`
  - `src/previews/embedded.ts`: `EMBEDDED_THUMBNAIL_ENTRIES: readonly string[]`, `extractEmbeddedThumbnail(absPath): { bytes: Uint8Array; width: number; height: number } | null`
  - `src/previews/queue.ts`: `type PreviewJob = { fileId: string; absPath: string; kind: FileKind; contentHash: Uint8Array | null }`, `type PreviewOutput = { bytes: Uint8Array; width: number; height: number; source: 'embedded' | 'rasterized' }`, `type PreviewHandler = { kinds: readonly FileKind[]; run(job: PreviewJob): Promise<PreviewOutput | null> }`, `MAX_PREVIEW_ATTEMPTS = 3`, `DEFAULT_CONCURRENCY = 2`, `EMBEDDED_HANDLER: PreviewHandler`, `claimPendingPreviews(lib, handlers, limit): PreviewJob[]`, `runPreviewQueue(lib, opts?): Promise<{ ready: number; failed: number; unsupported: number }>`
- `test/fixtures/make-png.ts`: `makePng(width, height): Uint8Array`

- [ ] **Step 1: Write the PNG fixture builder**

`packages/core/test/fixtures/make-png.ts` — a real, valid PNG so the extractor's IHDR read is
tested against the actual format rather than a stub:

```ts
import { deflateSync } from 'node:zlib'
import { concatBytes, crc32 } from './make-3mf.ts'

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(concatBytes([typeBytes, data])))
  return out
}

/** A valid all-black 8-bit RGB PNG of the requested size. */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // Each scanline is one filter byte followed by width RGB triples; zeros are fine.
  const raw = new Uint8Array((width * 3 + 1) * height)
  return concatBytes([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ])
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/previews.test.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import { extractEmbeddedThumbnail } from '../src/previews/embedded.ts'
import { readPngSize } from '../src/previews/png.ts'
import {
  MAX_PREVIEW_ATTEMPTS,
  claimPendingPreviews,
  runPreviewQueue,
  EMBEDDED_HANDLER,
} from '../src/previews/queue.ts'
import { rescan } from '../src/projects/rescan.ts'
import { getProject, listProjects } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'
import {
  bambuLineageProject,
  curaProject,
  plainMesh3mf,
  prusaProject,
  writeZip,
} from './fixtures/make-3mf.ts'
import { makePng } from './fixtures/make-png.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  mkdirSync(join(lib.dir, username), { recursive: true })
  return { userId: id, isAdmin: false }
}

test('readPngSize reads IHDR and rejects non-PNG bytes', () => {
  assert.deepEqual(readPngSize(makePng(300, 200)), { width: 300, height: 200 })
  assert.equal(readPngSize(new TextEncoder().encode('not a png at all really')), null)
  assert.equal(readPngSize(new Uint8Array(4)), null)
})

test('the Cura thumbnail is extracted at its measured size', async () => {
  await withLibrary((lib) => {
    const path = join(lib.dir, 'marc', 'a.3mf')
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    curaProject(path, makePng(300, 300))
    const found = extractEmbeddedThumbnail(path)
    assert.deepEqual({ width: found!.width, height: found!.height }, { width: 300, height: 300 })
  })
})

test('the PrusaSlicer thumbnail is extracted', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    prusaProject(path, makePng(256, 256))
    assert.equal(extractEmbeddedThumbnail(path)!.width, 256)
  })
})

test('the Bambu lineage uses plate_1.png, not its smaller or unlit siblings', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    writeZip(path, [
      { name: 'Metadata/slice_info.config', data: '<config><header/></config>' },
      { name: 'Metadata/plate_1_small.png', data: makePng(128, 128) },
      { name: 'Metadata/plate_no_light_1.png', data: makePng(512, 512) },
      { name: 'Metadata/top_1.png', data: makePng(512, 512) },
      { name: 'Metadata/pick_1.png', data: makePng(512, 512) },
      { name: 'Metadata/plate_1.png', data: makePng(511, 509) },
    ])
    // 511x509 is deliberately unique so only plate_1.png can satisfy this assertion.
    assert.deepEqual(
      (({ width, height }) => ({ width, height }))(extractEmbeddedThumbnail(path)!),
      { width: 511, height: 509 },
    )
  })
})

test('a project file with no embedded thumbnail yields null', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'marc'), { recursive: true })
    const path = join(lib.dir, 'marc', 'a.3mf')
    bambuLineageProject(path, ['X-BBL-Client-Type'])
    assert.equal(extractEmbeddedThumbnail(path), null)
  })
})

test('the queue only claims kinds a handler covers', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    curaProject(join(dir, 'benchy.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const claimed = claimPendingPreviews(lib, [EMBEDDED_HANDLER], 10)
    assert.deepEqual(
      claimed.map((job) => job.kind),
      ['slicer_project'],
    )
  })
})

test('running the queue makes a slicer project preview ready and writes the png', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'benchy.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const counts = await runPreviewQueue(lib)
    assert.deepEqual(counts, { ready: 1, failed: 0, unsupported: 0 })

    const row = lib.db
      .prepare('SELECT file_id, state, source, png_path, width, height, source_hash FROM previews')
      .get() as {
      file_id: string
      state: string
      source: string
      png_path: string
      width: number
      height: number
      source_hash: Uint8Array
    }
    assert.equal(row.state, 'ready')
    assert.equal(row.source, 'embedded')
    assert.equal(row.width, 300)
    assert.equal(row.png_path, `.spm/previews/${row.file_id}.png`)
    assert.ok(existsSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)))
    assert.equal(
      readPngSize(readFileSync(join(lib.dir, '.spm', 'previews', `${row.file_id}.png`)))!.width,
      300,
    )
    assert.equal(row.source_hash.byteLength, 32)

    // The ready preview becomes the project cover.
    assert.equal(listProjects(lib, ctx, {})[0]!.coverFileId, row.file_id)
    assert.equal(
      getProject(lib, ctx, listProjects(lib, ctx, {})[0]!.id).files[0]!.previewState,
      'ready',
    )
  })
})

test('a project file with no thumbnail is unsupported, not failed', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    bambuLineageProject(join(dir, 'a.3mf'), ['X-BBL-Client-Type'])
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib), { ready: 0, failed: 0, unsupported: 1 })
    // Deterministic absence, so it is never retried.
    assert.equal(
      (lib.db.prepare('SELECT state FROM previews').get() as { state: string }).state,
      'unsupported',
    )
  })
})

test('model files stay pending until a rasterizer handler exists', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'benchy.stl'), 'solid')
    plainMesh3mf(join(dir, 'mesh.3mf'))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib), { ready: 0, failed: 0, unsupported: 0 })
    const states = (lib.db.prepare('SELECT state FROM previews').all() as { state: string }[]).map(
      (r) => r.state,
    )
    assert.deepEqual(states, ['pending', 'pending'])
  })
})

test('a handler that throws fails the row and stops after MAX_PREVIEW_ATTEMPTS', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    curaProject(join(dir, 'a.3mf'), makePng(300, 300))
    await rescan(lib, ctx)

    const exploding = {
      kinds: ['slicer_project'] as const,
      run: () => Promise.reject(new Error('boom')),
    }
    for (let i = 0; i < MAX_PREVIEW_ATTEMPTS; i++) {
      // Rows are re-queued between attempts so the retry budget is what bounds the loop.
      lib.db.prepare("UPDATE previews SET state = 'pending'").run()
      await runPreviewQueue(lib, { handlers: [exploding] })
    }
    const row = lib.db.prepare('SELECT state, attempts, error FROM previews').get() as {
      state: string
      attempts: number
      error: string
    }
    assert.equal(row.state, 'failed')
    assert.equal(row.attempts, MAX_PREVIEW_ATTEMPTS)
    assert.match(row.error, /boom/)

    lib.db.prepare("UPDATE previews SET state = 'pending'").run()
    assert.equal(claimPendingPreviews(lib, [exploding], 10).length, 0)
  })
})

test('the queue processes a batch larger than its concurrency', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const dir = join(lib.dir, 'marc', 'Benchy')
    mkdirSync(dir)
    for (let i = 0; i < 7; i++) curaProject(join(dir, `p${i}.3mf`), makePng(64 + i, 64))
    await rescan(lib, ctx)

    assert.deepEqual(await runPreviewQueue(lib, { concurrency: 2 }), {
      ready: 7,
      failed: 0,
      unsupported: 0,
    })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/previews/png.ts'`.

- [ ] **Step 4: Implement the PNG size reader**

`packages/core/src/previews/png.ts`:

```ts
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Reads width/height from IHDR, which the format requires to be the first chunk. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
```

- [ ] **Step 5: Implement the extractor**

`packages/core/src/previews/embedded.ts`:

```ts
import { findZipEntry, readZipEntries, readZipEntryBytes } from '../files/zip.ts'
import { readPngSize } from './png.ts'

/**
 * Measured 2026-08-22 (spec 7.1). Cura and PrusaSlicer both use Metadata/thumbnail.png;
 * the Bambu lineage uses Metadata/plate_1.png specifically — plate_1_small.png is 128x128
 * (below the 256 target), plate_no_light_1.png is unlit, top_1.png is a top-down
 * orthographic view, and pick_1.png is an object-picking mask rather than a visual.
 */
export const EMBEDDED_THUMBNAIL_ENTRIES: readonly string[] = [
  'Metadata/thumbnail.png',
  'Metadata/plate_1.png',
]

export function extractEmbeddedThumbnail(
  absPath: string,
): { bytes: Uint8Array; width: number; height: number } | null {
  let entries
  try {
    entries = readZipEntries(absPath)
  } catch {
    return null
  }

  for (const name of EMBEDDED_THUMBNAIL_ENTRIES) {
    const entry = findZipEntry(entries, name)
    if (!entry) continue
    const bytes = readZipEntryBytes(absPath, entry)
    const size = readPngSize(bytes)
    if (!size) continue
    // Stored verbatim: resizing needs a PNG codec, which arrives with the rasterizer in spec B.
    return { bytes, width: size.width, height: size.height }
  }
  return null
}
```

- [ ] **Step 6: Implement the queue**

`packages/core/src/previews/queue.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileKind } from '@spm/contract/dtos.ts'
import type { Library } from '../db/open.ts'
import { previewPath } from '../files/paths.ts'
import { RELATIVE_PATH_SEPARATOR } from '../projects/rescan.ts'
import { PREVIEWS_DIR, SPM_DIR } from '../db/open.ts'
import { extractEmbeddedThumbnail } from './embedded.ts'

export type PreviewJob = {
  fileId: string
  absPath: string
  kind: FileKind
  contentHash: Uint8Array | null
}

export type PreviewOutput = {
  bytes: Uint8Array
  width: number
  height: number
  source: 'embedded' | 'rasterized'
}

/** A handler declares the kinds it covers; anything uncovered is left pending. */
export type PreviewHandler = {
  kinds: readonly FileKind[]
  run(job: PreviewJob): Promise<PreviewOutput | null>
}

/** Bounds a malformed mesh to a fixed number of attempts instead of looping forever (7.3). */
export const MAX_PREVIEW_ATTEMPTS = 3
export const DEFAULT_CONCURRENCY = 2

export const EMBEDDED_HANDLER: PreviewHandler = {
  kinds: ['slicer_project'],
  run: (job) => {
    const found = extractEmbeddedThumbnail(job.absPath)
    return Promise.resolve(found ? { ...found, source: 'embedded' as const } : null)
  },
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

export function claimPendingPreviews(
  lib: Library,
  handlers: readonly PreviewHandler[],
  limit: number,
): PreviewJob[] {
  const kinds = [...new Set(handlers.flatMap((handler) => [...handler.kinds]))]
  if (kinds.length === 0) return []

  const rows = lib.db
    .prepare(
      `SELECT pv.file_id AS fileId, f.kind AS kind, f.rel_path AS relPath, f.content_hash AS contentHash,
              p.dir_name AS dirName, u.library_dir AS libraryDir
       FROM previews pv
       JOIN files f ON f.id = pv.file_id
       JOIN projects p ON p.id = f.project_id
       JOIN users u ON u.id = p.owner_id
       WHERE pv.state = 'pending' AND pv.attempts < ? AND p.state = 'ok'
         AND f.kind IN (${placeholders(kinds.length)})
       ORDER BY pv.updated_at
       LIMIT ?`,
    )
    .all(MAX_PREVIEW_ATTEMPTS, ...kinds, limit) as {
    fileId: string
    kind: FileKind
    relPath: string
    contentHash: Uint8Array | null
    dirName: string
    libraryDir: string
  }[]

  return rows.map((row) => ({
    fileId: row.fileId,
    kind: row.kind,
    contentHash: row.contentHash,
    absPath: join(
      lib.dir,
      ...(row.libraryDir === '.' ? [] : [row.libraryDir]),
      row.dirName,
      ...row.relPath.split(RELATIVE_PATH_SEPARATOR),
    ),
  }))
}

async function runOne(
  lib: Library,
  job: PreviewJob,
  handlers: readonly PreviewHandler[],
  counts: { ready: number; failed: number; unsupported: number },
): Promise<void> {
  const handler = handlers.find((candidate) => candidate.kinds.includes(job.kind))
  if (!handler) return

  const now = Date.now()
  try {
    const output = await handler.run(job)
    if (!output) {
      // Deterministic absence: never retried.
      lib.db
        .prepare(
          "UPDATE previews SET state = 'unsupported', error = NULL, updated_at = ? WHERE file_id = ?",
        )
        .run(now, job.fileId)
      counts.unsupported++
      return
    }

    const target = previewPath(lib, job.fileId)
    writeFileSync(target, output.bytes)
    lib.db
      .prepare(
        `UPDATE previews SET state = 'ready', source = ?, png_path = ?, width = ?, height = ?,
                             source_hash = ?, error = NULL, updated_at = ?
         WHERE file_id = ?`,
      )
      .run(
        output.source,
        [SPM_DIR, PREVIEWS_DIR, `${job.fileId}.png`].join(RELATIVE_PATH_SEPARATOR),
        output.width,
        output.height,
        job.contentHash,
        now,
        job.fileId,
      )
    counts.ready++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lib.db
      .prepare(
        `UPDATE previews SET state = 'failed', error = ?, attempts = attempts + 1, updated_at = ?
         WHERE file_id = ?`,
      )
      .run(message.slice(0, 500), now, job.fileId)
    counts.failed++
  }
}

export async function runPreviewQueue(
  lib: Library,
  opts: { concurrency?: number; limit?: number; handlers?: readonly PreviewHandler[] } = {},
): Promise<{ ready: number; failed: number; unsupported: number }> {
  const handlers = opts.handlers ?? [EMBEDDED_HANDLER]
  const jobs = claimPendingPreviews(lib, handlers, opts.limit ?? 100)
  const counts = { ready: 0, failed: 0, unsupported: 0 }

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const job = jobs[index]
      if (!job) return
      await runOne(lib, job, handlers, counts)
    }
  }

  const width = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, jobs.length))
  await Promise.all(Array.from({ length: width }, worker))
  return counts
}
```

`source_hash` records the content hash the preview came from, so an edited file regenerates and
an untouched one never does (§7.3) — rescan compares against exactly this column.

Spec B adds a `PreviewHandler` with `kinds: ['model']` and passes it in `handlers`; nothing else
in this file changes, and the model rows already sitting at `pending` drain on the next run.

- [ ] **Step 7: Run the tests on both runtimes**

```bash
pnpm test:core:node && pnpm test:core:deno
```

Expected: 11 new tests passing under each.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): embedded thumbnail extraction and the bounded preview queue"
```

---

### Task 12: `core` — the CuraManager `metadata.json` importer (§3.6)

Migration is the adopt path plus a sidecar reader — no bespoke tool. A CuraManager library is
flat, which is exactly the shape of a local-mode library, so local mode needs no restructuring
at all; importing into a _server_ library moves each project folder under the target user.

**Files:**

- Create: `packages/core/src/projects/import-curamanager.ts`
- Modify: `packages/core/src/index.ts` (create the barrel — the single entry a transport imports)
- Test: `packages/core/test/import-curamanager.test.ts`

**Interfaces:**

- Consumes: `Library`, `Ctx`, `rescan`, `addTag`, `updateProject`, `userRoot`, `requireUserRow`, `RescanResultDto`.
- Produces:
  - `type CuraManagerSidecar = { tags: string[]; website: string | null; isArchived: boolean }`
  - `readCuraManagerSidecar(projectDirPath): CuraManagerSidecar | null`
  - `moveFlatLibraryIntoUserFolder(lib, ctx): number`
  - `importCuraManagerLibrary(lib, ctx, opts: { moveIntoUserFolder: boolean }): Promise<{ rescan: RescanResultDto; projectsUpdated: number; tagsApplied: number; moved: number }>`
  - `packages/core/src/index.ts` re-exporting every use case named in Tasks 3–12.

- [ ] **Step 1: Write the failing test**

`packages/core/test/import-curamanager.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import {
  importCuraManagerLibrary,
  readCuraManagerSidecar,
} from '../src/projects/import-curamanager.ts'
import { listProjects } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username: string, libraryDir: string): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, libraryDir)
  if (libraryDir !== '.') mkdirSync(join(lib.dir, libraryDir), { recursive: true })
  return { userId: id, isAdmin: false }
}

/** Writes a CuraManager-shaped project folder: files plus a PascalCase sidecar. */
function curaManagerProject(
  root: string,
  name: string,
  sidecar: Record<string, unknown> | null,
): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, `${name}.stl`), 'solid')
  if (sidecar) writeFileSync(join(root, name, 'metadata.json'), JSON.stringify(sidecar))
}

test('readCuraManagerSidecar accepts the PascalCase shape and tolerates a missing file', async () => {
  await withLibrary((lib) => {
    curaManagerProject(lib.dir, 'Benchy', {
      Tags: ['boat', 'benchmark'],
      Website: 'https://thingiverse.com/thing:763622',
      IsArchived: true,
    })
    assert.deepEqual(readCuraManagerSidecar(join(lib.dir, 'Benchy')), {
      tags: ['boat', 'benchmark'],
      website: 'https://thingiverse.com/thing:763622',
      isArchived: true,
    })

    curaManagerProject(lib.dir, 'Bare', null)
    assert.equal(readCuraManagerSidecar(join(lib.dir, 'Bare')), null)
  })
})

test('malformed sidecar json is ignored rather than fatal', async () => {
  await withLibrary((lib) => {
    mkdirSync(join(lib.dir, 'Broken'))
    writeFileSync(join(lib.dir, 'Broken', 'metadata.json'), '{ this is not json')
    assert.equal(readCuraManagerSidecar(join(lib.dir, 'Broken')), null)
  })
})

test('a flat CuraManager library imports into local mode with no restructuring', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'local', '.')
    curaManagerProject(lib.dir, 'Benchy', {
      Tags: ['boat'],
      Website: 'https://a.example',
      IsArchived: false,
    })
    curaManagerProject(lib.dir, 'Bracket', { Tags: ['petg', 'functional'], IsArchived: true })
    curaManagerProject(lib.dir, 'Plain', null)

    const result = await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })
    assert.equal(result.moved, 0)
    assert.equal(result.rescan.adopted, 3)
    assert.equal(result.projectsUpdated, 2)
    assert.equal(result.tagsApplied, 3)

    const projects = new Map(
      listProjects(lib, ctx, { includeArchived: true }).map((p) => [p.name, p]),
    )
    assert.deepEqual(projects.get('Benchy')!.tags, ['boat'])
    assert.equal(projects.get('Benchy')!.website, 'https://a.example')
    assert.equal(projects.get('Bracket')!.isArchived, true)
    assert.deepEqual(projects.get('Plain')!.tags, [])
  })
})

test('importing into a server library moves each folder under the target user', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc', 'marc')
    const anna = seedUser(lib, 'anna', 'anna')
    curaManagerProject(lib.dir, 'Benchy', { Tags: ['boat'] })

    const result = await importCuraManagerLibrary(lib, marc, { moveIntoUserFolder: true })
    assert.equal(result.moved, 1)
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy', 'Benchy.stl')))
    assert.equal(existsSync(join(lib.dir, 'Benchy')), false)
    // Another user's library root is never swept up.
    assert.ok(existsSync(join(lib.dir, 'anna')))
    assert.deepEqual(listProjects(lib, anna, {}), [])
    assert.deepEqual(
      listProjects(lib, marc, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('the .spm folder is never moved or adopted by the importer', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'marc', 'marc')
    curaManagerProject(lib.dir, 'Benchy', null)

    await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: true })
    assert.ok(existsSync(join(lib.dir, '.spm', 'app.db')))
    assert.deepEqual(
      listProjects(lib, ctx, {}).map((p) => p.name),
      ['Benchy'],
    )
  })
})

test('importing twice applies no duplicate tags and no duplicate projects', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib, 'local', '.')
    curaManagerProject(lib.dir, 'Benchy', { Tags: ['boat', 'BOAT'] })

    await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })
    const second = await importCuraManagerLibrary(lib, ctx, { moveIntoUserFolder: false })

    assert.equal(second.rescan.adopted, 0)
    const [project] = listProjects(lib, ctx, {})
    assert.deepEqual(project!.tags, ['boat'])
    assert.equal(listProjects(lib, ctx, {}).length, 1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:core:node
```

Expected: FAIL — `Cannot find module '../src/projects/import-curamanager.ts'`.

- [ ] **Step 3: Implement the importer**

`packages/core/src/projects/import-curamanager.ts`:

```ts
import { readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { userRoot } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'
import { addTag, updateProject } from './usecases.ts'
import { rescan } from './rescan.ts'

export const SIDECAR_FILE = 'metadata.json'

export type CuraManagerSidecar = { tags: string[]; website: string | null; isArchived: boolean }

/** CuraManager wrote PascalCase keys; camelCase is accepted too so hand-edits still load. */
export function readCuraManagerSidecar(projectDirPath: string): CuraManagerSidecar | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(projectDirPath, SIDECAR_FILE), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    // Absent or malformed: migration continues without it rather than aborting.
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const rawTags = parsed.Tags ?? parsed.tags
  const rawWebsite = parsed.Website ?? parsed.website
  const rawArchived = parsed.IsArchived ?? parsed.isArchived

  return {
    tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [],
    website: typeof rawWebsite === 'string' && rawWebsite.length > 0 ? rawWebsite : null,
    isArchived: rawArchived === true,
  }
}

/**
 * Server import: a CuraManager library is flat, so every project folder at the root moves
 * under the target user's library_dir. Dot-folders and every user's own root are left alone.
 */
export function moveFlatLibraryIntoUserFolder(lib: Library, ctx: Ctx): number {
  const user = requireUserRow(lib.db, ctx.userId)
  const target = userRoot(lib, user.library_dir)
  if (user.library_dir === '.') return 0

  const reserved = new Set(
    (lib.db.prepare('SELECT library_dir FROM users').all() as { library_dir: string }[]).map(
      (row) => row.library_dir,
    ),
  )

  let moved = 0
  for (const entry of readdirSync(lib.dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (reserved.has(entry.name)) continue
    renameSync(join(lib.dir, entry.name), join(target, entry.name))
    moved++
  }
  return moved
}

export async function importCuraManagerLibrary(
  lib: Library,
  ctx: Ctx,
  opts: { moveIntoUserFolder: boolean },
): Promise<{
  rescan: RescanResultDto
  projectsUpdated: number
  tagsApplied: number
  moved: number
}> {
  const moved = opts.moveIntoUserFolder ? moveFlatLibraryIntoUserFolder(lib, ctx) : 0

  // Adopt every folder and index its files first (spec 3.6, step 2).
  const rescanResult = await rescan(lib, ctx)

  const user = requireUserRow(lib.db, ctx.userId)
  const root = userRoot(lib, user.library_dir)
  const projects = lib.db
    .prepare("SELECT id, dir_name FROM projects WHERE owner_id = ? AND state = 'ok'")
    .all(ctx.userId) as { id: string; dir_name: string }[]

  let projectsUpdated = 0
  let tagsApplied = 0
  for (const project of projects) {
    const sidecar = readCuraManagerSidecar(join(root, project.dir_name))
    if (!sidecar) continue

    const before = lib.db
      .prepare('SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?')
      .get(project.id) as { n: number }
    for (const tag of sidecar.tags) addTag(lib, ctx, project.id, tag)
    const after = lib.db
      .prepare('SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?')
      .get(project.id) as { n: number }
    tagsApplied += Number(after.n) - Number(before.n)

    updateProject(lib, ctx, project.id, {
      website: sidecar.website,
      isArchived: sidecar.isArchived,
    })
    projectsUpdated++
  }

  return { rescan: rescanResult, projectsUpdated, tagsApplied, moved }
}
```

- [ ] **Step 4: Create the `core` barrel**

`packages/core/src/index.ts` — the single entry point a transport imports (§2.2). Adding a use
case means adding it here.

```ts
export type { Ctx } from './ctx.ts'
export { closeLibrary, openLibrary, type Db, type Library } from './db/open.ts'
export { newId } from './db/ids.ts'
export { runMigrations } from './db/migrate.ts'

export { activateAccount, login, type LoginResult } from './auth/login.ts'
export { checkActivationToken, issueActivationToken } from './auth/activation.ts'
export {
  createSession,
  deleteSession,
  pruneExpiredSessions,
  resolveSession,
  SESSION_TTL_MS,
} from './auth/sessions.ts'

export { ensureBootstrapAdmin, ensureLocalUser } from './users/bootstrap.ts'
export { changePassword, getSettings, me, putSettings, updateProfile } from './users/account.ts'
export {
  createUser,
  deleteUser,
  listUsers,
  reissueInvite,
  requireAdmin,
  updateUser,
} from './users/admin.ts'
export { diskUsageBytes, diskUsageByUser } from './users/usage.ts'

export { getProject, listProjects } from './projects/queries.ts'
export {
  addTag,
  createProject,
  deleteProject,
  removeTag,
  sanitizeDirName,
  updateProject,
} from './projects/usecases.ts'
export { rescan, RELATIVE_PATH_SEPARATOR } from './projects/rescan.ts'
export {
  importCuraManagerLibrary,
  moveFlatLibraryIntoUserFolder,
  readCuraManagerSidecar,
} from './projects/import-curamanager.ts'

export { classifyFile, SLICER_HEADER_REGISTRY } from './files/classify.ts'
export {
  assertWithinQuota,
  contentTypeFor,
  deleteFile,
  renameFile,
  resolveFilePath,
  resolvePreviewPath,
  uploadFile,
} from './files/usecases.ts'

export {
  EMBEDDED_HANDLER,
  MAX_PREVIEW_ATTEMPTS,
  runPreviewQueue,
  type PreviewHandler,
  type PreviewJob,
  type PreviewOutput,
} from './previews/queue.ts'
```

- [ ] **Step 5: Run the whole core suite on both runtimes**

```bash
pnpm verify
```

Expected: everything green — contract tests, then the full `core` suite on Node, then the same
suite on Deno. This is the last task before a transport exists, so this is the checkpoint that
says the runtime-agnostic core is complete and honest.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): CuraManager metadata.json importer and the core barrel"
```

---

### Task 13: `server` — foundation, capabilities, cookie sessions, auth routes

The transport is deliberately thin: parse, call `core`, decorate, serialise. No authorisation
logic lives here (§2.2). Integration tests call the composed handler function directly with a
`Request` object, so no port is ever bound.

**Files:**

- Create: `packages/server/main.ts`, `src/router.ts`, `src/session.ts`, `src/errors.ts`, `src/decorate.ts`, `src/static.ts`, `src/json.ts`, `src/routes/index.ts`, `src/routes/capabilities.ts`, `src/routes/auth.ts`
- Modify: `.github/workflows/ci.yml` (add the `server` job)
- Test: `packages/server/test/harness.ts`, `packages/server/test/auth.test.ts`

**Interfaces:**

- Consumes: everything exported from `@spm/core`; `loginSchema`, `activateSchema` from `@spm/contract/schemas.ts`; `AppError` from `@spm/contract/errors.ts`.
- Produces:
  - `src/router.ts`: `type Env = { lib: Library }`, `type Handler = (input: { req: Request; url: URL; params: Record<string, string>; env: Env; ctx: Ctx }) => Promise<Response> | Response`, `type Route = { method: string; path: string; auth: 'public' | 'session'; handler: Handler }`, `makeHandler(routes: Route[], env: Env): (req: Request) => Promise<Response>`
  - `src/session.ts`: `SESSION_COOKIE`, `readSessionToken(req): string | null`, `sessionSetCookie(token, expiresAt, url): string`, `sessionClearCookie(url): string`
  - `src/errors.ts`: `STATUS_BY_CODE`, `errorResponse(error: unknown): Response`
  - `src/decorate.ts`: `decorateFile(file: CoreFileDto): FileDto`, `decorateProject(project: CoreProjectDto): ProjectDto`, `decorateProjectDetail(detail: CoreProjectDetailDto): ProjectDetailDto`
  - `src/json.ts`: `json(body, init?): Response`, `noContent(): Response`, `parseJson<T>(req, schema): Promise<T>`
  - `src/routes/index.ts`: `routes: Route[]` — Tasks 14–16 append to this one array.

- [ ] **Step 1: Write the test harness and the failing test**

`packages/server/test/harness.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLibrary, ensureBootstrapAdmin, openLibrary, type Library } from '@spm/core'
import { makeHandler } from '../src/router.ts'
import { routes } from '../src/routes/index.ts'

export type TestServer = {
  lib: Library
  dir: string
  fetch: (path: string, init?: RequestInit & { cookie?: string }) => Promise<Response>
  bootstrapToken: string
}

export async function withServer(run: (server: TestServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spm-server-'))
  const lib = openLibrary(dir)
  const boot = await ensureBootstrapAdmin(lib)
  const handler = makeHandler(routes, { lib })

  const fetchFn: TestServer['fetch'] = (path, init = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    return handler(new Request(`http://localhost${path}`, { ...init, headers }))
  }

  try {
    await run({ lib, dir, fetch: fetchFn, bootstrapToken: boot!.token })
  } finally {
    closeLibrary(lib)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Activates the bootstrap admin and returns a usable session cookie header. */
export async function loginAsAdmin(server: TestServer): Promise<string> {
  const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a good long password', confirm: 'a good long password' }),
  })
  if (!response.ok) throw new Error(`activation failed: ${response.status}`)
  const setCookie = response.headers.get('set-cookie')!
  return setCookie.split(';')[0]!
}
```

`packages/server/test/auth.test.ts`:

```ts
import assert from 'node:assert/strict'
import { loginAsAdmin, withServer } from './harness.ts'

Deno.test('capabilities is public and describes the server build', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/capabilities')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      requiresAuth: true,
      canManageUsers: true,
      canPickLocalFolder: false,
      canLaunchSlicer: false,
      canConfigureSlicers: false,
      canBrowseModelSites: false,
    })
  })
})

Deno.test('an unknown api route is a 404 with the error envelope', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/nope')
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'NotFound')
  })
})

Deno.test('a session route without a cookie is a 401', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/account')
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'Unauthorized')
  })
})

Deno.test('the activation token can be checked before a password is typed', async () => {
  await withServer(async (server) => {
    const ok = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`)
    assert.deepEqual(await ok.json(), { valid: true, username: 'admin' })

    const bad = await server.fetch('/api/auth/activation/not-a-real-token')
    assert.equal(bad.status, 200)
    assert.deepEqual(await bad.json(), { valid: false })
  })
})

Deno.test('activation sets an HttpOnly session cookie and returns the user', async () => {
  await withServer(async (server) => {
    const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a good long password', confirm: 'a good long password' }),
    })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!
    assert.match(cookie, /^spm_session=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    // No Secure flag over http://localhost, or a dev browser would drop the cookie.
    assert.doesNotMatch(cookie, /Secure/)

    const user = await response.json()
    assert.equal(user.username, 'admin')
    assert.equal(user.status, 'active')
    assert.equal(user.isAdmin, true)
  })
})

Deno.test('a validation failure reports the offending field', async () => {
  await withServer(async (server) => {
    const response = await server.fetch(`/api/auth/activation/${server.bootstrapToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short', confirm: 'short' }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'Validation')
    assert.ok(Array.isArray(body.error.details.issues))
  })
})

Deno.test('login works after activation and rejects a wrong password', async () => {
  await withServer(async (server) => {
    await loginAsAdmin(server)

    const ok = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'a good long password' }),
    })
    assert.equal(ok.status, 200)
    assert.ok(ok.headers.get('set-cookie'))

    const bad = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong password' }),
    })
    assert.equal(bad.status, 401)
  })
})

Deno.test('a session cookie authenticates and logout revokes it', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const me = await server.fetch('/api/account', { cookie })
    assert.equal(me.status, 200)
    assert.equal((await me.json()).username, 'admin')

    const out = await server.fetch('/api/auth/logout', { method: 'POST', cookie })
    assert.equal(out.status, 204)
    assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)

    const after = await server.fetch('/api/account', { cookie })
    assert.equal(after.status, 401)
  })
})

Deno.test('a wrong method on a known path is a 405', async () => {
  await withServer(async (server) => {
    const response = await server.fetch('/api/capabilities', { method: 'DELETE' })
    assert.equal(response.status, 405)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:server
```

Expected: FAIL — module not found for `../src/router.ts`.

- [ ] **Step 3: Implement the JSON and error helpers**

`packages/server/src/json.ts`:

```ts
import { AppError } from '@spm/contract/errors.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

/** Validates with the same schema the Angular form uses (spec 2.3). */
export async function parseJson<T>(req: Request, schema: StandardSchemaV1<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new AppError('Validation', 'request body is not valid JSON')
  }
  const result = await schema['~standard'].validate(raw)
  if (result.issues) {
    throw new AppError('Validation', 'request body failed validation', { issues: result.issues })
  }
  return result.value
}
```

`packages/server/src/standard-schema.ts` — the minimal structural type, so the server depends on
the Standard Schema contract rather than on Zod itself:

```ts
export type StandardSchemaV1<T> = {
  '~standard': {
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
      | Promise<
          | { value: T; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
        >
  }
}
```

`packages/server/src/errors.ts`:

```ts
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { json } from './json.ts'

export const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  Validation: 400,
  InvalidToken: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  LastActiveAdmin: 409,
  TokenExpired: 410,
  LengthRequired: 411,
  QuotaExceeded: 413,
  Internal: 500,
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details ?? {} } },
      { status: STATUS_BY_CODE[error.code] },
    )
  }
  // Never leak an internal message or stack to a client.
  console.error('unhandled error', error)
  return json(
    { error: { code: 'Internal', message: 'internal error', details: {} } },
    { status: 500 },
  )
}
```

- [ ] **Step 4: Implement cookies and the router**

`packages/server/src/session.ts`:

```ts
export const SESSION_COOKIE = 'spm_session'

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** Secure is dropped only for a plain-http localhost origin, so dev over http still works. */
function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

function attributes(url: URL, maxAge: number): string {
  const parts = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (!isLocalHttp(url)) parts.push('Secure')
  return parts.join('; ')
}

export function sessionSetCookie(token: string, expiresAt: number, url: URL): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attributes(url, maxAge)}`
}

export function sessionClearCookie(url: URL): string {
  return `${SESSION_COOKIE}=; ${attributes(url, 0)}`
}
```

`packages/server/src/router.ts`:

```ts
import { AppError } from '@spm/contract/errors.ts'
import { resolveSession, type Ctx, type Library } from '@spm/core'
import { errorResponse } from './errors.ts'
import { readSessionToken } from './session.ts'
import { serveStatic } from './static.ts'

export type Env = { lib: Library }

export type Handler = (input: {
  req: Request
  url: URL
  params: Record<string, string>
  env: Env
  ctx: Ctx
}) => Promise<Response> | Response

export type Route = {
  method: string
  path: string
  auth: 'public' | 'session'
  handler: Handler
}

const ANONYMOUS: Ctx = { userId: '', isAdmin: false }

export function makeHandler(routes: Route[], env: Env): (req: Request) => Promise<Response> {
  const compiled = routes.map((route) => ({
    ...route,
    pattern: new URLPattern({ pathname: route.path }),
  }))

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (!url.pathname.startsWith('/api/')) return serveStatic(url)

    let pathMatched = false
    for (const route of compiled) {
      const match = route.pattern.exec({ pathname: url.pathname })
      if (!match) continue
      pathMatched = true
      if (route.method !== req.method) continue

      try {
        let ctx = ANONYMOUS
        if (route.auth === 'session') {
          const token = readSessionToken(req)
          const resolved = token ? await resolveSession(env.lib.db, token) : null
          if (!resolved) throw new AppError('Unauthorized', 'a valid session is required')
          ctx = resolved
        }
        const params = Object.fromEntries(
          Object.entries(match.pathname.groups).map(([key, value]) => [key, value ?? '']),
        )
        return await route.handler({ req, url, params, env, ctx })
      } catch (error) {
        return errorResponse(error)
      }
    }

    // The path exists but no route claimed this method.
    if (pathMatched) {
      return new Response(
        JSON.stringify({
          error: { code: 'MethodNotAllowed', message: 'method not allowed', details: {} },
        }),
        { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )
    }
    return errorResponse(new AppError('NotFound', 'no such endpoint'))
  }
}
```

- [ ] **Step 5: Implement DTO decoration and static serving**

`packages/server/src/decorate.ts` — the only place URLs are invented (§4.2):

```ts
import type {
  CoreFileDto,
  CoreProjectDetailDto,
  CoreProjectDto,
  FileDto,
  ProjectDetailDto,
  ProjectDto,
} from '@spm/contract/dtos.ts'

export function decorateFile(file: CoreFileDto): FileDto {
  return {
    ...file,
    rawUrl: `/api/files/${file.id}/raw`,
    ...(file.previewState === 'ready' ? { thumbUrl: `/api/files/${file.id}/thumb` } : {}),
  }
}

export function decorateProject(project: CoreProjectDto): ProjectDto {
  const { coverFileId, ...rest } = project
  return {
    ...rest,
    ...(coverFileId ? { coverThumbUrl: `/api/files/${coverFileId}/thumb` } : {}),
  }
}

export function decorateProjectDetail(detail: CoreProjectDetailDto): ProjectDetailDto {
  const { files, ...project } = detail
  return { ...decorateProject(project), files: files.map(decorateFile) }
}
```

`packages/server/src/static.ts`:

```ts
import { contentTypeFor } from '@spm/core'

const WEB_ROOT = Deno.env.get('SPM_WEB_ROOT') ?? '../web/dist/web/browser'

/** Serves the Angular bundle, falling back to index.html so client routes deep-link. */
export async function serveStatic(url: URL): Promise<Response> {
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  for (const candidate of [relative, 'index.html']) {
    try {
      const bytes = await Deno.readFile(`${WEB_ROOT}/${candidate}`)
      const type = candidate.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : candidate.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : candidate.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : contentTypeFor(candidate)
      return new Response(bytes, { headers: { 'content-type': type } })
    } catch {
      continue
    }
  }
  return new Response('not found', { status: 404 })
}
```

- [ ] **Step 6: Implement the capabilities and auth routes**

`packages/server/src/routes/capabilities.ts` — the server half of the §2.4 matrix. The client
unions this with whatever its shell contributes, and `canManageUsers` is further gated on
`me.isAdmin` in the UI:

```ts
import type { Capabilities } from '@spm/contract/dtos.ts'
import { json } from '../json.ts'
import type { Route } from '../router.ts'

export const SERVER_CAPABILITIES: Capabilities = {
  requiresAuth: true,
  canManageUsers: true,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

export const capabilityRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/capabilities',
    auth: 'public',
    handler: () => json(SERVER_CAPABILITIES),
  },
]
```

`packages/server/src/routes/auth.ts`:

```ts
import { activateSchema, loginSchema } from '@spm/contract/schemas.ts'
import { activateAccount, checkActivationToken, deleteSession, login } from '@spm/core'
import { json, parseJson } from '../json.ts'
import type { Route } from '../router.ts'
import { readSessionToken, sessionClearCookie, sessionSetCookie } from '../session.ts'

export const authRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    handler: async ({ req, url, env }) => {
      const input = await parseJson(req, loginSchema)
      const result = await login(
        env.lib,
        input.username,
        input.password,
        req.headers.get('user-agent'),
      )
      return json(result.user, {
        headers: { 'set-cookie': sessionSetCookie(result.token, result.expiresAt, url) },
      })
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'public',
    handler: async ({ req, url, env }) => {
      const token = readSessionToken(req)
      if (token) await deleteSession(env.lib.db, token)
      return new Response(null, { status: 204, headers: { 'set-cookie': sessionClearCookie(url) } })
    },
  },
  {
    method: 'GET',
    path: '/api/auth/activation/:token',
    auth: 'public',
    handler: async ({ params, env }) => {
      // Read-only, so an expired link errors before a password is typed (spec 5.3).
      const result = await checkActivationToken(env.lib.db, params.token!)
      return json(result.valid ? { valid: true, username: result.username } : { valid: false })
    },
  },
  {
    method: 'POST',
    path: '/api/auth/activation/:token',
    auth: 'public',
    handler: async ({ req, url, params, env }) => {
      const input = await parseJson(req, activateSchema)
      const result = await activateAccount(
        env.lib,
        params.token!,
        input.password,
        req.headers.get('user-agent'),
      )
      return json(result.user, {
        headers: { 'set-cookie': sessionSetCookie(result.token, result.expiresAt, url) },
      })
    },
  },
]
```

`noContent()` from `json.ts` is unused here; Tasks 14–16 use it for their `DELETE` handlers.

`packages/server/src/routes/index.ts` — Tasks 14–16 extend this array and nothing else:

```ts
import type { Route } from '../router.ts'
import { authRoutes } from './auth.ts'
import { capabilityRoutes } from './capabilities.ts'

export const routes: Route[] = [...capabilityRoutes, ...authRoutes]
```

- [ ] **Step 7: Implement the entry point**

`packages/server/main.ts`:

```ts
import {
  closeLibrary,
  ensureBootstrapAdmin,
  openLibrary,
  pruneExpiredSessions,
  runPreviewQueue,
} from '@spm/core'
import { makeHandler } from './src/router.ts'
import { routes } from './src/routes/index.ts'

const libraryDir = Deno.env.get('SPM_LIBRARY_DIR')
if (!libraryDir) {
  console.error('SPM_LIBRARY_DIR is required')
  Deno.exit(1)
}
const port = Number(Deno.env.get('SPM_PORT') ?? '8000')

const lib = openLibrary(libraryDir)

const boot = await ensureBootstrapAdmin(lib)
if (boot) {
  // No default password exists anywhere (spec 5.4); this link is the only way in.
  console.log(`First run: activate "${boot.username}" at /activate#${boot.token}`)
}

const PREVIEW_INTERVAL_MS = 30_000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
setInterval(() => {
  runPreviewQueue(lib, { limit: 20 }).catch((error) => console.error('preview queue', error))
}, PREVIEW_INTERVAL_MS)
setInterval(() => pruneExpiredSessions(lib.db), PRUNE_INTERVAL_MS)

const handler = makeHandler(routes, { lib })
const server = Deno.serve({ port }, handler)

Deno.addSignalListener('SIGINT', () => {
  server.shutdown().finally(() => {
    closeLibrary(lib)
    Deno.exit(0)
  })
})

console.log(`slicer-project-manager listening on http://localhost:${port}`)
```

- [ ] **Step 8: Run the server tests**

```bash
pnpm test:server
```

Expected: 9 passing.

- [ ] **Step 9: Add the CI job**

Append to `.github/workflows/ci.yml`:

```yaml
server:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with: { version: 10 }
    - uses: actions/setup-node@v4
      with: { node-version: '24', cache: pnpm }
    - uses: denoland/setup-deno@v2
      with: { deno-version: v2.x }
    - run: pnpm install --frozen-lockfile
    - run: pnpm test:server
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(server): Deno router, cookie sessions, capabilities and auth routes"
```

---

### Task 14: `server` — account and admin user routes

**Files:**

- Create: `packages/server/src/routes/account.ts`, `src/routes/users.ts`
- Modify: `packages/server/src/routes/index.ts`
- Test: `packages/server/test/users.test.ts`

**Interfaces:**

- Consumes: `me`, `updateProfile`, `changePassword`, `getSettings`, `putSettings`, `listUsers`, `createUser`, `reissueInvite`, `updateUser`, `deleteUser` from `@spm/core`; `profilePatchSchema`, `changePasswordSchema`, `settingsPatchSchema`, `createUserSchema`, `updateUserSchema` from `@spm/contract/schemas.ts`; `Route`, `json`, `noContent`, `parseJson`.
- Produces: `accountRoutes: Route[]`, `userRoutes: Route[]`, `activationUrl(url: URL, token: string): string`

**The activation link is built here, from the request's own origin** (Decision 2), and the token
rides in the URL **fragment** so it never reaches an access log or a `Referer` header (§5.3).

- [ ] **Step 1: Write the failing test**

`packages/server/test/users.test.ts`:

```ts
import assert from 'node:assert/strict'
import { loginAsAdmin, withServer, type TestServer } from './harness.ts'

async function createUser(
  server: TestServer,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return server.fetch('/api/users', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Activates a freshly created user from their activation URL and returns their cookie. */
async function activate(server: TestServer, activationUrl: string): Promise<string> {
  const token = activationUrl.split('#')[1]!
  const response = await server.fetch(`/api/auth/activation/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'another long password', confirm: 'another long password' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')!.split(';')[0]!
}

Deno.test(
  'creating a user returns an activation url carrying the token in the fragment',
  async () => {
    await withServer(async (server) => {
      const cookie = await loginAsAdmin(server)
      const response = await createUser(server, cookie, { username: 'anna', displayName: 'Anna' })
      assert.equal(response.status, 200)

      const body = await response.json()
      assert.equal(body.user.username, 'anna')
      assert.equal(body.user.status, 'pending')
      assert.match(body.activationUrl, /^http:\/\/localhost\/activate#[A-Za-z0-9_-]{43}$/)
      // A query string would land in access logs and Referer headers (spec 5.3).
      assert.doesNotMatch(body.activationUrl, /\?/)
    })
  },
)

Deno.test('a non-admin is refused every users route', async () => {
  await withServer(async (server) => {
    const adminCookie = await loginAsAdmin(server)
    const created = await (
      await createUser(server, adminCookie, { username: 'anna', displayName: 'Anna' })
    ).json()
    const annaCookie = await activate(server, created.activationUrl)

    assert.equal((await server.fetch('/api/users', { cookie: annaCookie })).status, 403)
    assert.equal(
      (await createUser(server, annaCookie, { username: 'x', displayName: 'X' })).status,
      403,
    )
    assert.equal(
      (
        await server.fetch(`/api/users/${created.user.id}`, {
          method: 'DELETE',
          cookie: annaCookie,
        })
      ).status,
      403,
    )
  })
})

Deno.test('an invite can be re-issued and the quota updated', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const created = await (
      await createUser(server, cookie, { username: 'anna', displayName: 'Anna' })
    ).json()

    const reissued = await server.fetch(`/api/users/${created.user.id}/invite`, {
      method: 'POST',
      cookie,
    })
    assert.equal(reissued.status, 200)
    assert.notEqual((await reissued.json()).activationUrl, created.activationUrl)

    const patched = await server.fetch(`/api/users/${created.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBytes: 1_000_000 }),
    })
    assert.equal((await patched.json()).quotaBytes, 1_000_000)
  })
})

Deno.test('removing the last active admin is a 409', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const me = await (await server.fetch('/api/account', { cookie })).json()

    const response = await server.fetch(`/api/users/${me.id}`, { method: 'DELETE', cookie })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'LastActiveAdmin')
  })
})

Deno.test('account patch and password change work on the caller', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const patched = await server.fetch('/api/account', {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Marc S' }),
    })
    assert.equal((await patched.json()).displayName, 'Marc S')

    const changed = await server.fetch('/api/account/password', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: 'a good long password', next: 'an even longer password' }),
    })
    assert.equal(changed.status, 204)

    const relogin = await server.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'an even longer password' }),
    })
    assert.equal(relogin.status, 200)
  })
})

Deno.test('settings round-trip through the api', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const defaults = await (await server.fetch('/api/account/settings', { cookie })).json()
    assert.equal(defaults.language, 'en')
    assert.equal(defaults.theme, 'system')

    const put = await server.fetch('/api/account/settings', {
      method: 'PUT',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'de', viewMode: 'list' }),
    })
    const saved = await put.json()
    assert.equal(saved.language, 'de')
    assert.equal(saved.viewMode, 'list')
    assert.equal(
      (await (await server.fetch('/api/account/settings', { cookie })).json()).language,
      'de',
    )
  })
})

Deno.test('an unknown setting key is rejected rather than stored', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const response = await server.fetch('/api/account/settings', {
      method: 'PUT',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'klingon' }),
    })
    assert.equal(response.status, 400)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:server
```

Expected: FAIL — the new routes 404.

- [ ] **Step 3: Implement the account routes**

`packages/server/src/routes/account.ts`:

```ts
import {
  changePasswordSchema,
  profilePatchSchema,
  settingsPatchSchema,
} from '@spm/contract/schemas.ts'
import { changePassword, getSettings, me, putSettings, updateProfile } from '@spm/core'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

export const accountRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/account',
    auth: 'session',
    handler: ({ env, ctx }) => json(me(env.lib, ctx)),
  },
  {
    method: 'PATCH',
    path: '/api/account',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const patch = await parseJson(req, profilePatchSchema)
      return json(updateProfile(env.lib, ctx, patch))
    },
  },
  {
    method: 'POST',
    path: '/api/account/password',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const input = await parseJson(req, changePasswordSchema)
      await changePassword(env.lib, ctx, input.current, input.next)
      return noContent()
    },
  },
  {
    method: 'GET',
    path: '/api/account/settings',
    auth: 'session',
    handler: ({ env, ctx }) => json(getSettings(env.lib, ctx)),
  },
  {
    method: 'PUT',
    path: '/api/account/settings',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const patch = await parseJson(req, settingsPatchSchema)
      return json(putSettings(env.lib, ctx, patch))
    },
  },
]
```

- [ ] **Step 4: Implement the admin user routes**

`packages/server/src/routes/users.ts`:

```ts
import { createUserSchema, updateUserSchema } from '@spm/contract/schemas.ts'
import { createUser, deleteUser, listUsers, reissueInvite, updateUser } from '@spm/core'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

/** The token rides in the fragment, so it never reaches a server log (spec 5.3). */
export function activationUrl(url: URL, token: string): string {
  return `${url.origin}/activate#${token}`
}

export const userRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/users',
    auth: 'session',
    handler: ({ env, ctx }) => json(listUsers(env.lib, ctx)),
  },
  {
    method: 'POST',
    path: '/api/users',
    auth: 'session',
    handler: async ({ req, url, env, ctx }) => {
      const input = await parseJson(req, createUserSchema)
      const { user, token } = await createUser(env.lib, ctx, input)
      // Returned once, for the admin to copy out of band. No SMTP (spec 5.7).
      return json({ user, activationUrl: activationUrl(url, token) })
    },
  },
  {
    method: 'POST',
    path: '/api/users/:id/invite',
    auth: 'session',
    handler: async ({ url, params, env, ctx }) => {
      const { token } = await reissueInvite(env.lib, ctx, params.id!)
      return json({ activationUrl: activationUrl(url, token) })
    },
  },
  {
    method: 'PATCH',
    path: '/api/users/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const patch = await parseJson(req, updateUserSchema)
      return json(updateUser(env.lib, ctx, params.id!, patch))
    },
  },
  {
    method: 'DELETE',
    path: '/api/users/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      deleteUser(env.lib, ctx, params.id!)
      return noContent()
    },
  },
]
```

Register both in `packages/server/src/routes/index.ts`:

```ts
import type { Route } from '../router.ts'
import { accountRoutes } from './account.ts'
import { authRoutes } from './auth.ts'
import { capabilityRoutes } from './capabilities.ts'
import { userRoutes } from './users.ts'

export const routes: Route[] = [...capabilityRoutes, ...authRoutes, ...accountRoutes, ...userRoutes]
```

`/api/users/:id/invite` is listed before `/api/users/:id` — `URLPattern` requires no such
ordering for distinct path shapes, but keeping the more specific pattern first makes the table
readable and is required once a route's method set overlaps.

- [ ] **Step 5: Run the tests**

```bash
pnpm test:server
```

Expected: 16 passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): account self-service and admin user routes"
```

---

### Task 15: `server` — project, tag and rescan routes

**Files:**

- Create: `packages/server/src/routes/projects.ts`
- Modify: `packages/server/src/routes/index.ts`
- Test: `packages/server/test/projects.test.ts`

**Interfaces:**

- Consumes: `listProjects`, `getProject`, `createProject`, `updateProject`, `deleteProject`, `addTag`, `removeTag`, `rescan` from `@spm/core`; `createProjectSchema`, `projectPatchSchema`, `projectQuerySchema`, `tagNameSchema`; `decorateProject`, `decorateProjectDetail`.
- Produces: `projectRoutes: Route[]`, `parseProjectQuery(url: URL): ProjectQuery`

- [ ] **Step 1: Write the failing test**

`packages/server/test/projects.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loginAsAdmin, withServer } from './harness.ts'

Deno.test('projects require a session', async () => {
  await withServer(async (server) => {
    assert.equal((await server.fetch('/api/projects')).status, 401)
  })
})

Deno.test('a project can be created, listed, fetched, patched and deleted', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)

    const created = await server.fetch('/api/projects', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Benchy', tags: ['boat'], website: 'https://a.example' }),
    })
    assert.equal(created.status, 200)
    const project = await created.json()
    assert.deepEqual(project.tags, ['boat'])

    const list = await (await server.fetch('/api/projects', { cookie })).json()
    assert.deepEqual(
      list.map((p: { id: string }) => p.id),
      [project.id],
    )

    const detail = await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    assert.deepEqual(detail.files, [])

    const patched = await server.fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    })
    assert.equal((await patched.json()).isArchived, true)

    const deleted = await server.fetch(`/api/projects/${project.id}?deleteFiles=true`, {
      method: 'DELETE',
      cookie,
    })
    assert.equal(deleted.status, 204)
    assert.deepEqual(await (await server.fetch('/api/projects', { cookie })).json(), [])
  })
})

Deno.test('query parameters map onto the project query', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const post = (body: unknown) =>
      server.fetch('/api/projects', {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    await post({ name: 'Benchy', tags: ['boat', 'petg'] })
    await post({ name: 'Bracket', tags: ['petg'] })
    const archived = await (await post({ name: 'Old' })).json()
    await server.fetch(`/api/projects/${archived.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isArchived: true }),
    })

    const names = async (query: string) =>
      (await (await server.fetch(`/api/projects${query}`, { cookie })).json())
        .map((p: { name: string }) => p.name)
        .sort()

    assert.deepEqual(await names('?search=bench'), ['Benchy'])
    assert.deepEqual(await names('?tags=petg&tags=boat'), ['Benchy'])
    assert.deepEqual(await names('?sort=name&dir=asc'), ['Benchy', 'Bracket'])
    assert.deepEqual(await names('?includeArchived=true&sort=name&dir=asc'), [
      'Benchy',
      'Bracket',
      'Old',
    ])
  })
})

Deno.test('tags are added by body and removed by path', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await (
      await server.fetch('/api/projects', {
        method: 'POST',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Benchy' }),
      })
    ).json()

    const added = await server.fetch(`/api/projects/${project.id}/tags`, {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'needs support' }),
    })
    assert.equal(added.status, 204)
    assert.deepEqual(
      (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
      ['needs support'],
    )

    // The name is in the path, so there is no DELETE body (spec 4.3).
    const removed = await server.fetch(
      `/api/projects/${project.id}/tags/${encodeURIComponent('needs support')}`,
      { method: 'DELETE', cookie },
    )
    assert.equal(removed.status, 204)
    assert.deepEqual(
      (await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()).tags,
      [],
    )
  })
})

Deno.test('rescan adopts folders and reports what it did', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    mkdirSync(join(server.dir, 'admin', 'Gridfinity Bin'), { recursive: true })
    writeFileSync(join(server.dir, 'admin', 'Gridfinity Bin', 'bin.stl'), 'solid')

    const response = await server.fetch('/api/projects/rescan', { method: 'POST', cookie })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.adopted, 1)
    assert.equal(result.filesAdded, 1)
    assert.equal(result.previewsQueued, 1)

    const [project] = await (await server.fetch('/api/projects', { cookie })).json()
    assert.equal(project.name, 'Gridfinity Bin')
    assert.deepEqual(project.fileCounts, { model: 1, slicerProject: 0, other: 0 })
  })
})

Deno.test('another user project is a 404, not a 403', async () => {
  await withServer(async (server) => {
    const adminCookie = await loginAsAdmin(server)
    const created = await (
      await server.fetch('/api/users', {
        method: 'POST',
        cookie: adminCookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'anna', displayName: 'Anna' }),
      })
    ).json()
    const token = created.activationUrl.split('#')[1]
    const annaCookie = (
      await server.fetch(`/api/auth/activation/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: 'another long password',
          confirm: 'another long password',
        }),
      })
    ).headers
      .get('set-cookie')!
      .split(';')[0]!

    const mine = await (
      await server.fetch('/api/projects', {
        method: 'POST',
        cookie: adminCookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Benchy' }),
      })
    ).json()

    // Admins administer users; they never see other users' projects (spec 5.5).
    assert.equal(
      (await server.fetch(`/api/projects/${mine.id}`, { cookie: annaCookie })).status,
      404,
    )
    assert.deepEqual(await (await server.fetch('/api/projects', { cookie: annaCookie })).json(), [])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:server
```

Expected: FAIL — the project routes 404.

- [ ] **Step 3: Implement the project routes**

`packages/server/src/routes/projects.ts`:

```ts
import type { ProjectQuery } from '@spm/contract/dtos.ts'
import {
  createProjectSchema,
  projectPatchSchema,
  projectQuerySchema,
  tagNameSchema,
} from '@spm/contract/schemas.ts'
import { z } from 'zod'
import {
  addTag,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  removeTag,
  rescan,
  updateProject,
} from '@spm/core'
import { decorateProject, decorateProjectDetail } from '../decorate.ts'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

const tagBodySchema = z.object({ name: tagNameSchema })

/** Query strings are all text; coerce, then validate with the shared schema. */
export function parseProjectQuery(url: URL): ProjectQuery {
  const raw = {
    ...(url.searchParams.get('search') ? { search: url.searchParams.get('search')! } : {}),
    ...(url.searchParams.getAll('tags').length ? { tags: url.searchParams.getAll('tags') } : {}),
    ...(url.searchParams.has('includeArchived')
      ? { includeArchived: url.searchParams.get('includeArchived') === 'true' }
      : {}),
    ...(url.searchParams.get('sort') ? { sort: url.searchParams.get('sort')! } : {}),
    ...(url.searchParams.get('dir') ? { dir: url.searchParams.get('dir')! } : {}),
  }
  const parsed = projectQuerySchema.safeParse(raw)
  // An unparseable query is treated as no query rather than as an error page.
  return parsed.success ? parsed.data : {}
}

export const projectRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects',
    auth: 'session',
    handler: ({ url, env, ctx }) =>
      json(listProjects(env.lib, ctx, parseProjectQuery(url)).map(decorateProject)),
  },
  {
    method: 'POST',
    path: '/api/projects',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const input = await parseJson(req, createProjectSchema)
      return json(decorateProject(createProject(env.lib, ctx, input)))
    },
  },
  // Must precede /api/projects/:id so "rescan" is never read as an id.
  {
    method: 'POST',
    path: '/api/projects/rescan',
    auth: 'session',
    handler: async ({ env, ctx }) => json(await rescan(env.lib, ctx)),
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) =>
      json(decorateProjectDetail(getProject(env.lib, ctx, params.id!))),
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const patch = await parseJson(req, projectPatchSchema)
      return json(decorateProject(updateProject(env.lib, ctx, params.id!, patch)))
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id',
    auth: 'session',
    handler: ({ url, params, env, ctx }) => {
      deleteProject(env.lib, ctx, params.id!, {
        deleteFiles: url.searchParams.get('deleteFiles') === 'true',
      })
      return noContent()
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/tags',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const { name } = await parseJson(req, tagBodySchema)
      addTag(env.lib, ctx, params.id!, name)
      return noContent()
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/tags/:name',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      removeTag(env.lib, ctx, params.id!, decodeURIComponent(params.name!))
      return noContent()
    },
  },
]
```

Add `...projectRoutes` to the array in `packages/server/src/routes/index.ts`, after
`userRoutes`.

- [ ] **Step 4: Run the tests**

```bash
pnpm test:server
```

Expected: 22 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): project, tag and rescan routes"
```

---

### Task 16: `server` — file routes and byte streaming

**Files:**

- Create: `packages/server/src/routes/files.ts`
- Modify: `packages/server/src/routes/index.ts`
- Test: `packages/server/test/files.test.ts`

**Interfaces:**

- Consumes: `uploadFile`, `renameFile`, `deleteFile`, `resolveFilePath`, `resolvePreviewPath`, `runPreviewQueue` from `@spm/core`; `fileNameSchema`; `decorateFile`.
- Produces: `fileRoutes: Route[]`, `UPLOAD_NAME_HEADER = 'x-spm-file-name'`

**Upload shape** (Decision 7): the body is the raw file stream; the name arrives
URL-encoded in `X-Spm-File-Name`; `Content-Length` is required because the quota check runs
before any byte is written (§5.6). `Range` requests are not implemented — `<img>` and the
three.js loaders do not need them; if the spec-B viewer ever does, add it there.

- [ ] **Step 1: Write the failing test**

`packages/server/test/files.test.ts`:

```ts
import assert from 'node:assert/strict'
import { runPreviewQueue } from '@spm/core'
import { loginAsAdmin, withServer, type TestServer } from './harness.ts'
import { curaProject } from '../../core/test/fixtures/make-3mf.ts'
import { makePng } from '../../core/test/fixtures/make-png.ts'
import { join } from 'node:path'

async function newProject(server: TestServer, cookie: string, name = 'Benchy') {
  return (
    await server.fetch('/api/projects', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).json()
}

function upload(
  server: TestServer,
  cookie: string,
  projectId: string,
  name: string,
  content: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(content)
  return server.fetch(`/api/projects/${projectId}/files`, {
    method: 'POST',
    cookie,
    headers: {
      'x-spm-file-name': encodeURIComponent(name),
      'content-length': String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  })
}

Deno.test('upload indexes the file and returns a decorated DTO', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)

    const response = await upload(server, cookie, project.id, 'benchy.stl', 'solid benchy')
    assert.equal(response.status, 200)
    const file = await response.json()
    assert.equal(file.name, 'benchy.stl')
    assert.equal(file.kind, 'model')
    assert.equal(file.previewState, 'pending')
    assert.equal(file.rawUrl, `/api/files/${file.id}/raw`)
    assert.equal(file.thumbUrl, undefined)
  })
})

Deno.test('upload without a name header or length is refused', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)

    const noName = await server.fetch(`/api/projects/${project.id}/files`, {
      method: 'POST',
      cookie,
      headers: { 'content-length': '5' },
      body: new TextEncoder().encode('solid'),
    })
    assert.equal(noName.status, 400)

    const noLength = await server.fetch(`/api/projects/${project.id}/files`, {
      method: 'POST',
      cookie,
      headers: { 'x-spm-file-name': 'a.stl' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('solid'))
          controller.close()
        },
      }),
    })
    assert.equal(noLength.status, 411)
  })
})

Deno.test('a traversal attempt in the name header is refused', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const response = await upload(server, cookie, project.id, '../escape.stl', 'solid')
    assert.equal(response.status, 400)
  })
})

Deno.test('exceeding the quota is a 413 carrying the numbers', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const me = await (await server.fetch('/api/account', { cookie })).json()
    await server.fetch(`/api/users/${me.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaBytes: 10 }),
    })
    const project = await newProject(server, cookie)

    const response = await upload(server, cookie, project.id, 'big.stl', 'x'.repeat(50))
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'QuotaExceeded')
    assert.deepEqual(body.error.details, { usageBytes: 0, quotaBytes: 10, incomingBytes: 50 })
  })
})

Deno.test('raw streams the bytes with a real content type', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const file = await (
      await upload(server, cookie, project.id, 'benchy.stl', 'solid benchy')
    ).json()

    const response = await server.fetch(file.rawUrl, { cookie })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'model/stl')
    assert.equal(response.headers.get('content-length'), '12')
    assert.equal(await response.text(), 'solid benchy')
  })
})

Deno.test('thumb is a 404 while pending and a png once ready', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    // Write a real Cura project into the project folder, then let the queue extract it.
    curaProject(join(server.dir, 'admin', 'Benchy', 'benchy.3mf'), makePng(300, 300))
    await server.fetch('/api/projects/rescan', { method: 'POST', cookie })

    const detail = await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    const pending = detail.files.find((f: { name: string }) => f.name === 'benchy.3mf')
    assert.equal(pending.previewState, 'pending')
    assert.equal((await server.fetch(`/api/files/${pending.id}/thumb`, { cookie })).status, 404)

    await runPreviewQueue(server.lib)
    const ready = (
      await (await server.fetch(`/api/projects/${project.id}`, { cookie })).json()
    ).files.find((f: { name: string }) => f.name === 'benchy.3mf')
    assert.equal(ready.previewState, 'ready')
    assert.equal(ready.thumbUrl, `/api/files/${ready.id}/thumb`)

    const thumb = await server.fetch(ready.thumbUrl, { cookie })
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers.get('content-type'), 'image/png')
  })
})

Deno.test('rename and delete work through the api', async () => {
  await withServer(async (server) => {
    const cookie = await loginAsAdmin(server)
    const project = await newProject(server, cookie)
    const file = await (await upload(server, cookie, project.id, 'a.stl', 'solid')).json()

    const renamed = await server.fetch(`/api/files/${file.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b.stl' }),
    })
    assert.equal((await renamed.json()).name, 'b.stl')

    assert.equal(
      (await server.fetch(`/api/files/${file.id}`, { method: 'DELETE', cookie })).status,
      204,
    )
    assert.equal((await server.fetch(`/api/files/${file.id}/raw`, { cookie })).status, 404)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:server
```

Expected: FAIL — the file routes 404.

- [ ] **Step 3: Implement the file routes**

`packages/server/src/routes/files.ts`:

```ts
import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema } from '@spm/contract/schemas.ts'
import { z } from 'zod'
import { deleteFile, renameFile, resolveFilePath, resolvePreviewPath, uploadFile } from '@spm/core'
import { decorateFile } from '../decorate.ts'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

export const UPLOAD_NAME_HEADER = 'x-spm-file-name'

const renameBodySchema = z.object({ name: fileNameSchema })

function requireUploadName(req: Request): string {
  const raw = req.headers.get(UPLOAD_NAME_HEADER)
  if (!raw) throw new AppError('Validation', `${UPLOAD_NAME_HEADER} header is required`)
  const decoded = decodeURIComponent(raw)
  const parsed = fileNameSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new AppError('Validation', 'illegal file name', { issues: parsed.error.issues })
  }
  return parsed.data
}

function requireContentLength(req: Request): number {
  const raw = req.headers.get('content-length')
  const size = raw === null ? Number.NaN : Number(raw)
  if (!Number.isInteger(size) || size < 0) {
    // 411: the quota check must know the size before a byte is written (spec 5.6).
    throw new AppError('LengthRequired', 'content-length is required')
  }
  return size
}

/** Streams a file off disk. Bulk bytes never pass through JSON (spec 4.2). */
async function streamFile(
  absPath: string,
  contentType: string,
  fileName: string,
): Promise<Response> {
  const file = await Deno.open(absPath, { read: true })
  const stat = await file.stat()
  return new Response(file.readable, {
    headers: {
      'content-type': contentType,
      'content-length': String(stat.size),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}

export const fileRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/projects/:id/files',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const name = requireUploadName(req)
      const sizeBytes = requireContentLength(req)
      if (!req.body) throw new AppError('Validation', 'a request body is required')
      const file = await uploadFile(env.lib, ctx, params.id!, name, { stream: req.body, sizeBytes })
      return json(decorateFile(file))
    },
  },
  {
    method: 'PATCH',
    path: '/api/files/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const { name } = await parseJson(req, renameBodySchema)
      return json(decorateFile(renameFile(env.lib, ctx, params.id!, name)))
    },
  },
  {
    method: 'DELETE',
    path: '/api/files/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      deleteFile(env.lib, ctx, params.id!)
      return noContent()
    },
  },
  {
    method: 'GET',
    path: '/api/files/:id/raw',
    auth: 'session',
    handler: async ({ params, env, ctx }) => {
      const resolved = resolveFilePath(env.lib, ctx, params.id!)
      return await streamFile(resolved.absPath, resolved.contentType, resolved.name)
    },
  },
  {
    method: 'GET',
    path: '/api/files/:id/thumb',
    auth: 'session',
    handler: async ({ params, env, ctx }) => {
      const preview = resolvePreviewPath(env.lib, ctx, params.id!)
      if (!preview) throw new AppError('NotFound', 'no preview is ready for this file')
      const response = await streamFile(preview.absPath, 'image/png', `${params.id}.png`)
      // The URL is stable while the preview is regenerated on content change, so keep it short.
      response.headers.set('cache-control', 'private, max-age=60')
      return response
    },
  },
]
```

Add `...fileRoutes` to `packages/server/src/routes/index.ts`, after `projectRoutes`.

- [ ] **Step 4: Run the tests and the whole suite**

```bash
pnpm test:server && pnpm verify
```

Expected: 29 server tests passing, and `verify` still green. This is the checkpoint that says
subsystem A's backend is complete: every `ApiClient` method in §4.1 now has an HTTP route.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): file upload, rename, delete and byte streaming"
```

---

### Task 17: `web` — Angular scaffold, HTTP transport, capabilities, two build targets

The client codes against `ApiClient` and never learns which transport it has (§2.3). The web
build **physically excludes** desktop-only code via `fileReplacements`, and affordances are
gated at runtime by capabilities (§2.5).

**Files:**

- Create: `packages/web/*` via the Angular CLI, then `src/app/core/api/api-client.token.ts`, `src/app/core/api/http-api-client.ts`, `src/app/core/capabilities.store.ts`, `src/app/core/auth.store.ts`, `src/app/core/guards.ts`, `src/app/routes.ts`, `src/app/routes.electron.ts`, `src/app/features/desktop/.gitkeep`
- Modify: `packages/web/angular.json`, `packages/web/src/app/app.config.ts`, `packages/web/src/app/app.ts`, `.github/workflows/ci.yml`
- Test: `packages/web/src/app/core/api/http-api-client.spec.ts`

**Interfaces:**

- Consumes: `ApiClient`, every DTO, `AppError` from `@spm/contract`.
- Produces:
  - `API_CLIENT: InjectionToken<ApiClient>`
  - `class HttpApiClient implements ApiClient` — constructed with a base URL (default `''`, same origin)
  - `CapabilitiesStore` with `capabilities: Signal<Capabilities>`, `load(): Promise<void>`
  - `AuthStore` with `user: Signal<UserDto | null>`, `isAdmin: Signal<boolean>`, `refresh()`, `setUser()`, `logout()`
  - `authGuard`, `adminGuard` (`CanActivateFn`)
  - `routes` / `routes` (electron variant) from `routes.ts` / `routes.electron.ts`

- [ ] **Step 1: Verify the API surfaces before writing any component**

Two dependencies in this stack move fast, so read the installed versions rather than trusting
memory:

```bash
pnpm --filter @spm/web exec node -e "console.log(Object.keys(require('@angular/forms/signals')))"
```

Confirm `form`, `validateStandardSchema`, and `submit` are exported, and check whether
`resource()` takes `params` or `request` in the installed `@angular/core`. For jig, install its
documentation MCP server (§8.3) and look up each control before use rather than guessing:

```bash
pnpm add -D -w @awdlab/jig-mcp
```

jig ships 65+ controls specifically so an agent can look them up. The components in Tasks
18–22 use only `jig-input-field`, `jig-hint`, `jigErrors`, and `[formField]` — the four the spec
itself names (§6.2) — plus plain semantic HTML. Upgrading a plain `<button>` to jig's button or
a plain table to `jig-table` is a legitimate improvement **after** confirming the selector and
inputs through the MCP.

- [ ] **Step 2: Scaffold the Angular app**

```bash
cd packages && pnpm dlx @angular/cli@22 new web --directory=web --style=css --ssr=false --zoneless --routing --skip-git --skip-install --package-manager=pnpm
```

Then in `packages/web/package.json` set `"name": "@spm/web"`, add
`"@spm/contract": "workspace:*"` to dependencies, and add
`"@awdlab/jig"`, `"@awdlab/jig-themes"`, `"@ngneers/signal-translate"`. From the repo root:

```bash
pnpm install
```

Point `packages/web/tsconfig.json` at the shared base by adding
`"extends": "../../tsconfig.base.json"` and keeping the Angular-specific compiler options the
CLI generated (`experimentalDecorators` is not needed; standalone components only).

- [ ] **Step 3: Write the failing transport test**

`packages/web/src/app/core/api/http-api-client.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import { HttpApiClient } from './http-api-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HttpApiClient', () => {
  it('sends credentials so the session cookie travels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }))
    const client = new HttpApiClient('', fetchMock)

    await client.account.me()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/account')
    expect(init.credentials).toBe('include')
  })

  it('builds the project query string from a ProjectQuery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    const client = new HttpApiClient('', fetchMock)

    await client.projects.list({
      search: '100%',
      tags: ['petg', 'functional'],
      includeArchived: true,
      sort: 'name',
      dir: 'asc',
    })

    const url = new URL(fetchMock.mock.calls[0]![0], 'http://x')
    expect(url.searchParams.get('search')).toBe('100%')
    expect(url.searchParams.getAll('tags')).toEqual(['petg', 'functional'])
    expect(url.searchParams.get('includeArchived')).toBe('true')
    expect(url.searchParams.get('sort')).toBe('name')
  })

  it('turns the error envelope back into an AppError with its details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'QuotaExceeded',
            message: 'storage quota exceeded',
            details: { usageBytes: 90, quotaBytes: 100, incomingBytes: 20 },
          },
        },
        413,
      ),
    )
    const client = new HttpApiClient('', fetchMock)

    await expect(
      client.files.upload('p1', 'a.stl', {
        stream: new ReadableStream(),
        sizeBytes: 20,
      }),
    ).rejects.toMatchObject({ code: 'QuotaExceeded', details: { quotaBytes: 100 } })
  })

  it('reports a non-JSON failure as an Internal AppError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gateway down', { status: 502 }))
    const client = new HttpApiClient('', fetchMock)
    const error = await client.capabilities().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('Internal')
  })

  it('encodes a tag name into the delete path rather than a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const client = new HttpApiClient('', fetchMock)

    await client.projects.removeTag('p1', 'needs support')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/projects/p1/tags/needs%20support')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })
})
```

Wire the unit-test target in `packages/web/angular.json` if the CLI did not:

```json
"test": {
  "builder": "@angular/build:unit-test",
  "options": { "buildTarget": "::development", "runner": "vitest" }
}
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./http-api-client`.

- [ ] **Step 5: Implement the transport**

`packages/web/src/app/core/api/http-api-client.ts`:

```ts
import type { ApiClient, UploadBody } from '@spm/contract/api-client.ts'
import type {
  Capabilities,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RescanResultDto,
  SettingsDto,
  UserDto,
} from '@spm/contract/dtos.ts'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string
  private readonly fetchFn: FetchLike

  constructor(baseUrl = '', fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl
    this.fetchFn = fetchFn
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      // The session cookie is httpOnly, so it must ride on the request itself (spec 5.2).
      credentials: 'include',
    })
    if (response.status === 204) return undefined as T
    if (!response.ok) throw await this.toError(response)
    return (await response.json()) as T
  }

  private async toError(response: Response): Promise<AppError> {
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> }
      }
      if (body.error?.code) {
        return new AppError(
          body.error.code as AppErrorCode,
          body.error.message ?? 'request failed',
          body.error.details,
        )
      }
    } catch {
      // Fall through: a proxy or gateway answered with something that is not our envelope.
    }
    return new AppError('Internal', `request failed with status ${response.status}`)
  }

  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  capabilities(): Promise<Capabilities> {
    return this.request('/api/capabilities')
  }

  readonly auth = {
    login: (username: string, password: string): Promise<UserDto> =>
      this.request('/api/auth/login', this.json('POST', { username, password })),
    logout: (): Promise<void> => this.request('/api/auth/logout', { method: 'POST' }),
    checkToken: (token: string): Promise<{ valid: boolean; username?: string }> =>
      this.request(`/api/auth/activation/${encodeURIComponent(token)}`),
    activate: (token: string, newPassword: string): Promise<UserDto> =>
      this.request(
        `/api/auth/activation/${encodeURIComponent(token)}`,
        this.json('POST', { password: newPassword, confirm: newPassword }),
      ),
  }

  readonly account = {
    me: (): Promise<UserDto> => this.request('/api/account'),
    changePassword: (current: string, next: string): Promise<void> =>
      this.request('/api/account/password', this.json('POST', { current, next })),
    updateProfile: (patch: { displayName?: string }): Promise<UserDto> =>
      this.request('/api/account', this.json('PATCH', patch)),
  }

  readonly settings = {
    get: (): Promise<SettingsDto> => this.request('/api/account/settings'),
    put: (patch: Partial<SettingsDto>): Promise<SettingsDto> =>
      this.request('/api/account/settings', this.json('PUT', patch)),
  }

  readonly users = {
    list: (): Promise<UserDto[]> => this.request('/api/users'),
    create: (dto: unknown): Promise<{ user: UserDto; activationUrl: string }> =>
      this.request('/api/users', this.json('POST', dto)),
    reissueInvite: (id: string): Promise<{ activationUrl: string }> =>
      this.request(`/api/users/${id}/invite`, { method: 'POST' }),
    update: (id: string, patch: unknown): Promise<UserDto> =>
      this.request(`/api/users/${id}`, this.json('PATCH', patch)),
    delete: (id: string): Promise<void> => this.request(`/api/users/${id}`, { method: 'DELETE' }),
  }

  readonly projects = {
    list: (query: ProjectQuery): Promise<ProjectDto[]> => {
      const params = new URLSearchParams()
      if (query.search) params.set('search', query.search)
      for (const tag of query.tags ?? []) params.append('tags', tag)
      if (query.includeArchived) params.set('includeArchived', 'true')
      if (query.sort) params.set('sort', query.sort)
      if (query.dir) params.set('dir', query.dir)
      const suffix = params.size > 0 ? `?${params.toString()}` : ''
      return this.request(`/api/projects${suffix}`)
    },
    get: (id: string): Promise<ProjectDetailDto> => this.request(`/api/projects/${id}`),
    create: (dto: unknown): Promise<ProjectDto> =>
      this.request('/api/projects', this.json('POST', dto)),
    update: (id: string, patch: unknown): Promise<ProjectDto> =>
      this.request(`/api/projects/${id}`, this.json('PATCH', patch)),
    delete: (id: string, opts: { deleteFiles: boolean }): Promise<void> =>
      this.request(`/api/projects/${id}?deleteFiles=${opts.deleteFiles}`, { method: 'DELETE' }),
    addTag: (id: string, name: string): Promise<void> =>
      this.request(`/api/projects/${id}/tags`, this.json('POST', { name })),
    removeTag: (id: string, name: string): Promise<void> =>
      this.request(`/api/projects/${id}/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    rescan: (): Promise<RescanResultDto> =>
      this.request('/api/projects/rescan', { method: 'POST' }),
  }

  readonly files = {
    upload: (projectId: string, name: string, body: UploadBody): Promise<FileDto> =>
      this.request(`/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: {
          'x-spm-file-name': encodeURIComponent(name),
          'content-length': String(body.sizeBytes),
        },
        body: body.stream,
        // Required by fetch whenever the body is a stream rather than a buffer.
        duplex: 'half',
      } as RequestInit),
    rename: (id: string, name: string): Promise<FileDto> =>
      this.request(`/api/files/${id}`, this.json('PATCH', { name })),
    delete: (id: string): Promise<void> => this.request(`/api/files/${id}`, { method: 'DELETE' }),
  }
}
```

`packages/web/src/app/core/api/api-client.token.ts`:

```ts
import { InjectionToken } from '@angular/core'
import type { ApiClient } from '@spm/contract/api-client.ts'
import { HttpApiClient } from './http-api-client'

/**
 * The only place the transport is chosen. Electron (spec C) provides IpcApiClient against
 * this same token, and no component changes.
 */
export const API_CLIENT = new InjectionToken<ApiClient>('API_CLIENT', {
  factory: () => new HttpApiClient(),
})
```

- [ ] **Step 6: Implement the capability and auth stores**

`packages/web/src/app/core/capabilities.store.ts`:

```ts
import { Injectable, inject, signal } from '@angular/core'
import type { Capabilities } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

/** Resolved at runtime, never compiled in: the effective set is shell x backend (spec 2.4). */
const OFFLINE_DEFAULTS: Capabilities = {
  requiresAuth: true,
  canManageUsers: false,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
  canBrowseModelSites: false,
}

@Injectable({ providedIn: 'root' })
export class CapabilitiesStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<Capabilities>(OFFLINE_DEFAULTS)
  readonly capabilities = this.state.asReadonly()

  async load(): Promise<void> {
    try {
      this.state.set(await this.api.capabilities())
    } catch {
      // A server that will not answer is treated as the most restrictive shell.
      this.state.set(OFFLINE_DEFAULTS)
    }
  }
}
```

`packages/web/src/app/core/auth.store.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core'
import type { UserDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<UserDto | null>(null)

  readonly user = this.state.asReadonly()
  readonly isAuthenticated = computed(() => this.state() !== null)
  readonly isAdmin = computed(() => this.state()?.isAdmin === true)

  setUser(user: UserDto | null): void {
    this.state.set(user)
  }

  async refresh(): Promise<void> {
    try {
      this.state.set(await this.api.account.me())
    } catch {
      // A 401 at bootstrap is the normal "not logged in yet" case.
      this.state.set(null)
    }
  }

  async logout(): Promise<void> {
    await this.api.auth.logout()
    this.state.set(null)
  }
}
```

`packages/web/src/app/core/guards.ts`:

```ts
import { inject } from '@angular/core'
import { Router, type CanActivateFn } from '@angular/router'
import { AuthStore } from './auth.store'
import { CapabilitiesStore } from './capabilities.store'

export const authGuard: CanActivateFn = () => {
  const capabilities = inject(CapabilitiesStore).capabilities()
  const auth = inject(AuthStore)
  // In Electron local mode requiresAuth is false and there is no session at all (spec 2.6).
  if (!capabilities.requiresAuth || auth.isAuthenticated()) return true
  return inject(Router).createUrlTree(['/login'])
}

export const adminGuard: CanActivateFn = () => {
  const capabilities = inject(CapabilitiesStore).capabilities()
  const auth = inject(AuthStore)
  if (capabilities.canManageUsers && auth.isAdmin()) return true
  return inject(Router).createUrlTree(['/projects'])
}
```

- [ ] **Step 7: Wire bootstrap and the two route files**

`packages/web/src/app/app.config.ts`:

```ts
import {
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  type ApplicationConfig,
} from '@angular/core'
import { provideRouter, withComponentInputBinding } from '@angular/router'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { routes } from './routes'

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAppInitializer(async () => {
      // Capabilities first: the auth guard reads requiresAuth from them.
      await inject(CapabilitiesStore).load()
      await inject(AuthStore).refresh()
    }),
  ],
}
```

`packages/web/src/app/routes.ts`:

```ts
import type { Routes } from '@angular/router'
import { adminGuard, authGuard } from './core/guards'

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'projects' },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'activate',
    loadComponent: () => import('./features/auth/activate.page').then((m) => m.ActivatePage),
  },
  {
    path: 'projects',
    canActivate: [authGuard],
    loadComponent: () => import('./features/projects/projects.page').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/project-detail.page').then((m) => m.ProjectDetailPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: 'admin/users',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./features/admin/users.page').then((m) => m.UsersPage),
  },
  { path: '**', redirectTo: 'projects' },
]
```

`packages/web/src/app/routes.electron.ts` — swapped in by `fileReplacements`, so `/browse` and
`/settings/slicers` and everything they import are **absent from the web bundle** (§2.5). Specs
D and E fill in the two components; until then the folder holds only `.gitkeep` and these two
entries stay commented out with a pointer:

```ts
import type { Routes } from '@angular/router'
import { routes as webRoutes } from './routes'

/**
 * Desktop-only routes live here and are referenced from nowhere else, so the web build cannot
 * pull them in. Spec D adds /settings/slicers, spec E adds /browse, both under
 * ./features/desktop/*.
 */
export const routes: Routes = [
  ...webRoutes.filter((route) => route.path !== '**'),
  { path: '**', redirectTo: 'projects' },
]
```

In `packages/web/angular.json`, add an `electron` configuration to the `build` target:

```json
"electron": {
  "fileReplacements": [
    { "replace": "src/app/routes.ts", "with": "src/app/routes.electron.ts" }
  ]
}
```

Create `packages/web/src/app/features/desktop/.gitkeep` so the exclusion boundary exists from
day one.

- [ ] **Step 8: Run the tests and both builds**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build && pnpm --filter @spm/web exec ng build --configuration=electron
```

Expected: 5 unit tests passing, both bundles built. Confirm the web bundle contains no desktop
code:

```bash
grep -rl "features/desktop" packages/web/dist/web/browser || echo "desktop code absent from web build"
```

Expected: the "absent" message.

- [ ] **Step 9: Add the CI job**

```yaml
web:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with: { version: 10 }
    - uses: actions/setup-node@v4
      with: { node-version: '24', cache: pnpm }
    - run: pnpm install --frozen-lockfile
    - run: pnpm test:web
    - run: pnpm --filter @spm/web exec ng build
    - run: pnpm --filter @spm/web exec ng build --configuration=electron
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): Angular 22 shell, HTTP transport, capability and auth stores"
```

---

### Task 18: `web` — runtime i18n and the settings page

`@angular/localize` was rejected because it is build-time, producing one bundle per locale,
which cannot satisfy the runtime language switch implied by `user_settings.language` (§6.4).

**Files:**

- Create: `packages/web/src/app/core/i18n/translate.service.ts`, `src/app/core/i18n/locales/en.json`, `src/app/core/i18n/locales/de.json`, `src/app/core/settings.store.ts`, `src/app/features/settings/settings.page.ts`
- Modify: `packages/web/src/app/app.config.ts`, `src/app/app.ts`
- Test: `packages/web/src/app/core/settings.store.spec.ts`

**Interfaces:**

- Consumes: `API_CLIENT`, `SettingsDto`, `DEFAULT_SETTINGS`.
- Produces:
  - `TranslateService extends BaseTranslateService<Translations>` with `setLanguage(lang)`, `translations` signal, `interpolate()`
  - `SettingsStore` with `settings: Signal<SettingsDto>`, `load()`, `patch(partial)`
  - `SettingsPage`

- [ ] **Step 1: Write the failing test**

`packages/web/src/app/core/settings.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'
import { SettingsStore } from './settings.store'

function provide(overrides: Partial<SettingsDto>, put = vi.fn()) {
  const api = {
    settings: {
      get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ...overrides }),
      put: put.mockImplementation((patch: Partial<SettingsDto>) =>
        Promise.resolve({ ...DEFAULT_SETTINGS, ...overrides, ...patch }),
      ),
    },
  }
  TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] })
  return { store: TestBed.inject(SettingsStore), api }
}

describe('SettingsStore', () => {
  it('starts from the shared defaults before anything is loaded', () => {
    const { store } = provide({})
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
  })

  it('loads the persisted settings', async () => {
    const { store } = provide({ language: 'de', viewMode: 'list' })
    await store.load()
    expect(store.settings().language).toBe('de')
    expect(store.settings().viewMode).toBe('list')
  })

  it('patches optimistically and keeps the server answer', async () => {
    const { store, api } = provide({})
    await store.load()
    await store.patch({ theme: 'dark' })
    expect(api.settings.put).toHaveBeenCalledWith({ theme: 'dark' })
    expect(store.settings().theme).toBe('dark')
  })

  it('rolls back when the server rejects the patch', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('nope'))
    const { store } = provide({ theme: 'light' }, failing)
    await store.load()
    await expect(store.patch({ theme: 'dark' })).rejects.toThrow()
    expect(store.settings().theme).toBe('light')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./settings.store`.

- [ ] **Step 3: Implement the settings store**

`packages/web/src/app/core/settings.store.ts`:

```ts
import { Injectable, inject, signal } from '@angular/core'
import { DEFAULT_SETTINGS, type SettingsDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from './api/api-client.token'

@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(API_CLIENT)
  private readonly state = signal<SettingsDto>(DEFAULT_SETTINGS)
  readonly settings = this.state.asReadonly()

  async load(): Promise<void> {
    try {
      this.state.set(await this.api.settings.get())
    } catch {
      this.state.set(DEFAULT_SETTINGS)
    }
  }

  /** Optimistic: the UI switches immediately, and rolls back if the write fails. */
  async patch(partial: Partial<SettingsDto>): Promise<void> {
    const previous = this.state()
    this.state.set({ ...previous, ...partial })
    try {
      this.state.set(await this.api.settings.put(partial))
    } catch (error) {
      this.state.set(previous)
      throw error
    }
  }
}
```

- [ ] **Step 4: Implement translations**

`packages/web/src/app/core/i18n/locales/en.json`:

```json
{
  "app": { "title": "Slicer Project Manager", "signOut": "Sign out" },
  "auth": {
    "username": "Username",
    "password": "Password",
    "confirmPassword": "Confirm password",
    "signIn": "Sign in",
    "signInFailed": "Username or password is not correct",
    "activateTitle": "Choose a password",
    "activateInvalid": "This activation link is not valid or has expired",
    "activateSubmit": "Activate account"
  },
  "projects": {
    "title": "Projects",
    "search": "Search",
    "newProject": "New project",
    "name": "Name",
    "website": "Source URL",
    "notes": "Notes",
    "tags": "Tags",
    "addTag": "Add tag",
    "includeArchived": "Show archived",
    "archived": "Archived",
    "missing": "Folder missing",
    "rescan": "Rescan library",
    "rescanned": "Adopted {adopted}, {filesAdded} files added",
    "empty": "No projects yet",
    "files": "Files",
    "upload": "Upload file",
    "delete": "Delete project",
    "deleteFiles": "Also delete the files on disk",
    "previewPending": "Preview pending"
  },
  "settings": {
    "title": "Settings",
    "theme": "Theme",
    "language": "Language",
    "viewMode": "Project view",
    "sort": "Sort by"
  },
  "admin": {
    "title": "Users",
    "displayName": "Display name",
    "isAdmin": "Administrator",
    "status": "Status",
    "usage": "Usage",
    "quota": "Quota",
    "unlimited": "Unlimited",
    "createUser": "Create user",
    "copyLink": "Copy activation link",
    "reissue": "Re-issue invite",
    "disable": "Disable",
    "enable": "Enable",
    "lastAdmin": "The last active administrator must remain"
  },
  "errors": {
    "quotaExceeded": "This upload would exceed your quota ({usage} of {quota} used)",
    "generic": "Something went wrong"
  }
}
```

`packages/web/src/app/core/i18n/locales/de.json` — the same key tree, German values (a missing
key is a compile error, so both files stay in step):

```json
{
  "app": { "title": "Slicer-Projektverwaltung", "signOut": "Abmelden" },
  "auth": {
    "username": "Benutzername",
    "password": "Passwort",
    "confirmPassword": "Passwort bestätigen",
    "signIn": "Anmelden",
    "signInFailed": "Benutzername oder Passwort ist falsch",
    "activateTitle": "Passwort festlegen",
    "activateInvalid": "Dieser Aktivierungslink ist ungültig oder abgelaufen",
    "activateSubmit": "Konto aktivieren"
  },
  "projects": {
    "title": "Projekte",
    "search": "Suchen",
    "newProject": "Neues Projekt",
    "name": "Name",
    "website": "Quell-URL",
    "notes": "Notizen",
    "tags": "Schlagwörter",
    "addTag": "Schlagwort hinzufügen",
    "includeArchived": "Archivierte anzeigen",
    "archived": "Archiviert",
    "missing": "Ordner fehlt",
    "rescan": "Bibliothek neu einlesen",
    "rescanned": "{adopted} übernommen, {filesAdded} Dateien ergänzt",
    "empty": "Noch keine Projekte",
    "files": "Dateien",
    "upload": "Datei hochladen",
    "delete": "Projekt löschen",
    "deleteFiles": "Dateien auf der Festplatte ebenfalls löschen",
    "previewPending": "Vorschau ausstehend"
  },
  "settings": {
    "title": "Einstellungen",
    "theme": "Erscheinungsbild",
    "language": "Sprache",
    "viewMode": "Projektansicht",
    "sort": "Sortierung"
  },
  "admin": {
    "title": "Benutzer",
    "displayName": "Anzeigename",
    "isAdmin": "Administrator",
    "status": "Status",
    "usage": "Belegung",
    "quota": "Kontingent",
    "unlimited": "Unbegrenzt",
    "createUser": "Benutzer anlegen",
    "copyLink": "Aktivierungslink kopieren",
    "reissue": "Einladung neu senden",
    "disable": "Deaktivieren",
    "enable": "Aktivieren",
    "lastAdmin": "Der letzte aktive Administrator muss bestehen bleiben"
  },
  "errors": {
    "quotaExceeded": "Dieser Upload würde das Kontingent überschreiten ({usage} von {quota} belegt)",
    "generic": "Etwas ist schiefgelaufen"
  }
}
```

`packages/web/src/app/core/i18n/translate.service.ts` — `loadTranslations` is a dynamic import,
so locale JSON is lazy-loaded rather than bundled up front (§6.4):

```ts
import { Injectable } from '@angular/core'
import { BaseTranslateService } from '@ngneers/signal-translate'
import en from './locales/en.json'

export type Translations = typeof en
export type Language = 'en' | 'de'

@Injectable({ providedIn: 'root' })
export class TranslateService extends BaseTranslateService<Translations, Language> {
  constructor() {
    super('en', en)
  }

  protected override async loadTranslations(language: Language): Promise<Translations> {
    if (language === 'de') return (await import('./locales/de.json')).default
    return en
  }
}
```

Confirm the base class's constructor and abstract member names against the installed
`@ngneers/signal-translate` typings before finishing this file:

```bash
pnpm --filter @spm/web exec cat node_modules/@ngneers/signal-translate/index.d.ts
```

Adjust the `super()` call and the overridden method to match; the shape above is the contract
this plan assumes (default language plus a lazy loader).

- [ ] **Step 5: Seed the language at bootstrap and write it back on change**

Extend the initializer in `app.config.ts`:

```ts
    provideAppInitializer(async () => {
      await inject(CapabilitiesStore).load()
      await inject(AuthStore).refresh()
      const settings = inject(SettingsStore)
      const translate = inject(TranslateService)
      if (inject(AuthStore).isAuthenticated()) {
        await settings.load()
        await translate.setLanguage(settings.settings().language)
      }
    }),
```

- [ ] **Step 6: Implement the settings page**

`packages/web/src/app/features/settings/settings.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { SettingsStore } from '../../core/settings.store'
import { TranslateService } from '../../core/i18n/translate.service'

@Component({
  selector: 'spm-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ t.translations().settings.title }}</h1>

    <label>
      {{ t.translations().settings.language }}
      <select [value]="settings.settings().language" (change)="onLanguage($event)">
        <option value="en">English</option>
        <option value="de">Deutsch</option>
      </select>
    </label>

    <label>
      {{ t.translations().settings.theme }}
      <select [value]="settings.settings().theme" (change)="onPatch('theme', $event)">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>

    <label>
      {{ t.translations().settings.viewMode }}
      <select [value]="settings.settings().viewMode" (change)="onPatch('viewMode', $event)">
        <option value="grid">Grid</option>
        <option value="list">List</option>
      </select>
    </label>
  `,
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  protected async onLanguage(event: Event): Promise<void> {
    const language = (event.target as HTMLSelectElement).value as 'en' | 'de'
    await this.settings.patch({ language })
    // Reactive switch at runtime; no rebuild, no reload (spec 6.4).
    await this.t.setLanguage(language)
  }

  protected onPatch(key: 'theme' | 'viewMode', event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value
    return this.settings.patch({ [key]: value } as never)
  }
}
```

Apply the theme by reflecting `settings().theme` onto a `data-theme` attribute on the document
element in `app.ts`, which is what `@awdlab/jig-themes` reads:

```ts
import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core'
import { RouterLink, RouterOutlet } from '@angular/router'
import { AuthStore } from './core/auth.store'
import { CapabilitiesStore } from './core/capabilities.store'
import { SettingsStore } from './core/settings.store'
import { TranslateService } from './core/i18n/translate.service'

@Component({
  selector: 'spm-root',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <a routerLink="/projects">{{ t.translations().app.title }}</a>
      <nav>
        <a routerLink="/settings">{{ t.translations().settings.title }}</a>
        @if (capabilities.capabilities().canManageUsers && auth.isAdmin()) {
          <a routerLink="/admin/users">{{ t.translations().admin.title }}</a>
        }
        @if (auth.isAuthenticated()) {
          <button type="button" (click)="auth.logout()">{{ t.translations().app.signOut }}</button>
        }
      </nav>
    </header>
    <main><router-outlet /></main>
  `,
})
export class App {
  protected readonly auth = inject(AuthStore)
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)
  private readonly settings = inject(SettingsStore)

  constructor() {
    effect(() => {
      document.documentElement.dataset.theme = this.settings.settings().theme
    })
  }
}
```

- [ ] **Step 7: Run the tests**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build
```

Expected: 9 unit tests passing, build clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): runtime i18n, settings store and settings page"
```

---

### Task 19: `web` — login and activation pages

One Zod schema validates the Angular form and the backend request (§2.3, §6.2). The activation
token is read from the URL **fragment**, never a query parameter (§5.3).

**Files:**

- Create: `packages/web/src/app/features/auth/login.page.ts`, `src/app/features/auth/activate.page.ts`
- Test: `packages/web/src/app/features/auth/activate.page.spec.ts`, `src/app/features/auth/login.page.spec.ts`

**Interfaces:**

- Consumes: `API_CLIENT`, `AuthStore`, `TranslateService`, `loginSchema`, `activateSchema`, `Router`, `ActivatedRoute`.
- Produces: `LoginPage` with public `errorKey: Signal<'signInFailed' | null>`; `ActivatePage` with public `state: Signal<'checking' | 'ready' | 'invalid'>` and `username: Signal<string | null>`.

**jig binding shape** — §6.2 fixes the structure: a `jig-input-field` wrapper carries the label,
the control is bound with `[formField]`, and errors render through `jigErrors` into `jig-hint`.
Confirm the exact control selectors through `@awdlab/jig-mcp` (Task 17, Step 1) before writing
the templates; if a selector differs, keep the structure and change the tag.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/app/features/auth/activate.page.spec.ts`:

```ts
import { ActivatedRoute } from '@angular/router'
import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ActivatePage } from './activate.page'

function setup(fragment: string | null, checkToken = vi.fn()) {
  const api = { auth: { checkToken, activate: vi.fn() } }
  TestBed.configureTestingModule({
    providers: [
      { provide: API_CLIENT, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { fragment } } },
    ],
  })
  const fixture = TestBed.createComponent(ActivatePage)
  return { fixture, api }
}

describe('ActivatePage', () => {
  it('reports an invalid link when the fragment is missing', async () => {
    const { fixture } = setup(null)
    await TestBed.inject(ApplicationRef).whenStable()
    expect(fixture.componentInstance.state()).toBe('invalid')
  })

  it('checks the token before asking for a password', async () => {
    const checkToken = vi.fn().mockResolvedValue({ valid: true, username: 'anna' })
    const { fixture } = setup('sometoken', checkToken)
    await TestBed.inject(ApplicationRef).whenStable()

    expect(checkToken).toHaveBeenCalledWith('sometoken')
    expect(fixture.componentInstance.state()).toBe('ready')
    expect(fixture.componentInstance.username()).toBe('anna')
  })

  it('reports an expired link as invalid', async () => {
    const { fixture } = setup('expired', vi.fn().mockResolvedValue({ valid: false }))
    await TestBed.inject(ApplicationRef).whenStable()
    expect(fixture.componentInstance.state()).toBe('invalid')
  })
})
```

`packages/web/src/app/features/auth/login.page.spec.ts`:

```ts
import { Router } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { LoginPage } from './login.page'

function setup(login: ReturnType<typeof vi.fn>) {
  const navigate = vi.fn()
  TestBed.configureTestingModule({
    providers: [
      { provide: API_CLIENT, useValue: { auth: { login }, account: { me: vi.fn() } } },
      { provide: Router, useValue: { navigate } },
    ],
  })
  return { fixture: TestBed.createComponent(LoginPage), navigate }
}

describe('LoginPage', () => {
  it('stores the user and navigates on success', async () => {
    const user = { id: '1', username: 'marc', isAdmin: false }
    const { fixture, navigate } = setup(vi.fn().mockResolvedValue(user))
    fixture.componentInstance.model.set({ username: 'marc', password: 'a good long password' })

    await fixture.componentInstance.onSubmit()

    expect(TestBed.inject(AuthStore).user()).toEqual(user)
    expect(navigate).toHaveBeenCalledWith(['/projects'])
    expect(fixture.componentInstance.errorKey()).toBeNull()
  })

  it('shows one generic message for any credential failure', async () => {
    const { fixture, navigate } = setup(
      vi.fn().mockRejectedValue(new AppError('Unauthorized', 'nope')),
    )
    fixture.componentInstance.model.set({ username: 'marc', password: 'wrong password' })

    await fixture.componentInstance.onSubmit()

    expect(fixture.componentInstance.errorKey()).toBe('signInFailed')
    expect(navigate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./activate.page`.

- [ ] **Step 3: Implement the login page**

`packages/web/src/app/features/auth/login.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { Router } from '@angular/router'
import { form, validateStandardSchema } from '@angular/forms/signals'
import { loginSchema } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { TranslateService } from '../../core/i18n/translate.service'

@Component({
  selector: 'spm-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ t.translations().auth.signIn }}</h1>
    <form (submit)="onSubmit(); $event.preventDefault()">
      <jig-input-field [label]="t.translations().auth.username">
        <jig-input [formField]="loginForm.username" autocomplete="username" />
        <jig-hint jigErrors />
      </jig-input-field>

      <jig-input-field [label]="t.translations().auth.password">
        <jig-input
          type="password"
          [formField]="loginForm.password"
          autocomplete="current-password"
        />
        <jig-hint jigErrors />
      </jig-input-field>

      @if (errorKey()) {
        <p role="alert">{{ t.translations().auth.signInFailed }}</p>
      }

      <button type="submit" [disabled]="busy()">{{ t.translations().auth.signIn }}</button>
    </form>
  `,
})
export class LoginPage {
  private readonly api = inject(API_CLIENT)
  private readonly auth = inject(AuthStore)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  readonly model = signal({ username: '', password: '' })
  // The same schema the server validates with (spec 2.3).
  protected readonly loginForm = form(this.model, (path) => {
    validateStandardSchema(path, loginSchema)
  })
  readonly errorKey = signal<'signInFailed' | null>(null)
  readonly busy = signal(false)

  async onSubmit(): Promise<void> {
    this.errorKey.set(null)
    this.busy.set(true)
    try {
      const { username, password } = this.model()
      this.auth.setUser(await this.api.auth.login(username, password))
      await this.router.navigate(['/projects'])
    } catch {
      // Unknown user, pending, disabled and wrong password are one message (spec 5.1).
      this.errorKey.set('signInFailed')
    } finally {
      this.busy.set(false)
    }
  }
}
```

- [ ] **Step 4: Implement the activation page**

`packages/web/src/app/features/auth/activate.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { form, validateStandardSchema } from '@angular/forms/signals'
import { activateSchema } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { AuthStore } from '../../core/auth.store'
import { TranslateService } from '../../core/i18n/translate.service'

@Component({
  selector: 'spm-activate-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state()) {
      @case ('checking') {
        <p>...</p>
      }
      @case ('invalid') {
        <p role="alert">{{ t.translations().auth.activateInvalid }}</p>
      }
      @case ('ready') {
        <h1>{{ t.translations().auth.activateTitle }}</h1>
        <p>{{ username() }}</p>
        <form (submit)="onSubmit(); $event.preventDefault()">
          <jig-input-field [label]="t.translations().auth.password">
            <jig-input
              type="password"
              [formField]="activateForm.password"
              autocomplete="new-password"
            />
            <jig-hint jigErrors />
          </jig-input-field>

          <jig-input-field [label]="t.translations().auth.confirmPassword">
            <jig-input
              type="password"
              [formField]="activateForm.confirm"
              autocomplete="new-password"
            />
            <jig-hint jigErrors />
          </jig-input-field>

          <button type="submit" [disabled]="busy()">
            {{ t.translations().auth.activateSubmit }}
          </button>
        </form>
      }
    }
  `,
})
export class ActivatePage {
  private readonly api = inject(API_CLIENT)
  private readonly auth = inject(AuthStore)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  // The token rides in the fragment so it never reaches an access log (spec 5.3).
  private readonly token = inject(ActivatedRoute).snapshot.fragment

  readonly state = signal<'checking' | 'ready' | 'invalid'>('checking')
  readonly username = signal<string | null>(null)
  readonly busy = signal(false)

  readonly model = signal({ password: '', confirm: '' })
  protected readonly activateForm = form(this.model, (path) => {
    validateStandardSchema(path, activateSchema)
  })

  constructor() {
    void this.check()
  }

  private async check(): Promise<void> {
    if (!this.token) {
      this.state.set('invalid')
      return
    }
    try {
      // Read-only check, so an expired link errors before a password is typed (spec 5.3).
      const result = await this.api.auth.checkToken(this.token)
      if (!result.valid) {
        this.state.set('invalid')
        return
      }
      this.username.set(result.username ?? null)
      this.state.set('ready')
    } catch {
      this.state.set('invalid')
    }
  }

  async onSubmit(): Promise<void> {
    if (!this.token) return
    this.busy.set(true)
    try {
      // Activation issues a session, so there is no second login step (spec 5.3).
      this.auth.setUser(await this.api.auth.activate(this.token, this.model().password))
      await this.router.navigate(['/projects'])
    } catch {
      this.state.set('invalid')
    } finally {
      this.busy.set(false)
    }
  }
}
```

Both components need jig's controls imported. Add the imports the MCP lookup names — the
`imports:` array gains the jig field/input/hint components, and the app-level provider from
`@awdlab/jig-themes` goes in `app.config.ts`.

- [ ] **Step 5: Run the tests**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build
```

Expected: 14 unit tests passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): login and activation pages on signal forms"
```

---

### Task 20: `web` — the project list

One `list` call renders the whole grid: `coverThumbUrl` is already on the DTO, so there is no
N+1 (§4.2).

**Files:**

- Create: `packages/web/src/app/features/projects/projects.store.ts`, `src/app/features/projects/projects.page.ts`
- Test: `packages/web/src/app/features/projects/projects.store.spec.ts`

**Interfaces:**

- Consumes: `API_CLIENT`, `SettingsStore`, `TranslateService`, `ProjectDto`, `ProjectQuery`, `createProjectSchema`.
- Produces: `ProjectsStore` with `query: Signal<ProjectQuery>`, `projects` (a `resource`), `setSearch(term)`, `toggleTag(name)`, `setIncludeArchived(flag)`, `setSort(sort, dir)`, `create(input)`, `rescan()`, `knownTags: Signal<string[]>`; `ProjectsPage`

- [ ] **Step 1: Write the failing test**

`packages/web/src/app/features/projects/projects.store.spec.ts`:

```ts
import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ProjectsStore } from './projects.store'

function project(over: Partial<ProjectDto>): ProjectDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function setup(list = vi.fn().mockResolvedValue([])) {
  const api = {
    projects: { list, create: vi.fn().mockResolvedValue(project({})), rescan: vi.fn() },
  }
  TestBed.configureTestingModule({
    providers: [ProjectsStore, { provide: API_CLIENT, useValue: api }],
  })
  return { store: TestBed.inject(ProjectsStore), api }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

describe('ProjectsStore', () => {
  it('starts sorted by most recently updated', async () => {
    const { store, api } = setup()
    await settle()
    expect(store.query()).toEqual({ sort: 'updatedAt', dir: 'desc' })
    expect(api.projects.list).toHaveBeenCalledWith({ sort: 'updatedAt', dir: 'desc' })
  })

  it('reloads when the search term changes', async () => {
    const { store, api } = setup()
    await settle()
    store.setSearch('bench')
    await settle()
    expect(api.projects.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'bench' }))
  })

  it('drops an empty search term rather than sending it', async () => {
    const { store } = setup()
    store.setSearch('bench')
    store.setSearch('   ')
    expect(store.query().search).toBeUndefined()
  })

  it('toggles a tag on and off', () => {
    const { store } = setup()
    store.toggleTag('petg')
    expect(store.query().tags).toEqual(['petg'])
    store.toggleTag('boat')
    expect(store.query().tags).toEqual(['petg', 'boat'])
    store.toggleTag('petg')
    expect(store.query().tags).toEqual(['boat'])
    store.toggleTag('boat')
    expect(store.query().tags).toBeUndefined()
  })

  it('collects the tag union of the loaded projects for the filter bar', async () => {
    const { store } = setup(
      vi
        .fn()
        .mockResolvedValue([
          project({ id: 'a', tags: ['petg', 'boat'] }),
          project({ id: 'b', tags: ['boat', 'functional'] }),
        ]),
    )
    await settle()
    expect(store.knownTags()).toEqual(['boat', 'functional', 'petg'])
  })

  it('reloads after creating a project and after a rescan', async () => {
    const { store, api } = setup()
    await settle()
    const before = api.projects.list.mock.calls.length

    await store.create({ name: 'New' })
    await settle()
    await store.rescan()
    await settle()

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'New' })
    expect(api.projects.rescan).toHaveBeenCalled()
    expect(api.projects.list.mock.calls.length).toBeGreaterThan(before + 1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./projects.store`.

- [ ] **Step 3: Implement the store**

`packages/web/src/app/features/projects/projects.store.ts`:

```ts
import { Injectable, computed, inject, resource, signal } from '@angular/core'
import type { ProjectDto, ProjectQuery, RescanResultDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'

@Injectable()
export class ProjectsStore {
  private readonly api = inject(API_CLIENT)
  private readonly queryState = signal<ProjectQuery>({ sort: 'updatedAt', dir: 'desc' })

  readonly query = this.queryState.asReadonly()

  /** resource() takes any promise, so the transport abstraction survives (spec 6.1). */
  readonly projects = resource<ProjectDto[], ProjectQuery>({
    params: () => this.queryState(),
    loader: ({ params }) => this.api.projects.list(params),
    defaultValue: [],
  })

  readonly knownTags = computed(() =>
    [...new Set(this.projects.value().flatMap((project) => project.tags))].sort((a, b) =>
      a.localeCompare(b),
    ),
  )

  setSearch(term: string): void {
    const trimmed = term.trim()
    this.queryState.update(({ search: _dropped, ...rest }) =>
      trimmed ? { ...rest, search: trimmed } : rest,
    )
  }

  toggleTag(name: string): void {
    this.queryState.update((query) => {
      const current = query.tags ?? []
      const next = current.includes(name)
        ? current.filter((tag) => tag !== name)
        : [...current, name]
      const { tags: _dropped, ...rest } = query
      return next.length > 0 ? { ...rest, tags: next } : rest
    })
  }

  setIncludeArchived(flag: boolean): void {
    this.queryState.update(({ includeArchived: _dropped, ...rest }) =>
      flag ? { ...rest, includeArchived: true } : rest,
    )
  }

  setSort(sort: ProjectQuery['sort'], dir: ProjectQuery['dir']): void {
    this.queryState.update((query) => ({ ...query, sort, dir }))
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    const created = await this.api.projects.create(input)
    this.projects.reload()
    return created
  }

  async rescan(): Promise<RescanResultDto> {
    const result = await this.api.projects.rescan()
    this.projects.reload()
    return result
  }
}
```

- [ ] **Step 4: Implement the page**

`packages/web/src/app/features/projects/projects.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { form, validateStandardSchema } from '@angular/forms/signals'
import { createProjectSchema } from '@spm/contract/schemas.ts'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import { SettingsStore } from '../../core/settings.store'
import { TranslateService } from '../../core/i18n/translate.service'
import { ProjectsStore } from './projects.store'

@Component({
  selector: 'spm-projects-page',
  imports: [RouterLink],
  providers: [ProjectsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <h1>{{ t.translations().projects.title }}</h1>
      <button type="button" (click)="onRescan()">{{ t.translations().projects.rescan }}</button>
      @if (rescanned()) {
        <p role="status">
          {{
            t.interpolate(t.translations().projects.rescanned, {
              adopted: rescanned()!.adopted,
              filesAdded: rescanned()!.filesAdded,
            })
          }}
        </p>
      }
    </header>

    <section>
      <input
        type="search"
        [attr.aria-label]="t.translations().projects.search"
        (input)="store.setSearch($any($event.target).value)"
      />

      <label>
        <input
          type="checkbox"
          [checked]="store.query().includeArchived === true"
          (change)="store.setIncludeArchived($any($event.target).checked)"
        />
        {{ t.translations().projects.includeArchived }}
      </label>

      <select (change)="onSort($any($event.target).value)">
        <option value="updatedAt:desc">{{ t.translations().settings.sort }}</option>
        <option value="name:asc">A–Z</option>
        <option value="createdAt:desc">Newest</option>
      </select>

      @for (tag of store.knownTags(); track tag) {
        <button
          type="button"
          [attr.aria-pressed]="(store.query().tags ?? []).includes(tag)"
          (click)="store.toggleTag(tag)"
        >
          {{ tag }}
        </button>
      }
    </section>

    <form (submit)="onCreate(); $event.preventDefault()">
      <jig-input-field [label]="t.translations().projects.name">
        <jig-input [formField]="createForm.name" />
        <jig-hint jigErrors />
      </jig-input-field>
      <button type="submit">{{ t.translations().projects.newProject }}</button>
    </form>

    @if (store.projects.isLoading()) {
      <p>...</p>
    } @else if (store.projects.value().length === 0) {
      <p>{{ t.translations().projects.empty }}</p>
    } @else {
      <ul [class]="settings.settings().viewMode">
        @for (project of store.projects.value(); track project.id) {
          <li>
            <a [routerLink]="['/projects', project.id]">
              @if (project.coverThumbUrl) {
                <img [src]="project.coverThumbUrl" [alt]="project.name" width="256" height="256" />
              } @else {
                <span>{{ t.translations().projects.previewPending }}</span>
              }
              <h2>{{ project.name }}</h2>
            </a>
            <p>
              {{ project.fileCounts.model }} / {{ project.fileCounts.slicerProject }} /
              {{ project.fileCounts.other }}
            </p>
            @if (project.isArchived) {
              <span>{{ t.translations().projects.archived }}</span>
            }
            @if (project.state === 'missing') {
              <span role="alert">{{ t.translations().projects.missing }}</span>
            }
            @for (tag of project.tags; track tag) {
              <span>{{ tag }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class ProjectsPage {
  protected readonly store = inject(ProjectsStore)
  protected readonly settings = inject(SettingsStore)
  protected readonly t = inject(TranslateService)

  readonly rescanned = signal<RescanResultDto | null>(null)
  readonly createModel = signal({ name: '' })
  protected readonly createForm = form(this.createModel, (path) => {
    validateStandardSchema(path, createProjectSchema)
  })

  protected onSort(value: string): void {
    const [sort, dir] = value.split(':')
    this.store.setSort(sort as 'name' | 'createdAt' | 'updatedAt', dir as 'asc' | 'desc')
  }

  protected async onCreate(): Promise<void> {
    const name = this.createModel().name.trim()
    if (!name) return
    await this.store.create({ name })
    this.createModel.set({ name: '' })
  }

  protected async onRescan(): Promise<void> {
    this.rescanned.set(await this.store.rescan())
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build
```

Expected: 20 unit tests passing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): project list with search, tag filter, sort and rescan"
```

---

### Task 21: `web` — the project detail page

**Files:**

- Create: `packages/web/src/app/features/projects/project-detail.page.ts`
- Test: `packages/web/src/app/features/projects/project-detail.page.spec.ts`

**Interfaces:**

- Consumes: `API_CLIENT`, `TranslateService`, `ProjectDetailDto`, `FileDto`, `projectPatchSchema`, `tagNameSchema`, `AppError`, `QuotaExceededDetails`.
- Produces: `ProjectDetailPage` with a route input `id: string` (bound by `withComponentInputBinding`), public `project` (a `resource`), `errorMessage: Signal<string | null>`, `onUpload(file: File)`, `onAddTag(name)`, `onRemoveTag(name)`, `onRenameFile(file, name)`, `onDeleteFile(file)`, `onDeleteProject(deleteFiles)`, and `formatBytes(n): string`.

- [ ] **Step 1: Write the failing test**

`packages/web/src/app/features/projects/project-detail.page.spec.ts`:

```ts
import { ApplicationRef } from '@angular/core'
import { Router } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import type { ProjectDetailDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { ProjectDetailPage } from './project-detail.page'

const detail: ProjectDetailDto = {
  id: 'p1',
  name: 'Benchy',
  isArchived: false,
  state: 'ok',
  tags: ['boat'],
  fileCounts: { model: 1, slicerProject: 0, other: 0 },
  createdAt: 0,
  updatedAt: 0,
  files: [
    {
      id: 'f1',
      name: 'benchy.stl',
      kind: 'model',
      sizeBytes: 2048,
      previewState: 'pending',
      rawUrl: '/api/files/f1/raw',
    },
  ],
}

function setup(overrides: Record<string, unknown> = {}) {
  const api = {
    projects: {
      get: vi.fn().mockResolvedValue(detail),
      update: vi.fn().mockResolvedValue(detail),
      addTag: vi.fn().mockResolvedValue(undefined),
      removeTag: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      upload: vi.fn().mockResolvedValue(detail.files[0]),
      rename: vi.fn().mockResolvedValue(detail.files[0]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  }
  TestBed.configureTestingModule({
    providers: [
      { provide: API_CLIENT, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ],
  })
  const fixture = TestBed.createComponent(ProjectDetailPage)
  fixture.componentRef.setInput('id', 'p1')
  return { fixture, api }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

describe('ProjectDetailPage', () => {
  it('loads the project named by the route input', async () => {
    const { fixture, api } = setup()
    await settle()
    expect(api.projects.get).toHaveBeenCalledWith('p1')
    expect(fixture.componentInstance.project.value()?.name).toBe('Benchy')
  })

  it('uploads a file as a stream with its real size', async () => {
    const { fixture, api } = setup()
    await settle()
    const file = new File(['solid benchy'], 'benchy.stl')

    await fixture.componentInstance.onUpload(file)

    const [projectId, name, body] = api.files.upload.mock.calls[0]!
    expect(projectId).toBe('p1')
    expect(name).toBe('benchy.stl')
    expect(body.sizeBytes).toBe(file.size)
    expect(body.stream).toBeInstanceOf(ReadableStream)
  })

  it('renders a quota failure with the actual numbers', async () => {
    const { fixture, api } = setup()
    await settle()
    api.files.upload.mockRejectedValueOnce(
      new AppError('QuotaExceeded', 'nope', {
        usageBytes: 1024,
        quotaBytes: 2048,
        incomingBytes: 4096,
      }),
    )

    await fixture.componentInstance.onUpload(new File(['x'], 'a.stl'))

    expect(fixture.componentInstance.errorMessage()).toContain('1.0 kB')
    expect(fixture.componentInstance.errorMessage()).toContain('2.0 kB')
  })

  it('adds and removes a tag, then reloads', async () => {
    const { fixture, api } = setup()
    await settle()

    await fixture.componentInstance.onAddTag('petg')
    await fixture.componentInstance.onRemoveTag('boat')

    expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
    expect(api.projects.removeTag).toHaveBeenCalledWith('p1', 'boat')
    expect(api.projects.get.mock.calls.length).toBeGreaterThan(1)
  })

  it('deletes the project with the deleteFiles choice and navigates away', async () => {
    const { fixture, api } = setup()
    await settle()

    await fixture.componentInstance.onDeleteProject(true)

    expect(api.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: true })
    expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith(['/projects'])
  })

  it('formats byte counts for humans', () => {
    const { fixture } = setup()
    expect(fixture.componentInstance.formatBytes(0)).toBe('0 B')
    expect(fixture.componentInstance.formatBytes(2048)).toBe('2.0 kB')
    expect(fixture.componentInstance.formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./project-detail.page`.

- [ ] **Step 3: Implement the page**

`packages/web/src/app/features/projects/project-detail.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, input, resource, signal } from '@angular/core'
import { Router } from '@angular/router'
import type { FileDto } from '@spm/contract/dtos.ts'
import { AppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

@Component({
  selector: 'spm-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (project.value(); as detail) {
      <h1>{{ detail.name }}</h1>
      @if (detail.state === 'missing') {
        <p role="alert">{{ t.translations().projects.missing }}</p>
      }

      <dl>
        <dt>{{ t.translations().projects.website }}</dt>
        <dd>
          @if (detail.website) {
            <a [href]="detail.website" target="_blank" rel="noreferrer noopener">
              {{ detail.website }}
            </a>
          }
        </dd>
        <dt>{{ t.translations().projects.notes }}</dt>
        <dd>{{ detail.notes }}</dd>
      </dl>

      <section>
        <h2>{{ t.translations().projects.tags }}</h2>
        @for (tag of detail.tags; track tag) {
          <span>
            {{ tag }}
            <button type="button" (click)="onRemoveTag(tag)" [attr.aria-label]="tag">x</button>
          </span>
        }
        <input
          type="text"
          [attr.aria-label]="t.translations().projects.addTag"
          (keydown.enter)="onAddTag($any($event.target).value); $any($event.target).value = ''"
        />
      </section>

      <section>
        <h2>{{ t.translations().projects.files }}</h2>
        <input
          type="file"
          [attr.aria-label]="t.translations().projects.upload"
          (change)="onFileInput($event)"
        />
        @if (errorMessage()) {
          <p role="alert">{{ errorMessage() }}</p>
        }

        <ul>
          @for (file of detail.files; track file.id) {
            <li>
              @if (file.thumbUrl) {
                <img [src]="file.thumbUrl" [alt]="file.name" width="128" height="128" />
              } @else {
                <span>{{ t.translations().projects.previewPending }}</span>
              }
              <a [href]="file.rawUrl">{{ file.name }}</a>
              <span>{{ formatBytes(file.sizeBytes) }}</span>
              @if (file.slicer) {
                <span>{{ file.slicer }}</span>
              }
              <button type="button" (click)="onDeleteFile(file)">x</button>
            </li>
          }
        </ul>
      </section>

      <section>
        <label>
          <input type="checkbox" #wipe />
          {{ t.translations().projects.deleteFiles }}
        </label>
        <button type="button" (click)="onDeleteProject(wipe.checked)">
          {{ t.translations().projects.delete }}
        </button>
      </section>
    }
  `,
})
export class ProjectDetailPage {
  private readonly api = inject(API_CLIENT)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  readonly id = input.required<string>()

  readonly project = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.projects.get(params),
  })

  readonly errorMessage = signal<string | null>(null)

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < UNITS.length - 1) {
      value /= 1024
      unit++
    }
    return `${value.toFixed(1)} ${UNITS[unit]}`
  }

  protected onFileInput(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0]
    return file ? this.onUpload(file) : Promise.resolve()
  }

  async onUpload(file: File): Promise<void> {
    this.errorMessage.set(null)
    try {
      // The browser streams the file; bytes never pass through JSON (spec 4.2).
      await this.api.files.upload(this.id(), file.name, {
        stream: file.stream(),
        sizeBytes: file.size,
      })
      this.project.reload()
    } catch (error) {
      this.errorMessage.set(this.describe(error))
    }
  }

  private describe(error: unknown): string {
    if (error instanceof AppError && error.code === 'QuotaExceeded') {
      const details = error.details as QuotaExceededDetails
      return this.t.interpolate(this.t.translations().errors.quotaExceeded, {
        usage: this.formatBytes(details.usageBytes),
        quota: this.formatBytes(details.quotaBytes),
      })
    }
    return this.t.translations().errors.generic
  }

  async onAddTag(name: string): Promise<void> {
    if (!name.trim()) return
    await this.api.projects.addTag(this.id(), name.trim())
    this.project.reload()
  }

  async onRemoveTag(name: string): Promise<void> {
    await this.api.projects.removeTag(this.id(), name)
    this.project.reload()
  }

  async onRenameFile(file: FileDto, name: string): Promise<void> {
    await this.api.files.rename(file.id, name)
    this.project.reload()
  }

  async onDeleteFile(file: FileDto): Promise<void> {
    await this.api.files.delete(file.id)
    this.project.reload()
  }

  async onDeleteProject(deleteFiles: boolean): Promise<void> {
    await this.api.projects.delete(this.id(), { deleteFiles })
    await this.router.navigate(['/projects'])
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build
```

Expected: 26 unit tests passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): project detail with files, tags, upload and quota errors"
```

---

### Task 22: `web` — the admin users page

Admins manage users and never see other users' projects (§5.5). What they get instead is
per-user usage and a quota (§5.6), plus the activation link to copy out of band (§5.7).

**Files:**

- Create: `packages/web/src/app/features/admin/users.page.ts`
- Test: `packages/web/src/app/features/admin/users.page.spec.ts`

**Interfaces:**

- Consumes: `API_CLIENT`, `TranslateService`, `UserDto`, `createUserSchema`, `AppError`.
- Produces: `UsersPage` with public `users` (a `resource`), `activationUrl: Signal<string | null>`, `errorMessage: Signal<string | null>`, `onCreate()`, `onReissue(user)`, `onToggleDisabled(user)`, `onToggleAdmin(user)`, `onSetQuota(user, megabytes)`, `onDelete(user)`, `usagePercent(user): number | null`

- [ ] **Step 1: Write the failing test**

`packages/web/src/app/features/admin/users.page.spec.ts`:

```ts
import { ApplicationRef } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@spm/contract/errors.ts'
import type { UserDto } from '@spm/contract/dtos.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { UsersPage } from './users.page'

function user(over: Partial<UserDto>): UserDto {
  return {
    id: 'u1',
    username: 'marc',
    displayName: 'Marc',
    isAdmin: true,
    status: 'active',
    diskUsageBytes: 0,
    quotaBytes: null,
    createdAt: 0,
    ...over,
  }
}

function setup() {
  const api = {
    users: {
      list: vi.fn().mockResolvedValue([user({})]),
      create: vi.fn().mockResolvedValue({
        user: user({ id: 'u2', username: 'anna', status: 'pending' }),
        activationUrl: 'http://x/activate#tok',
      }),
      reissueInvite: vi.fn().mockResolvedValue({ activationUrl: 'http://x/activate#tok2' }),
      update: vi.fn().mockResolvedValue(user({})),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }
  TestBed.configureTestingModule({ providers: [{ provide: API_CLIENT, useValue: api }] })
  return { fixture: TestBed.createComponent(UsersPage), api }
}

const settle = () => TestBed.inject(ApplicationRef).whenStable()

describe('UsersPage', () => {
  it('lists users on load', async () => {
    const { fixture, api } = setup()
    await settle()
    expect(api.users.list).toHaveBeenCalled()
    expect(fixture.componentInstance.users.value()?.length).toBe(1)
  })

  it('surfaces the activation url once, for the admin to copy', async () => {
    const { fixture } = setup()
    await settle()
    fixture.componentInstance.createModel.set({
      username: 'anna',
      displayName: 'Anna',
      isAdmin: false,
      quotaBytes: null,
    })

    await fixture.componentInstance.onCreate()

    expect(fixture.componentInstance.activationUrl()).toBe('http://x/activate#tok')
  })

  it('re-issuing an invite replaces the shown link', async () => {
    const { fixture } = setup()
    await settle()
    await fixture.componentInstance.onReissue(user({ id: 'u2' }))
    expect(fixture.componentInstance.activationUrl()).toBe('http://x/activate#tok2')
  })

  it('converts a megabyte quota entry into bytes', async () => {
    const { fixture, api } = setup()
    await settle()
    await fixture.componentInstance.onSetQuota(user({}), 500)
    expect(api.users.update).toHaveBeenCalledWith('u1', { quotaBytes: 500 * 1024 * 1024 })
  })

  it('clears a quota back to unlimited', async () => {
    const { fixture, api } = setup()
    await settle()
    await fixture.componentInstance.onSetQuota(user({}), null)
    expect(api.users.update).toHaveBeenCalledWith('u1', { quotaBytes: null })
  })

  it('explains a last-active-admin refusal', async () => {
    const { fixture, api } = setup()
    await settle()
    api.users.delete.mockRejectedValueOnce(new AppError('LastActiveAdmin', 'nope'))

    await fixture.componentInstance.onDelete(user({}))

    expect(fixture.componentInstance.errorMessage()).toBe(
      'The last active administrator must remain',
    )
  })

  it('computes usage percent only when a quota exists', () => {
    const { fixture } = setup()
    expect(fixture.componentInstance.usagePercent(user({ quotaBytes: null }))).toBeNull()
    expect(
      fixture.componentInstance.usagePercent(user({ quotaBytes: 200, diskUsageBytes: 50 })),
    ).toBe(25)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:web
```

Expected: FAIL — cannot resolve `./users.page`.

- [ ] **Step 3: Implement the page**

`packages/web/src/app/features/admin/users.page.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core'
import { form, validateStandardSchema } from '@angular/forms/signals'
import type { UserDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { createUserSchema } from '@spm/contract/schemas.ts'
import { API_CLIENT } from '../../core/api/api-client.token'
import { TranslateService } from '../../core/i18n/translate.service'

const MIB = 1024 * 1024

@Component({
  selector: 'spm-users-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ t.translations().admin.title }}</h1>

    <form (submit)="onCreate(); $event.preventDefault()">
      <jig-input-field [label]="t.translations().auth.username">
        <jig-input [formField]="createForm.username" />
        <jig-hint jigErrors />
      </jig-input-field>
      <jig-input-field [label]="t.translations().admin.displayName">
        <jig-input [formField]="createForm.displayName" />
        <jig-hint jigErrors />
      </jig-input-field>
      <button type="submit">{{ t.translations().admin.createUser }}</button>
    </form>

    @if (activationUrl(); as url) {
      <p>
        <code>{{ url }}</code>
        <button type="button" (click)="onCopy(url)">{{ t.translations().admin.copyLink }}</button>
      </p>
    }
    @if (errorMessage()) {
      <p role="alert">{{ errorMessage() }}</p>
    }

    <table>
      <thead>
        <tr>
          <th>{{ t.translations().auth.username }}</th>
          <th>{{ t.translations().admin.status }}</th>
          <th>{{ t.translations().admin.isAdmin }}</th>
          <th>{{ t.translations().admin.usage }}</th>
          <th>{{ t.translations().admin.quota }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (user of users.value() ?? []; track user.id) {
          <tr>
            <td>{{ user.username }}</td>
            <td>{{ user.status }}</td>
            <td>
              <input
                type="checkbox"
                [checked]="user.isAdmin"
                (change)="onToggleAdmin(user)"
                [attr.aria-label]="t.translations().admin.isAdmin"
              />
            </td>
            <td>
              {{ user.diskUsageBytes }}
              @if (usagePercent(user); as percent) {
                <span>({{ percent }}%)</span>
              }
            </td>
            <td>
              @if (user.quotaBytes === null) {
                <span>{{ t.translations().admin.unlimited }}</span>
              } @else {
                <span>{{ user.quotaBytes }}</span>
              }
              <input
                type="number"
                min="1"
                [attr.aria-label]="t.translations().admin.quota"
                (change)="onSetQuota(user, $any($event.target).valueAsNumber || null)"
              />
            </td>
            <td>
              <button type="button" (click)="onReissue(user)">
                {{ t.translations().admin.reissue }}
              </button>
              <button type="button" (click)="onToggleDisabled(user)">
                {{
                  user.status === 'disabled'
                    ? t.translations().admin.enable
                    : t.translations().admin.disable
                }}
              </button>
              <button type="button" (click)="onDelete(user)">x</button>
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class UsersPage {
  private readonly api = inject(API_CLIENT)
  protected readonly t = inject(TranslateService)

  readonly users = resource({ loader: () => this.api.users.list() })
  readonly activationUrl = signal<string | null>(null)
  readonly errorMessage = signal<string | null>(null)

  readonly createModel = signal({
    username: '',
    displayName: '',
    isAdmin: false,
    quotaBytes: null as number | null,
  })
  protected readonly createForm = form(this.createModel, (path) => {
    validateStandardSchema(path, createUserSchema)
  })

  usagePercent(user: UserDto): number | null {
    if (user.quotaBytes === null || user.quotaBytes === 0) return null
    return Math.round((user.diskUsageBytes / user.quotaBytes) * 100)
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    this.errorMessage.set(null)
    try {
      await action()
    } catch (error) {
      this.errorMessage.set(
        error instanceof AppError && error.code === 'LastActiveAdmin'
          ? this.t.translations().admin.lastAdmin
          : this.t.translations().errors.generic,
      )
    }
  }

  async onCreate(): Promise<void> {
    await this.guard(async () => {
      // Returned exactly once; the admin copies it out of band (spec 5.7).
      const result = await this.api.users.create(this.createModel())
      this.activationUrl.set(result.activationUrl)
      this.createModel.set({ username: '', displayName: '', isAdmin: false, quotaBytes: null })
      this.users.reload()
    })
  }

  onReissue(user: UserDto): Promise<void> {
    return this.guard(async () => {
      this.activationUrl.set((await this.api.users.reissueInvite(user.id)).activationUrl)
    })
  }

  onToggleDisabled(user: UserDto): Promise<void> {
    return this.guard(async () => {
      await this.api.users.update(user.id, { isDisabled: user.status !== 'disabled' })
      this.users.reload()
    })
  }

  onToggleAdmin(user: UserDto): Promise<void> {
    return this.guard(async () => {
      await this.api.users.update(user.id, { isAdmin: !user.isAdmin })
      this.users.reload()
    })
  }

  onSetQuota(user: UserDto, megabytes: number | null): Promise<void> {
    return this.guard(async () => {
      await this.api.users.update(user.id, {
        quotaBytes: megabytes === null ? null : megabytes * MIB,
      })
      this.users.reload()
    })
  }

  onDelete(user: UserDto): Promise<void> {
    return this.guard(async () => {
      await this.api.users.delete(user.id)
      this.users.reload()
    })
  }

  protected onCopy(url: string): void {
    void navigator.clipboard.writeText(url)
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test:web && pnpm --filter @spm/web exec ng build
```

Expected: 34 unit tests passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): admin users page with quotas, usage and activation links"
```

---

### Task 23: CI — the full pipeline and an end-to-end smoke test

**Files:**

- Create: `packages/web/e2e/seed.ts`, `packages/web/e2e/smoke.spec.ts`, `packages/web/playwright.config.ts`, `README.md`
- Modify: `package.json` (root scripts), `.github/workflows/ci.yml`
- Test: the e2e suite itself

**Interfaces:**

- Consumes: `openLibrary`, `ensureBootstrapAdmin`, `activateAccount` from `@spm/core`; `@awdlab/jig-playwright` (§8.2).
- Produces: root script `pnpm e2e`, CI job `e2e`, `README.md`.

- [ ] **Step 1: Write the seed script**

`packages/web/e2e/seed.ts` — run under Deno; creates a library with one **known-password**
admin so the browser can log in. No production code path grants a default password; this uses
the ordinary bootstrap-then-activate flow.

```ts
import { activateAccount, ensureBootstrapAdmin, openLibrary } from '@spm/core'

const dir = Deno.args[0]
if (!dir) {
  console.error('usage: deno run -A e2e/seed.ts <libraryDir>')
  Deno.exit(1)
}

const lib = openLibrary(dir)
const boot = await ensureBootstrapAdmin(lib)
if (boot) await activateAccount(lib, boot.token, 'e2e test password', 'seed')
console.log('seeded')
```

- [ ] **Step 2: Write the failing e2e test**

`packages/web/e2e/smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

const PASSWORD = 'e2e test password'

test('an admin can log in, create a project and see it in the grid', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.getByLabel('Name').fill('Benchy')
  await page.getByRole('button', { name: 'New project' }).click()

  await expect(page.getByRole('heading', { name: 'Benchy' })).toBeVisible()
})

test('a rescan adopts a folder dropped into the library', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('button', { name: 'Rescan library' }).click()
  await expect(page.getByRole('status')).toContainText('Adopted')
})

test('the language switch takes effect without a reload', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByLabel('Language').selectOption('de')

  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()
})

test('the admin route is reachable for an admin and lists users', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('link', { name: 'Users' }).click()
  await expect(page.getByRole('cell', { name: 'admin' })).toBeVisible()
})
```

- [ ] **Step 3: Configure Playwright**

`packages/web/playwright.config.ts` — builds the web bundle, seeds a temp library, and serves
both from the Deno server, so the e2e run exercises the real static-file path (§4.3):

```ts
import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const libraryDir = process.env.SPM_E2E_LIBRARY ?? mkdtempSync(join(tmpdir(), 'spm-e2e-'))

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:8123' },
  webServer: {
    command: [
      'pnpm --filter @spm/web exec ng build',
      `deno run -A ../../packages/web/e2e/seed.ts "${libraryDir}"`,
      'deno run -A ../server/main.ts',
    ].join(' && '),
    cwd: '.',
    url: 'http://localhost:8123/api/capabilities',
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      SPM_LIBRARY_DIR: libraryDir,
      SPM_PORT: '8123',
      SPM_WEB_ROOT: 'dist/web/browser',
    },
  },
})
```

Add the root script:

```json
"e2e": "pnpm --filter @spm/web exec playwright test"
```

`@awdlab/jig-playwright` (§8.2) supplies jig-aware locators; add it as a dev dependency of
`@spm/web` and prefer its locators over raw CSS wherever a jig control's internals would
otherwise leak into the test.

- [ ] **Step 4: Run the e2e suite**

```bash
pnpm e2e
```

Expected: 4 passing. If a locator misses, fix the _component_ to carry a proper accessible
label rather than weakening the locator to a CSS selector — the label is what a screen reader
uses too.

- [ ] **Step 5: Complete the CI pipeline**

Add the final job to `.github/workflows/ci.yml`:

```yaml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with: { version: 10 }
    - uses: actions/setup-node@v4
      with: { node-version: '24', cache: pnpm }
    - uses: denoland/setup-deno@v2
      with: { deno-version: v2.x }
    - run: pnpm install --frozen-lockfile
    - run: pnpm --filter @spm/web exec playwright install --with-deps chromium
    - run: pnpm e2e
```

The finished pipeline has six jobs: `checks`, `core-node`, `core-deno`, `server`, `web`, `e2e`.
`core-node` and `core-deno` are the ones that matter most — they are the standing test of the
runtime-agnostic core (§8.1).

- [ ] **Step 6: Write the README**

`README.md`:

```markdown
# Slicer Project Manager

A cross-platform manager for 3D-printing projects. See
[docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md](docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md)
for the design and
[docs/superpowers/plans](docs/superpowers/plans) for the implementation plans.

## Requirements

Node >= 24.4, Deno >= 2.5, pnpm >= 10.

## Running the server

    export SPM_LIBRARY_DIR="/path/to/your/print files"
    pnpm install
    pnpm --filter @spm/web exec ng build
    deno run -A packages/server/main.ts

On first run against an empty library the server creates a `pending` admin account and prints
its activation path. Open it, choose a password, and you are logged in. There is no default
password anywhere.

`SPM_PORT` (default 8000) and `SPM_WEB_ROOT` (default `../web/dist/web/browser`) are optional.

## Layout

| Package    | What it is                                   |
| ---------- | -------------------------------------------- |
| `contract` | DTOs, Zod schemas, the `ApiClient` interface |
| `core`     | all behaviour; runs on Deno and Node         |
| `server`   | the Deno HTTP transport                      |
| `web`      | the Angular client                           |

## Tests

    pnpm verify   # lint, format, contract, core on Node, core on Deno
    pnpm test:server
    pnpm test:web
    pnpm e2e

`core` runs under both runtimes on purpose: that is what keeps the same code usable from the
Electron main process (subsystem C).
```

- [ ] **Step 7: Run everything**

```bash
pnpm verify && pnpm test:server && pnpm test:web && pnpm e2e
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: end-to-end smoke suite, complete CI pipeline and README"
```

---

## Done means

Subsystem A is complete when all of the following hold:

- `pnpm verify && pnpm test:server && pnpm test:web && pnpm e2e` is green.
- `core`'s suite passes under **both** Deno and Node, as two separate CI jobs (§8.1).
- Every `ApiClient` method in §4.1 has an HTTP route in §4.3's table, and every route is
  covered by an integration test.
- No authorisation decision exists outside `core`: grepping the server for `isAdmin` finds only
  the capability constant, and every project/file query is scoped by `ctx.userId`.
- `grep -rl "features/desktop" packages/web/dist/web/browser` finds nothing.
- The five slicer detection cases and the Orca-before-Bambu ordering are covered by tests
  against synthetic 3MFs matching the layouts measured on 2026-08-22.
- Rescan has explicit tests for adopt, missing-folder, changed-file, and dot-folder skipping
  (§8.2).
- No default password exists in the code, the config, or the docs.

## Deliberately not done here

- Subsystem B: the mesh rasterizer, the 3MF streaming mesh parser, PNG encoding, thumbnail
  downscaling, and the three.js viewer. The seam is `PreviewHandler`.
- Subsystem C: `packages/desktop`, `IpcApiClient`, `protocol.handle('spm://')`, the local/remote
  mode picker. The seams are `ApiClient`, the capability model, and `resolveFilePath`.
- Subsystem D: slicer launching and machine-local slicer configuration. The seam is
  `files.slicer` plus `/settings/slicers` in `routes.electron.ts`.
- Subsystem E: the embedded model browser and download interception. The seams are
  `projects.website`, `canBrowseModelSites`, and `files.upload`.
- FTS5 search (§3.8), `Range` requests on `/raw`, and per-file preview downscaling — all
  recorded as optional later work.
