import { createSignal } from 'solid-js'
import type { FileDto, ProjectDetailDto, ProjectPatch } from '../api/generated'
import { api, type ApiClient } from './api/client'
import { isApiError } from './api/error'
import { t } from './i18n'
import { errorMessage } from './i18n/errors'

/** Tag names are 1 to 60 characters once trimmed (the server's rule, repeated here for UX). */
export const TAG_MAX_LENGTH = 60
export const FILE_NAME_MAX_LENGTH = 255

/** The tags to add and remove to turn `current` into `next`, compared case-insensitively. */
export function diffTags(
  current: readonly string[],
  next: readonly string[],
): { add: string[]; remove: string[] } {
  const lower = (name: string) => name.toLowerCase()
  const have = new Set(current.map(lower))
  const want = new Set(next.map(lower))
  return {
    add: next.filter((name) => !have.has(lower(name))),
    remove: current.filter((name) => !want.has(lower(name))),
  }
}

/** The kind a file is shown as, in the words of the badge. */
export function fileKindKey(
  kind: FileDto['kind'],
): 'projects.kindModel' | 'projects.kindSlicerProject' | 'projects.kindOther' {
  if (kind === 'model') return 'projects.kindModel'
  if (kind === 'slicer_project') return 'projects.kindSlicerProject'
  return 'projects.kindOther'
}

/**
 * Whether a preview is still expected for this file. The server reports `pending` for a file that
 * has no preview record at all, which is every file of kind `other` (a text file, a PDF): the queue
 * never picks those up, so for them `pending` means "never", not "soon".
 */
export function isPreviewPending(file: Pick<FileDto, 'previewState' | 'kind'>): boolean {
  return file.previewState === 'pending' && file.kind !== 'other'
}

/**
 * What a file's thumbnail slot shows when there is no picture: the preview's state, in words.
 * `ready` with a missing `thumbUrl` is treated as pending (the URL arrives with the next load).
 */
export function previewStateKey(
  file: Pick<FileDto, 'previewState' | 'kind'>,
  folderMissing = false,
): 'projects.previewPending' | 'projects.previewFailed' | 'projects.previewUnsupported' {
  if (file.previewState === 'failed') return 'projects.previewFailed'
  if (file.previewState === 'unsupported' || file.kind === 'other' || folderMissing) {
    return 'projects.previewUnsupported'
  }
  return 'projects.previewPending'
}

export type ProjectDetailDeps = { client: Pick<ApiClient, 'projects' | 'files'> }

/**
 * One project's detail page as state: the loaded project, whether it is loading or failed, and the
 * mutations (tags, edit, files, delete) that each report one error message and then reload.
 *
 * `id` is read on every call, so the page can follow the route. A load that answers after the route
 * has moved on is discarded. Plain signals, no reactive owner needed.
 */
export function createProjectDetail(id: () => string, deps: Partial<ProjectDetailDeps> = {}) {
  const client = deps.client ?? api
  const [detail, setDetail] = createSignal<ProjectDetailDto | undefined>(undefined)
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  let generation = 0

  async function load(): Promise<void> {
    const mine = ++generation
    const projectId = id()
    setLoading(true)
    try {
      const loaded = await client.projects.get(projectId)
      if (mine !== generation) return
      setDetail(loaded)
      setLoadError(null)
    } catch (error) {
      if (mine !== generation) return
      // Keep what is on screen on a failed *refresh*; only a first load has nothing to keep.
      if (detail()?.id !== projectId) setDetail(undefined)
      setLoadError(
        isApiError(error) && error.code === 'NotFound' ? t('errors.notFound') : errorMessage(error),
      )
    } finally {
      if (mine === generation) setLoading(false)
    }
  }

  /** Switching to another project clears what belonged to the last one. */
  function reset(): void {
    setDetail(undefined)
    setLoadError(null)
    setActionError(null)
  }

  /**
   * Runs one mutation: clears the old error, awaits it, reloads on success, reports on failure.
   * Returns whether it worked. `describe` lets an operation say more than the generic sentence.
   */
  async function mutate(
    action: () => Promise<unknown>,
    describe: (error: unknown) => string = errorMessage,
  ): Promise<boolean> {
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(describe(error))
      return false
    }
    await load()
    return true
  }

  const tagError = (error: unknown) =>
    isApiError(error) && error.code === 'Validation' ? t('errors.invalidTag') : errorMessage(error)
  const fileNameError = (error: unknown) =>
    isApiError(error) && error.code === 'Validation'
      ? t('errors.invalidFileName')
      : errorMessage(error)

  return {
    detail,
    loading,
    loadError,
    actionError,
    clearActionError: () => setActionError(null),
    load,
    reset,
    mutate,
    reportError: (message: string) => setActionError(message),

    /** Applies a tag list the user edited: one add or remove call per difference, in order. */
    setTags(next: readonly string[]): Promise<boolean> {
      const { add, remove } = diffTags(detail()?.tags ?? [], next)
      return mutate(async () => {
        for (const name of add) await client.projects.addTag(id(), name)
        for (const name of remove) await client.projects.removeTag(id(), name)
      }, tagError)
    },

    update: (patch: ProjectPatch) => mutate(() => client.projects.update(id(), patch)),
    /** Like `update`, but a rejection reaches the caller (a dialog shows it beside its fields). */
    async updateStrict(patch: ProjectPatch): Promise<void> {
      setActionError(null)
      await client.projects.update(id(), patch)
      await load()
    },
    renameFile: (file: Pick<FileDto, 'id'>, name: string) =>
      mutate(() => client.files.rename(file.id, name), fileNameError),
    deleteFile: (file: Pick<FileDto, 'id'>) => mutate(() => client.files.delete(file.id)),

    /** Deletes the project. Resolves true on success; the page then leaves for the list. */
    async deleteProject(deleteFiles: boolean): Promise<boolean> {
      setActionError(null)
      try {
        await client.projects.delete(id(), { deleteFiles })
        return true
      } catch (error) {
        setActionError(errorMessage(error))
        return false
      }
    },
  }
}

export type ProjectDetail = ReturnType<typeof createProjectDetail>

/**
 * The website as something safe to put in an `href`: the address when it is http or https, nothing
 * otherwise. The server accepts any absolute URL (`javascript:` parses), so the page must not link
 * to one: it shows such a value as plain text instead.
 */
export function webLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}
