# Slicer Project Manager — Migration to Rust, SolidJS and Tauri

- **Date:** 2026-10-25
- **Status:** Approved and implemented; see "Implementation notes" at the end for where the build
  deliberately differs
- **Supersedes, for the _how_:** the Package layout, runtime, contract, frontend, desktop and
  tooling sections of
  [`2026-08-22-slicer-project-manager-design.md`](2026-08-22-slicer-project-manager-design.md)
  (§2.1–2.3, §2.5, §6.1–6.2, §7, §8.3) and the Electron mechanics of subsystems C, D, E and G.
- **Does not supersede, for the _what_:** every behaviour those specs and subsystems A–H define —
  library layout, schema, classification, reconciliation, auth rules, quotas, capabilities, slicer
  registry, model-browser policy, shell, settings, the projects page — stays as specified, except
  where §4 below names a change. Where this document is silent, the existing spec and the existing
  tests are the definition of correct behaviour.

## 1. Why

The app is unreleased and has no consumers, so nothing has to stay wire- or code-compatible. Four
pressures drive the move, all stated by the user:

1. **Deno is being wound down** — security patches only, for one more year.
2. **RAM on the NAS.** A Node backend costs too much resident memory on the target NAS. This is the
   binding constraint and the reason for the backend choice.
3. **Angular is too heavy** for the frontend; SolidJS is faster and lighter.
4. **Electron ships Chromium.** Tauri uses the OS webview, so the desktop package loses it.

### 1.1 Success

- The app runs again, end to end, with the full current feature set (minus STEP previews, §4.1):
  browser + NAS server, Tauri desktop on a local folder, Tauri desktop against a remote server.
- The NAS server's resident memory is materially below today's Deno server for the same library.
- A completely new visual style (§6), not a port of the current one.
- The Deno, Angular and Electron code is gone from the repository.

### 1.2 Non-goals

- Changing product behaviour beyond §4.
- Keeping the old style, the jig component library, or any Angular/Electron code alongside the new.
- macOS/Linux desktop parity beyond what already exists (subsystem E was Windows-measured only and
  stays that way).
- Installer signing, auto-update.

### 1.3 Anti-goals

- A backend that is "migrated" but still needs a JavaScript runtime on the NAS.
- Styling repeated per call site: a button is styled in exactly one place (§6.2).
- A port where the tests were dropped to get to green. Nobody reads the Rust or TS line by line
  (the codebase is fully agent-written and the user does not read Rust), so the test suites are the
  only safety net and are part of the migration, not a follow-up.

## 2. Decisions the user made

| Decision                                                                                   | Notes                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Backend in Rust** (not Go)                                                               | Recommended by Claude, accepted. Rationale in §3.1.                                            |
| **Frontend in SolidJS + Tailwind 4**                                                       | Tailwind for bundle size.                                                                      |
| **Desktop on Tauri** (2.x)                                                                 | Replaces Electron.                                                                             |
| **Drop STEP support for now**                                                              | Not much STEP in the library; can come back later.                                             |
| **Toolchain:** Node 24, pnpm 12, TypeScript 7, oxlint, oxfmt, `minimumReleaseAge` = 2 days | Applies to the JS side. pnpm setting `minimumReleaseAge: 2880` (minutes).                      |
| **Style direction "B"**: neutral surfaces + orange accent, light **and** dark              | Picked from mockups. Follows OS by default with a manual toggle.                               |
| **Reusable components**                                                                    | Meaning: every UI element (button, input, …) is styled once, in a component, never per usage.  |
| **Migrate everything at once, best effort**, fix what breaks                               | No staged hybrid. Bottom-up order with test checkpoints (§8).                                  |
| **Delete the old code** once its replacement passes                                        | No parallel old/new trees at the end.                                                          |
| **Keep Playwright e2e**, pointed at the new app                                            |                                                                                                |

## 3. Architecture

### 3.1 Why Rust for the server

