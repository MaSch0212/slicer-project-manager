import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  BROWSE_FILE_NAME,
  LAST_URL_KEY,
  MAX_REMEMBERED_URL,
  clearLastPage,
  isRememberableUrl,
  readLastPage,
  writeLastPage,
} from '../src/browse/last-page.ts'
import { NODE_IO, type JsonStoreIo } from '../src/json-store.ts'

/**
 * `browse.json` — one entry of persisted third-party browsing history — against a real file.
 *
 * Nothing here needs Electron. What it covers that `json-store.test.ts` does not is that **this**
 * consumer actually goes through that writer: the sequence is asserted for this file, not inferred
 * from the fact that the import exists. A `writeLastPage` that reached for `writeFileSync` would
 * pass every assertion about the file's contents and turn the recording test red.
 */

let root: string
let seq = 0

before(() => {
  root = mkdtempSync(join(tmpdir(), 'spm-browse-last-page-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fileFor(): string {
  seq += 1
  return join(root, `case-${seq}`, BROWSE_FILE_NAME)
}

/** A file written by hand, so the reader is driven against bytes it did not produce. */
function fileWith(contents: string): string {
  const file = fileFor()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents)
  return file
}

/* -------------------------------------------------------------------------------------------
 * What may be remembered
 * ---------------------------------------------------------------------------------------- */

/**
 * One table, both answers, for the reason `browse-policy.test.ts` gives: a suite that only
 * enumerates refusals passes for a predicate that refuses everything, and this one's whole job is
 * that it *accepts* the four sites' own URLs.
 */
const REMEMBERABLE: ReadonlyArray<readonly [unknown, boolean]> = [
  ['https://www.thingiverse.com/thing:7401409', true],
  ['http://192.168.1.5:8000/model', true],
  ['https://cults3d.com/zh/3d-m%C3%B3x%C3%ADng/du%C5%8Dxi%C3%A0ng/hyper-hopper', true],

  // Narrower than `browseNavigationPolicy` on purpose, and each of these three is a URL the policy
  // *allows* the view to be at. `blob:` is dead the moment the document that minted it goes;
  // `about:blank` is nothing; and a `data:` URL is a whole site-authored document inlined into a
  // string, which is the arm that would put arbitrary bytes into `userData` under a name that
  // reads like a bookmark.
  ['blob:https://www.thingiverse.com/ae5e9664-0d63-4a6f-9c0a-2b0b4b8b0e21', false],
  ['about:blank', false],
  ['data:text/html,<h1>hello</h1>', false],

  // And the ones the policy blocks too, because this predicate is applied on the way *out* of the
  // file as well as on the way in: a hand-edited `browse.json` must not be able to name them.
  ['file:///C:/Windows/System32/drivers/etc/hosts', false],
  ['spm://app/_spm/files/1/raw', false],
  ['javascript:alert(1)', false],

  ['', false],
  ['not a url at all', false],
  [`https://example.com/${'x'.repeat(MAX_REMEMBERED_URL)}`, false],
  [null, false],
  [42, false],
  [{ href: 'https://www.thingiverse.com/' }, false],
]

test('only an http(s) URL of a sane length is a page this file will remember', () => {
  for (const [value, expected] of REMEMBERABLE) {
    assert.equal(isRememberableUrl(value), expected, JSON.stringify(value))
  }
  // The bound is on the length and not on the shape: one character under it is kept.
  const longest = `https://example.com/${'x'.repeat(MAX_REMEMBERED_URL - 'https://example.com/'.length)}`
  assert.equal(longest.length, MAX_REMEMBERED_URL)
  assert.equal(isRememberableUrl(longest), true)
  assert.equal(isRememberableUrl(`${longest}x`), false)
})

/* -------------------------------------------------------------------------------------------
 * Round trip
 * ---------------------------------------------------------------------------------------- */

test('a page written is the page read back', () => {
  const file = fileFor()
  assert.equal(readLastPage(file), null, 'a file that is not there is a first run')
  writeLastPage(file, 'https://www.printables.com/model/1807378-universal-clip')
  assert.equal(readLastPage(file), 'https://www.printables.com/model/1807378-universal-clip')
  writeLastPage(file, 'https://makerworld.com/en/models/2093108-dji-neo-2-the-box')
  assert.equal(readLastPage(file), 'https://makerworld.com/en/models/2093108-dji-neo-2-the-box')
  // One key, and the name of it is part of the file format rather than an implementation detail:
  // a reader from a previous build has to find what a writer from this one left.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    [LAST_URL_KEY]: 'https://makerworld.com/en/models/2093108-dji-neo-2-the-box',
  })
})

