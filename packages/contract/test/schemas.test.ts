import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateSchema,
  createUserSchema,
  fileNameSchema,
  projectPatchSchema,
  serverUrlSchema,
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

test('fileNameSchema rejects Windows-reserved device names but accepts look-alikes', () => {
  for (const bad of ['NUL.stl', 'con.gcode', 'COM1', 'LPT9.txt', 'nul']) {
    assert.equal(fileNameSchema.safeParse(bad).success, false, bad)
  }
  assert.equal(fileNameSchema.safeParse('console.stl').success, true)
  assert.equal(fileNameSchema.safeParse('Gridfinity Bin.stl').success, true)
  assert.equal(fileNameSchema.safeParse('benchy.stl').success, true)
})

test('projectPatchSchema allows clearing website with null but not with a bad url', () => {
  assert.equal(projectPatchSchema.safeParse({ website: null }).success, true)
  assert.equal(projectPatchSchema.safeParse({ website: 'not a url' }).success, false)
})

test('serverUrlSchema accepts http and https and no other scheme', () => {
  // z.url() alone accepts every one of these: they are absolute URLs, and it is the *scheme*
  // that makes them unusable as the origin of a window.
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///c:/', 'not a url']) {
    assert.equal(serverUrlSchema.safeParse(bad).success, false, bad)
  }
  assert.equal(serverUrlSchema.safeParse('https://example.invalid:8443/').success, true)
  assert.equal(serverUrlSchema.safeParse('http://192.168.1.10:8080').success, true)
})

test('serverUrlSchema rejects an address carrying credentials', () => {
  // A decision, not a side effect: every one of these is a valid https URL. A library server is
  // an origin the app stores and reconnects to, so a password in it would be persisted as part
  // of that origin -- and userinfo is the oldest way there is to make one host read as another.
  for (const bad of [
    'https://user:pass@example.invalid/',
    'https://user@example.invalid/',
    'https://:pass@example.invalid/',
    'http://admin:hunter2@192.168.1.10:8080/',
  ]) {
    assert.equal(serverUrlSchema.safeParse(bad).success, false, bad)
  }
  // The same host without them is still fine, so this rejects the credentials and not the URL.
  assert.equal(serverUrlSchema.safeParse('https://example.invalid/').success, true)
})

test('serverUrlSchema rejects a path, a query and a fragment, as the shell does', () => {
  // These are the addresses that used to pass the form and be refused by the main process's
  // `parseRemoteOrigin` before any transport call, which surfaced to the user as a server that
  // "could not be reached" when nothing had been contacted. A deep link pasted out of a browser
  // is the realistic one.
  for (const bad of [
    'https://print.example.invalid/spm',
    'https://print.example.invalid/?next=/projects',
    'https://print.example.invalid/#projects',
    'http://192.168.1.10:8080/api/',
  ]) {
    assert.equal(serverUrlSchema.safeParse(bad).success, false, bad)
  }
  // A bare origin, and an origin with the root slash the URL parser adds, both still pass: this
  // refuses what is *after* the host, not the host.
  assert.equal(serverUrlSchema.safeParse('https://print.example.invalid').success, true)
  assert.equal(serverUrlSchema.safeParse('https://print.example.invalid/').success, true)
  assert.equal(serverUrlSchema.safeParse('http://192.168.1.10:8080/').success, true)
})
