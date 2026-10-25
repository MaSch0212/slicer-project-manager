import { describe, expect, it, vi } from 'vitest'
import type { FileDto, ProjectDetailDto } from '../api/generated'
import { ApiError } from './api/error'
import {
  createProjectDetail,
  diffTags,
  fileKindKey,
  isPreviewPending,
  previewStateKey,
  webLink,
} from './project-detail'

// Ported from legacy features/projects/project-detail.page.spec.ts: the load, the error branches,
// the tag, edit, rename and delete mutations. The Angular spec drove a component; the behaviour
// lives in `createProjectDetail`, so the same cases run against it directly. What stayed in the
// page (the dialogs, the archive button) is covered by pages/project-detail.test.tsx.

function detail(over: Partial<ProjectDetailDto> = {}): ProjectDetailDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: ['boats'],
    fileCounts: { model: 1, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    files: [],
    ...over,
  }
}

function setup(id = 'p1') {
  const client = {
    projects: {
      get: vi.fn().mockResolvedValue(detail()),
      addTag: vi.fn().mockResolvedValue(undefined),
      removeTag: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }
  const state = createProjectDetail(() => id, { client: client as never })
  return { state, client }
}

describe('createProjectDetail: loading', () => {
  it('loads the project named by the route', async () => {
    const { state, client } = setup('abc')
    await state.load()
    expect(client.projects.get).toHaveBeenCalledWith('abc')
    expect(state.detail()?.name).toBe('Benchy')
    expect(state.loading()).toBe(false)
    expect(state.loadError()).toBeNull()
  })

  it('reports a failed load instead of throwing, and says a missing project is missing', async () => {
    const { state, client } = setup()
    client.projects.get.mockRejectedValueOnce(new ApiError('NotFound', 'gone', { status: 404 }))
    await state.load()
    expect(state.detail()).toBeUndefined()
    expect(state.loadError()).toBe('This project does not exist any more')

    client.projects.get.mockRejectedValueOnce(new ApiError('Internal', 'boom'))
    await state.load()
    expect(state.loadError()).toBe('Something went wrong')
  })

  it('keeps what is on screen when a refresh fails', async () => {
    const { state, client } = setup()
    await state.load()
    client.projects.get.mockRejectedValueOnce(new ApiError('Internal', 'blip'))
    await state.load()
    expect(state.detail()?.name).toBe('Benchy')
    expect(state.loadError()).toBe('Something went wrong')
  })

  it('drops an answer that arrives after the route moved on', async () => {
    let id = 'a'
    const slow: { resolve: (value: ProjectDetailDto) => void } = { resolve: () => {} }
    const client = {
      projects: {
        get: vi
          .fn()
          .mockReturnValueOnce(new Promise((resolve) => (slow.resolve = resolve)))
          .mockResolvedValueOnce(detail({ id: 'b', name: 'Second' })),
      },
    }
    const state = createProjectDetail(() => id, { client: client as never })
    const first = state.load()
    id = 'b'
    await state.load()
    slow.resolve(detail({ id: 'a', name: 'First' }))
    await first
    expect(state.detail()?.name).toBe('Second')
  })
})

describe('createProjectDetail: tags', () => {
  it('adds and removes only the tags that differ, then reloads', async () => {
    const { state, client } = setup()
    await state.load()
    await expect(state.setTags(['boats', 'petg'])).resolves.toBe(true)
    expect(client.projects.addTag).toHaveBeenCalledWith('p1', 'petg')
    expect(client.projects.removeTag).not.toHaveBeenCalled()

    await state.setTags([])
    expect(client.projects.removeTag).toHaveBeenCalledWith('p1', 'boats')
    expect(client.projects.get).toHaveBeenCalledTimes(3)
  })

  it('compares tag names case-insensitively', () => {
    expect(diffTags(['Boats'], ['boats', 'PETG'])).toEqual({ add: ['PETG'], remove: [] })
    expect(diffTags(['a', 'b'], ['b'])).toEqual({ add: [], remove: ['a'] })
  })

  it('says why when the server rejects a tag, and does not reload', async () => {
    const { state, client } = setup()
    await state.load()
    client.projects.addTag.mockRejectedValueOnce(new ApiError('Validation', 'bad'))
    await expect(state.setTags(['boats', 'x'.repeat(61)])).resolves.toBe(false)
    expect(state.actionError()).toBe('A tag must be between 1 and 60 characters')
    expect(client.projects.get).toHaveBeenCalledTimes(1)
  })

  it('clears the previous error when the next action starts', async () => {
    const { state, client } = setup()
    await state.load()
    client.projects.addTag.mockRejectedValueOnce(new ApiError('Internal', 'x'))
    await state.setTags(['boats', 'a'])
    expect(state.actionError()).not.toBeNull()
    await state.setTags(['boats', 'b'])
    expect(state.actionError()).toBeNull()
  })
})

describe('createProjectDetail: edit, files, delete', () => {
  it('saves an edit through projects.update and reloads', async () => {
    const { state, client } = setup()
    await state.load()
    await state.update({ name: 'Renamed', website: null })
    expect(client.projects.update).toHaveBeenCalledWith('p1', { name: 'Renamed', website: null })
    expect(client.projects.get).toHaveBeenCalledTimes(2)
  })

  it('surfaces a rejected update, and lets the strict variant throw for a dialog', async () => {
    const { state, client } = setup()
    client.projects.update.mockRejectedValue(new ApiError('Internal', 'x'))
    await expect(state.update({ name: 'x' })).resolves.toBe(false)
    expect(state.actionError()).toBe('Something went wrong')
    await expect(state.updateStrict({ name: 'x' })).rejects.toBeInstanceOf(ApiError)
  })

  it('renames a file, and says what is wrong with a name the server refuses', async () => {
    const { state, client } = setup()
    await state.renameFile({ id: 'f1' }, 'new.stl')
    expect(client.files.rename).toHaveBeenCalledWith('f1', 'new.stl')
    client.files.rename.mockRejectedValueOnce(new ApiError('Validation', 'bad'))
    await state.renameFile({ id: 'f1' }, 'a/b')
    expect(state.actionError()).toBe('That file name is not allowed')
  })

  it('deletes a file and reloads, and surfaces a rejected delete', async () => {
    const { state, client } = setup()
    await state.deleteFile({ id: 'f1' })
    expect(client.files.delete).toHaveBeenCalledWith('f1')
    expect(client.projects.get).toHaveBeenCalledTimes(1)
    client.files.delete.mockRejectedValueOnce(new ApiError('Internal', 'x'))
    await expect(state.deleteFile({ id: 'f2' })).resolves.toBe(false)
    expect(state.actionError()).toBe('Something went wrong')
  })

  it('deletes the project with or without its files, and reports a failure', async () => {
    const { state, client } = setup()
    await expect(state.deleteProject(true)).resolves.toBe(true)
    expect(client.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: true })
    await state.deleteProject(false)
    expect(client.projects.delete).toHaveBeenLastCalledWith('p1', { deleteFiles: false })

    client.projects.delete.mockRejectedValueOnce(new ApiError('Internal', 'x'))
    await expect(state.deleteProject(false)).resolves.toBe(false)
    expect(state.actionError()).toBe('Something went wrong')
  })

  it('forgets one project when switching to another', async () => {
    const { state } = setup()
    await state.load()
    state.reset()
    expect(state.detail()).toBeUndefined()
    expect(state.actionError()).toBeNull()
  })
})

