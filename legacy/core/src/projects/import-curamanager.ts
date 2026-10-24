import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { userRoot } from '../files/paths.ts'
import { requireUserRow } from '../users/repo.ts'
import { addTag, updateProject } from './usecases.ts'
import { rescan, type RescanProgress } from './rescan.ts'

export const SIDECAR_FILE = 'metadata.json'

export type CuraManagerSidecar = { tags: string[]; website: string | null; isArchived: boolean }

/** CuraManager wrote PascalCase keys; camelCase is accepted too so hand-edits still load. */
export function readCuraManagerSidecar(projectDirPath: string): CuraManagerSidecar | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(projectDirPath, SIDECAR_FILE), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    // Absent or malformed: migration continues without it rather than aborting.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const rawTags = parsed.Tags ?? parsed.tags
  const rawWebsite = parsed.Website ?? parsed.website
  const rawArchived = parsed.IsArchived ?? parsed.isArchived

  return {
    tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [],
    website: typeof rawWebsite === 'string' && rawWebsite.length > 0 ? rawWebsite : null,
    isArchived: rawArchived === true,
  }
}

/**
 * Server import: a CuraManager library is flat, so every project folder at the root moves
 * under the target user's library_dir. Dot-folders and every user's own root are left alone.
 */
export function moveFlatLibraryIntoUserFolder(lib: Library, ctx: Ctx): number {
  const user = requireUserRow(lib.db, ctx.userId)
  if (user.library_dir === '.') return 0
  const target = userRoot(lib, user.library_dir)

  const reserved = new Set(
    (lib.db.prepare('SELECT library_dir FROM users').all() as { library_dir: string }[]).map(
      (row) => row.library_dir,
    ),
  )

  const toMove = readdirSync(lib.dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.') && !reserved.has(entry.name),
    )
    .map((entry) => entry.name)

  // Verify every destination is free before moving anything, so a collision aborts loudly
  // and leaves the filesystem untouched -- on every platform. Catching the rename failure
  // after the fact would not do: on POSIX, rename(2) onto an *empty* existing directory
  // succeeds by silently replacing it, so the same input would abort on one OS and succeed
  // on another. Checking first removes that divergence by never reaching renameSync at all.
  const collisions = toMove.filter((name) => existsSync(join(target, name)))
  if (collisions.length > 0) {
    throw new AppError(
      'Conflict',
      `cannot import: already exists under the target user's folder: ${collisions.join(', ')}`,
      { existing: collisions },
    )
  }

  for (const name of toMove) renameSync(join(lib.dir, name), join(target, name))
  return toMove.length
}

/**
 * The two phases take very different amounts of time -- indexing hashes every byte on disk,
 * applying sidecars is a handful of queries per project -- so they are reported separately
 * rather than folded into one percentage that would sit at 99% for the whole second half.
 */
export type ImportProgress =
  | ({ phase: 'indexing' } & RescanProgress)
  | { phase: 'sidecars'; projectIndex: number; projectCount: number; dirName: string }

export async function importCuraManagerLibrary(
  lib: Library,
  ctx: Ctx,
  opts: { moveIntoUserFolder: boolean; onProgress?: (progress: ImportProgress) => void },
): Promise<{
  rescan: RescanResultDto
  projectsUpdated: number
  tagsApplied: number
  moved: number
}> {
  const moved = opts.moveIntoUserFolder ? moveFlatLibraryIntoUserFolder(lib, ctx) : 0

  // Adopt every folder and index its files first (spec 3.6, step 2).
  const rescanResult = await rescan(lib, ctx, {
    onProgress: (progress) => opts.onProgress?.({ phase: 'indexing', ...progress }),
  })

  const { projectsUpdated, tagsApplied } = applyCuraManagerSidecars(lib, ctx, opts.onProgress)

  return { rescan: rescanResult, projectsUpdated, tagsApplied, moved }
}

/**
 * Applies every project sidecar found on disk: its tags, website and archived flag.
 *
 * Split out of `importCuraManagerLibrary` so the zip upload path (`importCuraManagerZip`)
 * runs the identical second half. The alternative was a second copy that would drift, and
 * the two entry points differ only in how the folders arrive.
 */
export function applyCuraManagerSidecars(
  lib: Library,
  ctx: Ctx,
  onProgress?: (progress: ImportProgress) => void,
  /**
   * Restricts the pass to these folder names. Omitted means every project the user owns,
   * which is right for the one-shot CLI migration but wrong for the repeatable zip upload:
   * a sidecar still sitting in an older project's folder would otherwise reset the website
   * and archived flag that the user has since edited in the app, every time they import
   * anything at all.
   */
  onlyDirNames?: readonly string[],
): { projectsUpdated: number; tagsApplied: number } {
  const user = requireUserRow(lib.db, ctx.userId)
  const root = userRoot(lib, user.library_dir)
  const all = lib.db
    .prepare("SELECT id, dir_name FROM projects WHERE owner_id = ? AND state = 'ok'")
    .all(ctx.userId) as { id: string; dir_name: string }[]
  const wanted = onlyDirNames ? new Set(onlyDirNames) : null
  const projects = wanted ? all.filter((row) => wanted.has(row.dir_name)) : all

  let projectsUpdated = 0
  let tagsApplied = 0
  let projectIndex = 0
  for (const project of projects) {
    projectIndex++
    onProgress?.({
      phase: 'sidecars',
      projectIndex,
      projectCount: projects.length,
      dirName: project.dir_name,
    })
    const sidecar = readCuraManagerSidecar(join(root, project.dir_name))
    if (!sidecar) continue

    const before = lib.db
      .prepare('SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?')
      .get(project.id) as { n: number }
    for (const tag of sidecar.tags) addTag(lib, ctx, project.id, tag)
    const after = lib.db
      .prepare('SELECT COUNT(*) AS n FROM project_tags WHERE project_id = ?')
      .get(project.id) as { n: number }
    tagsApplied += Number(after.n) - Number(before.n)

    updateProject(lib, ctx, project.id, {
      website: sidecar.website,
      isArchived: sidecar.isArchived,
    })
    projectsUpdated++
  }

  lib.log.info('applied curamanager sidecars', { userId: ctx.userId, projectsUpdated, tagsApplied })
  return { projectsUpdated, tagsApplied }
}
