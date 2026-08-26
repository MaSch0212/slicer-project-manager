import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CoreFileDto, CoreProjectDetailDto, CoreProjectDto } from '../src/dtos.ts'
import { createDecorators } from '../src/decorate.ts'

/**
 * Ruling C-2 moved these three functions out of `packages/server/src/decorate.ts` so the Electron
 * shell could produce the same DTOs against its own scheme. The ruling's condition was that the
 * server's output come out byte-identical, asserted rather than assumed — so this pins the
 * serialised bytes, key order included, for the base the server passes and for the base the
 * desktop passes, side by side.
 *
 * Byte-level and not `deepEqual`: key order is not something `deepEqual` sees, and the DTO is
 * JSON on the wire in one shell and a structured clone in the other. Nothing depends on the
 * order today; pinning it is how a reordering shows up as a decision rather than as a diff nobody
 * looked at. (`packages/server/test/files.test.ts` independently asserts the same `/api/...`
 * strings over real HTTP, which is what proves the server itself did not move.)
 */

const API = createDecorators('/api')
const SPM = createDecorators('spm://app/_spm')

const READY_FILE: CoreFileDto = {
  id: 'f1',
  name: 'cube.stl',
  kind: 'model',
  sizeBytes: 42,
  previewState: 'ready',
}

const PENDING_FILE: CoreFileDto = {
  id: 'f2',
  name: 'notes.txt',
  kind: 'other',
  sizeBytes: 7,
  previewState: 'pending',
}

const PROJECT: CoreProjectDto = {
  id: 'p1',
  name: 'Bracket',
  isArchived: false,
  state: 'ok',
  tags: ['petg'],
  fileCounts: { model: 1, slicerProject: 0, other: 1 },
  coverFileId: 'f1',
  createdAt: 10,
  updatedAt: 20,
}

test('decorateFile emits the exact bytes the server has always emitted', () => {
  assert.equal(
    JSON.stringify(API.decorateFile(READY_FILE)),
    '{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready",' +
      '"rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"}',
  )
  assert.equal(
    JSON.stringify(API.decorateFile(PENDING_FILE)),
    '{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending",' +
      '"rawUrl":"/api/files/f2/raw"}',
  )
})

test('a preview that is not ready claims no thumbUrl at all, in either shell', () => {
  // Not `thumbUrl: undefined`: the key is absent, which is what the UI's `@if (thumbUrl)` and the
  // JSON envelope both depend on.
  assert.equal(Object.hasOwn(API.decorateFile(PENDING_FILE), 'thumbUrl'), false)
  assert.equal(Object.hasOwn(SPM.decorateFile(PENDING_FILE), 'thumbUrl'), false)
  for (const state of ['pending', 'failed', 'unsupported'] as const) {
    assert.equal(SPM.decorateFile({ ...READY_FILE, previewState: state }).thumbUrl, undefined)
  }
})

test('decorateProject replaces coverFileId with a URL and does not leak the id', () => {
  assert.equal(
    JSON.stringify(API.decorateProject(PROJECT)),
    '{"id":"p1","name":"Bracket","isArchived":false,"state":"ok","tags":["petg"],' +
      '"fileCounts":{"model":1,"slicerProject":0,"other":1},"createdAt":10,"updatedAt":20,' +
      '"coverThumbUrl":"/api/files/f1/thumb"}',
  )
  assert.equal(Object.hasOwn(API.decorateProject(PROJECT), 'coverFileId'), false)
  const noCover: CoreProjectDto = { ...PROJECT }
  delete noCover.coverFileId
  assert.equal(Object.hasOwn(API.decorateProject(noCover), 'coverThumbUrl'), false)
})

test('decorateProjectDetail decorates the project and every file under it', () => {
  const detail: CoreProjectDetailDto = { ...PROJECT, files: [READY_FILE, PENDING_FILE] }
  assert.equal(
    JSON.stringify(API.decorateProjectDetail(detail)),
    '{"id":"p1","name":"Bracket","isArchived":false,"state":"ok","tags":["petg"],' +
      '"fileCounts":{"model":1,"slicerProject":0,"other":1},"createdAt":10,"updatedAt":20,' +
      '"coverThumbUrl":"/api/files/f1/thumb","files":[' +
      '{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready",' +
      '"rawUrl":"/api/files/f1/raw","thumbUrl":"/api/files/f1/thumb"},' +
      '{"id":"f2","name":"notes.txt","kind":"other","sizeBytes":7,"previewState":"pending",' +
      '"rawUrl":"/api/files/f2/raw"}]}',
  )
})

test('the desktop base produces the same shape under the reserved spm:// path', () => {
  const detail: CoreProjectDetailDto = { ...PROJECT, files: [READY_FILE] }
  assert.equal(
    JSON.stringify(SPM.decorateProjectDetail(detail)),
    '{"id":"p1","name":"Bracket","isArchived":false,"state":"ok","tags":["petg"],' +
      '"fileCounts":{"model":1,"slicerProject":0,"other":1},"createdAt":10,"updatedAt":20,' +
      '"coverThumbUrl":"spm://app/_spm/files/f1/thumb","files":[' +
      '{"id":"f1","name":"cube.stl","kind":"model","sizeBytes":42,"previewState":"ready",' +
      '"rawUrl":"spm://app/_spm/files/f1/raw","thumbUrl":"spm://app/_spm/files/f1/thumb"}]}',
  )

  // The only difference between the two shells is the prefix. Asserted by construction rather
  // than by eye: swap one base's prefix for the other's and the two must be the same string.
  assert.equal(
    JSON.stringify(SPM.decorateProjectDetail(detail)).split('spm://app/_spm').join('/api'),
    JSON.stringify(API.decorateProjectDetail(detail)),
  )
})

test('two decorators built from different bases do not share state', () => {
  // They are closures over `base`; a refactor to a module-level mutable would pass every test
  // above and fail this one.
  assert.equal(API.decorateFile(READY_FILE).rawUrl, '/api/files/f1/raw')
  assert.equal(SPM.decorateFile(READY_FILE).rawUrl, 'spm://app/_spm/files/f1/raw')
  assert.equal(API.decorateFile(READY_FILE).rawUrl, '/api/files/f1/raw')
})