describe('what the page says about a file', () => {
  const file = (over: Partial<FileDto>): FileDto => ({
    id: 'f',
    name: 'a.stl',
    kind: 'model',
    sizeBytes: 1,
    previewState: 'pending',
    rawUrl: '/api/files/f/raw',
    ...over,
  })

  it('names the three kinds', () => {
    expect(fileKindKey('model')).toBe('projects.kindModel')
    expect(fileKindKey('slicer_project')).toBe('projects.kindSlicerProject')
    expect(fileKindKey('other')).toBe('projects.kindOther')
  })

  it('names each preview state that has no picture', () => {
    expect(previewStateKey(file({}))).toBe('projects.previewPending')
    expect(previewStateKey(file({ previewState: 'failed' }))).toBe('projects.previewFailed')
    expect(previewStateKey(file({ previewState: 'unsupported' }))).toBe(
      'projects.previewUnsupported',
    )
  })

  // The server reports `pending` for a file that has no preview record, which is every file of
  // kind `other`. The page must not wait for, or poll for, a preview that will never come.
  it('does not wait for a preview of a file the queue never picks up', () => {
    expect(isPreviewPending(file({ kind: 'other' }))).toBe(false)
    expect(previewStateKey(file({ kind: 'other' }))).toBe('projects.previewUnsupported')
    expect(isPreviewPending(file({ kind: 'model' }))).toBe(true)
    expect(isPreviewPending(file({ kind: 'model', previewState: 'ready' }))).toBe(false)
    expect(previewStateKey(file({}), true)).toBe('projects.previewUnsupported')
  })

  it('links a website only when it is http or https', () => {
    expect(webLink('https://example.com/a')).toBe('https://example.com/a')
    expect(webLink('http://example.com')).toBe('http://example.com')
    expect(webLink('javascript:alert(1)')).toBeUndefined()
    expect(webLink('not a url')).toBeUndefined()
    expect(webLink(undefined)).toBeUndefined()
  })
})