Tauri already requires Rust, so a Go server would mean three languages (Go, Rust, TS) and a
sidecar process inside the desktop bundle. With Rust, the same shape the repo has today — one
`core` shared by a server and a desktop shell — maps directly onto one Cargo crate used twice.
Rust also has no GC or runtime heap overhead, which matters most for the bursty allocations of
the mesh rasterizer on a RAM-constrained NAS.

### 3.2 Repository layout

```
slicer-project-manager/
├── Cargo.toml                 Cargo workspace
├── pnpm-workspace.yaml        pnpm workspace (web + tooling)
├── crates/
│   ├── spm-core/              all application behaviour: db, auth, files, projects, import, previews
│   ├── spm-http/              axum router over spm-core: the REST API of today's §4.3, sessions, static
│   └── spm-server/            NAS binary: env parsing (today's server/env.ts), logging, serves spm-http
├── apps/
│   └── desktop/               Tauri app (src-tauri/ = Rust; frontend = the shared web build)
├── packages/
│   └── web/                   SolidJS + Tailwind 4 frontend, one build for browser and desktop
└── tools/                     icon generation etc. (Node 24 scripts)
```

Exact crate boundaries are the builder's call; the constraint is that **ownership and
authorisation are enforced in `spm-core`** (as today, parent §2.2), never in a transport.

### 3.3 One transport: HTTP everywhere _(Claude's call)_

Today the frontend has two API clients — HTTP for server mode and IPC for Electron's local-folder
mode (parent §2.6). The new design keeps **only HTTP**:

- **Browser + NAS:** `spm-server` serves `spm-http` and the built web bundle.
- **Desktop, both modes:** the Tauri process runs one in-process HTTP listener on `127.0.0.1`, an
  OS-assigned port, guarded by a per-launch random secret the webview carries (header or cookie)
  so other local processes cannot use it. It serves the web bundle and `/api/…` from the same
  origin. No sidecar binary, no second process — it is a tokio task inside the app.
  - **Local folder:** `/api/…` is the **same `spm-http` router** over a local `spm-core`.
  - **Remote server:** `/api/…` is a **reverse proxy** to the configured remote origin, exactly the
    shape of today's `packages/desktop/src/remote.ts`. The webview never navigates to, or learns,
    the remote origin. The four measured reasons in that file's header still hold and bind:
    desktop privileges (Tauri `invoke`) must never be reachable from a remote origin; the
    server's relative `/api/files/<id>/thumb` URLs must resolve on the app's own origin; the
    server gets **no** CORS headers; and the `SameSite=Lax`/`Secure` session cookie must stay
    first-party. The proxy's origin validation and its tests port from `remote.ts` and
    `test/remote.test.ts`. **No server behaviour changes for remote mode.**

This deletes the IPC client and the `spm://` protocol, makes file streaming (`/raw`, `/thumb`,
uploads) identical in all three modes, and means the server integration tests also cover desktop
local mode. Tauri capabilities grant `invoke` to the app's local origin only.

**Desktop-only operations** that are not part of the library API — pick a folder, detect/configure/
launch slicers, the model browser and its downloads, local machine settings — are Tauri
`invoke` commands, gated by the existing capability model (parent §2.4, unchanged).

### 3.4 Contract _(Claude's call)_

The `contract` package's role (shared types + Zod schemas validating both sides) cannot survive a
Rust server. Replacement:

- **Rust is the source of truth.** DTOs are Rust structs; TypeScript types are **generated** from
  them (e.g. `ts-rs` or `specta`) into the web package and checked in. CI fails if regeneration
  produces a diff.
- **The server validates everything**; validation rules (username shape, password length, tag
  names, quotas…) live in `spm-core`.
- The frontend validates forms in TS for UX only. Rules are duplicated deliberately and guarded by
  e2e tests that submit invalid input and expect the server's error.
