import type {
  CoreFileDto,
  CoreProjectDetailDto,
  CoreProjectDto,
  FileDto,
  ProjectDetailDto,
  ProjectDto,
} from './dtos.ts'

/**
 * Core returns ids, never URLs (spec 4.2, and the comment on `CoreFileDto`). Turning those ids
 * into URLs is the one piece of DTO shaping that depends on the transport, so it is a factory
 * over the base rather than a constant: the Deno server serves file bytes from `/api/...` and
 * the Electron shell from its own `spm://` scheme, and both must produce the same DTO shape or
 * the same Angular components break in one of them.
 *
 * `base` is everything before `/files/<id>/...`. The server passes `/api`; the desktop passes
 * the value of `FILE_URL_BASE` in `packages/desktop/src/urls.ts`.
 *
 * This lived in `packages/server/src/decorate.ts` until the Electron shell needed it. The
 * server's own module still exists and still exports the same three names, bound to `/api`, so
 * nothing about the server's output moved — `packages/server/test/files.test.ts` asserts the
 * exact `/api/files/<id>/raw` and `/api/files/<id>/thumb` strings over real HTTP, and
 * `packages/contract/test/decorate.test.ts` pins the serialised bytes for both bases.
 */
export type Decorators = {
  decorateFile(file: CoreFileDto): FileDto
  decorateProject(project: CoreProjectDto): ProjectDto
  decorateProjectDetail(detail: CoreProjectDetailDto): ProjectDetailDto
}

export function createDecorators(base: string): Decorators {
  function decorateFile(file: CoreFileDto): FileDto {
    return {
      ...file,
      rawUrl: `${base}/files/${file.id}/raw`,
      ...(file.previewState === 'ready' ? { thumbUrl: `${base}/files/${file.id}/thumb` } : {}),
    }
  }

  function decorateProject(project: CoreProjectDto): ProjectDto {
    const { coverFileId, ...rest } = project
    return {
      ...rest,
      ...(coverFileId ? { coverThumbUrl: `${base}/files/${coverFileId}/thumb` } : {}),
    }
  }

  function decorateProjectDetail(detail: CoreProjectDetailDto): ProjectDetailDto {
    const { files, ...project } = detail
    return { ...decorateProject(project), files: files.map(decorateFile) }
  }

  return { decorateFile, decorateProject, decorateProjectDetail }
}
