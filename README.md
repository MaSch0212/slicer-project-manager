# Slicer Project Manager

A cross-platform manager for 3D-printing projects. See
[docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md](docs/superpowers/specs/2026-08-22-slicer-project-manager-design.md)
for the design and
[docs/superpowers/plans](docs/superpowers/plans) for the implementation plans.

## Requirements

Deno >= 2.9. Node >= 24.4 as well, but only to run the `core` and `contract` suites under
Node — `core` is required to work on both runtimes. Deno installs the dependencies and runs
everything else; there is no second package manager.

## Running the server

    export SPM_LIBRARY_DIR="/path/to/your/print files"
    deno task install
    deno task build:ui
    deno run -A packages/server/main.ts

On first run against an empty library the server creates a `pending` admin account and prints
its activation path. Open it, choose a password, and you are logged in. There is no default
password anywhere.

### Environment

| Variable                  | Default                                                                                                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPM_LIBRARY_DIR`         | _required_                                                                                                                                                       | The library root on disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SPM_PORT`                | `8000`                                                                                                                                                           | Listen port: a whole number from 1 to 65535. `0` is refused rather than passed through as "pick any free port", which would bring the server up somewhere unpredictable.                                                                                                                                                                                                                                                                                                           |
| `SPM_WEB_ROOT`            | `packages/web/dist/web/browser`, found next to the server's own source rather than the process working directory — so the command above works from any directory | Where the built Angular bundle lives. When set explicitly it is resolved relative to the process working directory.                                                                                                                                                                                                                                                                                                                                                                |
| `SPM_PUBLIC_ORIGIN`       | the origin of the incoming request                                                                                                                               | The origin used to build activation links, e.g. `https://print.example.com`. Set this when a TLS-terminating reverse proxy sits in front: Deno only sees its own plain-HTTP listener, so without it the generated link is `http://…`, which also drops the `Secure` session cookie and leaves the user activated but not signed in. `X-Forwarded-Proto` is deliberately _not_ trusted — it is client-settable, the same reason the rate limiter keys on the TCP peer address only. |
| `SPM_LOG_LEVEL`           | `info`                                                                                                                                                           | How much the server logs: `silent`, `error`, `warn`, `info`, `debug` or `trace`. `info` covers startup, one line per API request, preview batches, authentication and every create/update/delete. `debug` adds static-asset requests and per-job preview detail. An unrecognised value is refused at startup rather than ignored.                                                                                                                                                  |
| `SPM_DEV_UI_ORIGIN`       | _unset_                                                                                                                                                          | **Development only.** Forward every non-`/api/` request to a running Angular dev server, e.g. `http://localhost:4200`, live reload included. Without it the server reads the built bundle from `SPM_WEB_ROOT`, so the UI has to be rebuilt to be seen. An unusable value is refused at startup.                                                                                                                                                                                    |
| `SPM_PREVIEW_INTERVAL_MS` | `30000`                                                                                                                                                          | How often, in milliseconds, the preview queue runs. Mainly a development affordance: at the default a model that has just been indexed waits up to 30 seconds for its thumbnail, which is a slow loop to work against, and the e2e suite sets it low so it can watch one appear rather than sit out a tick. A whole number from 1 to 2147483647; past that ceiling `setInterval` silently clamps the delay to 1 ms and the queue would run flat out, so it is refused instead.     |
| `SPM_PREVIEW_CONCURRENCY` | `1`                                                                                                                                                              | How many thumbnails are rendered at once. Each worker may hold one whole mesh, so this multiplies the memory the queue uses. A whole number from 1 to 64. See **Preview memory** below before raising it.                                                                                                                                                                                                                                                                          |
| `SPM_MAX_MESH_MB`         | `256`                                                                                                                                                            | The largest mesh, in megabytes, the rasterizer will allocate for one model. A backstop against pathological input, not a filter on real files: the largest model in the reference library needs 209 MB and nothing normal comes near the default. A model over the ceiling fails its preview with a message naming its size and the permitted one. A whole number from 1 to 2048 — past that a single mesh no longer fits in one `Float32Array`.                                   |

Every one of these is validated before the server binds its port. A value it cannot use produces
one line naming the variable and what it wanted, and exit status 1 — never a stack trace.

Note one deliberate asymmetry. `SPM_LOG_LEVEL` trims and ignores case, because it is a word an
operator types from memory. The numeric variables accept **only** a plain run of digits, so
`""`, `" 8000 "`, `"1e3"`, `"0x1f"`, `"1.5"`, `"-1"` and `"+8000"` are all refused — every one of
them is a spelling JavaScript's `Number()` quietly accepts, and a value that happens to work is
worse than one that fails, because nothing tells the operator their config does not say what they
think it says. The error message quotes the raw value, so a stray space is visible in it.

