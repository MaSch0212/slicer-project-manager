# Slicer Project Manager

A cross-platform manager for 3D-printing projects: a library of project folders on disk, indexed in
SQLite, with thumbnails, an interactive 3D viewer, tags, quotas and accounts, reachable from a
browser (a server you run on a NAS, usually in Docker) or from a desktop application that can open a
folder on the same computer or sign in to such a server.

The original design is
[docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md](docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md)
and the per-subsystem specs and plans beside it
([specs](docs/superpowers/specs), [plans](docs/superpowers/plans)). The move from Deno + Angular +
Electron to the current stack is
[docs/superpowers/specs/2026-10-25-rust-solid-tauri-migration-design.md](docs/superpowers/specs/2026-10-25-rust-solid-tauri-migration-design.md);
it records what changed and, at the end, the deliberate deviations. The older documents are history:
where they name Deno, Angular or Electron, the migration design says what replaced it.

The stack: a Rust server (`axum`, SQLite bundled into one static binary) with the SolidJS web app
embedded in it, and a Tauri desktop shell around the same two.

## Requirements

- The Rust toolchain pinned in `rust-toolchain.toml` (installed by `rustup` on first use; with
  `rustfmt` and `clippy`).
- Node >= 24 and pnpm 12 (`packageManager` in `package.json`; `corepack enable` provides it). Node
  and pnpm build the web bundle and run the JavaScript tooling; **nothing in the running server or
  the desktop app needs Node.**
- To build or run the desktop app: Windows 10 or 11 (the WebView2 runtime that ships with them) and
  the MSVC build tools Rust uses on Windows. The measurements below were taken on Windows only.
- To build the image: Docker.

Install the JavaScript dependencies once:

    pnpm install

## Running the server

Natively:

    export SPM_LIBRARY_DIR="/path/to/your/print files"
    pnpm --filter @spm/web build
    cargo run --release -p spm-server

The web bundle is compiled into the binary at build time (the build script embeds
`packages/web/dist`), which is why it is built first. `SPM_LIBRARY_DIR` is the only required
variable. By default the server listens on every interface, port 8000; `SPM_HOST=127.0.0.1` keeps a
local run to loopback.

With Docker, which is how the NAS runs it:

    docker build -t spm-server .
    docker run --rm -p 8000:8000 -v /path/to/your/print\ files:/library spm-server

