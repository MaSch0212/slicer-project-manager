import tseslint from 'typescript-eslint'

/**
 * The rules that mechanically enforce the two-runtime bet.
 *
 * `packages/core` running unmodified on Deno *and* Node is the load-bearing claim of the
 * design — subsystems C (Electron main process) and D build on it — but neither CI job can
 * catch a violation on its own:
 *
 * - `process.env.X` passes **both** jobs. Deno 2 supplies a `process` global through its
 *   Node compatibility layer, and `@types/node` makes it type-check.
 * - A `Deno.*` reference fails under Node only if that exact line executes during a test.
 *   Anything on a branch the suite does not cover ships broken.
 *
 * So the invariant lives here, not in the test matrix.
 */
const CORE_RUNTIME_MESSAGE =
  'packages/core must run unmodified on Deno and Node. Take the capability as a parameter, or use a node: builtin, instead.'

const CORE_BANNED_GLOBALS = [
  { name: 'process', message: CORE_RUNTIME_MESSAGE },
  { name: 'Deno', message: CORE_RUNTIME_MESSAGE },
  { name: 'require', message: CORE_RUNTIME_MESSAGE },
  { name: '__dirname', message: `${CORE_RUNTIME_MESSAGE} Use import.meta.url.` },
  { name: '__filename', message: `${CORE_RUNTIME_MESSAGE} Use import.meta.url.` },
  { name: 'Buffer', message: `${CORE_RUNTIME_MESSAGE} Use Uint8Array.` },
]

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.angular/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...CORE_BANNED_GLOBALS],
      // Explicit allow-list, evaluated gitignore-style: deny everything, then re-permit
      // node: builtins, the workspace packages, and relative paths. Anything else (an npm
      // package, a jsr: or https: specifier, a bare 'fs') is a runtime-portability risk
      // that has to be argued for rather than defaulted into.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // `!@spm` before `!@spm/**` is load-bearing: these are gitignore semantics
              // (ESLint runs them through the `ignore` package), and gitignore cannot
              // re-include a path whose parent directory is still excluded. Without the
              // bare `!@spm`, every `@spm/contract/*.ts` import in core is reported.
              // `node:*/**` re-permits subpaths such as `node:fs/promises`, since `*` alone
              // does not cross a `/`.
              group: [
                '**',
                '!node:*',
                '!node:*/**',
                '!@spm',
                '!@spm/**',
                '!.',
                '!..',
                '!./**',
                '!../**',
              ],
              message: `${CORE_RUNTIME_MESSAGE} Only node: builtins, @spm/* workspace packages and relative paths are allowed here.`,
            },
          ],
        },
      ],
    },
  },
)
