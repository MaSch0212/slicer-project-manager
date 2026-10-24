// Regression test for the local `@awdlab/jig` / `@awdlab/jig-themes` manifest patches
// (see /patches and the `patchedDependencies` entry in pnpm-workspace.yaml). Both packages
// are published with a source `package.json` at their root that is missing `exports` —
// the real manifest lives at `dist/package.json`. The patches splice the corrected,
// dist-prefixed fields into the root manifest so Angular's esbuild, `tsc`, and vitest can
// all resolve the package by construction.
//
// This spec imports a concrete, real class (not `import type`) so the module is actually
// loaded at runtime, proving TypeScript + vitest resolution end to end. `JigHint` also
// transitively imports from `@awdlab/jig-themes/templates/hint`, so a passing test here
// exercises both patched packages, not just `@awdlab/jig`.
import { JigHint } from '@awdlab/jig/hint'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigErrors } from '@awdlab/jig/errors'

describe('@awdlab/jig manifest patch', () => {
  it('resolves jig-hint, jig-input-field and jigErrors as real runtime exports', () => {
    expect(JigHint).toBeDefined()
    expect(JigInputField).toBeDefined()
    expect(JigErrors).toBeDefined()
  })
})