The `Dockerfile` has three stages: the web bundle (Node 24, pnpm), the server built for
`x86_64-unknown-linux-musl`, and a `scratch` runtime image that holds that one static binary and two
empty directories — no shell, no operating-system packages. It runs as the unprivileged user
`10001:10001`, so **the mounted library folder must be writable by uid 10001** (`chown -R 10001
/path/to/your/print\ files` on the host, or a named volume, which inherits the image's ownership).
The image sets `SPM_LIBRARY_DIR=/library` and `SPM_PORT=8000`, declares `/library` as a volume and
exposes 8000; any other `SPM_*` variable is passed with `-e`. Publish the port to the interface you
want (`-p 127.0.0.1:8000:8000` to keep it off the network).

On first run against an empty library the server creates a `pending` admin account and prints one
line on stdout (`docker logs` shows it):

    First run: activate "admin" at /activate#<token>

Open that path on the server's address, choose a password, and you are logged in. There is no
default password anywhere. The line is printed even with `SPM_LOG_LEVEL=silent`, because without it
the first run cannot be completed.

### Environment

| Variable                  | Default                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPM_LIBRARY_DIR`         | _required_                            | The library root on disk. Unset, empty or whitespace-only is refused: there is no sensible default, and guessing one would have the server create a library somewhere you never look. (The Docker image sets it to `/library`.)                                                                                                                                                                                                                                                                          |
| `SPM_PORT`                | `8000`                                | Listen port: a whole number from 1 to 65535. `0` is refused rather than passed through as "pick any free port", which would bring the server up somewhere unpredictable.                                                                                                                                                                                                                                                                                                                                 |
| `SPM_HOST`                | every interface                       | The address to bind: an IP literal such as `127.0.0.1` or `::1`. Unset keeps every interface, which a container's published port needs; set `127.0.0.1` for a local run so there is no firewall prompt. A host _name_ is refused: resolving one would make the bind depend on DNS, and `localhost` can resolve to either family.                                                                                                                                                                         |
| `SPM_WEB_ROOT`            | the web bundle embedded in the binary | Serve the web app from this directory instead of the embedded bundle. Unset or empty means the embedded bundle, so a working directory can never make the whole UI answer 404. When set it is resolved relative to the process working directory (`SPM_WEB_ROOT=dist` means `./dist`). Mostly useful to try a UI build without rebuilding the server.                                                                                                                                                    |
| `SPM_PUBLIC_ORIGIN`       | the origin of the incoming request    | The origin used to build activation links, e.g. `https://print.example.com`. Set this when a TLS-terminating reverse proxy sits in front: the server only sees its own plain-HTTP listener, so without it the generated link is `http://…`, which also drops the `Secure` session cookie and leaves the user activated but not signed in. `X-Forwarded-Proto` is deliberately _not_ trusted — it is client-settable, the same reason the rate limiter keys on the TCP peer address only. Blank is unset. |
| `SPM_LOG_LEVEL`           | `info`                                | How much the server logs: `silent`, `error`, `warn`, `info`, `debug` or `trace`. `info` covers startup, one line per API request, preview batches, authentication and every create/update/delete. `debug` adds static-asset requests and per-job preview detail. An unrecognised value is refused at startup rather than ignored.                                                                                                                                                                        |
| `SPM_DEV_UI_ORIGIN`       | _unset_                               | **Development only.** Forward every non-`/api/` request to a running Vite dev server, e.g. `http://127.0.0.1:5173`, hot reload included. An unusable value is refused at startup. Only plain `http://` upstreams work: an `https://` dev origin passes validation but every request to it answers 502 with the reason logged — the server carries no TLS client, and a development proxy was not worth one.                                                                                              |
| `SPM_PREVIEW_INTERVAL_MS` | `30000`                               | How often, in milliseconds, the preview queue runs. Mainly a development affordance: at the default a model that has just been indexed waits up to 30 seconds for its thumbnail, and the e2e suite sets it low so it can watch one appear. A whole number from 1 to 2147483647 (a signed 32-bit millisecond count).                                                                                                                                                                                      |
| `SPM_PREVIEW_CONCURRENCY` | `1`                                   | How many thumbnails are rendered at once. Each worker may hold one whole mesh, so this multiplies the _mesh_ part of the memory the queue uses. A whole number from 1 to 64. See **Preview memory** below before raising it.                                                                                                                                                                                                                                                                             |
| `SPM_MAX_MESH_MB`         | `256`                                 | The largest mesh, in megabytes (1 000 000 bytes), the rasterizer will allocate for one model. A backstop against pathological input, not a filter on real files: the largest model in the reference library needs 209 MB. A model over the ceiling fails its preview with a message naming its size and the permitted one. A whole number from 1 to 2048.                                                                                                                                                |
| `SPM_MAX_STEP_MB`         | _removed_                             | Ignored. STEP previews are gone (see **STEP** below) and the variable with them. It is not validated and not refused — a leftover line in a compose file must not stop the server — but the server logs a warning at startup when it is set.                                                                                                                                                                                                                                                             |

Every other variable here is validated before the server binds its port. A value it cannot use
produces one line naming the variable and what it wanted, and exit status 1 — never a stack trace.

Note one deliberate asymmetry. `SPM_LOG_LEVEL` trims and ignores case, because it is a word an
operator types from memory. The numeric variables (`SPM_PORT`, `SPM_PREVIEW_INTERVAL_MS`,
`SPM_PREVIEW_CONCURRENCY`, `SPM_MAX_MESH_MB`) accept **only** a plain run of decimal digits, so
`""`, `" 8000 "`, `"1e3"`, `"0x1f"`, `"1.5"`, `"-1"` and `"+8000"` are all refused — every one of
them is a spelling a lenient number parser quietly accepts, and a value that happens to work is
worse than one that fails, because nothing tells the operator their config does not say what they
think it says. Leading zeros pass (`08000` reads as deliberate padding). The error message quotes
the raw value, so a stray space is visible in it.

### Preview memory

Rendering a thumbnail is the only thing this server does whose memory is a function of the file
rather than of the request. **Nothing is read whole.** A 3MF is a zip, and its model part can
inflate to many times the size of the file; an STL or OBJ can be hundreds of megabytes. All of them
pass through a fixed **256 KiB** streaming window, so what is left in the peak is the mesh itself —
**36 bytes per triangle plus 12 bytes per distinct vertex** — and a constant of well under a
megabyte beside it.

That is measured, not assumed, by `crates/spm-core/tests/memory.rs`: one test binary with a
counting global allocator, writing large synthetic files by streaming them to disk and comparing the
allocator's peak against the formula. At the reference sizes
(`SPM_MEMORY_TEST_SCALE=10 cargo test --release -p spm-core --test memory -- --nocapture`):

| Input                               | Mesh      | Peak above baseline | Overhead |
| ----------------------------------- | --------- | ------------------- | -------- |
| 3MF, model part 613.1 MiB inflated  | 366.2 MiB | 366.6 MiB           | 0.42 MiB |
| STL, 572.2 MiB file                 | 412.0 MiB | 412.2 MiB           | 0.25 MiB |
| OBJ                                 | 286.1 MiB | 286.9 MiB           | 0.75 MiB |
| whole job, 3MF (parse, raster, PNG) | 366.2 MiB | 366.6 MiB           | 0.4 MiB  |

A 3MF with the same 20 000-triangle mesh peaks at 1.33 MiB whether its document is small or carries
a 321 MiB comment: the cost follows the mesh, not the file. The default test scale (about 60 MB per
fixture) is what `pnpm verify` runs.

In the container (the Docker image above), the server measured **2.56 MiB idle**. Rendering a
library of **24 large files** (twelve ~50 MB STLs, six 100 MB STLs, six ~720k-triangle 3MFs) at
concurrency 1, its anonymous memory peaked at **73.6 MB with no limit set**. The same library under
`docker run --memory=64m` still completed **24 of 24 previews**, peaking at 65.9 MB (62.8 MiB): with
less headroom the allocator returned memory sooner, so the peak stayed under the limit.

Two variables set the ceiling, and they multiply: `SPM_MAX_MESH_MB` is the biggest single mesh, and
`SPM_PREVIEW_CONCURRENCY` is how many can be in memory at once. As a rule of thumb, budget the
worst case from the configuration, not from the library you happen to have:

    peak  ≈  concurrency × (SPM_MAX_MESH_MB + ~1 MiB)  +  a few MiB for the process itself

The ~1 MiB is the measured overhead above (0.25–0.75 MiB) rounded up; the process figure is the
idle footprint. The shipped defaults (concurrency 1, 256 MB) therefore bound the queue at about
257 MB in the worst case, which fits the 500 MB budget the original design set for a 2 GB NAS with
room to spare, and a library whose largest mesh is 209 MB peaks near 210 MB. There is no longer a
decompressor, a JavaScript heap or a geometry kernel to add to that.

Parsing and rasterizing are CPU-bound, so a second worker mostly interleaves with the first rather
than running beside it. Raise `SPM_PREVIEW_CONCURRENCY` when the queue is waiting on I/O — a
network-mounted library, or spinning disks — not to use more cores.

`SPM_MAX_MESH_MB` is a backstop rather than a tuning knob: it exists so that a corrupt or hostile
file declaring a billion triangles is refused instead of allocating 36 GB. Leave it alone unless a
real model of yours is refused — the failure message names the size it needed, so the new value is
the number in that message rounded up. Its own ceiling is 2 048.

### STEP

`.step` and `.stp` files are still classified and listed, and download as before; they just get no
preview. Their preview state is `unsupported`, and the viewer says so instead of trying to load
them. Previews that were already `ready` in an existing library are kept. The kernel that read STEP
(OpenCascade, through `occt-import-js`) is gone from the repository and from every build, along with
`SPM_MAX_STEP_MB`. It may return later through a pure-Rust kernel; that is not planned work.

## The desktop application

The Tauri shell runs the same web app in the operating system's webview (WebView2 on Windows), so
nothing like a browser engine is shipped. It opens either of two libraries:

- **a folder on this computer** — no server, no login, fully offline. The app runs the same Rust
  core and HTTP router the server does, in-process, and the preview queue itself.
- **a server** — a `spm-server` you run somewhere else. You sign in with an account on that server.

On first run it asks which. Choosing a folder opens the system folder chooser; choosing a server
asks for its address. Whichever you pick is remembered, and **Settings → General → Where your
library is** is how you change your mind later. The window's menu keeps a **Library → Choose
library…** item as well, as the recovery path if the page will not start.

Either way, the page talks to one HTTP listener the app runs on `127.0.0.1` on an OS-assigned port.
In folder mode it serves the library API; in server mode it is a reverse proxy to the remote
origin, so the webview never navigates to the server, the server's relative thumbnail URLs resolve
on the app's own origin, and the server gets no CORS headers. The listener is not open to other
programs on the machine: it requires a secret that is generated at launch and handed to the webview,
and rejects requests whose `Host`, `Origin` or `Sec-Fetch-Site` are not the app's own.

Two things the desktop app does that the browser cannot:

- **Slicers.** It detects Cura, PrusaSlicer, Anycubic Slicer Next, Bambu Studio and OrcaSlicer on
  Windows (registry and MSIX package metadata), lets you add one by hand, and opens a project's
  model file in it. An embedded slicer configuration is stripped from a `.3mf` before it is handed
  over, so the slicer starts from your own profile. In server mode the file is fetched to a
  scratch folder first.
- **The model browser.** A **Browse** page embeds Thingiverse, Printables, MakerWorld and Cults3D in
  a child webview with its own persistent profile. A download from a site is caught, staged in the
  app's own folder (never your Downloads folder) and offered as a file to add to a project, which
  uploads it through the normal route. It never tries to get past a site's challenge; if a site
  shows one, you answer it yourself.

### Running and building it

    pnpm install
    pnpm dev:desktop        # tauri dev: opens a real window, the web app from Vite on :5173
    pnpm build:desktop      # the installer, then checks it

`pnpm build:desktop` builds the web bundle, compiles the app in release mode and bundles an NSIS
installer for the current user (no elevation) in `target/release/bundle/nsis/`, then
`apps/desktop/scripts/verify-bundle.mjs` checks the result: the installer exists and has a sane size,
the executable is named for the app, `LICENSE` and `THIRD-PARTY-NOTICES.md` were put beside it (in
`third-party/`) and are the repository's own, and no browser-engine files travelled with it. The
installer measures **about 5 MiB** (5.4 MiB; the executable is 20.8 MiB). It uses the WebView2
runtime Windows provides and does not install one. Installers are unsigned, and there is no
auto-update.

Windows is the only platform this has been built and measured on.

### Environment

Two variables override the remembered choice for one launch, and neither is written back to the
state file — naming a library for one run is not a choice made in the app:

| Variable          | What it does                                                                      |
| ----------------- | --------------------------------------------------------------------------------- |
| `SPM_LIBRARY_DIR` | Open this folder in local mode. The same variable the server reads.               |
| `SPM_REMOTE_URL`  | Connect to this server, e.g. `http://192.168.1.5:8000`. An origin only — no path. |

Setting both is refused at startup rather than resolved by precedence: they name two different
libraries. `SPM_DEV_UI_ORIGIN` (set by `pnpm dev:desktop`) serves the UI from the dev server
instead of the bundle compiled into the app. The `SPM_DESKTOP_*` variables are for the automated
suites (hidden mode, smoke reports, a separate profile directory); they are read in
`apps/desktop/src-tauri/src/lib.rs`.

### The session in server mode

The desktop app is not a browser tab, so it has no browser cookie jar. The app holds the session
cookie the server sets **in memory only**, attaches it to every request it forwards, and never hands
it to the page. Nothing about the session is written to disk, so quitting the app signs you out —
a decision, not a default: a persisted bearer credential for your server would sit at rest,
protected by nothing this app controls. The mode and the server address are remembered, so a
restart comes straight back to the login screen of the right server.

Before you point it at a LAN server over plain `http`: the login, the session and every model cross
that network in the clear. The app says so once, on stderr, and connects anyway — a home server on
`http` is the normal case.

## Development

Two processes: Vite owns the UI, `spm-server` owns `/api`. Run them in two terminals and open
**http://127.0.0.1:8000** — the server proxies everything outside `/api` to Vite
(`SPM_DEV_UI_ORIGIN`), so there is one origin, no CORS, and hot reload without a rebuild.

    pnpm dev:web            # Vite on http://127.0.0.1:5173
    pnpm dev:server         # cargo run -p spm-server on http://127.0.0.1:8000

Both bind **loopback only**: binding every interface raises a firewall prompt on Windows, and
neither has any business being reachable from the LAN. `pnpm dev:server` (`tools/dev-server.mjs`)
keeps a throw-away library in the git-ignored `.dev/library` and sets `SPM_HOST`,
`SPM_LIBRARY_DIR` and `SPM_DEV_UI_ORIGIN` for you; any `SPM_*` variable already in your environment
wins (`SPM_PORT=9000 pnpm dev:server`). The activation line is printed in that terminal.

The rest of the root scripts:

| Script            | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `pnpm lint`       | `oxlint`                                                         |
| `pnpm fmt`        | `oxfmt` (`pnpm fmt:check` only checks)                           |
| `pnpm typecheck`  | `tsc --noEmit` in every package                                  |
| `pnpm test`       | Vitest (jsdom + Solid Testing Library) in `packages/web`         |
| `pnpm test:tools` | the icon assets' test (`tools/icons.test.ts`, Node's own runner) |
| `pnpm test:rust`  | `cargo test --workspace --all-features`                          |
| `pnpm lint:rust`  | `cargo clippy` with warnings denied, then `cargo fmt --check`    |
| `pnpm verify`     | all of the above, in that order: what CI runs                    |
| `pnpm e2e`        | the Playwright suite against the real server                     |
| `pnpm gen:types`  | regenerate the TypeScript DTO types (below)                      |
| `pnpm icons`      | regenerate the app icons (below)                                 |
| `pnpm notices`    | regenerate `THIRD-PARTY-NOTICES.md` (below)                      |

