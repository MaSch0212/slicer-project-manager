# Web

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.1.5.

## `@awdlab/jig` / `@awdlab/jig-themes` local patches

Both packages are published with their **source** `package.json` at the package root (`files:
["dist", "README.md"]`, no `exports`/`main`/`module`/`typings`) instead of the built manifest that
actually lives at `dist/package.json`. As published, neither package is importable by Node, `tsc`,
vitest, or Angular's esbuild bundler. `patches/@awdlab__jig@<version>.patch` and
`patches/@awdlab__jig-themes@<version>.patch` (wired up via `patchedDependencies` in
`pnpm-workspace.yaml`) splice the real `dist/package.json` fields into the root manifest, with every
target rewritten to point into `dist/`.

**Delete these patches** once a released version of `@awdlab/jig` (and/or `@awdlab/jig-themes`) ships
a root `package.json` that carries its own `exports` field — at that point bump the dependency version
and drop the corresponding patch file and `patchedDependencies` entry.

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

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
