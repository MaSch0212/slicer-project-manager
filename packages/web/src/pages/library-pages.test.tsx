import { createMemoryHistory, MemoryRouter, Route, useNavigate, useParams } from '@solidjs/router'
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type FileDto,
  type ProjectDetailDto,
  type ProjectDto,
} from '../api/generated'
import { ApiError } from '../core/api/error'

// Ported from the former Angular projects.page.spec.ts and project-detail.page.spec.ts, import.page.spec.ts:
// what the user sees and can do. The store and mutation logic have their own specs
// (core/projects-store.test.ts, core/project-detail.test.ts); these drive the real pages and stores
// over a fake API.

const api = vi.hoisted(() => ({
  projects: {
    list: vi.fn(),
    tags: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    rescan: vi.fn(),
  },
  files: {
    uploadWithProgress: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
  },
  importer: { curaManagerZip: vi.fn() },
  settings: { get: vi.fn(), put: vi.fn() },
}))
vi.mock('../core/api/client', () => ({ api }))

import ImportPage from './import'
import { ProjectDetail } from './project-detail'
import ProjectsPage from './projects'
import { settings } from '../core/stores'

/**
 * The detail on its own, keyed on `:id`, wired the way the projects page wires it: the close goes
 * back to the list and the preview is part of the address.
 */
function RoutedDetail() {
  const params = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  return (
    <ProjectDetail
      id={params.id}
      onClose={() => navigate('/projects')}
      previewFileId={params.fileId ?? null}
      onPreview={(fileId) =>
        navigate(fileId ? `/projects/${params.id}/view/${fileId}` : `/projects/${params.id}`)
      }
    />
  )
}

const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: 'p1',
  name: 'Benchy',
  isArchived: false,
  state: 'ok',
  tags: ['boats'],
  fileCounts: { model: 2, slicerProject: 0, other: 1 },
  createdAt: 0,
  updatedAt: 0,
  coverThumbUrl: '/api/files/f1/thumb',
  ...over,
})

const file = (over: Partial<FileDto> = {}): FileDto => ({
  id: 'f1',
  name: 'benchy.stl',
  kind: 'model',
  sizeBytes: 2048,
  previewState: 'ready',
  rawUrl: '/api/files/f1/raw',
  thumbUrl: '/api/files/f1/thumb',
  ...over,
})

const detail = (over: Partial<ProjectDetailDto> = {}): ProjectDetailDto => ({
  ...project(),
  files: [file()],
  ...over,
})

function renderAt(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/projects" component={ProjectsPage} />
      <Route path={['/projects/:id', '/projects/:id/view/:fileId']} component={RoutedDetail} />
      <Route path="/import" component={ImportPage} />
    </MemoryRouter>
  ))
}

/** The app's own routing: one route for the list and the list-with-one-open. */
function renderLibrary(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  render(() => (
    <MemoryRouter history={history}>
      <Route path={['/projects', '/projects/:id']} component={ProjectsPage} />
    </MemoryRouter>
  ))
  return history
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  api.projects.list.mockResolvedValue([project()])
  api.projects.tags.mockResolvedValue(['boats', 'gadgets'])
  api.projects.get.mockResolvedValue(detail())
  api.projects.create.mockResolvedValue(project({ id: 'new', name: 'Made' }))
  api.projects.update.mockResolvedValue(project())
  api.projects.delete.mockResolvedValue(undefined)
  api.projects.addTag.mockResolvedValue(undefined)
  api.projects.removeTag.mockResolvedValue(undefined)
  api.files.rename.mockResolvedValue(file())
  api.files.delete.mockResolvedValue(undefined)
  api.files.uploadWithProgress.mockResolvedValue(file())
  api.settings.put.mockImplementation((patch: object) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  )
  // Each test starts from the defaults, whatever the last one remembered.
  settings.reset()
})