### Layout

| Path                     | What it is                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/spm-core`        | all behaviour: database, auth, files, projects, import, previews. Ownership and authorisation are enforced here, never in a transport |
| `crates/spm-http`        | the `axum` router over core: the REST API, sessions, rate limiting, static files, the dev proxy                                       |
| `crates/spm-server`      | the server binary: environment, logging, embedded web bundle, `import-curamanager`                                                    |
| `crates/spm-shell`       | the desktop's logic without Tauri: libraries, remote proxy, slicers, model browser                                                    |
| `apps/desktop/src-tauri` | the Tauri app (crate `spm-desktop`); `apps/desktop` is its CLI package                                                                |
| `packages/web`           | the SolidJS + Tailwind 4 web app, one build for the browser and the desktop                                                           |
| `tools/`                 | repo scripts: dev server, icon generator, notices generator                                                                           |
| `assets/icons/`          | the three source SVGs every icon is drawn from                                                                                        |

### Tests

    pnpm verify

runs every check CI runs. It needs no browser and opens no window.

    pnpm e2e

builds the web bundle and the server, then runs the Playwright suite in `packages/web/e2e` against
a real `spm-server` on loopback with a throw-away library. It needs a Chromium once:
`pnpm --filter @spm/web exec playwright install chromium`. It is not part of `verify`.

    cargo test -p spm-desktop --test hidden_smoke

is the desktop's end-to-end run, on Windows: it starts the **built app** with no visible window and
no focus change (`SPM_DESKTOP_HIDDEN=1`), once per mode, drives the slicer commands through the real
bridge against a stub slicer, loads the model browser against a fixture site and reads the report the
app writes about itself. It uses neither `tauri-driver` nor anything that shows a window. A second,
manual test in the same file opens the four real sites' start pages read-only
(`cargo test -p spm-desktop --test hidden_smoke -- --ignored the_real_sites --nocapture`); it needs
the network and is not part of `verify`.

### Regenerating the TypeScript types

Rust is the source of truth for the API's shapes. The DTOs and error codes in
`packages/web/src/api/generated/` are generated from the Rust structs by `ts-rs` and committed:

    pnpm gen:types

Run it after changing a DTO. A test fails if the committed files differ from what the structs
produce.

### Icons

Three SVGs in `assets/icons/` are the source of every icon this project ships. Everything derived
from them is generated by one command and committed:

    pnpm icons

`tools/generate-icons.ts` runs directly under Node 24 and rasterises the SVGs with the Chromium
that `@playwright/test` installs (`pnpm exec playwright install chromium`, once), so there is no
`sharp`, no ImageMagick and nothing native — and **no build depends on it**. Run it by hand after
changing an SVG and commit what it writes. A different Chromium build can change a few PNG bytes
without changing the picture.

| source                    | derived                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `favicon.svg` (the mark)  | `packages/web/public/favicon.svg`, `favicon.ico` (16/32/48)                                                          |
| `app.svg` (the blue tile) | `packages/web/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180)                                     |
| `desktop.svg`             | `apps/desktop/src-tauri/icons/`: `icon.png` (512), `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico` (16–256) |

