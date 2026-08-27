import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'
import { resolveFilePath, resolvePreviewPath, type Ctx, type Library } from '@spm/core'
import { RESERVED_PATH_SEGMENT } from './urls.ts'

/**
 * File bytes over `spm://`, and nothing else.
 *
 * The reference implementation is `packages/server/src/routes/files.ts`: the same two core calls,
 * `resolveFilePath` and `resolvePreviewPath`, in the same order, streamed off disk with the same
 * headers. Where this diverges from the server it says so on the spot. It imports nothing from
 * `electron`, so `test/files.test.ts` runs it under plain `node --test`.
 */

/** The middle segment of `<base>/files/<id>/{raw,thumb}`, as `createDecorators` spells it. */
const FILES_SEGMENT = 'files'

export type FileRequest = { id: string; kind: 'raw' | 'thumb' }

/**
 * Whether a `spm://app` pathname names file bytes, and which ones.
 *
 * Exact segment matching on the **undecoded** path, deliberately. `resolveRendererFile` has to
 * chase every alias of the reserved prefix that a filesystem might resolve back onto it —
 * `_SPM`, `_spm.`, `_spm%00`, `x/..%2f_spm` — because it is deciding whether to *open* something
 * under that name. This is the opposite question: it decides whether to hand the path to a
 * database lookup, so anything that is not the one canonical spelling can simply be left to fall
 * through to `resolveRendererFile`, which already refuses every one of those aliases with a 404.
 * `shell.spec.ts` pins that list, and it still passes unchanged with this parser in front of it.
 *
 * The split is on the raw pathname and only the id is decoded afterwards, so a `%2f` inside a
 * segment cannot invent structure: `/_spm%2ffiles/abc/raw` is four segments, not five, and is
 * not a file request at all.
 *
 * Nothing here validates the id's *shape*. It does not need to — the id is a SQL bind parameter
 * in `requireOwnedFile`, so a value that is not a real id selects no row and comes back
 * `NotFound`. See `serveLibraryFile` for what containment actually rests on.
 *
 * Nothing here looks at the request *method* either, and that is a divergence from the server's
 * router, which answers these two paths for GET alone. It is deliberate: `createSpmHandler` has
 * never read the method — a POST to `spm://app/main.js` returns the script today — and neither
 * of these routes writes anything, so a check on one branch of a method-agnostic handler would
 * be inconsistency rather than defence. Measured: every consumer sends GET (see `app.ts`).
 */
export function parseFileRequest(pathname: string): FileRequest | null {
  const segments = pathname.split('/')
  if (segments.length !== 5) return null
  const [leading, reserved, files, encodedId, kind] = segments
  if (leading !== '' || reserved !== RESERVED_PATH_SEGMENT || files !== FILES_SEGMENT) return null
  if (kind !== 'raw' && kind !== 'thumb') return null
  let id: string
  try {
    id = decodeURIComponent(encodedId!)
  } catch {
    // `%zz` is not an escape; an unhandled URIError here would reject the handler's promise and
    // reach the renderer as a bare `TypeError: Failed to fetch`. Same rule as the renderer half.
    return null
  }
  if (id === '' || id.includes('\0')) return null
  return { id, kind }
}

/**
 * Status codes, for the two codes these routes can actually raise.
 *
 * `NotFound` comes from `requireOwnedFile` (no such file, or one owned by someone else), from a
 * preview that is not `ready`, and from bytes that vanished between the row and the open.
 * `Forbidden` comes from core's `safeJoin`. Anything else reaching here is a bug in the main
 * process, and 500 is the honest answer to it. The server's `STATUS_BY_CODE` covers all thirteen
 * codes because its routes can raise all thirteen; copying the whole table here would claim a
 * breadth these two routes do not have.
 */
const STATUS_BY_CODE: Partial<Record<AppErrorCode, number>> = { NotFound: 404, Forbidden: 403 }

const BODY_BY_STATUS: Record<number, string> = {
  403: 'forbidden',
  404: 'not found',
  500: 'internal error',
}

/**
 * A failure, as plain text rather than as the server's JSON error envelope.
 *
 * The divergence is deliberate and it is narrow. Nothing reads a body from these two routes: an
 * `<img>` discards it, and `viewer.page.ts`'s `fetchModel` branches on `response.status` alone
 * (404/410 -> "not part of this project any more", any other non-2xx -> a retryable transport
 * message). The alternative is two body shapes inside one `spm://` handler, since every refusal
 * on the renderer-asset side of it is already `not found` in plain text.
 */
