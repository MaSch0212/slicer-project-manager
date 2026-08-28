import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { NODE_IO, writeJsonFile, type JsonStoreIo } from '../src/json-store.ts'

/**
 * The atomic writer `state.json` and `slicers.json` share, driven directly.
 *
 * `state.test.ts` and `library.test.ts` still own everything they owned before the extraction —
 * this adds the assertions those two could not make, because the guarantee that matters most in
 * this file has no observable effect in user space. See `JsonStoreIo`.
 */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-json-store-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fileFor(name = 'thing.json'): string {
  seq += 1
  return join(root, `case-${seq}`, name)
}

/** Every call the writer makes, in order, over the real filesystem. */
function recording(): { io: JsonStoreIo; calls: string[]; handles: number[] } {
  const calls: string[] = []
  const handles: number[] = []
  const io: JsonStoreIo = {
    mkdirSync: (dir, options) => {
      calls.push('mkdir')
      return NODE_IO.mkdirSync(dir, options)
    },
    openSync: (path, flags) => {
      const handle = NODE_IO.openSync(path, flags)
      calls.push('open')
      handles.push(handle)
      return handle
    },
    writeFileSync: (handle, data) => {
      calls.push(`write:${handle}`)
      NODE_IO.writeFileSync(handle, data)
    },
    fsyncSync: (handle) => {
      calls.push(`fsync:${handle}`)
      NODE_IO.fsyncSync(handle)
    },
    closeSync: (handle) => {
      calls.push(`close:${handle}`)
      NODE_IO.closeSync(handle)
    },
    renameSync: (from, to) => {
      calls.push('rename')
      NODE_IO.renameSync(from, to)
    },
    rmSync: (path, options) => {
      calls.push('rm')
      NODE_IO.rmSync(path, options)
    },
  }
  return { io, calls, handles }
}

test('the file is written whole, with a trailing newline, and nothing is left beside it', () => {
  const file = fileFor()
  writeJsonFile(file, { a: 1, b: ['two'] })

  assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1,\n  "b": [\n    "two"\n  ]\n}\n')
  // The temp file is renamed over the real one, so a directory listing has one entry — a stray
  // `.tmp` would be litter in the user's own `userData`.
  assert.deepEqual(readdirSync(join(file, '..')), ['thing.json'])
})

test('a directory that does not exist yet is created', () => {
  const file = join(root, `nested-${(seq += 1)}`, 'deeper', 'still', 'thing.json')
  writeJsonFile(file, { made: true })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { made: true })
})

test('an existing file is replaced rather than appended to or truncated in place', () => {
  const file = fileFor()
  writeJsonFile(file, { first: 'write', padding: 'x'.repeat(200) })
  writeJsonFile(file, { second: true })

  // A shorter second write over a longer first one is where an in-place `writeFileSync` without
  // truncation leaves the tail of the old document behind and produces unparseable JSON.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { second: true })
  assert.deepEqual(readdirSync(join(file, '..')), ['thing.json'])
})

/**
 * **The assertion the extraction was flagged for.**
 *
 * `fsyncSync` is the step that makes the write survive a crash rather than only a concurrent
 * reader, and deleting it passes every other test in this repo — measured, by deleting it. This
 * is what goes red instead: the handle the bytes went to must be flushed, and flushed before the
 * rename that publishes it.
 */
test('the bytes are flushed to disk, on the handle they were written to, before the rename', () => {
  const file = fileFor()
  const { io, calls, handles } = recording()
  writeJsonFile(file, { durable: true }, io)

  const [handle] = handles
  assert.equal(handles.length, 1, 'one temp file, one handle')
  assert.deepEqual(calls, [
    'mkdir',
    'open',
    `write:${handle}`,
    `fsync:${handle}`,
    `close:${handle}`,
    'rename',
  ])
})

test('a rename that cannot complete removes the temp file and rethrows', () => {
  const file = fileFor()
  // A directory where the file should be: the write succeeds and the rename cannot.
  mkdirSync(file, { recursive: true })
  const { io, calls } = recording()

  assert.throws(() => writeJsonFile(file, { doomed: true }, io))

  // The rename was attempted and the cleanup ran after it — not instead of it.
  assert.deepEqual(calls.slice(-2), ['rename', 'rm'])
  assert.deepEqual(readdirSync(join(file, '..')), ['thing.json'], 'no temp file survives')
})

test('the temp file carries this process id, so two instances cannot collide', () => {
  const file = fileFor()
  const opened: string[] = []
  const io: JsonStoreIo = {
    ...NODE_IO,
    openSync: (path, flags) => {
      opened.push(path)
      return NODE_IO.openSync(path, flags)
    },
  }
  writeJsonFile(file, {}, io)

  assert.deepEqual(opened, [`${file}.${process.pid}.tmp`])
})

test('a write over a file another writer is mid-way through does not read as torn', () => {
  const file = fileFor()
  // Stand in for the loser of a race: a complete, valid document is already there, and a temp
  // file belonging to a *different* pid is beside it.
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{ "from": "the other instance" }\n')
  const foreignTemp = `${file}.${process.pid + 1}.tmp`
  writeFileSync(foreignTemp, '{ "half')

  writeJsonFile(file, { from: 'this instance' })

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { from: 'this instance' })
  // Deliberately still there: sweeping another process's temp file would race it mid-write.
  assert.equal(readFileSync(foreignTemp, 'utf8'), '{ "half')
})
