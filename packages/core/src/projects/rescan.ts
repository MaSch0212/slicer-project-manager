import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { classifyFile } from '../files/classify.ts'
import { fileContentHash } from '../files/hash.ts'
import { userRoot } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'

export const RELATIVE_PATH_SEPARATOR = '/'

type DiskFile = { relPath: string; absPath: string; size: number; mtimeMs: number }

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** Depth-first walk that skips dot-entries at every level (spec 3.1, 3.5). */
function walkFiles(dir: string, prefix = ''): DiskFile[] {
  const found: DiskFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue
    const absPath = join(dir, entry.name)
    const relPath = prefix ? `${prefix}${RELATIVE_PATH_SEPARATOR}${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...walkFiles(absPath, relPath))
    } else if (entry.isFile()) {
      const stat = statSync(absPath)
      found.push({ relPath, absPath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    }
  }
  return found
}

function isMissingRootError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function listProjectFolders(root: string): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    // The library root itself is absent (unmounted drive, deleted folder): report nothing
    // rather than deleting. Anything else (EPERM/EACCES, a transient I/O error) means the
    // drive IS there and something else is wrong; hiding that behind "missing" would tell
    // the user their whole library vanished when the real problem is permissions.
    if (isMissingRootError(err)) return []
    throw err
  }
  return entries.filter((e) => e.isDirectory() && !isHidden(e.name)).map((e) => e.name)
}

export async function rescan(lib: Library, ctx: Ctx): Promise<RescanResultDto> {
  const user = requireUserRow(lib.db, ctx.userId)
  const root = userRoot(lib, user.library_dir)
  const now = Date.now()
  const result: RescanResultDto = {
    adopted: 0,
    markedMissing: 0,
    filesAdded: 0,
    filesRemoved: 0,
    previewsQueued: 0,
  }

  const onDisk = new Set(listProjectFolders(root))
  const rows = lib.db
    .prepare('SELECT id, dir_name, state FROM projects WHERE owner_id = ?')
    .all(ctx.userId) as { id: string; dir_name: string; state: string }[]
  const byDirName = new Map(rows.map((row) => [row.dir_name, row]))

  // Adopt every folder with no row.
  for (const dirName of onDisk) {
    if (byDirName.has(dirName)) continue
    const id = newId()
    lib.db
      .prepare(
        `INSERT INTO projects (id, owner_id, name, dir_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.userId, dirName, dirName, now, now)
    byDirName.set(dirName, { id, dir_name: dirName, state: 'ok' })
    result.adopted++
  }

  const insertFile = lib.db.prepare(
    `INSERT INTO files (id, project_id, rel_path, kind, slicer, size_bytes, mtime_ms, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertPreview = lib.db.prepare(
    "INSERT INTO previews (file_id, state, updated_at) VALUES (?, 'pending', ?)",
  )
  const resetPreview = lib.db.prepare(
    `UPDATE previews SET state = 'pending', source = NULL, png_path = NULL, width = NULL,
                         height = NULL, error = NULL, attempts = 0, claimed_at = NULL,
                         updated_at = ?
     WHERE file_id = ?`,
  )

  for (const row of byDirName.values()) {
    if (!onDisk.has(row.dir_name)) {
      // Never delete metadata implicitly; the drive may just be unmounted (3.5).
      if (row.state !== 'missing') {
        lib.db
          .prepare("UPDATE projects SET state = 'missing', updated_at = ? WHERE id = ?")
          .run(now, row.id)
        result.markedMissing++
      }
      continue
    }
    if (row.state !== 'ok') {
      lib.db
        .prepare("UPDATE projects SET state = 'ok', updated_at = ? WHERE id = ?")
        .run(now, row.id)
    }

    const files = walkFiles(join(root, row.dir_name))
    const seen = new Set(files.map((file) => file.relPath))
    const existing = new Map(
      (
        lib.db
          .prepare('SELECT id, rel_path, size_bytes, mtime_ms FROM files WHERE project_id = ?')
          .all(row.id) as { id: string; rel_path: string; size_bytes: number; mtime_ms: number }[]
      ).map((f) => [f.rel_path, f]),
    )

    for (const file of files) {
      const known = existing.get(file.relPath)
      if (!known) {
        const id = newId()
        const classification = classifyFile(file.absPath)
        insertFile.run(
          id,
          row.id,
          file.relPath,
          classification.kind,
          classification.slicer,
          file.size,
          file.mtimeMs,
          await fileContentHash(file.absPath),
        )
        insertPreview.run(id, now)
        result.filesAdded++
        result.previewsQueued++
        continue
      }

      if (Number(known.size_bytes) === file.size && Number(known.mtime_ms) === file.mtimeMs)
        continue

      // Cheap stat mismatch, so pay for the hash and reclassify: a saved 3MF can change slicer.
      const hash = await fileContentHash(file.absPath)
      const classification = classifyFile(file.absPath)
      lib.db
        .prepare(
          'UPDATE files SET kind = ?, slicer = ?, size_bytes = ?, mtime_ms = ?, content_hash = ? WHERE id = ?',
        )
        .run(classification.kind, classification.slicer, file.size, file.mtimeMs, hash, known.id)

      const preview = lib.db
        .prepare('SELECT source_hash FROM previews WHERE file_id = ?')
        .get(known.id) as { source_hash: Uint8Array | null } | undefined
      const sameSource =
        preview?.source_hash != null &&
        preview.source_hash.length === hash.length &&
        preview.source_hash.every((byte, i) => byte === hash[i])
      if (!sameSource) {
        if (preview) resetPreview.run(now, known.id)
        else insertPreview.run(known.id, now)
        result.previewsQueued++
      }
    }

    for (const [relPath, known] of existing) {
      if (seen.has(relPath)) continue
      lib.db.prepare('DELETE FROM files WHERE id = ?').run(known.id)
      result.filesRemoved++
    }
  }

  return result
}
