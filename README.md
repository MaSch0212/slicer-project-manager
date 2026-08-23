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

| Variable            | Default                                                                                                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPM_LIBRARY_DIR`   | _required_                                                                                                                                                       | The library root on disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SPM_PORT`          | `8000`                                                                                                                                                           | Listen port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SPM_WEB_ROOT`      | `packages/web/dist/web/browser`, found next to the server's own source rather than the process working directory — so the command above works from any directory | Where the built Angular bundle lives. When set explicitly it is resolved relative to the process working directory.                                                                                                                                                                                                                                                                                                                                                                |
| `SPM_PUBLIC_ORIGIN` | the origin of the incoming request                                                                                                                               | The origin used to build activation links, e.g. `https://print.example.com`. Set this when a TLS-terminating reverse proxy sits in front: Deno only sees its own plain-HTTP listener, so without it the generated link is `http://…`, which also drops the `Secure` session cookie and leaves the user activated but not signed in. `X-Forwarded-Proto` is deliberately _not_ trusted — it is client-settable, the same reason the rate limiter keys on the TCP peer address only. |
| `SPM_LOG_LEVEL`     | `info`                                                                                                                                                           | How much the server logs: `silent`, `error`, `warn`, `info`, `debug` or `trace`. `info` covers startup, one line per API request, preview batches, authentication and every create/update/delete. `debug` adds static-asset requests and per-job preview detail. An unrecognised value is refused at startup rather than ignored.                                                                                                                                                  |

## Migrating an existing CuraManager library

A CuraManager library is flat: every project folder sits at the library root, each with an
optional `metadata.json` sidecar carrying its tags, source URL and archived flag (spec 3.6).
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
