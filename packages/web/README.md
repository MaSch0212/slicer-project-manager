# Web

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.1.5.

## `@awdlab/jig` / `@awdlab/jig-themes`

Both packages used to need a local patch: they were published with their **source**
`package.json` at the package root, with no `exports`/`main`/`module`/`typings`, while the real
manifest sat at `dist/package.json`. As published, neither was importable by Node, `tsc`,
vitest, or Angular's esbuild bundler, so `patches/` spliced the built manifest into the root
one via pnpm's `patchedDependencies`.

`0.0.5` ships a proper root `exports` map and the patches are gone, along with the `patches/`
directory and pnpm itself — that patch mechanism was the last thing keeping pnpm in the repo.

## Why `@awdlab/jig-playwright` is _not_ a dependency

It was installed while task 23 was written and then deliberately dropped. Its page-object
harnesses are addressed by a **CSS host locator** (`page.jigInput('jig-input-field#name')`
and similar), which means the e2e suite would have to know each control's element id or
class — coupling the tests to the component tree. Playwright's own `getByLabel` /
`getByRole` address the same controls through their accessible name instead, which is both
what the user sees and what `e2e/smoke.spec.ts` already asserts on everywhere else. Every
harness the package offers had a shorter, more durable `getByRole` equivalent, so it earned
nothing.

It is recorded here rather than left installed-but-unimported: an unused dependency in
`package.json` reads as an oversight and invites the next contributor to spend an afternoon
rediscovering the same conclusion.

## Why `zod` is a dependency here

Nothing under `src/` imports `zod` by name, but this package must declare it anyway.
`@spm/contract`'s `exports` map points at **TypeScript source**, not built output, so every
consumer inlines contract's source and has to resolve contract's own imports itself — `zod`
included. Locally this can appear to work without the declaration, because Deno materialises a
root `node_modules/zod` for the root `deno.json` import map (`nodeModulesDir: "auto"`) and Vite
walks up and finds it. CI runs nothing but `deno install --allow-scripts --frozen` before the web job,
so that directory does not exist there and the build fails with
`Failed to resolve import "zod"`. The range is kept identical to contract's (`^4.0.0`) so both
packages resolve to one copy.

`packages/server` deliberately does **not** declare `zod`: it only ever runs under Deno, which
resolves it through the root import map.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

From the repository root:

```bash
deno task e2e
```

`playwright.config.ts` builds the bundle, seeds a throw-away library in the system temp directory
with a known-password admin (`e2e/seed.ts`, run under Deno) and serves both from the real Deno
server on port 8123, so the suite exercises the deployed static-file path rather than `ng serve`.
The browser binary is installed once with
`cd packages/web && deno run -A node_modules/@playwright/test/cli.js install chromium`.

Both `deno run` invocations in that config pass `--config ../../deno.json` explicitly: Deno stops
walking up at the first configuration it finds, which is this package's `package.json`, and that
does not depend on `@spm/core` — without the flag the seed script fails with
`Import "@spm/core" not a dependency`.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
