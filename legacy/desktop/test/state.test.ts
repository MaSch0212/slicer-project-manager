import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  MODE_KEY,
  readRememberedDir,
  readRememberedMode,
  readRememberedRemote,
  readState,
  REMEMBERED_DIR_KEY,
  rememberChoice,
  rememberDir,
  REMOTE_URL_KEY,
  STATE_FILE_NAME,
  writeState,
} from '../src/state.ts'

/**
 * What the shell remembers between launches, driven directly.
 *
 * This file exists because a comment in `state.ts` claimed it did before it was written — the
 * branches were really covered, but through `shell.test.ts`, one level up and by inference. The
 * three that matter here are cheap to state directly and expensive to read off a mode switch: an
 * unknown `mode`, a task-4 file with no `mode` at all, and the two keys moving in one write.
 *
 * `library.test.ts` still owns the atomicity of the writer itself (the temp file, the fsync, the
 * rename), because that is where the folder tests that depend on it live.
 */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-state-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function stateFileFor(): string {
  seq += 1
  return join(root, `state-${seq}`, STATE_FILE_NAME)
}

function raw(stateFile: string): unknown {
  return JSON.parse(readFileSync(stateFile, 'utf8'))
}

test('nothing is remembered before anything is written', () => {
  const stateFile = stateFileFor()
  assert.deepEqual(readState(stateFile), {})
  assert.equal(readRememberedMode(stateFile), null)
  assert.equal(readRememberedDir(stateFile), null)
  assert.equal(readRememberedRemote(stateFile), null)
})

test('a choice writes the mode and its target in one pass', () => {
  const stateFile = stateFileFor()
  rememberChoice(stateFile, 'remote', 'https://print.example.com')

  // One write, both keys. Two calls would leave a window in which `mode: 'remote'` sat on disk
  // beside no `remoteUrl`, which the next launch would read as a remote mode with nowhere to go.
  assert.deepEqual(raw(stateFile), {
    [MODE_KEY]: 'remote',
    [REMOTE_URL_KEY]: 'https://print.example.com',
  })
  assert.equal(readRememberedMode(stateFile), 'remote')
  assert.equal(readRememberedRemote(stateFile), 'https://print.example.com')
})

test('switching mode leaves the other mode target where it was', () => {
  const stateFile = stateFileFor()
  rememberDir(stateFile, 'C:/libraries/mine')
  rememberChoice(stateFile, 'remote', 'https://print.example.com')

  // Only `mode` decides which is read; forgetting the folder because the user tried a server for
  // an afternoon would be a worse answer than keeping a key nothing reads.
  assert.deepEqual(raw(stateFile), {
    [REMEMBERED_DIR_KEY]: 'C:/libraries/mine',
    [MODE_KEY]: 'remote',
    [REMOTE_URL_KEY]: 'https://print.example.com',
  })
  assert.equal(readRememberedDir(stateFile), 'C:/libraries/mine')

  rememberChoice(stateFile, 'local', 'C:/libraries/other')
  assert.equal(readRememberedMode(stateFile), 'local')
  assert.equal(readRememberedRemote(stateFile), 'https://print.example.com')
})

test('a task-4 state file — a folder and no mode — reads as local', () => {
  const stateFile = stateFileFor()
  // Exactly what task 4 wrote, before modes existed. Upgrading must not throw a user back to a
  // question they already answered.
  writeState(stateFile, { [REMEMBERED_DIR_KEY]: 'C:/libraries/from-task-4' })
  assert.equal(readRememberedMode(stateFile), 'local')
  assert.equal(readRememberedDir(stateFile), 'C:/libraries/from-task-4')
})

test('a mode that is neither spelling is not a mode', () => {
  const stateFile = stateFileFor()
  // A folder is in the file **on purpose**, and it is what makes this test able to fail. Without
  // it, `null` comes back whether or not the unknown value is noticed, because the task-4
  // fallback below has nothing to fall back to — measured, by deleting the guard and watching
  // this stay green. With it, a shell that ignored the unknown `mode` would silently open that
  // folder instead of asking.
  writeState(stateFile, {
    [MODE_KEY]: 'cloud',
    [REMEMBERED_DIR_KEY]: 'C:/libraries/not-this-one',
    [REMOTE_URL_KEY]: 'https://print.example.com',
  })
  assert.equal(readRememberedMode(stateFile), null)
})

test('an empty string is not a remembered value', () => {
  const stateFile = stateFileFor()
  writeState(stateFile, { [REMEMBERED_DIR_KEY]: '', [REMOTE_URL_KEY]: '' })
  assert.equal(readRememberedDir(stateFile), null)
  assert.equal(readRememberedRemote(stateFile), null)
  assert.equal(readRememberedMode(stateFile), null)
})

test('a value of the wrong type is ignored rather than returned', () => {
  const stateFile = stateFileFor()
  writeState(stateFile, { [REMEMBERED_DIR_KEY]: 42, [REMOTE_URL_KEY]: { host: 'x' } })
  assert.equal(readRememberedDir(stateFile), null)
  assert.equal(readRememberedRemote(stateFile), null)
})

test('a file that is not an object at all is treated as nothing remembered', () => {
  for (const contents of ['[]', '"a string"', 'null', '{ half', '']) {
    const stateFile = stateFileFor()
    mkdirSync(join(stateFile, '..'), { recursive: true })
    writeFileSync(stateFile, contents)
    assert.deepEqual(readState(stateFile), {}, contents)
    assert.equal(readRememberedMode(stateFile), null, contents)
  }
})

test('the write leaves nothing behind but the file itself', () => {
  const stateFile = stateFileFor()
  rememberChoice(stateFile, 'remote', 'https://print.example.com')
  rememberChoice(stateFile, 'local', 'C:/libraries/mine')
  // The temp file is renamed over the real one, so a directory listing has one entry — a stray
  // `.tmp` would be litter in the user's own `userData`.
  assert.deepEqual(readdirSync(join(stateFile, '..')), [STATE_FILE_NAME])
})
