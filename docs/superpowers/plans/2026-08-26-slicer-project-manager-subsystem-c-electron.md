# Slicer Project Manager — Subsystem C: the Electron shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run the same Angular UI as a desktop application that opens a **local folder** with no
server and no login, and that can also point at a remote server. Spec 2.6's two modes, spec 2.4's
runtime capability model, and the `IpcApiClient` that 2.4 and 9 promise.

**Architecture:** a new `packages/desktop` holds an Electron main process that talks to
`packages/core` directly — the same functions the Deno server calls — and exposes them to the
renderer over one IPC channel. The renderer is the existing Angular electron build, unchanged
except that `API_CLIENT` resolves to `IpcApiClient` instead of `HttpApiClient`. File bytes reach
the renderer through a registered `spm://` protocol rather than over HTTP.

**Spec:** [`docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md`](../specs/2026-08-22-slicer-project-manager-design.md)
§2.4 (capability model), §2.5 (build targets), §2.6 (desktop library modes), §2.7 (the slicer
constraint, recorded not solved), §9 (the seams).

**Prior plans:** [A](2026-08-22-slicer-project-manager-subsystem-a.md),
[B1](2026-08-23-slicer-project-manager-subsystem-b1-rasterizer.md),
[B1 follow-ups](2026-08-24-slicer-project-manager-b1-followups.md),
[B2](2026-08-25-slicer-project-manager-subsystem-b2-viewer.md).

---

## What was measured before this plan was written

Every figure here came from a spike, not from documentation. They are the reason the tasks are
shaped as they are, and a task that contradicts one of them is wrong.

| Question                                     | Measured                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Current Electron, and the Node it bundles    | **44.0.0**, Node **24.18.1**, Chromium 152                                                                     |
| Does `node:sqlite` work in the main process? | **Yes** — `DatabaseSync`, `prepare`, `run`, `get` all fine                                                     |
| Does `packages/core` run there unchanged?    | **Yes** — opened a library, migrated, `ensureLocalUser`, created and listed a project                          |
| Can the main bundle be CJS?                  | **No** — `migrate.ts` resolves its SQL through `import.meta.url`, which a CJS bundle breaks with `Invalid URL` |
| Does an ESM bundle fix it?                   | **Yes**, with `migrations/*.sql` copied next to the bundle                                                     |
| What journal mode does a library open in?    | **`delete`**, not WAL — see the open questions                                                                 |

`node:sqlite` being present is the load-bearing fact of this subsystem: it is why the desktop app
can call core directly instead of shipping a second copy of the data layer.

---

## Scope

| In this plan                                                   | Not in this plan                           |
| -------------------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`: Electron main, preload, and its build      | Slicer configuration or launching (spec D) |
| `IpcApiClient` implementing the whole `ApiClient` interface    | The embedded model browser (spec E)        |
| `spm://` for thumbnails and raw file bytes                     | Installers, code signing, auto-update      |
| Local-folder mode: native picker, first run, remembered folder | Any change to how the Deno server behaves  |
| Remote-server mode from the desktop shell                      | Multi-window, tray, OS file associations   |

**Deliberately deferred, with reasons:**

- **Installers and signing.** The plan produces a runnable unpacked app and a `dev:desktop` task.
  Packaging is a per-OS concern with certificates attached to it, and no design question in this
  subsystem depends on how the result is shipped.
- **Auto-update.** Meaningless before there is a release channel.

---

## Global constraints

A reviewer should treat a violation as a defect regardless of what a task says.

1. **The renderer is the existing Angular app, unmodified except at the seams the spec named** —
   `API_CLIENT` (`packages/web/src/app/core/api/api-client.token.ts`) and `routes.electron.ts`. A
   component that has to know it is running in Electron is a design failure: capabilities are
   resolved at runtime and every affordance keys off them.
2. **No change to how the Deno server behaves.** Refactoring code the server shares is allowed and
   expected (task 3 does it); changing its observable behaviour is not.
3. **The main process is the only thing that touches the filesystem or the database.** The renderer
   gets bytes over IPC or `spm://`, never through `node:` modules. `nodeIntegration: false`,
   `contextIsolation: true`, `sandbox: true`.
4. **Every IPC channel validates its input in the main process.** The renderer is the untrusted
   side of this boundary even though we wrote it — a compromised renderer must not be able to read
   or write outside the library folder. The zod schemas in `@spm/contract` already exist for this.
5. **Errors keep their identity across the boundary.** `AppError` carries a `code` the UI switches
   on; an IPC error arriving as a bare string breaks error handling that already works over HTTP.
6. **`deno task verify` stays green and gains the new package.** Desktop tests run in CI.
7. **Every assertion must be able to fail** — break the code it covers, confirm red, restore. This
   subsystem has a GUI and an IPC boundary, and both make it easy to write a test that passes
   because nothing happened.

---

## Decisions taken up front

1. **A new package, `packages/desktop`.** Not a folder inside `packages/web`: it is a different
   runtime with a different build and a different dependency set, and the Angular builder should
   never see it. It joins the Deno workspace like the others.
