import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateSchema,
  createUserSchema,
  fileNameSchema,
  projectPatchSchema,
  usernameSchema,
} from '../src/schemas.ts'

test('usernameSchema rejects a leading dash and accepts dots', () => {
  assert.equal(usernameSchema.safeParse('-nope').success, false)
  assert.equal(usernameSchema.safeParse('marc.schmidt').success, true)
})

test('activateSchema requires the confirmation to match', () => {
  const bad = activateSchema.safeParse({ password: 'longenoughpw', confirm: 'other' })
  assert.equal(bad.success, false)
  assert.deepEqual(bad.error?.issues[0]?.path, ['confirm'])
  assert.equal(
    activateSchema.safeParse({ password: 'longenoughpw', confirm: 'longenoughpw' }).success,
    true,
  )
})

test('activateSchema enforces the 10 character floor', () => {
  assert.equal(activateSchema.safeParse({ password: 'short', confirm: 'short' }).success, false)
})

test('createUserSchema defaults isAdmin to false and quota to unlimited', () => {
  const parsed = createUserSchema.parse({ username: 'anna', displayName: 'Anna' })
  assert.equal(parsed.isAdmin, false)
  assert.equal(parsed.quotaBytes, null)
})

test('fileNameSchema rejects separators, traversal and dotfiles', () => {
  for (const bad of ['../evil.stl', 'a/b.stl', 'a\\b.stl', '..', '.hidden']) {
    assert.equal(fileNameSchema.safeParse(bad).success, false, bad)
  }
  assert.equal(fileNameSchema.safeParse('benchy.stl').success, true)
})

test('projectPatchSchema allows clearing website with null but not with a bad url', () => {
  assert.equal(projectPatchSchema.safeParse({ website: null }).success, true)
  assert.equal(projectPatchSchema.safeParse({ website: 'not a url' }).success, false)
})
