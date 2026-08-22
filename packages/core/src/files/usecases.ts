import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreFileDto, FileKind, PreviewState, SlicerId } from '@spm/contract/dtos.ts'
import { AppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { RELATIVE_PATH_SEPARATOR } from '../projects/rescan.ts'
import { requireProjectRow, toCoreFileDto } from '../projects/queries.ts'
import { requireUserRow } from '../users/repo.ts'
import { diskUsageBytes } from '../users/usage.ts'
import { classifyFile } from './classify.ts'
import { fileContentHash } from './hash.ts'
import { previewPath, projectDir, safeJoin } from './paths.ts'

const CONTENT_TYPES: Record<string, string> = {
  stl: 'model/stl',
  obj: 'model/obj',
  '3mf': 'model/3mf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  gcode: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
}

export function contentTypeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

type FileRowFull = {
  id: string
  project_id: string
  rel_path: string
  kind: FileKind
  slicer: SlicerId | null
  size_bytes: number
  preview_state: PreviewState | null
}

/** Joined against projects so ownership is part of the lookup, never a later check. */
function requireOwnedFile(lib: Library, ctx: Ctx, id: string): FileRowFull & { dir_name: string } {
  const row = lib.db
    .prepare(
      `SELECT f.*, pv.state AS preview_state, p.dir_name AS dir_name
       FROM files f
       JOIN projects p ON p.id = f.project_id
       LEFT JOIN previews pv ON pv.file_id = f.id
       WHERE f.id = ? AND p.owner_id = ?`,
    )
    .get(id, ctx.userId) as (FileRowFull & { dir_name: string }) | undefined
  if (!row) throw new AppError('NotFound', 'file not found')
  return row
}

/** Throws QuotaExceeded with the numbers the UI needs to render a real message (5.6). */
export function assertWithinQuota(lib: Library, ctx: Ctx, incomingBytes: number): void {
  const user = requireUserRow(lib.db, ctx.userId)
  if (user.quota_bytes === null) return
  const usageBytes = diskUsageBytes(lib.db, ctx.userId)
  if (usageBytes + incomingBytes <= user.quota_bytes) return
  const details: QuotaExceededDetails = {
    usageBytes,
    quotaBytes: user.quota_bytes,
    incomingBytes,
  }
  throw new AppError('QuotaExceeded', 'storage quota exceeded', details)
}

export async function uploadFile(
  lib: Library,
  ctx: Ctx,
  projectId: string,
  name: string,
  body: { stream: ReadableStream<Uint8Array>; sizeBytes: number },
): Promise<CoreFileDto> {
  const project = requireProjectRow(lib, ctx, projectId)
  if (project.state !== 'ok') {
    throw new AppError('Conflict', 'project folder is missing on disk')
  }
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, project.dir_name)
  // safeJoin rejects separators and traversal before anything is opened.
  const absPath = safeJoin(dir, name)

  const clash = lib.db
    .prepare('SELECT 1 FROM files WHERE project_id = ? AND rel_path = ?')
    .get(projectId, name)
  if (clash || existsSync(absPath)) throw new AppError('Conflict', `"${name}" already exists`)

  assertWithinQuota(lib, ctx, body.sizeBytes)

  let handle
  try {
    // Exclusive create: the DB/disk check above is not atomic with this, so a name that wins
    // the race still surfaces as the same Conflict rather than a raw EEXIST.
    handle = await open(absPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AppError('Conflict', `"${name}" already exists`)
    }
    throw error
  }

  const reader = body.stream.getReader()
  try {
    let written = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (written > body.sizeBytes) {
        throw new AppError('Validation', 'upload body is larger than its declared size')
      }
      await handle.write(value)
    }
  } catch (error) {
    // A transport hands us its request body as this stream; leaving it undrained on a
    // rejection can hang the underlying connection, so cancel it before cleaning up.
    await reader.cancel(error).catch(() => {})
    await handle.close()
    rmSync(absPath, { force: true })
    throw error
  }
  await handle.close()

  const id = newId()
  const stat = statSync(absPath)
  const classification = classifyFile(absPath)
  lib.db
    .prepare(
      `INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      name,
      classification.kind,
      classification.slicer,
      stat.size,
      Math.round(stat.mtimeMs),
      await fileContentHash(absPath),
    )
  lib.db
    .prepare("INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)")
    .run(id, Date.now())
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)

  return toCoreFileDto({
    id,
    project_id: projectId,
    rel_path: name,
    kind: classification.kind,
    slicer: classification.slicer,
    size_bytes: stat.size,
    preview_state: 'pending',
  })
}

export function renameFile(lib: Library, ctx: Ctx, id: string, name: string): CoreFileDto {
  const row = requireOwnedFile(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, row.dir_name)

  const segments = row.rel_path.split(RELATIVE_PATH_SEPARATOR)
  const currentName = segments.pop()!
  const from = safeJoin(dir, ...segments, currentName)
  const to = safeJoin(dir, ...segments, name)
  const newRelPath = [...segments, name].join(RELATIVE_PATH_SEPARATOR)

  const clash = lib.db
    .prepare('SELECT 1 FROM files WHERE project_id = ? AND rel_path = ? AND id <> ?')
    .get(row.project_id, newRelPath, id)
  if (clash || existsSync(to)) throw new AppError('Conflict', `"${name}" already exists`)

  renameSync(from, to)
  lib.db.prepare('UPDATE files SET rel_path = ? WHERE id = ?').run(newRelPath, id)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), row.project_id)

  return toCoreFileDto({ ...row, rel_path: newRelPath })
}

export function deleteFile(lib: Library, ctx: Ctx, id: string): void {
  const row = requireOwnedFile(lib, ctx, id)
  const { absPath } = resolveFilePath(lib, ctx, id)
  rmSync(absPath, { force: true })
  rmSync(previewPath(lib, id), { force: true })
  lib.db.prepare('DELETE FROM files WHERE id = ?').run(id)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), row.project_id)
}

export function resolveFilePath(
  lib: Library,
  ctx: Ctx,
  id: string,
): { absPath: string; name: string; sizeBytes: number; contentType: string } {
  const row = requireOwnedFile(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  const dir = projectDir(lib, user.library_dir, row.dir_name)
  const segments = row.rel_path.split(RELATIVE_PATH_SEPARATOR)
  const name = segments[segments.length - 1]!
  return {
    absPath: safeJoin(dir, ...segments),
    name,
    sizeBytes: Number(row.size_bytes),
    contentType: contentTypeFor(name),
  }
}

export function resolvePreviewPath(
  lib: Library,
  ctx: Ctx,
  fileId: string,
): { absPath: string } | null {
  requireOwnedFile(lib, ctx, fileId)
  const row = lib.db
    .prepare("SELECT png_path FROM previews WHERE file_id = ? AND state = 'ready'")
    .get(fileId) as { png_path: string | null } | undefined
  if (!row?.png_path) return null
  const absPath = join(lib.dir, ...row.png_path.split(RELATIVE_PATH_SEPARATOR))
  return existsSync(absPath) ? { absPath } : null
}
