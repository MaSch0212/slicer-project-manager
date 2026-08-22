import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { AppError } from '@spm/contract/errors.ts'
import type { Library } from '../db/open.ts'
import { PREVIEWS_DIR, SPM_DIR } from '../db/open.ts'

/**
 * Joins under `base` and refuses anything that escapes it. Every path built from
 * user-supplied text goes through here.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || isAbsolute(segment) || normalize(segment).split(sep).includes('..')) {
      throw new AppError('Forbidden', `illegal path segment: ${segment}`)
    }
  }
  const target = resolve(base, ...segments)
  const root = resolve(base)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new AppError('Forbidden', 'path escapes the library')
  }
  return target
}

/** `library_dir` of '.' means a flat library: project folders sit at the root (spec 2.6). */
export function userRoot(lib: Library, libraryDir: string): string {
  return libraryDir === '.' ? resolve(lib.dir) : safeJoin(lib.dir, libraryDir)
}

export function projectDir(lib: Library, libraryDir: string, dirName: string): string {
  return safeJoin(userRoot(lib, libraryDir), dirName)
}

export function previewPath(lib: Library, fileId: string): string {
  return join(lib.dir, SPM_DIR, PREVIEWS_DIR, `${fileId}.png`)
}