### Preview memory

Rendering a thumbnail is the only thing this server does whose memory is a function of the file
rather than of the request. Nothing is read whole any more — a 164 MB STL and a 3MF whose model
part inflates to 674 MB both pass through a fixed 256 KB window — so what is left in the peak is
the mesh itself, at 36 bytes per triangle plus 12 per distinct vertex, and about 80 MB of
decompressor beside it.

Two variables set the ceiling, and they multiply: **`SPM_PREVIEW_CONCURRENCY` × one mesh**. The
defaults are sized for a 2 GB NAS with a 500 MB budget for the whole queue. Measured on Deno,
backfilling a reference library of 1 725 models (402 3MF, 1 311 STL, 12 OBJ; largest mesh 209 MB,
largest file a 164 MB STL, largest inflated model part 674 MB):

| `SPM_PREVIEW_CONCURRENCY` | peak RSS   | wall time for the whole library |
| ------------------------- | ---------- | ------------------------------- |
| `1` (default)             | 400–410 MB | baseline                        |
| `2`                       | 620–621 MB | 0–1.5% faster                   |

Raising it to `2` costs 212 MB and saves nothing worth having: 1.5% on the machine measured here,
0% on a second one. That is a bad trade here and would be a bad trade on a larger machine too —
parsing and rasterizing are CPU-bound JavaScript on one thread, so a second worker mostly
interleaves with the first rather than running beside it. Raise it when the queue is waiting on
I/O — a network-mounted library, or spinning disks — not to use more cores.

As a rule of thumb, budget **`concurrency × (SPM_MAX_MESH_MB + 80) + 120` megabytes**. The 80 is
the decompressor; the 120 is Deno's own ~46 MB plus the heap V8 has touched and not returned. It
is meant to bound the configuration from above, so it uses the _ceiling_ rather than the model you
actually have: at the shipped defaults it predicts 456 MB, against 400–410 MB measured on a
library whose largest mesh is 209 MB rather than the permitted 256 — and substituting that real
209 gives 409 MB, which is the measurement. At concurrency 2 it predicts 792 MB against 621 MB
measured, so it stays conservative as the worker count grows.

**Moving to a bigger machine.** Say a Mac mini where you are happy to give the preview queue 2 GB.
Solving `2000 = c × (m + 80) + 120` leaves you a choice, and the table above says which way to
spend it: extra workers buy almost nothing, extra ceiling buys headroom for models you do not have
yet. So `SPM_MAX_MESH_MB=1024` on its own comes to 1 224 MB and lets through a 28-million-triangle
STL, or a 14-million-triangle 3MF whose vertex table doubles the cost per triangle — either way
several times anything in a normal library — while `SPM_PREVIEW_CONCURRENCY=3` with
`SPM_MAX_MESH_MB=512` comes to 1 896 MB for a backfill that finishes at about the same time.
Prefer the first. Nothing goes wrong if you change neither: the defaults are safe everywhere, they
are merely cautious off the NAS.

`SPM_MAX_MESH_MB` is a backstop rather than a tuning knob: it exists so that a corrupt or hostile
file declaring a billion triangles is refused instead of allocating 36 GB. Leave it alone unless a
real model of yours is refused — the failure message names the size it needed, so the new value is
the number in that message rounded up. Its own ceiling is 2 048, which is where a single mesh stops
fitting in one `Float32Array` at all.

## Development

Two processes: the Angular dev server owns the UI, the Deno server owns `/api`. Run them in
two terminals and reach both through **http://localhost:8000** — the Deno server proxies
everything outside `/api` to `ng serve`, so there is one origin, no CORS, and no rebuild
between edits.

    deno task dev:ui        # ng serve on :4200
    deno task dev:server    # the API on :8000, proxying the UI

Both halves reload on save. `dev:server` runs under `deno run --watch`, which watches the
whole local module graph — so a change in `packages/core` or `packages/contract` restarts the
server just as a change in `packages/server` does. Only source files are watched, so the
library's own writes (the SQLite database, generated previews) never trigger a restart, even
with the library inside the repo.

`dev:server` needs `SPM_LIBRARY_DIR`; everything else it sets for you.

`deno task` lists the rest: `build:ui`, `serve` (build the UI, then serve it for real),
`import`, `check`, `lint`, `fmt`, `test`, `test:core`, `test:server`, `e2e`.

### Editors

Only `packages/server` is Deno code. `.vscode/settings.json` scopes the Deno extension to
that folder with `deno.enablePaths` and leaves everything else — contract, core and the
Angular app — to the normal TypeScript service. Enabling Deno for the whole workspace takes
the Angular language service down with it.

### Deno owns the toolchain

