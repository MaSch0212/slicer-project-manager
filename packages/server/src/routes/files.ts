import { AppError } from '@spm/contract/errors.ts'
import { fileNameSchema, fileRenameSchema } from '@spm/contract/schemas.ts'
import { deleteFile, renameFile, resolveFilePath, resolvePreviewPath, uploadFile } from '@spm/core'
import { decorateFile } from '../decorate.ts'
import { json, noContent, parseJson } from '../json.ts'
import { decodeURIComponentOrThrow } from '../percent.ts'
import type { Route } from '../router.ts'

export const UPLOAD_NAME_HEADER = 'x-spm-file-name'

function requireUploadName(req: Request): string {
  const raw = req.headers.get(UPLOAD_NAME_HEADER)
  if (!raw) throw new AppError('Validation', `${UPLOAD_NAME_HEADER} header is required`)
  const decoded = decodeURIComponentOrThrow(raw, `${UPLOAD_NAME_HEADER} header`)
  const parsed = fileNameSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new AppError('Validation', 'illegal file name', { issues: parsed.error.issues })
  }
  return parsed.data
}

function requireContentLength(req: Request): number {
  const raw = req.headers.get('content-length')
  const size = raw === null ? Number.NaN : Number(raw)
  if (!Number.isInteger(size) || size < 0) {
    // 411: the quota check must know the size before a byte is written (spec 5.6).
    throw new AppError('LengthRequired', 'content-length is required')
  }
  return size
}

/**
 * Streams a file off disk. Bulk bytes never pass through JSON (spec 4.2).
 *
 * A file *row* can outlive its *bytes*: rescan marks a file `missing` without deleting the
 * row, and the bytes can also vanish underneath the server between the DB read and this open
 * (no state column can prevent that race). Either way the honest answer is a 404, not an
 * unhandled `Deno.errors.NotFound` falling through to a logged 500 (Ruling 34).
 */
async function streamFile(
  absPath: string,
  contentType: string,
  fileName: string,
): Promise<Response> {
  let file: Deno.FsFile
  try {
    file = await Deno.open(absPath, { read: true })
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new AppError('NotFound', 'file is missing on disk')
    }
    throw error
  }
  // Past this point the handle is open; on any failure below we must close it ourselves,
  // since nothing else owns it yet. On success, `file.readable` takes ownership of the
  // handle and the response stream closes it when consumed — do not close it here too.
  try {
    const stat = await file.stat()
    return new Response(file.readable, {
      headers: {
        'content-type': contentType,
        'content-length': String(stat.size),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    })
  } catch (error) {
    file.close()
    throw error
  }
}

export const fileRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/projects/:id/files',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const name = requireUploadName(req)
      const sizeBytes = requireContentLength(req)
      if (!req.body) throw new AppError('Validation', 'a request body is required')
      const file = await uploadFile(env.lib, ctx, params.id!, name, { stream: req.body, sizeBytes })
      return json(decorateFile(file))
    },
  },
  {
    method: 'PATCH',
    path: '/api/files/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const { name } = await parseJson(req, fileRenameSchema)
      return json(decorateFile(renameFile(env.lib, ctx, params.id!, name)))
    },
  },
  {
    method: 'DELETE',
    path: '/api/files/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      deleteFile(env.lib, ctx, params.id!)
      return noContent()
    },
  },
  {
    method: 'GET',
    path: '/api/files/:id/raw',
    auth: 'session',
    handler: async ({ params, env, ctx }) => {
      const resolved = resolveFilePath(env.lib, ctx, params.id!)
      return await streamFile(resolved.absPath, resolved.contentType, resolved.name)
    },
  },
  {
    method: 'GET',
    path: '/api/files/:id/thumb',
    auth: 'session',
    handler: async ({ params, env, ctx }) => {
      const preview = resolvePreviewPath(env.lib, ctx, params.id!)
      if (!preview) throw new AppError('NotFound', 'no preview is ready for this file')
      const response = await streamFile(preview.absPath, 'image/png', `${params.id}.png`)
      // The URL is stable while the preview is regenerated on content change, so keep it short.
      response.headers.set('cache-control', 'private, max-age=60')
      return response
    },
  },
]