describe('ProjectsPage', () => {
  it('lists projects as cards that link to the project, with tags and a file count', async () => {
    renderAt('/projects')
    const link = await screen.findByRole('link', { name: 'Benchy' })
    expect(link.getAttribute('href')).toBe('/projects/p1')
    expect(screen.getByText('3 files')).toBeTruthy()
    expect(screen.getByText('boats')).toBeTruthy()
    expect(document.querySelector('img')!.getAttribute('src')).toBe('/api/files/f1/thumb')
  })

  it('says a project is archived or has lost its folder', async () => {
    api.projects.list.mockResolvedValue([project({ isArchived: true, state: 'missing' })])
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.getByText('Folder missing')).toBeTruthy()
  })

  it('shows a few tags and counts the rest', async () => {
    api.projects.list.mockResolvedValue([project({ tags: ['a', 'b', 'c', 'd', 'e'] })])
    renderAt('/projects')
    await screen.findByText('c')
    expect(screen.queryByText('d')).toBeNull()
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('has a search box with no visible label, an accessible name and a cap', async () => {
    renderAt('/projects')
    const search = (await screen.findByRole('searchbox', { name: 'Search' })) as HTMLInputElement
    expect(search.placeholder).toBe('Search')
    expect(search.maxLength).toBe(200)
    expect(document.querySelector('label[for="' + search.id + '"]')).toBeNull()
  })

  it('searches after typing stops, not on every keystroke', async () => {
    renderAt('/projects')
    const search = await screen.findByRole('searchbox')
    await waitFor(() => expect(api.projects.list).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    fireEvent.input(search, { target: { value: 'ben' } })
    fireEvent.input(search, { target: { value: 'benchy' } })
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    vi.useRealTimers()
    await waitFor(() =>
      expect(api.projects.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'benchy' }),
      ),
    )
    expect(api.projects.list).toHaveBeenCalledTimes(2)
  })

  it('sorts from the toolbar menu, picking the direction the field reads in, and remembers it', async () => {
    renderAt('/projects')
    const sort = await screen.findByRole('button', { name: 'Sort: Last changed, Descending' })
    fireEvent.keyDown(sort, { key: 'Enter' })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'Name' }), {
      pointerType: 'mouse',
    })
    await waitFor(() =>
      expect(api.projects.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'name', dir: 'asc' }),
      ),
    )
    expect(api.settings.put).toHaveBeenCalledWith({ sort: 'name', dir: 'asc' })
    await screen.findByRole('button', { name: 'Sort: Name, Ascending' })
  })

  it('shows archived projects from the filter panel, counts it, and remembers it', async () => {
    renderAt('/projects')
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }))
    const archived = await screen.findByRole('switch', { name: 'Show archived' })
    expect((archived as HTMLInputElement).checked).toBe(false)
    fireEvent.click(archived)
    await waitFor(() =>
      expect(api.projects.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeArchived: true }),
      ),
    )
    expect(api.settings.put).toHaveBeenCalledWith({ includeArchived: true })
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeTruthy()
  })

  it('switches between grid and list and remembers the view', async () => {
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    expect((screen.getByRole('radio', { name: 'Grid' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'List' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenCalledWith({ viewMode: 'list' }))
    expect((screen.getByRole('radio', { name: 'List' }) as HTMLInputElement).checked).toBe(true)
  })

  it('narrows by tag from the filter panel, with a pill for each that can take it off again', async () => {
    api.projects.list.mockResolvedValue([project()])
    api.projects.tags.mockResolvedValue(['boats', 'gadgets'])
    settings.reset()
    renderAt('/projects')
    const funnel = await screen.findByRole('button', { name: 'Filters' })
    // No count while nothing narrows the list.
    expect(funnel.textContent).toBe('')

    fireEvent.click(funnel)
    const tags = await screen.findByRole('group', { name: 'Tags' })
    fireEvent.click(within(tags).getByRole('checkbox', { name: 'gadgets' }))
    await waitFor(() =>
      expect(api.projects.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ tags: ['gadgets'] }),
      ),
    )
    expect(
      within(tags).getByRole('checkbox', { name: 'gadgets' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByRole('button', { name: 'Filters, 1 active' }).textContent).toBe('1')

    // With no saved view in play the filters are spelled out under the toolbar.
    const pills = screen.getByRole('group', { name: 'Active filters' })
    fireEvent.click(within(pills).getByRole('button', { name: 'Remove gadgets' }))
    await waitFor(() => expect(api.settings.put).toHaveBeenLastCalledWith({ filterTags: [] }))
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull()
  })

  it('starts from the filter the user left, and says so in the request', async () => {
    api.settings.get.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      includeArchived: true,
      filterTags: ['boats'],
    })
    await settings.load()
    renderAt('/projects')
    await waitFor(() =>
      expect(api.projects.list).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: true, tags: ['boats'] }),
      ),
    )
    // One tag and the archive switch.
    expect((await screen.findByRole('button', { name: 'Filters, 2 active' })).textContent).toBe('2')
  })

  it('shows a skeleton while loading, and an empty state with a way forward', async () => {
    api.projects.list.mockResolvedValue([])
    renderAt('/projects')
    expect(screen.getByLabelText('Loading')).toBeTruthy()
    await screen.findByText('No projects yet')
    expect(screen.getAllByRole('button', { name: 'New project' }).length).toBeGreaterThan(0)
  })

  it('tells a filter that matches nothing from a library that is empty', async () => {
    api.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, filterTags: ['gone'] })
    await settings.load()
    api.projects.list.mockResolvedValue([])
    renderAt('/projects')
    await screen.findByText('No projects match your filter')
    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  it('says when the list cannot be loaded, and retries', async () => {
    api.projects.list.mockRejectedValueOnce(new ApiError('Internal', 'x'))
    renderAt('/projects')
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: 'Benchy' })
  })

  it('offers "Load more" while more rows exist, with no disabled state and a status for readers', async () => {
    const page = (prefix: string) =>
      Array.from({ length: 48 }, (_, i) => project({ id: `${prefix}${i}`, name: `${prefix} ${i}` }))
    api.projects.list
      .mockResolvedValueOnce(page('a'))
      .mockResolvedValueOnce([project({ id: 'z', name: 'Last' })])
    renderAt('/projects')
    const more = await screen.findByRole('button', { name: 'Load more' })
    expect((more as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(more)
    await screen.findByRole('link', { name: 'Last' })
    expect(api.projects.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 48, limit: 48 }),
    )
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Showing 49 projects')
  })

  it('keeps "Load more" and says so when a page fails', async () => {
    const page = Array.from({ length: 48 }, (_, i) => project({ id: `a${i}`, name: `a ${i}` }))
    api.projects.list
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new ApiError('Internal', 'x'))
    renderAt('/projects')
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'More projects could not be loaded',
    )
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
  })

  it('creates a project from the dialog and goes to it', async () => {
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: '  Made  ' } })
    fireEvent.input(within(dialog).getByLabelText('Source URL'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await waitFor(() =>
      expect(api.projects.create).toHaveBeenCalledWith({
        name: 'Made',
        website: 'https://example.com',
      }),
    )
    // Navigated to the new project: its detail route asked for it.
    await waitFor(() => expect(api.projects.get).toHaveBeenCalledWith('new'))
  })

  it('refuses a blank name and a bad address without calling the API', async () => {
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.input(within(dialog).getByLabelText('Source URL'), { target: { value: 'nope' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await within(dialog).findByText('This field is required')
    expect(within(dialog).getByText(/full address/)).toBeTruthy()
    expect(api.projects.create).not.toHaveBeenCalled()
  })

  it('keeps what was typed and says why when the create fails', async () => {
    api.projects.create.mockRejectedValue(new ApiError('Internal', 'x'))
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]!)
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText(/^Name/) as HTMLInputElement
    fireEvent.input(name, { target: { value: 'Keep me' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await within(dialog).findByText('Something went wrong')
    expect(name.value).toBe('Keep me')
  })

  it('rescans the library and reloads', async () => {
    api.projects.rescan.mockResolvedValue({ adopted: 2, filesAdded: 5 })
    renderAt('/projects')
    await screen.findByRole('link', { name: 'Benchy' })
    const before = api.projects.list.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Rescan library' }))
    await waitFor(() => expect(api.projects.rescan).toHaveBeenCalled())
    await waitFor(() => expect(api.projects.list.mock.calls.length).toBe(before + 1))
  })
})

describe('ProjectDetailPage', () => {
  it('shows the project, its link, notes, tags and files', async () => {
    api.projects.get.mockResolvedValue(
      detail({ website: 'https://example.com/m', notes: 'Print slowly', files: [file()] }),
    )
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'Benchy', level: 2 })
    // The site is what it says; the link and the hover still carry the whole address.
    const site = screen.getByRole('link', { name: 'example.com' })
    expect(site.getAttribute('href')).toBe('https://example.com/m')
    expect(site.getAttribute('title')).toBe('https://example.com/m')
    expect(site.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('Print slowly')).toBeTruthy()
    expect(screen.getByText('boats')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'benchy.stl' })).toBeTruthy()
    expect(screen.getByText('2.0 kB')).toBeTruthy()
    expect(screen.getByText('Model')).toBeTruthy()
  })

  it('does not link a website that is not http or https', async () => {
    api.projects.get.mockResolvedValue(detail({ website: 'javascript:alert(1)' }))
    renderAt('/projects/p1')
    await screen.findByText('javascript:alert(1)')
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull()
  })

  it('says a project is missing rather than showing an empty page', async () => {
    api.projects.get.mockRejectedValue(new ApiError('NotFound', 'gone'))
    renderAt('/projects/p1')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This project does not exist any more',
    )
    expect(screen.getByRole('link', { name: 'Back to all projects' })).toBeTruthy()
  })

  it('shows the thumbnail when it is ready, and a state badge when it is not', async () => {
    api.projects.get.mockResolvedValue(
      detail({
        files: [
          file({ id: 'a', name: 'ready.stl' }),
          file({ id: 'b', name: 'pending.stl', previewState: 'pending', thumbUrl: undefined }),
          file({ id: 'c', name: 'failed.stl', previewState: 'failed', thumbUrl: undefined }),
          file({ id: 'd', name: 'x.step', previewState: 'unsupported', thumbUrl: undefined }),
          file({
            id: 'e',
            name: 'notes.txt',
            kind: 'other',
            previewState: 'pending',
            thumbUrl: undefined,
          }),
        ],
      }),
    )
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'ready.stl' })
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByText('Preview pending')).toBeTruthy()
    expect(screen.getByText('Preview failed')).toBeTruthy()
    // The unsupported one and the text file (never previewed) both say there is none.
    expect(screen.getAllByText('No preview')).toHaveLength(2)
  })

  it('tells the kinds apart and names the slicer of a slicer project', async () => {
    api.projects.get.mockResolvedValue(
      detail({
        files: [
          file({
            id: 'a',
            name: 'plate.3mf',
            kind: 'slicer_project',
            slicer: 'orca',
            previewState: 'unsupported',
            thumbUrl: undefined,
          }),
          file({
            id: 'b',
            name: 'readme.txt',
            kind: 'other',
            previewState: 'unsupported',
            thumbUrl: undefined,
          }),
        ],
      }),
    )
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'plate.3mf' })
    expect(screen.getByText('Slicer project')).toBeTruthy()
    expect(screen.getByText('OrcaSlicer')).toBeTruthy()
    expect(screen.getByText('Other file')).toBeTruthy()
  })

  it('opens every file in the preview popup from its card, the ones with no 3D view too', async () => {
    api.projects.get.mockResolvedValue(
      detail({
        files: [
          file({ id: 'm', name: 'a.stl' }),
          file({
            id: 'o',
            name: 'b.txt',
            kind: 'other',
            previewState: 'unsupported',
            thumbUrl: undefined,
          }),
        ],
      }),
    )
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'a.stl' })
    const download = screen.getByRole('link', { name: 'Download: a.stl' })
    expect(download.getAttribute('href')).toBe('/api/files/f1/raw')
    expect(download.getAttribute('download')).toBe('a.stl')

    // The card's title is its open control, and the heading keeps the file's name.
    expect(screen.getByRole('heading', { name: 'b.txt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'b.txt' }))
    const popup = await screen.findByRole('dialog')
    expect(within(popup).getByRole('heading', { name: 'b.txt' })).toBeTruthy()
    // No 3D view, so what can be done with it is the content, labelled.
    expect(within(popup).getByText(/no preview for this kind of file/)).toBeTruthy()
    expect(within(popup).getByRole('link', { name: 'Download' })).toBeTruthy()
    expect(within(popup).getByRole('button', { name: 'Rename' })).toBeTruthy()

    fireEvent.click(within(popup).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('warns about a missing folder and will not take uploads', async () => {
    api.projects.get.mockResolvedValue(detail({ state: 'missing' }))
    renderAt('/projects/p1')
    await screen.findByText('The project folder is missing')
    const add = screen.getByRole('button', {
      name: 'Files cannot be added while the project folder is missing.',
    }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  it('shows an archived project as archived and offers to restore it', async () => {
    api.projects.get.mockResolvedValue(detail({ isArchived: true }))
    renderAt('/projects/p1')
    await screen.findByText('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Restore this project from the archive' }))
    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith('p1', { isArchived: false }),
    )
  })

  it('archives a project that is not archived', async () => {
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Archive this project' }))
    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith('p1', { isArchived: true }),
    )
  })

  it('picks tags from a list with a checkmark on each the project has, and adds new ones', async () => {
    api.projects.tags.mockResolvedValue(['boats', 'petg'])
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'Benchy', level: 2 })
    // The tags are shown as they are, not as a text field.
    expect(screen.queryByRole('textbox', { name: 'Add tag' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Choose tags' }))
    const list = await screen.findByRole('group', { name: 'Tags' })
    await within(list).findByRole('checkbox', { name: 'petg' })
    expect(within(list).getByRole('checkbox', { name: 'boats' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.click(within(list).getByRole('checkbox', { name: 'petg' }))
    await waitFor(() => expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'petg'))

    fireEvent.click(within(list).getByRole('checkbox', { name: 'boats' }))
    await waitFor(() => expect(api.projects.removeTag).toHaveBeenCalledWith('p1', 'boats'))

    // A name that is not a tag yet is offered as a new one.
    const field = screen.getByRole('searchbox', { name: 'Find or add a tag' })
    fireEvent.input(field, { target: { value: 'functional' } })
    fireEvent.click(within(list).getByRole('button', { name: 'Add "functional"' }))
    await waitFor(() => expect(api.projects.addTag).toHaveBeenCalledWith('p1', 'functional'))
  })

  it('shows the server refusal of a tag and puts the tags back', async () => {
    api.projects.addTag.mockRejectedValue(new ApiError('Validation', 'bad'))
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'Benchy', level: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Choose tags' }))
    const field = await screen.findByRole('searchbox', { name: 'Find or add a tag' })
    fireEvent.input(field, { target: { value: 'bad' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await screen.findByText('A tag must be between 1 and 60 characters')
    expect(screen.queryByRole('checkbox', { name: 'bad' })).toBeNull()
  })

  it('edits name, website and notes, and clears a website that was emptied', async () => {
    api.projects.get.mockResolvedValue(detail({ website: 'https://example.com', notes: 'n' }))
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText(/^Name/) as HTMLInputElement
    expect(name.value).toBe('Benchy')
    fireEvent.input(name, { target: { value: 'Renamed' } })
    fireEvent.input(within(dialog).getByLabelText('Source URL'), { target: { value: '' } })
    fireEvent.input(within(dialog).getByLabelText('Notes'), { target: { value: '  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.projects.update).toHaveBeenCalledWith('p1', {
        name: 'Renamed',
        website: null,
        notes: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the edit dialog open and says why when the save is refused', async () => {
    api.projects.update.mockRejectedValue(new ApiError('Internal', 'x'))
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await within(dialog).findByText('Something went wrong')
  })

  it('arms nothing: delete asks first, with the on-disk option, and goes back to the list', async () => {
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/the files stay on disk/)).toBeTruthy()
    expect(api.projects.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Also delete the files on disk' }))
    expect(within(dialog).getByText(/erase every one of its files/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() =>
      expect(api.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: true }),
    )
    await waitFor(() => expect(api.projects.list).toHaveBeenCalled())
  })

  it('deletes without touching the files unless asked, and cancels cleanly', async () => {
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.projects.delete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() =>
      expect(api.projects.delete).toHaveBeenCalledWith('p1', { deleteFiles: false }),
    )
  })

  it('stays on the page and says why when the delete fails', async () => {
    api.projects.delete.mockRejectedValue(new ApiError('Internal', 'x'))
    renderAt('/projects/p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, delete' }),
    )
    await screen.findByText('Something went wrong')
    expect(screen.getByRole('heading', { name: 'Benchy', level: 2 })).toBeTruthy()
  })

  it('uploads several files with progress and reloads each, and shows a quota failure with numbers', async () => {
    api.files.uploadWithProgress
      .mockImplementationOnce(
        (_id: string, _name: string, _body: Blob, onProgress: (n: number) => void) => {
          onProgress(0.5)
          return Promise.resolve(file())
        },
      )
      .mockRejectedValueOnce(
        new ApiError('QuotaExceeded', 'over', {
          details: { usageBytes: 1024, quotaBytes: 2048, incomingBytes: 9 },
        }),
      )
    const { container } = renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'Benchy', level: 2 })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const a = new File(['a'], 'a.stl')
    const b = new File(['b'], 'b.stl')
    fireEvent.change(input, { target: { files: [a, b] } })
    await screen.findByText('This upload would exceed your quota (1.0 kB of 2.0 kB used)')
    expect(api.files.uploadWithProgress).toHaveBeenCalledWith(
      'p1',
      'a.stl',
      a,
      expect.any(Function),
    )
    expect(api.files.uploadWithProgress).toHaveBeenCalledWith(
      'p1',
      'b.stl',
      b,
      expect.any(Function),
    )
    expect(screen.getByText('Added')).toBeTruthy()
    // The project was refetched after the file that went through.
    await waitFor(() => expect(api.projects.get.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('renames a file through its menu, and refuses a bad name without calling the API', async () => {
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'benchy.stl' })
    const open = async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for benchy.stl' }), {
        key: 'Enter',
      })
      fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'Rename' }), {
        pointerType: 'mouse',
      })
      return screen.findByRole('dialog')
    }
    const dialog = await open()
    const input = within(dialog).getByLabelText('New file name') as HTMLInputElement
    expect(input.value).toBe('benchy.stl')
    fireEvent.input(input, { target: { value: 'a/b.stl' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await within(dialog).findByText('That file name is not allowed')
    expect(api.files.rename).not.toHaveBeenCalled()

    fireEvent.input(input, { target: { value: 'renamed.stl' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.files.rename).toHaveBeenCalledWith('f1', 'renamed.stl'))
  })

  it('deletes a file after asking', async () => {
    renderAt('/projects/p1')
    await screen.findByRole('heading', { name: 'benchy.stl' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for benchy.stl' }), {
      key: 'Enter',
    })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'Delete file' }), {
      pointerType: 'mouse',
    })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Delete benchy.stl\?/)).toBeTruthy()
    expect(api.files.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() => expect(api.files.delete).toHaveBeenCalledWith('f1'))
  })

  it('shows an empty project as empty', async () => {
    api.projects.get.mockResolvedValue(detail({ files: [], tags: [] }))
    renderAt('/projects/p1')
    await screen.findByText('This project has no files yet')
  })
})

