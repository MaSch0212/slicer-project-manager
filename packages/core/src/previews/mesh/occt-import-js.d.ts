/**
 * The types `occt-import-js@0.0.23` does not ship. It publishes no `.d.ts` of any kind.
 *
 * **Only the factory is declared here, and the shape it resolves to lives in `step.ts`.** Writing
 * the shape out a second time in this file would be two descriptions of one library drifting apart
 * silently, so this declares the specifier and defers everything else to the one module that reads
 * it — which is also where the fields are documented against what was measured.
 *
 * The module deliberately has no `ReadFile`, `ReadIgesFile` or `ReadBrepFile`, all three of which
 * the library really does export. IGES and BREP are out of scope for this subsystem, and a declared
 * entry point that nothing has tested is how a file that could have rendered ends up with a
 * terminal `unsupported` row instead.
 *
 * **This file is named twice, and the second naming is not redundant.** `packages/core/tsconfig.json`
 * finds it through `include: ["src"]`. `packages/desktop/tsconfig.json` does not include core's
 * directory at all, yet compiles `step.ts` by importing `@spm/core` — and an ambient
 * `declare module` that is not in the program does not exist, so `deno task typecheck:desktop`
 * failed TS7016 on a file that package does not own until its `include` named this one. Measured,
 * before and after. A `/// <reference>` in `step.ts` would have covered every consumer at once;
 * `@typescript-eslint/triple-slash-reference` refuses it, and this repository has no
 * `eslint-disable` comment in it to follow.
 *
 * Only `tsc` reads this. Deno resolves the same import through the npm package itself and, finding
 * no declarations there, types it as `any` — so `deno check` is not what keeps `step.ts` honest,
 * `deno task typecheck:core` and `deno task typecheck:desktop` are.
 */
declare module 'occt-import-js' {
  import type { Occt } from './step.ts'

  const occtimportjs: () => Promise<Occt>
  export default occtimportjs
}