test('a URL this file does not keep leaves the previous one alone rather than clearing it', () => {
  const file = fileFor()
  writeLastPage(file, 'https://www.thingiverse.com/thing:1')
  writeLastPage(file, 'blob:https://www.thingiverse.com/ae5e9664')
  writeLastPage(file, 'about:blank')
  assert.equal(readLastPage(file), 'https://www.thingiverse.com/thing:1')
})

test('a file that is not what this reader expects degrades to a first run', () => {
  // Every one of these is a `browse.json` a user, a crash or a previous build could produce, and
  // every one of them means "start where the registry says" rather than an error the app reports.
  const cases = [
    '',
    '{',
    'null',
    '[]',
    '"https://www.thingiverse.com/"',
    '{}',
    `{"${LAST_URL_KEY}": 42}`,
    `{"${LAST_URL_KEY}": null}`,
    // The reader's own check, not the writer's: a file edited by hand to point the browse view at
    // a scheme the policy refuses is refused when it is read.
    `{"${LAST_URL_KEY}": "file:///C:/secrets.txt"}`,
    `{"lastUrlTypo": "https://www.thingiverse.com/"}`,
  ]
  for (const contents of cases) {
    assert.equal(readLastPage(fileWith(contents)), null, JSON.stringify(contents))
  }
})

test('a directory where the file should be is a first run and not a crash', () => {
  const file = fileFor()
  mkdirSync(file, { recursive: true })
  assert.equal(readLastPage(file), null)
})

/* -------------------------------------------------------------------------------------------
 * Clearing
 * ---------------------------------------------------------------------------------------- */

test('clearing removes the file, and clearing twice is not an error', () => {
  const file = fileFor()
  writeLastPage(file, 'https://cults3d.com/en/3d-model/various/hyper-hopper')
  assert.equal(existsSync(file), true)
  clearLastPage(file)
  // The file is gone, not rewritten as `{}` — the point of the call is that the entry stops
  // existing, and a file that says `{}` is a file that still says the feature ran.
  assert.equal(existsSync(file), false)
  assert.deepEqual(readdirSync(join(file, '..')), [])
  clearLastPage(file)
  assert.equal(readLastPage(file), null)
})

/* -------------------------------------------------------------------------------------------
 * The writer's guarantees, for this file
 * ---------------------------------------------------------------------------------------- */

/**
 * **That `browse.json` gets D's writer, asserted rather than assumed.**
 *
 * `json-store.test.ts` proves the writer flushes before it renames; nothing there says this
 * module uses it. `fsyncSync` has no observable effect in user space — remove it and every
 * assertion above still passes on every platform — so a `writeLastPage` built on `writeFileSync`
 * would produce a byte-identical file and lose the guarantee silently. This is the one assertion
 * that goes red for that change.
 */
test('the last page goes through the atomic writer: pid temp, fsync, then rename', () => {
  const calls: string[] = []
  const handles: number[] = []
  const io: JsonStoreIo = {
    mkdirSync: (dir, options) => {
      calls.push('mkdir')
      return NODE_IO.mkdirSync(dir, options)
    },
    openSync: (path, flags) => {
      const handle = NODE_IO.openSync(path, flags)
      calls.push(`open:${path.endsWith(`.${process.pid}.tmp`) ? 'pid-temp' : path}`)
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

  const file = fileFor()
  writeLastPage(file, 'https://www.thingiverse.com/thing:7401409', io)

  const handle = handles[0]
  assert.equal(handles.length, 1)
  assert.deepEqual(calls, [
    'mkdir',
    'open:pid-temp',
    `write:${handle}`,
    // Flushed, flushed *before* the rename, and the same handle the bytes went to. Without the
    // fsync the rename can reach the directory before the data reaches the disk, and what a
    // reader finds afterwards is a zero-length file.
    `fsync:${handle}`,
    `close:${handle}`,
    'rename',
  ])
  assert.equal(readLastPage(file), 'https://www.thingiverse.com/thing:7401409')
  // And nothing left beside it. A stray `.tmp` is litter in the user's own `userData`.
  assert.deepEqual(readdirSync(join(file, '..')), [BROWSE_FILE_NAME])
})

test('a rename that fails takes the temp file with it, and does not throw at the caller', () => {
  const file = fileFor()
  let removed: string | null = null
  const io: JsonStoreIo = {
    ...NODE_IO,
    renameSync: () => {
      throw new Error('EPERM: the antivirus has the file open')
    },
    rmSync: (path, options) => {
      removed = path
      NODE_IO.rmSync(path, options)
    },
  }

  // No throw: the caller is a `did-navigate` handler, and a navigation that has already happened
  // must not be reported as a failure because a scroll position could not be written down.
  writeLastPage(file, 'https://www.thingiverse.com/thing:1', io)

  assert.equal(removed, `${file}.${process.pid}.tmp`)
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false)
  assert.equal(existsSync(file), false)
  assert.equal(readLastPage(file), null)
})
