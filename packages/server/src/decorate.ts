import type {
  CoreFileDto,
  CoreProjectDetailDto,
  CoreProjectDto,
  FileDto,
  ProjectDetailDto,
  ProjectDto,
} from '@spm/contract/dtos.ts'

export function decorateFile(file: CoreFileDto): FileDto {
  return {
    ...file,
    rawUrl: `/api/files/${file.id}/raw`,
    ...(file.previewState === 'ready' ? { thumbUrl: `/api/files/${file.id}/thumb` } : {}),
  }
}

export function decorateProject(project: CoreProjectDto): ProjectDto {
  const { coverFileId, ...rest } = project
  return {
    ...rest,
    ...(coverFileId ? { coverThumbUrl: `/api/files/${coverFileId}/thumb` } : {}),
  }
}

export function decorateProjectDetail(detail: CoreProjectDetailDto): ProjectDetailDto {
  const { files, ...project } = detail
  return { ...decorateProject(project), files: files.map(decorateFile) }
}
