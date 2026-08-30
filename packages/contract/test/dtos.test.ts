import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../src/dtos.ts'

/**
 * A literal, not a self-comparison. `packages/core/src/users/account.ts`'s `getSettings`
 * builds its result as `{ ...DEFAULT_SETTINGS }` when a user has no `user_settings` rows, so a
 * test that asserts the no-rows case against the `DEFAULT_SETTINGS` import (there's one in
 * `packages/core/test/account.test.ts`) pins that `getSettings` returns *a copy of the
 * constant* — it catches a key going missing from the merge, but nothing pins what the constant
 * itself is defined as. Task 1's review (finding 1) measured the gap directly: changing
 * `DEFAULT_SETTINGS.viewMode` from `'grid'` to `'list'` left the entire repository's test suite
 * green — core, server, desktop and web all passed unchanged, because nothing anywhere pinned
 * that one key's default *value*, only its type. This test is that pin, one per shipped default,
 * so a change to any of them has to touch a test that says so.
 */
test('DEFAULT_SETTINGS matches the shipped defaults exactly', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    theme: 'system',
    language: 'en',
    viewMode: 'grid',
    sort: 'updatedAt',
    dir: 'desc',
    navCollapsed: false,
  })
})
