import type {
  CoreFileDto,
  CoreProjectDetailDto,
  CoreProjectDto,
  FileKind,
  PreviewState,
  ProjectQuery,
  SlicerId,
} from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Db, Library } from '../db/open.ts'

export type ProjectRow = {
  id: string
  owner_id: string
  name: string
  dir_name: string
  website: string | null
  notes: string | null
  is_archived: number
  state: 'ok' | 'missing'
  created_at: number
  updated_at: number
}

type FileRow = {
  id: string
  project_id: string
  rel_path: string
  kind: FileKind
  slicer: SlicerId | null
  size_bytes: number
  preview_state: PreviewState | null
}

const SORT_COLUMNS = {
  name: 'p.name COLLATE NOCASE',
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
} as const

/** Always scoped by ctx.userId: there is no unscoped variant to call by mistake (spec 2.2). */
export function requireProjectRow(lib: Library, ctx: Ctx, id: string): ProjectRow {
  const row = lib.db
    .prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
    .get(id, ctx.userId) as ProjectRow | undefined
  if (!row) throw new AppError('NotFound', 'project not found')
  return row
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/** % and _ are LIKE wildcards; a user searching for "100%" means the literal character. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function tagsByProject(db: Db, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT pt.project_id AS projectId, t.name AS name
       FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.project_id IN (${placeholders(ids.length)})
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all(...ids) as { projectId: string; name: string }[]
  for (const row of rows) {
    const list = map.get(row.projectId) ?? []
    list.push(row.name)
    map.set(row.projectId, list)
  }
  return map
}

function countsByProject(
  db: Db,
  ids: string[],
): Map<string, { model: number; slicerProject: number; other: number }> {
  const map = new Map<string, { model: number; slicerProject: number; other: number }>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT project_id AS projectId, kind, COUNT(*) AS n FROM files
       WHERE project_id IN (${placeholders(ids.length)}) GROUP BY project_id, kind`,
    )
    .all(...ids) as { projectId: string; kind: FileKind; n: number }[]
  for (const row of rows) {
    const entry = map.get(row.projectId) ?? { model: 0, slicerProject: 0, other: 0 }
    if (row.kind === 'model') entry.model = Number(row.n)
    else if (row.kind === 'slicer_project') entry.slicerProject = Number(row.n)
    else entry.other = Number(row.n)
    map.set(row.projectId, entry)
  }
  return map
}

/** Prefers a ready model preview, falls back to a ready slicer-project thumbnail. */
function coverByProject(db: Db, ids: string[]): Map<string, string> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const rows = db
    .prepare(
      `SELECT f.project_id AS projectId, f.id AS fileId
       FROM files f JOIN previews pv ON pv.file_id = f.id
       WHERE f.project_id IN (${placeholders(ids.length)}) AND pv.state = 'ready'
         AND f.kind IN ('model', 'slicer_project')
       ORDER BY (f.kind = 'model') DESC, f.rel_path COLLATE NOCASE`,
    )
    .all(...ids) as { projectId: string; fileId: string }[]
  for (const row of rows) if (!map.has(row.projectId)) map.set(row.projectId, row.fileId)
  return map
}

export function toCoreFileDto(row: FileRow): CoreFileDto {
  return {
    id: row.id,
    name: row.rel_path,
    kind: row.kind,
    ...(row.slicer ? { slicer: row.slicer } : {}),
    sizeBytes: Number(row.size_bytes),
    previewState: row.preview_state ?? 'pending',
  }
}

function toCoreProjectDto(
  row: ProjectRow,
  tags: string[],
  counts: { model: number; slicerProject: number; other: number },
  coverFileId: string | undefined,
): CoreProjectDto {
  return {
    id: row.id,
    name: row.name,
    ...(row.website ? { website: row.website } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    isArchived: row.is_archived === 1,
    state: row.state,
    tags,
    fileCounts: counts,
    ...(coverFileId ? { coverFileId } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listProjects(lib: Library, ctx: Ctx, query: ProjectQuery): CoreProjectDto[] {
  const where: string[] = ['p.owner_id = ?']
  const params: (string | number)[] = [ctx.userId]

  if (!query.includeArchived) where.push('p.is_archived = 0')

  if (query.search?.trim()) {
    const like = `%${escapeLike(query.search.trim())}%`
    // LIKE case-folding here comes from SQLite's default `case_sensitive_like = off`, not from
    // COLLATE: LIKE's case sensitivity is governed solely by that pragma and ignores any
    // COLLATE clause on its operands, so one is deliberately not applied to these three.
    where.push(
      `(p.name LIKE ? ESCAPE '\\'
        OR IFNULL(p.notes, '') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
                   WHERE pt.project_id = p.id AND t.name LIKE ? ESCAPE '\\'))`,
    )
    params.push(like, like, like)
  }

  // Dedupe case-insensitively: both sides of the COUNT(...) = ? comparison below must agree on
  // what "every requested tag" means, or ['petg', 'PETG'] (or a literal duplicate) can never match.
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of query.tags ?? []) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(trimmed)
  }
  if (tags.length > 0) {
    // AND semantics: the project must carry every requested tag.
    where.push(
      `(SELECT COUNT(DISTINCT t.name COLLATE NOCASE) FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.project_id = p.id AND t.name COLLATE NOCASE IN (${placeholders(tags.length)})) = ?`,
    )
    params.push(...tags, tags.length)
  }

  const column = SORT_COLUMNS[query.sort ?? 'updatedAt']
  const direction = query.dir === 'asc' ? 'ASC' : 'DESC'

  const rows = lib.db
    .prepare(
      `SELECT p.* FROM projects p WHERE ${where.join(' AND ')} ORDER BY ${column} ${direction}`,
    )
    .all(...params) as ProjectRow[]

  const ids = rows.map((row) => row.id)
  const tagMap = tagsByProject(lib.db, ids)
  const countMap = countsByProject(lib.db, ids)
  const coverMap = coverByProject(lib.db, ids)

  return rows.map((row) =>
    toCoreProjectDto(
      row,
      tagMap.get(row.id) ?? [],
      countMap.get(row.id) ?? { model: 0, slicerProject: 0, other: 0 },
      coverMap.get(row.id),
    ),
  )
}

export function getProject(lib: Library, ctx: Ctx, id: string): CoreProjectDetailDto {
  const row = requireProjectRow(lib, ctx, id)
  const tags = tagsByProject(lib.db, [id]).get(id) ?? []
  const counts = countsByProject(lib.db, [id]).get(id) ?? { model: 0, slicerProject: 0, other: 0 }
  const cover = coverByProject(lib.db, [id]).get(id)

  const files = lib.db
    .prepare(
      `SELECT f.*, pv.state AS preview_state FROM files f
       LEFT JOIN previews pv ON pv.file_id = f.id
       WHERE f.project_id = ? ORDER BY f.rel_path COLLATE NOCASE`,
    )
    .all(id) as FileRow[]

  return {
    ...toCoreProjectDto(row, tags, counts, cover),
    files: files.map(toCoreFileDto),
  }
}
