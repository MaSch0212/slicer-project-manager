import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RescanResultDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import type { Ctx } from '../ctx.ts'
import type { Library } from '../db/open.ts'
import { safeJoin, userRoot } from '../files/paths.ts'
import { assertWithinQuota } from '../files/usecases.ts'
import { openZip, type ZipEntry } from '../files/zip.ts'
import { requireUserRow } from '../users/repo.ts'
import { applyCuraManagerSidecars, type ImportProgress } from './import-curamanager.ts'
import { RELATIVE_PATH_SEPARATOR, rescan } from './rescan.ts'

/** Zip paths always use forward slashes, whatever platform wrote the archive. */
const ZIP_SEPARATOR = '/'

export type ZipPlan = {
  /** Entries that will be written, with the path each lands at under the user's root. */
  files: { entry: ZipEntry; relPath: string }[]
  /** Top-level folder names, i.e. the projects this import would create. */
  projectDirs: string[]
  /** The single wrapping folder that was stripped, if the archive had one. */
  strippedRoot: string | null
  /** Entries deliberately not written: loose root files, dot-entries, __MACOSX noise. */
  skipped: number
  totalBytes: number
}

function segments(name: string): string[] {
  return name.split(ZIP_SEPARATOR).filter((part) => part.length > 0)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Absent is the common answer and the only one that matters here; a permissions error
    // resolves the same way and surfaces properly when the write itself is attempted.
    return false
  }
}

/**
 * Decides what an archive would produce, without writing anything.
 *
 * Kept separate from the extraction so every refusal — a collision, a quota overrun, an
 * archive with no projects in it — happens before the first byte hits the disk. A half-written
 * library is far worse than a rejected upload, and "verify everything, then act" is the same
 * rule `moveFlatLibraryIntoUserFolder` already follows for the on-disk variant.
 */
export function planZipImport(entries: ZipEntry[]): ZipPlan {
  let skipped = 0
  const usable: { parts: string[]; entry: ZipEntry }[] = []

  for (const entry of entries) {
    // A trailing slash marks a directory record; directories are created from the file paths
    // instead, so an empty folder in the archive simply does not survive the trip.
    if (entry.name.endsWith(ZIP_SEPARATOR)) continue
    const parts = segments(entry.name)
    // Zip-slip and its relatives. `safeJoin` would refuse these later anyway; refusing here
    // means a malicious archive is a clean rejection rather than a half-done extraction.
    if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) {
      skipped++
      continue
    }
    // macOS resource forks, and the dot-entries that rescan would ignore on disk anyway.
    if (parts[0] === '__MACOSX' || parts.some((part) => part.startsWith('.'))) {
      skipped++
      continue
    }
    usable.push({ parts, entry })
  }

  // Zipping a library folder yields `MyLibrary/Project A/part.stl`; zipping its *contents*
  // yields `Project A/part.stl`. Both are things people actually upload, so the wrapper is
  // detected rather than demanded — but only when it holds folders. A lone top-level folder
  // whose children are all files is a single project, and stripping it would scatter that
  // project's files across the library root.
  const topLevel = new Set(usable.map((file) => file.parts[0]!))
  const hasNestedDirs = usable.some((file) => file.parts.length > 2)
  const strippedRoot = topLevel.size === 1 && hasNestedDirs ? [...topLevel][0]! : null

  const files: ZipPlan['files'] = []
  const projectDirs = new Set<string>()
  let totalBytes = 0

  for (const { parts, entry } of usable) {
    const relative = strippedRoot ? parts.slice(1) : parts
    // A file sitting directly at the library root belongs to no project — CuraManager's own
    // `metadata-cache.json` is exactly this. Nothing would ever index it, so it is not written.
    if (relative.length < 2) {
      skipped++
      continue
    }
    projectDirs.add(relative[0]!)
    files.push({ entry, relPath: relative.join(RELATIVE_PATH_SEPARATOR) })
    totalBytes += entry.uncompressedSize
  }

  return { files, projectDirs: [...projectDirs].sort(), strippedRoot, skipped, totalBytes }
}