`packages/web/public/manifest.webmanifest` is hand-written and names the two home-screen PNGs. It
is a manifest for _icons_, not a PWA: there is no service worker and no offline caching.
`pnpm test:tools` (part of `verify`) decodes every one of those files and checks it against what
`index.html` and the manifest claim — each `.ico` is taken apart frame by frame and each PNG's pixel
data is inflated rather than its header read. No icon is declared `purpose: "maskable"`: `app.svg`
is a full-bleed tile whose mark touches the top and bottom edges, so Android's maskable crop would
clip it. A macOS `.icns` is not built; the desktop app is Windows-only for now.

### Third-party notices

`THIRD-PARTY-NOTICES.md` is generated, not written: `pnpm notices` reads `cargo tree`/`cargo
metadata` for the Rust crates that go into the server image and the desktop installer, `pnpm ls`
for the npm packages in the embedded web bundle, and each package's own licence files, and adds the
hand-written sections in `tools/notices-static.md` (the Rust standard library, SQLite, musl,
the WebView2 loader, NSIS). Run it after a dependency change and commit the result. The desktop
installer ships the file beside the program.

### Dependency policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 2880` (minutes): pnpm refuses npm package versions
published less than two days ago, as a supply-chain measure. If an install fails naming a version
that is "too new", wait or pin the previous one.

