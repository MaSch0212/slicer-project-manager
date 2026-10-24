import { defineConfig } from 'vitest/config'

/**
 * Extra vitest configuration for `ng test`, wired in through the `runnerConfig` option of
 * `@angular/build:unit-test` in angular.json.
 *
 * `@iconify/icons-tabler` ships one CommonJS-shaped file per icon with no `exports` map, so
 * `withDefaultIcons()`'s extensionless imports (`@iconify/icons-tabler/alert-circle`) are
 * unresolvable under Node's ESM rules. The browser build never hits this because Vite's own
 * resolver handles it; the test run does, because vitest externalises node_modules and hands
 * them to Node as-is. Inlining the package puts it back through Vite's resolver.
 */
export default defineConfig({
  test: {
    server: { deps: { inline: [/@iconify\//, /@awdlab\//] } },
  },
})