describe('ImportPage', () => {
  const RESULT = {
    projectsExtracted: 2,
    filesExtracted: 7,
    bytesExtracted: 2048,
    strippedRoot: null,
    skipped: 0,
    projectsUpdated: 0,
    tagsApplied: 4,
    rescan: { adopted: 2, markedMissing: 0, filesAdded: 7, filesRemoved: 0, previewsQueued: 0 },
  }

  it('is a page with a heading, and uploads an archive and shows what it did', async () => {
    api.importer.curaManagerZip.mockResolvedValue(RESULT)
    const { container } = renderAt('/import')
    expect(
      screen.getByRole('heading', { name: 'Import a CuraManager library', level: 1 }),
    ).toBeTruthy()
    const archive = new File(['zip'], 'lib.zip')
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [archive] },
    })
    await screen.findByText('Import finished')
    expect(api.importer.curaManagerZip).toHaveBeenCalledWith(archive)
    expect(screen.getByText('Projects created').nextElementSibling!.textContent).toBe('2')
    expect(screen.getByRole('link', { name: 'View projects' }).getAttribute('href')).toBe(
      '/projects',
    )
  })

  it('refuses a file that is not a zip, and shows a refusal from the server verbatim', async () => {
    api.importer.curaManagerZip.mockRejectedValue(
      new ApiError('Conflict', 'already in your library: Widget A'),
    )
    const { container } = renderAt('/import')
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } })
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a .zip archive.')
    expect(api.importer.curaManagerZip).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { files: [new File(['x'], 'a.zip')] } })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('already in your library: Widget A'),
    )
  })
})