2. **The main process is bundled with esbuild, as ESM.** Measured above: CJS breaks the migration
   loader. `migrations/*.sql` are copied next to the bundle by the build. esbuild is already
   present as an Angular dependency; add it explicitly rather than borrowing it.
3. **One IPC channel, not thirty.** `spm:invoke` carries `{ path: string; args: unknown[] }` where
   `path` is a dotted `ApiClient` route (`projects.list`, `files.rename`). A dispatch table in the
   main process maps each to a core call. Thirty named channels would need thirty registrations and
   thirty preload entries and would still be one lookup — this way the table is a value that can be
   unit-tested without Electron running at all.
4. **`spm://` serves file bytes, and decoration is parameterised to produce it.** `decorate.ts`
   hardcodes `/api/files/...` and lives in `packages/server`. It moves to `packages/contract` as a
   factory over the URL base; the server passes `/api`, the desktop passes `spm://file`.
   Duplicating twenty lines that must stay in sync across two shells is the alternative, and it is
   worse.
5. **Local mode is the default and the interesting one.** Remote mode is the same `HttpApiClient`
   the browser already uses, pointed at a configured origin. Task 5 proves it works and invents
   nothing for it.
6. **Tests use Playwright's Electron support**, which the repo already has a Playwright dependency
   for. GUI tests need `xvfb` on the Linux runner, and the CI job says so.

---

## Tasks

### Task 1 — A window that opens, and a build that produces it

- [ ] Create `packages/desktop` with its own `deno.json` and `package.json`, added to the root
      `deno.json` workspace list alongside contract, core, server and web.
- [ ] `packages/desktop/src/main.ts`: create a `BrowserWindow` with `nodeIntegration: false`,
      `contextIsolation: true`, `sandbox: true`, load the Angular **electron** build from
      `packages/web/dist/electron/browser`, and quit on all-windows-closed except on darwin.
- [ ] `packages/desktop/src/preload.ts`: `contextBridge.exposeInMainWorld` with nothing on it yet.
      Task 2 fills it. It exists now so the window is created with the real preload path and task 2
      does not have to change the window options.
- [ ] `packages/desktop/build.ts`: esbuild, `--format=esm`, `--platform=node`,
      `--external:electron`, bundling `src/main.ts` and `src/preload.ts` into `dist/`, and copying
      `packages/core/src/db/migrations/*.sql` next to the main bundle. **ESM is not a preference:**
      a CJS bundle fails at runtime with `Invalid URL` out of `migrate.ts`. Put that reason in the
      file, because the next person to meet an ESM Electron main will try to "fix" it.
- [ ] Root tasks: `build:desktop` (ng build electron, then `build.ts`) and `dev:desktop`.
- [ ] Tests: a Playwright `_electron.launch` test that the app opens exactly one window, that the
      window title is the app name, that the renderer actually reached `projects` (the Angular app
      booted — not merely that a window exists), and that the process exits 0 when the window
      closes. Assert on rendered DOM: a blank window passes a window count.
- [ ] CI: a `desktop` job installing Node and Deno, building, and running the Electron tests under
      `xvfb-run`, with a `timeout-minutes` like the web and e2e jobs have.

### Task 2 — The IPC bridge and `IpcApiClient`

- [ ] `packages/desktop/src/dispatch.ts`: a table mapping each dotted `ApiClient` path to a
      function over `(lib, ctx, args)`. It imports from `@spm/core` and knows nothing about
      Electron, so it is unit-testable in plain Node. Every entry validates its arguments with the
      matching `@spm/contract` schema before calling core.
- [ ] Wire `ipcMain.handle('spm:invoke', ...)` to the table, and expose `invoke(path, args)` from
      the preload over `contextBridge`.
- [ ] **Error identity across the boundary (constraint 5).** Electron serialises a thrown `Error`
      by message only, so `AppError.code` is lost. Catch in the handler, return a tagged failure
      value, and rethrow a reconstructed `AppError` in the renderer. Test that a core validation
      failure arrives in the renderer as an `AppError` with the same `code` it has on the server —
      not merely that something throws.
- [ ] `packages/web/src/app/core/api/ipc-api-client.ts`: implements `ApiClient` by forwarding to
      `invoke`. It lives in `packages/web` because the renderer bundles it, and it is referenced
      only from the electron-side providers so the web build cannot pull it in.
- [ ] Provide it for `API_CLIENT` in the electron build only, following the `fileReplacements`
      pattern `routes.electron.ts` already uses.
- [ ] Tests: unit tests over the dispatch table for every `ApiClient` method — it is the
      interface's only other implementation, and a missing entry fails at runtime in a shell the
      unit suite does not otherwise cover. Add a test that the table's key set **equals** the
      interface's method set, so adding a method to `ApiClient` without implementing it here fails
      a test rather than the app. Plus a Playwright-Electron test that the project list renders
      from a real library on disk.

### Task 3 — `spm://` for thumbnails and raw bytes

