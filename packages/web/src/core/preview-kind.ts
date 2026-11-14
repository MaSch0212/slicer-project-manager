import type { FileDto } from '../api/generated'
import { judgeFile } from '../viewer/model-kind'
import { extensionOfName, fileGroupKind, TEXT_EXTENSIONS } from './grouping'

/**
 * How the preview popup shows a file: a 3D model on its stage, a picture, text (highlighted where
 * the kind has a grammar), the tree of an archive, or nothing but its actions.
 */
export type PreviewKind = 'model' | 'image' | 'text' | 'archive' | 'none'

export function previewKindOf(file: Pick<FileDto, 'name' | 'kind'>): PreviewKind {
  if (judgeFile(file).status === 'viewable') return 'model'
  // A slicer project or a model that the 3D viewer turns away is not text, whatever it is named.
  if (file.kind !== 'other') return 'none'
  return entryKindOf(file.name)
}

/** The same decision for a file inside an archive, by its name alone. */
export function entryKindOf(name: string): Exclude<PreviewKind, 'model'> {
  const extension = extensionOfName(name)
  if (extension === 'zip') return 'archive'
  if (fileGroupKind({ name, kind: 'other' }) === 'image') return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'none'
}

/** The MIME type a picture is served as from an archive's bytes. */
export function imageMime(name: string): string {
  const extension = extensionOfName(name)
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    default:
      return `image/${extension}`
  }
}
