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

Every one of these is validated before the server binds its port. A value it cannot use produces
one line naming the variable and what it wanted, and exit status 1 — never a stack trace.

Note one deliberate asymmetry. `SPM_LOG_LEVEL` trims and ignores case, because it is a word an
operator types from memory. The two numeric variables accept **only** a plain run of digits, so
`""`, `" 8000 "`, `"1e3"`, `"0x1f"`, `"1.5"`, `"-1"` and `"+8000"` are all refused — every one of
them is a spelling JavaScript's `Number()` quietly accepts, and a value that happens to work is
worse than one that fails, because nothing tells the operator their config does not say what they
think it says. The error message quotes the raw value, so a stray space is visible in it.

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

### How much of this runs on Deno

The Angular CLI runs fine under Deno's Node compatibility layer, so the whole dev loop does:
`deno task dev:ui`, `build:ui` and `test:web` invoke `ng` through `deno run`, not through
pnpm or Node. Building, serving with live reload, and the 126 unit tests all work that way.

**Installing** dependencies is the one part that still needs pnpm, for two reasons:

- `deno install` reads the root `package.json` and Deno's own `workspace` field; it does not
  read `pnpm-workspace.yaml`.
- `@awdlab/jig@0.0.4` is published with pnpm's `catalog:` protocol left in its
  `peerDependencies`. pnpm warns and carries on; Deno refuses the tree
  (`parsing version requirement for dependency "@angular/router": "catalog:"`). The same
  package also needs the `patchedDependencies` in `pnpm-workspace.yaml`, which Deno has no
  equivalent of — see [patches/README.md](patches/README.md) and
  [awdlab/jig#22](https://github.com/awdlab/jig/pull/22), which fixes both upstream.

So: `pnpm install` once (also available as `deno task install`), Deno for everything after.
A greenfield Angular app with no such dependency installs and builds under Deno alone.

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

    pnpm verify   # lint, format, typecheck (tsc + deno check), contract, core on Node,
                  # core on Deno, server, web
    pnpm e2e      # Playwright smoke suite; not part of verify

`core` runs under both runtimes on purpose: that is what keeps the same code usable from the
Electron main process (subsystem C).

`pnpm e2e` builds the web bundle, seeds a throw-away library in the system temp directory and
serves both from the real Deno server, so it exercises the static-file path the deployed server
uses. It needs a browser binary once:
`pnpm --filter @spm/web exec playwright install chromium`.