## Migrating an existing CuraManager library

A CuraManager library is flat: every project folder sits at the library root, each with an optional
`metadata.json` sidecar carrying its tags, source URL and archived flag.

### Upload it (recommended)

Sign in, open **Settings → General → Import** (or go straight to `/import`), and drop a zip of your
CuraManager library onto the page. The server extracts it into your own library folder, indexes it
and applies every sidecar — no shell access needed, and it works when the library lives on a
different machine from the server.

Zip either the library folder or its contents: a single wrapping folder is detected and stripped,
unless it holds only files, in which case it is one project. Files sitting loose at the library
root (CuraManager's own `metadata-cache.json`), hidden entries and `__MACOSX` noise are skipped.
The whole import is refused before anything is written if a project folder name already exists in
your library or the archive would exceed your quota. The archive itself is capped at 10 GiB.

### Or run it against a library already on the server

Create the account that should own it first (first run does this for the bootstrap admin), then:

    spm-server import-curamanager "/path/to/curamanager/library" marc

(`cargo run --release -p spm-server -- import-curamanager …` from a checkout.) That moves every
project folder under `marc/`, adopts and indexes them, and applies each sidecar's tags, website and
archived flag. Pass `--in-place` to skip the move, for a library whose folders already sit under the
right user directory.

The move is all-or-nothing. If any folder name already exists under the target user's folder, the
import refuses before renaming anything, lists the colliding names and exits non-zero — rename them
and run it again. Previews are queued, not generated: the running server picks them up on its next
pass.

Indexing hashes every byte of every file, so a large library takes minutes. The command shows a
live progress line (`indexing [12/240] Widget Mk2 -- 812 files seen, 806 new`), which redraws in
place on a terminal and falls back to a line every few seconds when redirected to a file. It logs
at `info` by default; `SPM_LOG_LEVEL` works here too. The upload route has no such progress: it
answers when it is done.

The server may stay running during the import — both processes open the same SQLite file and wait
for one another rather than failing.
