# Why these patches exist

`@awdlab/jig@0.0.4` and `@awdlab/jig-themes@0.0.4` are both published with their **source**
`package.json` at the package root — `{"files": ["dist", "README.md"]}` and no
`exports`/`main`/`module`/`typings`. The manifest that actually describes the shipped build
lives one level down, at `dist/package.json`, and npm does not consult it. As published,
neither package is resolvable by Node, `tsc`, vitest, or Angular's esbuild bundler: every
import of `@awdlab/jig/...` fails outright.

Each patch here splices the fields from that nested `dist/package.json` into the root
manifest, with every target rewritten to point into `dist/`. They are wired up through
`patchedDependencies` in `pnpm-workspace.yaml`, and each patched manifest carries a
`//patch-note` key repeating this reasoning where a future reader will actually trip over it.

They change packaging metadata only. No package source is touched.

## Upstream

The root cause is a one-line publishing mistake, not something wrong with the packages
themselves: all three build-from-dist packages pack with awesome-publish's `publishFiles`
instead of `publishDir`, so the tarball root gets the _source_ manifest and the correct
generated one stays nested at `dist/package.json`. The same mistake is why their published
`peerDependencies` still read `catalog:`, which pnpm merely warns about but `deno install`
refuses outright.

[awdlab/jig#22](https://github.com/awdlab/jig/pull/22) fixes it. Verified before opening:
packing each package's existing `dist/` as the tarball root and installing that here with
these patches removed resolves every import, type-checks, builds, and passes all web tests.

## The single condition for deleting them

Delete a patch when a released version of that package ships a root `package.json` carrying
its own `exports` field. At that point: bump the dependency version in
`packages/web/package.json`, delete the corresponding `patches/@awdlab__*.patch` file, and
remove its entry from `patchedDependencies` in `pnpm-workspace.yaml`. If both packages are
fixed, this directory goes with them.

Nothing else is a reason to touch them. In particular a version bump that does _not_ add a
root `exports` field still needs a patch — regenerate it against the new version rather than
dropping it, or the web build stops resolving jig at all.

See `packages/web/README.md` for the same story from the consumer's side.
