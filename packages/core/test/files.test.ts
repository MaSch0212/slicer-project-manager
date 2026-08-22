import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  resolvePreviewPath,
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

/** Enqueues each string as its own chunk, so a consuming reader sees several `read()`s. */
function streamOfChunks(chunks: string[]): {
  stream: ReadableStream<Uint8Array>
  sizeBytes: number
} {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk))
  const sizeBytes = encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  return {
    sizeBytes,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const bytes of encoded) controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

/** Same as streamOfChunks, but exposes whether the underlying source was ever cancelled. */
function trackedStreamOfChunks(chunks: string[]): {
  stream: ReadableStream<Uint8Array>
  sizeBytes: number
  wasCancelled: () => boolean
} {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk))
  const sizeBytes = encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  let cancelled = false
  return {
    sizeBytes,
    wasCancelled: () => cancelled,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const bytes of encoded) controller.enqueue(bytes)
        controller.close()
      },
      cancel() {
        cancelled = true
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

test('upload accepts a body delivered across multiple chunks', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const chunks = ['solid ', 'benchy ', 'in three parts']
    const { stream, sizeBytes } = streamOfChunks(chunks)

    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', { stream, sizeBytes })
    assert.equal(dto.sizeBytes, sizeBytes)

    const onDisk = join(lib.dir, 'marc', 'Benchy', 'benchy.stl')
    assert.equal(readFileSync(onDisk, 'utf8'), chunks.join(''))
  })
})

test('a body that exceeds its declared size partway through a later chunk cancels the stream and cleans up', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    // 3 chunks of 5 bytes each; the declared size (8) is only exceeded on the second chunk,
    // leaving the third unread — that unread remainder is what makes cancellation observable.
    const { stream, wasCancelled } = trackedStreamOfChunks(['xxxxx', 'xxxxx', 'xxxxx'])

    await assert.rejects(
      () => uploadFile(lib, ctx, project.id, 'a.stl', { stream, sizeBytes: 8 }),
      (e: unknown) => (e as AppError).code === 'Validation',
    )
    assert.equal(existsSync(join(lib.dir, 'marc', 'Benchy', 'a.stl')), false)
    assert.equal(getProject(lib, ctx, project.id).files.length, 0)
    assert.equal(wasCancelled(), true)
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

test('rename of a nested file changes only its last path segment', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    // Rescan is what actually produces nested rel_paths; recreate that shape by hand rather
    // than pulling rescan into this test.
    const subDir = join(lib.dir, 'marc', 'Benchy', 'sub')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'a.stl'), 'solid')
    const id = newId()
    lib.db
      .prepare(
        `INSERT INTO files (id, project_id, rel_path, kind, size_bytes, mtime_ms)
         VALUES (?, ?, 'sub/a.stl', 'model', 5, 0)`,
      )
      .run(id, project.id)

    const renamed = renameFile(lib, ctx, id, 'b.stl')
    assert.equal(renamed.name, 'sub/b.stl')
    assert.ok(existsSync(join(subDir, 'b.stl')))
    assert.equal(existsSync(join(subDir, 'a.stl')), false)
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

test('resolvePreviewPath is null while the preview is still pending', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    // uploadFile leaves a freshly-queued preview row in state 'pending'.
    assert.equal(resolvePreviewPath(lib, ctx, dto.id), null)
  })
})

test("resolvePreviewPath is null when a ready preview's png is missing from disk", async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    lib.db
      .prepare("UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?")
      .run(`.spm/previews/${dto.id}.png`, dto.id)
    // No file was ever written at that path.

    assert.equal(resolvePreviewPath(lib, ctx, dto.id), null)
  })
})

test('resolvePreviewPath returns the absolute path for a ready, present preview', async () => {
  await withLibrary(async (lib) => {
    const ctx = seedUser(lib)
    const project = createProject(lib, ctx, { name: 'Benchy' })
    const dto = await uploadFile(lib, ctx, project.id, 'benchy.stl', streamOf('solid'))

    const png = join(lib.dir, '.spm', 'previews', `${dto.id}.png`)
    writeFileSync(png, 'not really a png')
    lib.db
      .prepare("UPDATE previews SET state = 'ready', png_path = ? WHERE file_id = ?")
      .run(`.spm/previews/${dto.id}.png`, dto.id)

    const resolved = resolvePreviewPath(lib, ctx, dto.id)
    assert.equal(resolved?.absPath, png)
  })
})