- **Error codes** (today's `contract/errors.ts`) become a Rust enum serialized to the same string
  codes, exported to TS with the DTOs, so i18n keys keep working.

### 3.5 Data compatibility _(Claude's call)_

The user's real library may already contain `.spm/app.db` and `.spm/previews/`. The Rust core
**opens existing libraries as-is**: same schema, same migration files (`001`–`003` reused
verbatim, applied with the same version bookkeeping), same preview paths, same PBKDF2-HMAC-SHA256
parameters stored per user, so existing passwords keep working.

## 4. Behaviour changes

### 4.1 STEP

- No STEP mesh parsing and no OpenCascade/`occt-import-js`. `SPM_MAX_STEP_MB` is removed.
- `.step`/`.stp` files are still **classified and listed** as today; their preview goes to
  `unsupported` (an existing state), and the viewer shows a "no preview for STEP" state instead of
  loading. Previews already `ready` in an existing library are kept.
- `LICENSE`/`THIRD-PARTY-NOTICES.md` drop the OCCT/LGPL entries and gain whatever the new
  dependency tree requires.
- A future return of STEP should go through a pure-Rust kernel (`truck`/`monstertruck`); not in
  scope here.

### 4.2 Everything else

No intended behaviour change. Specifically still in scope and unchanged in behaviour: auth,
activation, first-run admin bootstrap, users admin, quotas, projects list/detail (subsystem H incl.
infinite scroll and remembered filters), tags, file upload/rename/delete, rescan/reconciliation,
zip import, CuraManager import (CLI today: `import-curamanager.ts` → a `spm-server` subcommand),
3MF config stripping on project creation, embedded-thumbnail extraction, STL/OBJ/3MF rasterizer and
queue, interactive viewer, i18n (en, de), shell/navigation/settings (G), slicer detection and launch
(D), model browser and downloads (E), all `SPM_*` environment variables except `SPM_MAX_STEP_MB`
with the same strict validation rules, rate limiting, logging levels, and `SPM_DEV_UI_ORIGIN`
dev proxy (now pointing at the Vite dev server).

## 5. Backend details

- **Stack (builder's choice within this):** tokio + axum, rusqlite with the bundled SQLite (single
  static binary; no system SQLite), `tracing` for logs.
- **NAS target (user):** x86_64 Linux, **deployed as a Docker container**. Release target is
  `x86_64-unknown-linux-musl`, one static binary.
- **Docker image** _(Claude's call — the repo has no Dockerfile today)_: a multi-stage
  `Dockerfile` in the repo root — build the web bundle (Node 24/pnpm), build `spm-server` for
  musl, copy the single binary into a minimal runtime image (`scratch` or distroless static; it
  needs CA certificates only if the server ever makes outbound TLS calls). Runs as a non-root
  user, library mounted as a volume at `SPM_LIBRARY_DIR`, `SPM_PORT` exposed. CI builds the image
  as a check; publishing it to a registry is out of scope.
- The §5 memory measurement is taken **inside the container** (`docker stats`), so it compares
  like for like with how the NAS actually runs it.
- **Web bundle:** embedded into `spm-server` at build time so the NAS deployment is one file;
  `SPM_WEB_ROOT` still overrides it.
- **Previews:** port parent §7 faithfully — streaming 3MF (never inflate the model part whole),
  embedded-thumbnail fast path first, isometric software rasterizer, 256×256 PNG, mesh-size ceiling
  (`SPM_MAX_MESH_MB`), bounded concurrency (`SPM_PREVIEW_CONCURRENCY`), attempts counter, content
  hash. Memory behaviour must be at least as good as documented in the README's "Preview memory".
- **Memory check:** measure resident memory of the new server idle and while generating previews
  on a representative library, and record it next to the README's current figures.

## 6. Frontend

### 6.1 Stack

SolidJS + Vite, `@solidjs/router`, Tailwind 4, TypeScript 7, one build for browser and desktop.
Desktop-only routes are lazy chunks gated by capabilities (compile-time exclusion from the browser
build is no longer required — the desktop and web builds are now the same bundle; the server
refuses desktop-only API calls anyway because they are Tauri commands, not HTTP routes).
Three.js stays for the interactive viewer, lazy-loaded. i18n keeps the existing `en.json` and
`de.json` keys.

### 6.2 Design system

- **Tokens** (colour, radius, spacing, shadow, typography) defined once as CSS variables in Tailwind
  4's `@theme`, with a light and a dark set. Direction B: neutral grey surfaces, thin borders,
  rounded-full tags, one orange accent (`~#ea580c` light / `~#f97316` dark). Modern, restrained,
  thumbnails carry the colour.
- **Theme:** follows `prefers-color-scheme` by default; a toggle (system / light / dark) in the
  shell, persisted in user settings.
- **Component library** under `packages/web/src/ui/`: at minimum Button (variants: primary,
  secondary, ghost, danger; sizes), IconButton, Input, Textarea, Select, MultiSelect/TagPicker,
  Checkbox, Switch, Tag/Badge, Card, Dialog, Menu/Dropdown, Tooltip, Toast, Tabs, Table, EmptyState,
  Spinner/Skeleton, Page header. **Feature code composes these and does not set colours, borders,
  radii or font sizes itself**; layout utilities (flex, grid, gap, padding) are fine.
- Accessibility baseline: keyboard reachable, visible focus ring in the accent, dialogs trap focus,
  colour contrast AA in both themes.
- Headless primitives (e.g. Kobalte or Ark UI for Solid) may be used under the components for
  behaviour; the styling is ours.

## 7. Desktop (Tauri)

- Library mode picker (local folder / remote server) as today; local mode per §3.3.
- **Slicers (D):** registry, detection, the machine-local store, `.3mf` stripping before handoff,
  launch via `std::process`. Behaviour as subsystem D.
- **Model browser (E):** the site is a **child webview inside the main window** (Tauri's
  multiwebview `Window::add_child`, Cargo feature `unstable`), as the Electron app embeds it today.
  The `/browse` page renders a placeholder; the frontend reports its bounds to Rust, which
  positions/resizes the child on route change and window resize and hides it when `/browse` is
  not shown (the child does not follow window resizes by itself — measured). The child has its own persistent
  `data_directory`, `on_navigation` policy, `on_new_window` deny-by-default, and `on_download`
  redirecting into a staging directory, landing via `files.upload`. **Spiked on 2026-10-25 under
  Tauri 2.12.5 / WebView2 156** (`.superpowers/spikes/2026-10-25-webview2-model-browser-facts.md`),
  both as a separate window and embedded as a child webview: all four sites load, Cloudflare's managed challenge clears by itself (~2 s), Thingiverse's
  `blob:` download and Printables' zip download are both intercepted and redirected without
  touching the user's Downloads folder, storage is isolated per data directory and survives a
  restart. So E carries over; E §1.2 (never bypass a challenge) still binds.
- **Bridge containment (from the spike):** Tauri injects `window.__TAURI_INTERNALS__` into remote
  pages too, so the bridge is always present and only the capability ACL decides whether a call
  succeeds. What was built (`apps/desktop/src-tauri/src/security.rs`): no static capability file
  (`capabilities/` is empty); **one runtime capability**, created once the listener has bound,
  whose `remote.urls` names the main webview's **exact loopback origin** (`http://127.0.0.1:<port>/*`
  — not `127.0.0.1:*`, not `localhost`, not a wildcard) with `local: false`; scoped **by webview
  label** (`webviews: ["main"]`, `windows: []`), so a child webview in the same window is never
  covered; permissions are the app's own commands from an app manifest and no `core:*` or plugin
  permission. The model-browser child (`browse`) is named by no capability and has a different
  origin, so it gets nothing; tests assert that `invoke` from it is refused.
- **Tauri version:** 2.x stable (2.12 at time of writing) with the `unstable` feature for multiwebview; 3.0 is alpha and not used.
- Packaging with the Tauri bundler for Windows; icons regenerated from `assets/`.

## 8. Order of work and tests

Everything is migrated in one push, bottom-up, each layer's tests as its checkpoint:

1. **Tooling skeleton:** Cargo workspace, pnpm 12 workspace with `minimumReleaseAge: 2880`, Node 24,
   TS 7, oxlint, oxfmt, CI (GitHub Actions) running Rust (fmt, clippy, test) and JS (lint, fmt,
   typecheck, unit, e2e).
2. **`spm-core`** with its tests ported from `packages/core/test` (every case translated, none
   dropped silently; anything dropped is listed with the reason, e.g. STEP).
3. **`spm-http` / `spm-server`** with `packages/server/test` ported as integration tests over HTTP
   against a temp library.
4. **Web**: design tokens and component library first, then the features. Unit tests on Vitest +
   Solid Testing Library for stores/logic; Playwright e2e (`packages/web/e2e`) ported off
   `@awdlab/jig-playwright` and run against `spm-server`.
5. **Desktop**: Tauri shell, local mode, slicers, model browser. Rust tests for the commands;
   desktop e2e via `tauri-driver` for a smoke path (open local folder, see a project, launch a
   stubbed slicer) where feasible on Windows.
6. **Delete** `packages/contract`, `packages/core`, `packages/server`, `packages/desktop`, the
   Angular app, `deno.json`/`deno.lock`, ESLint/Prettier config; update README (requirements,
   running, environment table, preview memory), LICENSE/notices.

A single `verify` command (pnpm script) runs everything CI runs.

## 9. Left to the builder

Exact crate split and module layout; Rust crate choices beyond §5; type-generation tool; headless
UI library; icon set; exact token values within direction B; how the per-launch desktop secret is
transported; how CI caches; commit granularity.

## 10. Implementation notes

Deliberate deviations from the text above, recorded as the migration was built. This design
describes intent; where a line here and the code disagree, this list is the explanation.

- **Create and update project return the list DTO** (no `files`), not the detail DTO; a client that
  needs the files fetches the detail.
- **`SPM_MAX_STEP_MB` is ignored with a warning**, not refused: a leftover line in a compose file
  must not stop the server. The server logs that it is ignored when it is set.
- **`SPM_WEB_ROOT` defaults to the embedded bundle** (§5 said it "still overrides" it): unset or
  empty serves the bundle compiled into the binary, and an explicit value is resolved against the
  working directory.
- **New `SPM_HOST`**: an IP literal to bind (default every interface), so a local run can stay on
  loopback.
- **An `https://` dev UI origin is unsupported.** `SPM_DEV_UI_ORIGIN` still validates it, but the
  dev proxy speaks plain HTTP only and answers 502 for an `https://` upstream.
- **No HTTP progress streaming**: the old import progress was a CLI feature
  (`spm-server import-curamanager`) and stayed one; the zip-import route answers when it is done.
- **The release profile unwinds** (no `panic = "abort"`), so the preview queue's `catch_unwind`
  fails one row when a parser panics instead of taking the server down; a test keeps it that way.
- **Desktop listener hardening beyond §3.3:** a launch-secret handshake, plus a gate on `Host`,
  `Origin` and `Sec-Fetch-Site`; in remote mode the session cookie is kept **in memory only** and
  never reaches the page or disk.
- **Model browser under WebView2:** download progress events do not exist (progress is the size on
  disk); popups are routed into the same view and `about:blank` is denied; subframe navigation
  cannot be hooked, so the policy covers top-level navigation; and there is no OS notification when
  a download lands.
- **Accent `#c2410c` for filled light-mode buttons** (the design says `~#ea580c`): white text on
  `#ea580c` misses AA contrast, so filled buttons use the darker orange in light mode.
