import { mkdirSync, rmSync } from 'node:fs'
import type { CoreProjectDto } from '@spm/contract/dtos.ts'
import type { CreateProjectInput, ProjectPatchInput } from '@spm/contract/schemas.ts'
import type { Ctx } from '../ctx.ts'
import { newId } from '../db/ids.ts'
import type { Library } from '../db/open.ts'
import { projectDir } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'
import { getProject, requireProjectRow } from './queries.ts'

/** Folder names come from the project name but must survive every filesystem. */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    // Trims leading/trailing dots, whitespace and the dashes that just replaced separators
    // (e.g. a trailing "?" becomes a trailing "-", which is still junk to trim).
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'project'
}

function uniqueDirName(lib: Library, ctx: Ctx, base: string): string {
  const taken = lib.db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND dir_name = ?')
  let candidate = base
  for (let n = 2; taken.get(ctx.userId, candidate); n++) candidate = `${base} (${n})`
  return candidate
}

export function createProject(lib: Library, ctx: Ctx, input: CreateProjectInput): CoreProjectDto {
  const user = requireUserRow(lib.db, ctx.userId)
  const id = newId()
  const now = Date.now()
  const dirName = uniqueDirName(lib, ctx, sanitizeDirName(input.name))

  mkdirSync(projectDir(lib, user.library_dir, dirName), { recursive: true })
  lib.db
    .prepare(
      `INSERT INTO projects (id, owner_id, name, dir_name, website, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.userId, input.name, dirName, input.website ?? null, input.notes ?? null, now, now)

  for (const tag of input.tags ?? []) addTag(lib, ctx, id, tag)
  return getProject(lib, ctx, id)
}

export function updateProject(
  lib: Library,
  ctx: Ctx,
  id: string,
  patch: ProjectPatchInput,
): CoreProjectDto {
  requireProjectRow(lib, ctx, id)
  const sets: string[] = []
  const params: (string | number | null)[] = []

  // dir_name deliberately does not follow name: a rename must never move a folder.
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if (patch.website !== undefined) {
    sets.push('website = ?')
    params.push(patch.website)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    params.push(patch.notes)
  }
  if (patch.isArchived !== undefined) {
    sets.push('is_archived = ?')
    params.push(patch.isArchived ? 1 : 0)
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?')
    params.push(Date.now(), id, ctx.userId)
    lib.db
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
      .run(...params)
  }
  return getProject(lib, ctx, id)
}

export function deleteProject(
  lib: Library,
  ctx: Ctx,
  id: string,
  opts: { deleteFiles: boolean },
): void {
  const row = requireProjectRow(lib, ctx, id)
  const user = requireUserRow(lib.db, ctx.userId)
  if (opts.deleteFiles) {
    rmSync(projectDir(lib, user.library_dir, row.dir_name), { recursive: true, force: true })
  }
  lib.db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, ctx.userId)
}

export function addTag(lib: Library, ctx: Ctx, projectId: string, name: string): void {
  requireProjectRow(lib, ctx, projectId)
  const trimmed = name.trim()
  if (!trimmed) return

  const existing = lib.db
    .prepare('SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.userId, trimmed) as { id: number } | undefined
  const tagId =
    existing?.id ??
    Number(
      lib.db
        .prepare('INSERT INTO tags (owner_id, name) VALUES (?, ?) RETURNING id')
        .get(ctx.userId, trimmed)!.id,
    )

  lib.db
    .prepare('INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)')
    .run(projectId, tagId)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)
}

export function removeTag(lib: Library, ctx: Ctx, projectId: string, name: string): void {
  requireProjectRow(lib, ctx, projectId)
  lib.db
    .prepare(
      `DELETE FROM project_tags WHERE project_id = ?
       AND tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND name = ? COLLATE NOCASE)`,
    )
    .run(projectId, ctx.userId, name.trim())
  // A tag that labels nothing is noise in the filter list.
  lib.db
    .prepare('DELETE FROM tags WHERE owner_id = ? AND id NOT IN (SELECT tag_id FROM project_tags)')
    .run(ctx.userId)
  lib.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)
}