export type ZipImportProgress =
  { phase: 'extracting'; fileIndex: number; fileCount: number; relPath: string } | ImportProgress

export type ZipImportResult = {
  projectsExtracted: number
  filesExtracted: number
  bytesExtracted: number
  strippedRoot: string | null
  skipped: number
  projectsUpdated: number
  tagsApplied: number
  rescan: RescanResultDto
}

/**
 * Imports a CuraManager library from a zip archive already staged on disk.
 *
 * This is the counterpart to the `import-curamanager` CLI, and exists because that CLI has to
 * run on the machine holding the library — which for a self-hosted server is the wrong
 * machine. Uploading the archive lets the import run entirely server-side, in the one process
 * that already owns the database.
 */
export async function importCuraManagerZip(
  lib: Library,
  ctx: Ctx,
  zipPath: string,
  opts: { onProgress?: (progress: ZipImportProgress) => void } = {},
): Promise<ZipImportResult> {
  const user = requireUserRow(lib.db, ctx.userId)
  const root = userRoot(lib, user.library_dir)
  const zip = openZip(zipPath)

  try {
    const plan = planZipImport(zip.entries)
    if (plan.files.length === 0) {
      throw new AppError(
        'Validation',
        'the archive contains no project folders. A CuraManager library is a folder of ' +
          'project folders; zip that folder, or its contents.',
      )
    }

    // Refuse before writing: an import that stopped halfway would leave a library that is
    // neither the old one nor the new one, with no obvious way back.
    const collisions = plan.projectDirs.filter((name) => isDirectory(safeJoin(root, name)))
    if (collisions.length > 0) {
      throw new AppError(
        'Conflict',
        `already in your library: ${collisions.join(', ')}. Rename or remove them first.`,
        { existing: collisions },
      )
    }
    // Uncompressed size, deliberately: the quota governs what lands on disk, and a zip bomb
    // is precisely the case where the compressed size is a useless proxy for it.
    assertWithinQuota(lib, ctx, plan.totalBytes)

    // Resolve every destination up front. `safeJoin` is the authoritative containment check —
    // it normalises each segment and re-verifies the result sits under the root, which is what
    // catches escapes `planZipImport` cannot see, such as a Windows-authored entry whose
    // separators are backslashes and so arrives here as one opaque segment. Doing it in the
    // write loop would still be safe, but it would abort halfway and leave a partial library;
    // doing it here keeps the whole operation all-or-nothing.
    const targets = plan.files.map((file) =>
      safeJoin(root, ...file.relPath.split(RELATIVE_PATH_SEPARATOR)),
    )

    let bytesExtracted = 0
    for (const [index, file] of plan.files.entries()) {
      opts.onProgress?.({
        phase: 'extracting',
        fileIndex: index + 1,
        fileCount: plan.files.length,
        relPath: file.relPath,
      })
      const target = targets[index]!
      mkdirSync(dirname(target), { recursive: true })
      const bytes = zip.read(file.entry)
      writeFileSync(target, bytes)
      bytesExtracted += bytes.length
    }
    lib.log.info('extracted a curamanager archive', {
      userId: ctx.userId,
      projects: plan.projectDirs.length,
      files: plan.files.length,
      bytes: bytesExtracted,
      strippedRoot: plan.strippedRoot,
      skipped: plan.skipped,
    })

    const rescanResult = await rescan(lib, ctx, {
      onProgress: (progress) => opts.onProgress?.({ phase: 'indexing', ...progress }),
    })
    // Scoped to what this archive brought in: re-running the pass over the whole library
    // would let a stale metadata.json in an older folder overwrite edits made since.
    const sidecars = applyCuraManagerSidecars(lib, ctx, opts.onProgress, plan.projectDirs)

    return {
      projectsExtracted: plan.projectDirs.length,
      filesExtracted: plan.files.length,
      bytesExtracted,
      strippedRoot: plan.strippedRoot,
      skipped: plan.skipped,
      rescan: rescanResult,
      ...sidecars,
    }
  } finally {
    zip.close()
  }
}
