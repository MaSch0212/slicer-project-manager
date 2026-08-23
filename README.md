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

    pnpm verify   # lint, format, typecheck (tsc + deno check), contract, core on Node,
                  # core on Deno, server, web
    pnpm e2e      # Playwright smoke suite; not part of verify

`core` runs under both runtimes on purpose: that is what keeps the same code usable from the
Electron main process (subsystem C).

`pnpm e2e` builds the web bundle, seeds a throw-away library in the system temp directory and
serves both from the real Deno server, so it exercises the static-file path the deployed server
uses. It needs a browser binary once:
`pnpm --filter @spm/web exec playwright install chromium`.