- [ ] Move `decorateFile` / `decorateProject` / `decorateProjectDetail` out of
      `packages/server/src/decorate.ts` into `packages/contract`, as a factory over the URL base.
      The server calls it with `/api` and must produce byte-identical DTOs — assert that, do not
      assume it.
- [ ] `protocol.registerSchemesAsPrivileged` plus `protocol.handle('spm://')` in the main process,
      serving `spm://file/<id>/thumb` and `spm://file/<id>/raw` out of the library.
- [ ] **Path containment is the security boundary here.** A file id resolves to a path through
      core's own `safeJoin`; a request that escapes the library folder is refused. Test the escape
      explicitly, including a percent-encoded traversal.
- [ ] Range requests for `raw`: the B2 viewer fetches whole files, but the size gate's design
      assumed HTTP semantics. State plainly whether ranges are supported and what happens without
      them.
- [ ] Tests: a thumbnail renders in the desktop app — assert pixels or a non-zero natural size, not
      that an `<img>` element exists, which B2 learned the hard way; a raw fetch returns the right
      bytes; a traversal attempt is refused.

### Task 4 — Local folder mode

- [ ] First run with no remembered folder shows a picker: `dialog.showOpenDialog` with
      `properties: ['openDirectory', 'createDirectory']`.
- [ ] On open: `openLibrary`, `runMigrations`, `ensureLocalUser` — all three exist already, and
      `ensureLocalUser` already implements spec 2.6's single flat-library user with
      `library_dir = '.'`. Do not reimplement it.
- [ ] Remember the last folder in `app.getPath('userData')/state.json` and reopen it next launch. A
      remembered folder that no longer exists returns to the picker with an explanation, not a
      crash.
- [ ] Capabilities: the main process returns the **Electron + local folder** column of spec 2.4 —
      `requiresAuth: false`, `canManageUsers: false`, `canPickLocalFolder: true`, and the three
      slicer/browser flags **false** until specs D and E ship them. Claiming a capability whose
      feature does not exist lights up UI that goes nowhere.
- [ ] **Someone has to tick the preview queue.** In the browser it is the Deno server, on
      `SPM_PREVIEW_INTERVAL_MS`; in local mode there is no server, so a freshly opened folder would
      show every model as `pending` forever and task 3's thumbnails would have nothing to serve.
      The main process runs the queue. Decide and state the interval and the concurrency, and say
      what happens to a claim the app held when it was killed mid-render — the queue's lease logic
      exists for exactly that and should not be re-invented here.
- [ ] A control to switch folders, reopening the library without a restart.
- [ ] Tests: first run shows the picker; a chosen folder survives a relaunch; a remembered-but-
      deleted folder degrades to the picker with a message; the capability set matches the spec
      table exactly — assert the whole object, so a later task cannot quietly flip one flag; and no
      login screen ever appears.

### Task 5 — Remote mode, and making the thing runnable

- [ ] A mode picker at first run: local folder, or a remote server URL. Remote mode uses the
      existing `HttpApiClient` against that origin, with `requiresAuth: true` arriving from the
      server's own `capabilities()` — the shell contributes its column, the backend contributes its
      own, and the client uses the union (spec 2.4). Implement the union explicitly and test it: it
      is the one part of the capability model a single-mode app never exercises.
- [ ] Sessions in remote mode: the desktop app is not a browser tab. Say how the session is carried
      and where it is stored, and test that a restart either keeps the user logged in or
      deliberately does not.
- [ ] `deno task dev:desktop` runs against a dev build with devtools available; document it and
      `build:desktop` in the README beside the existing tasks.
- [ ] An unpacked, runnable application directory, and the command that produces it. Not an
      installer.
- [ ] Tests: remote mode reaches a real server started by the test and lists its projects; the
      capability union is asserted for both modes; switching modes does not leak the previous
      mode's client — a stale `HttpApiClient` after switching to local is the obvious failure.

---

## Open questions, decided or recorded

1. **Journal mode is `delete`, not WAL** — measured. Spec 2.3's `busy_timeout` comment says the
   library file is opened by several processes at once by design, and this subsystem adds the
   second process. WAL would handle that contention far better, but WAL is unreliable on network
   filesystems and a local folder may well be a network share — which may be exactly why it is not
   set. **Recorded, not changed:** it predates this subsystem, and changing it is a data-layer
   decision deserving its own measurement rather than a side effect of shipping a desktop app.
2. **Packaging is deferred**, with the reason in Scope. Task 5 still has to produce something a
   person can run, or the subsystem cannot be said to work.
3. **Spec 2.7's slicer-launch-against-a-remote-library problem is not solved here** and must not be
   half-solved. It belongs to spec D.

---

## Definition of done

- `deno task verify` green, `deno task e2e` green, the new desktop tests green, CI green on `main`.
- The desktop app opens a folder chosen in a native dialog, with no server running and no login,
  and shows the projects in it — including thumbnails that the app rendered itself, from a folder
  that had none when it was opened.
- Every `ApiClient` method works over IPC, and adding one to the interface without implementing it
  fails a test.
- The capability set matches spec 2.4 exactly in both modes.
- A `.stl` in a local library opens in the B2 viewer inside the desktop app.