There is no pnpm. `deno install` resolves everything, including the Angular toolchain, and
writes a normal `node_modules` (`nodeModulesDir: "auto"`) that `ng`, `tsc`, `vitest`,
Playwright and `node --test` all read. The four packages are a **Deno workspace** — the
`workspace` field in `deno.json` — and `contract`, `core` and `web` are linked into
`node_modules/@spm/` so Angular's bundler resolves them exactly as it did before.

All four packages are members. `packages/server` needs one extra line the others do not:
`"compilerOptions": { "lib": ["deno.window"] }` in its `deno.json`. A workspace member gets
its own compiler options, and without them it inherits a Node-flavoured `lib` where the `Deno`
global has no types, so every `Deno.serve`/`Deno.env` in the package fails to type-check.
Do **not** add `dom` alongside it: that resolves the global but re-types `WebSocket`, and
`WebSocket.CLOSED` stops being assignable to `readyState` in the dev-proxy tests. `deno.window`
already carries the web APIs the server uses.

The Angular toolchain is the one thing that still runs under **Node**. `ng`, `ngc` and
Playwright are invoked as `node node_modules/…` from the deno tasks, so there is still a single
entry point for everything (`deno task test:web`, `build:ui`, `e2e`) — Node is just what
executes them.

That is not conservatism. `ng test` under Deno's Node compatibility layer works on Windows and
hangs on a Linux CI runner: no output at all, no error, until the job is killed. `CI=1` does not
help and stdin is not the trigger. Since Node is already required — `core` has to work on both
runtimes, and `node --test` is how that is proven — running the Node toolchain under Node costs
nothing and removes a failure mode nobody would enjoy debugging.

One policy worth knowing: Deno refuses npm packages published within the last day, as a
supply-chain measure. `minimumDependencyAge` in `deno.json` sets that window and exempts the
three `@awdlab/jig*` packages, so a same-day jig release installs without disabling the
quarantine for everything else. The exemption is matched on the **package name** — a version
cannot be named, and the transitive `@awdlab/jig-custom-types` has to be listed explicitly or
the install still refuses.

## Migrating an existing CuraManager library

A CuraManager library is flat: every project folder sits at the library root, each with an
optional `metadata.json` sidecar carrying its tags, source URL and archived flag (spec 3.6).

### Upload it (recommended)

Sign in, open **Import**, and drop a zip of your CuraManager library onto the page. The server
extracts it into your own library folder, indexes it and applies every sidecar — no shell
access needed, and it works when the library lives on a different machine from the server.

Zip either the library folder or its contents: a single wrapping folder is detected and
stripped, unless it holds only files, in which case it is one project. Files sitting loose at
the library root (CuraManager's own `metadata-cache.json`), hidden entries and `__MACOSX`
noise are skipped. The whole import is refused before anything is written if a project folder
name already exists in your library or the archive would exceed your quota.

### Or run it against a library already on the server

Create the account that should own it first (first run does this for the bootstrap admin),
then:

    deno run -A packages/server/import-curamanager.ts "/path/to/curamanager/library" marc

That moves every project folder under `marc/`, adopts and indexes them, and applies each
sidecar's tags, website and archived flag. Pass `--in-place` to skip the move, for a library
whose folders already sit under the right user directory.

The move is all-or-nothing. If any folder name already exists under the target user's folder,
the import refuses before renaming anything, lists the colliding names and exits non-zero —
rename them and run it again. Previews are queued, not generated: the running server picks
them up on its next pass.

Indexing hashes every byte of every file, so a large library takes minutes. The command shows
a live progress line (`indexing [12/240] Widget Mk2 -- 812 files seen, 806 new`), which
redraws in place on a terminal and falls back to a line every few seconds when redirected to a
file. It logs at `info` by default; `SPM_LOG_LEVEL` works here too.

The server may stay running during the import — both processes open the same SQLite file and
wait for one another rather than failing.

## Layout

| Package    | What it is                                   |
| ---------- | -------------------------------------------- |
| `contract` | DTOs, Zod schemas, the `ApiClient` interface |
| `core`     | all behaviour; runs on Deno and Node         |
| `server`   | the Deno HTTP transport                      |
| `web`      | the Angular client                           |

## Tests

    deno task verify   # lint, format, typecheck (tsc + deno check + ngc), contract,
                       # core on Node, core on Deno, server, web
    deno task e2e      # Playwright smoke suite; not part of verify

`core` runs under both runtimes on purpose: that is what keeps the same code usable from the
Electron main process (subsystem C).

`deno task e2e` builds the web bundle, seeds a throw-away library in the system temp directory and
serves both from the real Deno server, so it exercises the static-file path the deployed server
uses. It needs a browser binary once:
`cd packages/web && deno run -A node_modules/@playwright/test/cli.js install chromium`.