function errorResponse(lib: Library, error: unknown): Response {
  const status = (error instanceof AppError ? STATUS_BY_CODE[error.code] : undefined) ?? 500
  if (status === 500) {
    // A non-AppError here is a bug and the stack is the only thing that makes it findable. It
    // goes to the library's own logger, the same place the server puts it — the renderer gets
    // three words.
    lib.log.error('spm: unhandled error serving file bytes', {
      err: error,
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  return new Response(BODY_BY_STATUS[status]!, { status })
}

/**
 * Streams a file off disk, exactly as the server's `streamFile` does.
 *
 * Opened before the `Response` is built, and that ordering is the point: a `createReadStream`
 * over a path that is not there fails *after* the handler has already returned 200, which the
 * renderer sees as a truncated body rather than as a 404. A file row can outlive its bytes —
 * rescan marks a file `missing` without deleting the row, and the bytes can vanish between the
 * database read and this open — so ENOENT is a `NotFound`, not a 500 (the server's Ruling 34).
 *
 * `autoClose: true` is spelled out, and it is **already the default** — this comment first said
 * the opposite and the probe said otherwise. Measured on Node v24.19.0: with no options at all,
 * with `{ autoClose: true }`, and after cancelling the web stream mid-read, a later `stat()` on
 * the `FileHandle` throws `EBADF` in all three cases, so the handle is closed on completion and
 * on cancellation alike. It stays written out because this is the line that decides whether a
 * thumbnail in a long list leaks a descriptor, and a reader should not have to look that up.
 */
async function streamFile(
  absPath: string,
  contentType: string,
  fileName: string,
): Promise<Response> {
  let handle: FileHandle
  try {
    handle = await open(absPath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('NotFound', 'file is missing on disk')
    }
    throw error
  }
  try {
    const { size } = await handle.stat()
    // Past this point the stream owns the handle and closes it — on completion, and on the
    // cancel that `Readable.toWeb` forwards when the renderer aborts a fetch mid-model.
    const body = Readable.toWeb(
      handle.createReadStream({ autoClose: true }),
    ) as ReadableStream<Uint8Array>
    return new Response(body, {
      headers: {
        'content-type': contentType,
        'content-length': String(size),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        // Ranges are not served. See the note in `app.ts` for what was measured to ask for one.
        'accept-ranges': 'none',
        // These bytes are the user's own files, served *into the app's own origin* — the same
        // origin that holds `window.spm`. If Chromium ever sniffed one into HTML, that document
        // would execute with the IPC bridge and, because the CSP is attached on the
        // renderer-asset branch alone, with no policy at all.
        //
        // Measured on Electron 44.0.0 before this header existed, with real payload files in a
        // fixture library and a top-level navigation to each `rawUrl`: `.html`, `.svg` and
        // `.xhtml` all take core's `application/octet-stream` fallback and Chromium **downloads**
        // them (`will-download` fires with that mime type) rather than sniffing. No script ran.
        // The one file type that does render is `.txt` — `text/plain`, shown as escaped text with
        // the markup visible, so still no execution — and it confirmed the hazard is real:
        // `typeof window.spm` on that document is `'object'`.
        //
        // So this header changes nothing observable today, and that is the point of it. What is
        // holding the line today is core's ten-entry content-type map happening to contain
        // nothing renderable; `files.test.ts` pins that separately, because one entry added there
        // is the whole difference.
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * The bytes for one `spm://app/_spm/files/<id>/{raw,thumb}` request.
 *
 * **What contains this to the library, precisely.** Not this module. The id is a bind parameter,
 * so only a row that exists and is owned by `ctx.userId` yields anything at all; the path is then
 * assembled by core from that row's `dir_name` and `rel_path` through `safeJoin`, which refuses
 * an absolute segment, a `..` segment and any result outside the library root. This function adds
 * exactly one thing on top: it never builds a path from the URL. The escape a URL could attempt
 * therefore does not reach a path join — it reaches `WHERE f.id = ?` and selects nothing.
 *
 * What that leaves uncovered, stated rather than implied: `resolvePreviewPath` joins the
 * `previews.png_path` column under `lib.dir` with a plain `join`, **not** `safeJoin`, so a row
 * whose `png_path` is `../x.png` names a file outside the library — measured, by writing that
 * exact row into a real library and calling the function: it returned an `absPath` one directory
 * above `lib.dir`. The Deno server shares the function and so shares this. Nothing writes that
 * column but `previews/queue.ts`, from an id it generated, and reaching it needs write access to
 * the library database — at which point the attacker already has the library. Left alone rather
 * than patched here, because the fix belongs in core where both shells would get it, and because
 * a guard in one shell would make the two disagree about the same row. **Ruling C-13 assigns it
 * to task 4** — the task that makes previews real, and so the first task in which shipping code
 * writes that column at all.
 */
export async function serveLibraryFile(
  lib: Library,
  ctx: Ctx,
  request: FileRequest,
): Promise<Response> {
  try {
    if (request.kind === 'thumb') {
      const preview = resolvePreviewPath(lib, ctx, request.id)
      if (!preview) throw new AppError('NotFound', 'no preview is ready for this file')
      const response = await streamFile(preview.absPath, 'image/png', `${request.id}.png`)
      // The URL is stable while the preview is regenerated on content change, so keep it short.
      response.headers.set('cache-control', 'private, max-age=60')
      return response
    }
    const resolved = resolveFilePath(lib, ctx, request.id)
    return await streamFile(resolved.absPath, resolved.contentType, resolved.name)
  } catch (error) {
    return errorResponse(lib, error)
  }
}