/**
 * Choosing a project opens it beside the list instead of replacing it. The selection is the
 * route, which is what makes a link, the back button and a reload all land in the same place.
 */
describe('the project panel beside the list', () => {
  it('shows the list alone until a project is chosen', async () => {
    renderLibrary('/projects')
    await screen.findByRole('heading', { name: 'Projects', level: 1 })

    expect(screen.queryByRole('complementary', { name: 'Project details' })).toBeNull()
    expect(api.projects.get).not.toHaveBeenCalled()
  })

  it('opens the chosen one beside the list, with the list still there', async () => {
    renderLibrary('/projects/p1')
    await screen.findByRole('heading', { name: 'Projects', level: 1 })

    const panel = await screen.findByRole('complementary', { name: 'Project details' })
    expect(within(panel).getByRole('heading', { name: 'Benchy' })).toBeTruthy()
    // The list is still the list: this is a panel beside it, not a page over it.
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy()
    // And no way back is offered, because the list never went away.
    expect(within(panel).queryByRole('link', { name: 'All projects' })).toBeNull()
  })

  it('does not reload the list when the selection changes', async () => {
    const history = renderLibrary('/projects')
    await screen.findByRole('heading', { name: 'Projects', level: 1 })
    const listCalls = api.projects.list.mock.calls.length

    history.set({ value: '/projects/p1' })
    await screen.findByRole('complementary', { name: 'Project details' })

    expect(api.projects.list.mock.calls.length).toBe(listCalls)
  })

  it('closes back to the list', async () => {
    const history = renderLibrary('/projects/p1')
    const panel = await screen.findByRole('complementary', { name: 'Project details' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(history.get()).toBe('/projects'))
  })

  it('offers a splitter that says how wide the panel is and answers the keyboard', async () => {
    renderLibrary('/projects/p1')
    await screen.findByRole('complementary', { name: 'Project details' })

    const bar = screen.getByRole('separator', { name: 'The width of the project panel' })
    const before = Number(bar.getAttribute('aria-valuenow'))
    // It grows to the left, so the left arrow widens it.
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })

    await waitFor(() => expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(before))
  })
})
