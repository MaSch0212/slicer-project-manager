import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppError, QuotaExceededDetails } from '@spm/contract/errors.ts'
import type { Ctx } from '../src/ctx.ts'
import { newId } from '../src/db/ids.ts'
import type { Library } from '../src/db/open.ts'
import {
  assertWithinQuota,
  contentTypeFor,
  deleteFile,
  renameFile,
  resolveFilePath,
  uploadFile,
} from '../src/files/usecases.ts'
import { createProject } from '../src/projects/usecases.ts'
import { getProject } from '../src/projects/queries.ts'
import { assert, test } from './harness.ts'
import { withLibrary } from './tmp-library.ts'

function seedUser(lib: Library, username = 'marc'): Ctx {
  const id = newId()
  lib.db
    .prepare(
      `INSERT INTO users (id, username, display_name, library_dir, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', 0)`,
    )
    .run(id, username, username, username)
  return { userId: id, isAdmin: false }
}

function streamOf(text: string): { stream: ReadableStream<Uint8Array>; sizeBytes: number } {
  const bytes = new TextEncoder().encode(text)
  return {
    sizeBytes: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

test('contentTypeFor maps the formats this app cares about', () => {
  assert.equal(contentTypeFor('a.stl'), 'model/stl')
  assert.equal(contentTypeFor('a.3MF'), 'model/3mf')
  assert.equal(contentTypeFor('a.png'), 'image/png')
  assert.equal(contentTypeFor('a.weird'), 'application/octet-stream')
})

test('upload writes the file, indexes it and queues a preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })

    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid benchy'))
    assert.equal(dto.name, 'benchy.stl')
    assert.equal(dto.kind, 'model')
    assert.equal(dto.previewState, 'pending')
    assert.equal(dto.sizeBytes, 'solid benchy'.length)

    const onDisk = join(lib.dir, 'marc', 'Benchy', 'benchy.stl')
    assert.equal(readFileSync(onDisk, 'utf8'), 'solid benchy')
    assert.equal(getProject(lib, ctx, project.id).files.length, 1)
  })
})

test('upload refuses a duplicate name in the same project', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid again')),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('upload refuses a path segment in the file name', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, '../escape.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'Forbidden',
    )
  })
})

test('upload into another user project is a NotFound', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const project = createProject(lib, marc, { name: 'Benchy' })
    await assert.rejects(
      () => uploadFile(lib, anna, project.id, 'a.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
  })
})

test('upload into a missing project is refused', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    lib.db.prepare("UPDATE projects SET state = 'missing' WHERE id = ?").run(project.id)
    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'a.stl', streamOf('solid')),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('a null quota means unlimited', async () => {
  await withLibrary((lib) => {
    const ctx = seedUser(lib)
    assertWithinQuota(lib, ctx, Number.MAX_SAFE_INTEGER)
  })
})

test('quota is checked before writing and reports the numbers', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    lib.db.prepare('UPDATE users SET quota_bytes = 100 WHERE id = ?').run(ctx.userId)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    await uploadFile(lib, ctx, project.id, 'a.stl', streamOf('x'.repeat(90)))

    let caught: AppError | undefined
    try {
      await uploadFile(lib, ctx, project.id, 'b.stl', streamOf('x'.repeat(20)))
    } catch (error) {
      caught = error as AppError
    }
    assert.equal(caught?.code, 'QuotaExceeded')
    const details = caught?.details as QuotaExceededDetails
    assert.deepEqual(details, { usageBytes: 90, quotaBytes: 100, incomingBytes: 20 })
    // Nothing was written.
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'b.stl')), false)
  })
})

test('a body longer than its declared size is rejected and cleaned up', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const body = streamOf('x'.repeat(50))

    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'a.stl', { stream: body.stream, sizeBytes: 10 }),
      (e: unknown) => (e as AppError).code === 'Validation',
    )
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'a.stl')), false)
    assert.equal(getProject(lib, ctx, project.id).files.length, 0)
  })
})

test('rename moves the file on disk and keeps its folder', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    const renamed = renameFile(lib, ctx, dto.id, 'benchy-v2.stl')
    assert.equal(renamed.name, 'benchy-v2.stl')
    assert.ok(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy-v2.stl')))
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy.stl')), false)
  })
})

test('rename onto an existing name is a conflict', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const a = await uploadFile(lib, ctx, project.id, 'a.stl', streamOf('solid'))
    await uploadFile(lib, ctx, project.id, 'b.stl', streamOf('solid'))
    assert.throws(
      () => renameFile(lib, ctx, a.id, 'b.stl'),
      (e: unknown) => (e as AppError).code === 'Conflict',
    )
  })
})

test('delete removes the bytes, the row and the preview png', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    const png = join(lib.dir, '.spm', 'previews', `${dto.id}.png`)
    writeFileSync(png, 'not really a png')
    lib.db
      .prepare("UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?")
      .run(`.spm/previews/${dto.id}.png`, dto.id)

    deleteFile(lib, ctx, dto.id)
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'benchy.stl')), false)
    assert.equal(existsSync(png), false)
    assert.equal(getProject(lib, ctx, project.id).files.length, 0)
  })
})

test('resolveFilePath is scoped to the owner', async () => {
  await withLibrary(async (lib) => {
    const marc = seedUser(lib, 'marc')
    const anna = seedUser(lib, 'anna')
    const project = createProject(lib, marc, { name: 'Benchy' })
    const dto = await uploadFile(lib, marc, project.id, 'benchy.stl', streamOf('solid'))

    const resolved = resolveFilePath(lib, marc, dto.id)
    assert.equal(resolved.absPath, join(lib.dir, 'marc', 'Benchy', 'benchy.stl'))
    assert.equal(resolved.contentType, 'model/stl')
    assert.equal(resolved.sizeBytes, 5)

    assert.throws(
      () => resolveFilePath(lib, anna, dto.id),
      (e: unknown) => (e as AppError).code === 'NotFound',
    )
  })
})
