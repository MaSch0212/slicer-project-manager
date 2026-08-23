import { AppError } from '@spm/contract/errors.ts'
import { importCuraManagerZip } from '@spm/core'
import { json } from '../json.ts'
import type { Route } from '../router.ts'

/**
 * Ten gigabytes. A CuraManager library of a few hundred projects is comfortably under this;
 * the cap exists so a wrong file or a hostile client cannot fill the disk before the quota
 * check — which needs the archive's central directory, and so cannot run until the whole
 * upload has landed.
 */
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024

function requireContentLength(req: Request): number {
  const raw = req.headers.get('content-length')
  const size = raw === null ? Number.NaN : Number(raw)
  if (!Number.isInteger(size) || size <= 0) {
    throw new AppError('LengthRequired', 'content-length is required')
  }
  if (size > MAX_ARCHIVE_BYTES) {
    throw new AppError('QuotaExceeded', 'that archive is larger than the 10 GiB upload limit')
  }
  return size
}

/**
 * Streams the upload to a temporary file inside the library's own `.spm` directory.
 *
 * Not the OS temp directory: a library on a large data disk is routinely paired with a small
 * system disk, and a multi-gigabyte archive staged on the wrong one would fail for reasons
 * that have nothing to do with the user's quota. `.spm` is also already excluded from every
 * rescan, so a staging file can never be mistaken for a project.
 *
 * Staged rather than held in memory because the zip central directory sits at the *end* of
 * the archive: nothing can be planned, validated or extracted until the last byte has arrived.
 */
async function stageArchive(libraryDir: string, body: ReadableStream<Uint8Array>): Promise<string> {
  const dir = `${libraryDir}/.spm/uploads`
  await Deno.mkdir(dir, { recursive: true })
  const path = `${dir}/${crypto.randomUUID()}.zip`
  const file = await Deno.create(path)
  try {
    await body.pipeTo(file.writable)
  } catch (error) {
    // pipeTo closes the handle on both paths, so only the staged file needs cleaning up.
    await Deno.remove(path).catch(() => {})
    throw error
  }
  return path
}

export const importRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/import/curamanager',
    auth: 'session',
    // One import at a time per client is already more than anyone needs, and each one can
    // occupy the disk for minutes.
    rateLimit: { limit: 5, windowMs: 60_000 },
    handler: async ({ req, env, ctx }) => {
      requireContentLength(req)
      if (!req.body) throw new AppError('Validation', 'a request body is required')

      const staged = await stageArchive(env.lib.dir, req.body)
      try {
        const result = await importCuraManagerZip(env.lib, ctx, staged)
        return json(result)
      } finally {
        // Always: the archive has either been extracted or rejected, and either way keeping
        // a multi-gigabyte copy inside the user's own library would silently eat their quota.
        await Deno.remove(staged).catch(() => {})
      }
    },
  },
]
