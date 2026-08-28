import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileDto, ProjectDetailDto } from '@spm/contract/dtos.ts'
import { AppError, isAppErrorCode } from '@spm/contract/errors.ts'
import { API_PATH_PREFIX, UPLOAD_LENGTH_HEADER } from '../protocol.ts'
import { RENDERER_ORIGIN } from '../urls.ts'

/**
 * The four things the slicer subsystem asks a remote library for, and nothing else.
 *
 * **All of it goes through `RemoteHost.proxy`, which is that class's only public entry point**
 * (spec 7.1). The proxy already holds the session cookie, already refuses redirects and already
 * confines every request to `/api` on the one configured origin — so a second HTTP client here,
 * however small, would be a second copy of all four of those decisions with nothing keeping them
 * in step. What this module adds on top is only: the URL shapes, the two headers an upload needs,
 * and turning the server's error envelope back into an `AppError` (constraint 5).
 *
 * **The bytes never round-trip through the window.** A download is streamed from the proxy
 * straight into the launch directory, and an upload is streamed from the launch directory
 * straight back — the renderer names a `fileId` and a `projectId` and never sees either.
 *
 * Nothing here imports `electron`, and the proxy arrives as `RemoteProxy` rather than as a
 * `RemoteHost`, so every path runs under plain `node --test` against a recorder.
 */

/**
 * The one public entry point of `RemoteHost`, and all of it this subsystem uses.
 *
 * Structural rather than the class, for the same reason `SpawnedSlicer` is: a seam a real value
 * cannot be assigned to is a seam that only ever sees doubles. A real `RemoteHost` satisfies this
 * unchanged.
 */
export type RemoteProxy = { proxy(request: Request): Promise<Response> }

/**
 * A request on the **renderer's** origin, which is what `proxy` takes.
 *
 * It is not the remote origin and must not be: `proxy` reads the pathname off this URL, checks it
 * against `API_PATH_PREFIX` and appends it to whichever origin the shell is configured for. The
 * renderer origin is simply the one spelling of "a request this app made" that the proxy already
 * accepts, and the origin the *renderer's* own `HttpApiClient` produces for the same call.
 */
export function apiRequest(path: string, init?: RequestInit): Request {
  return new Request(`${RENDERER_ORIGIN}${API_PATH_PREFIX}${path}`, init)
}

/** The shell has no server. Not a failure of the request — there was never one to make. */
export function requireRemote(remote: RemoteProxy | null): RemoteProxy {
  if (remote === null) {
    throw new AppError('Conflict', 'this app is not connected to a server')
  }
  return remote
}

/**
 * The project as the server sees it, which is also the ownership check.
 *
 * Remote mode has no local index to resolve a `fileId` against, and parent §4.3 exposes no
 * `GET /api/files/:id` — so this is where a launch learns the file's name, kind and slicer, and
 * where a `(fileId, projectId)` pair the renderer made up is refused. A project the user does not
 * own answers 404 and arrives here as `NotFound`, exactly as core's own scoping would in local
 * mode.
 */
export async function remoteProject(
  remote: RemoteProxy,
  projectId: string,
): Promise<ProjectDetailDto> {
  const response = await remote.proxy(apiRequest(`/projects/${encodeURIComponent(projectId)}`))
  if (!response.ok) throw await failureOf(response, 'could not read that project')
  return (await response.json()) as ProjectDetailDto
}

/**
 * Streams `/api/files/<id>/raw` into `destination`.
 *
 * Streamed rather than buffered because a model part in the reference library reaches 674 MB, and
 * the main process holding one of those in memory to write it out again is a cost with nothing
 * behind it. `pipeline` is what closes the file handle on a mid-stream failure; the caller removes
 * the partial file, because only the caller knows whether the directory it is in should survive.
 */
export async function remoteDownload(
  remote: RemoteProxy,
  fileId: string,
  destination: string,
): Promise<void> {
  const response = await remote.proxy(apiRequest(`/files/${encodeURIComponent(fileId)}/raw`))
  if (!response.ok) throw await failureOf(response, 'could not download that file')
  if (response.body === null) {
    throw new AppError('Internal', 'the server answered that file with no body')
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination),
  )
}

/**
 * Uploads a file from the launch directory to a project on the server, as a new file.
 *
 * **`UPLOAD_LENGTH_HEADER` is not optional here, and leaving it off is a live 411.** The server
 * needs the size before it writes a byte, for the quota check (spec 5.6), and refuses a body with
 * no length outright. A body this process streams reaches undici as `Transfer-Encoding: chunked`
 * unless something declares a length, and `RemoteHost.#send` is what turns this header into the
 * real `content-length` — a plain `content-length` set here would not survive, because it is a
 * forbidden header name on a `Request` and is dropped before the proxy ever sees it.
 *
 * The name travels percent-encoded in `x-spm-file-name`, which is what the server's
 * `requireUploadName` decodes: a header value is Latin-1 by the HTTP grammar and a file name is
 * not, so anything outside ASCII would otherwise arrive mangled or be refused by undici.
 */
export async function remoteUpload(
  remote: RemoteProxy,
  projectId: string,
  name: string,
  body: ReadableStream<Uint8Array>,
  sizeBytes: number,
  contentType: string,
): Promise<FileDto> {
  const request = apiRequest(`/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-spm-file-name': encodeURIComponent(name),
      [UPLOAD_LENGTH_HEADER]: String(sizeBytes),
    },
    body,
    // Required by undici for a streaming request body, and inert everywhere else.
    duplex: 'half',
  } as RequestInit)
  const response = await remote.proxy(request)
  if (!response.ok) throw await failureOf(response, `could not upload ${name}`)
  return (await response.json()) as FileDto
}

/**
 * The server's error envelope, turned back into an `AppError` with its own code (constraint 5).
 *
 * The code is checked against the union rather than cast into it. It comes off the wire from
 * another machine, and an `AppError` carrying a code nothing switches on would be worse than an
 * honest `Internal`: every UI that branches on a code would silently take its default arm.
 */
export async function failureOf(response: Response, fallback: string): Promise<AppError> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Not the envelope — a gateway page, an empty body. Handled below.
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = isAppErrorCode(error?.code) ? error.code : 'Internal'
  const message = typeof error?.message === 'string' ? error.message : fallback
  return new AppError(code, message)
}
