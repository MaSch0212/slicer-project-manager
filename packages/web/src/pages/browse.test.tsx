import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  BrowseDownloadDto,
  BrowseNoticeDto,
  BrowseStateDto,
  BrowseTabsDto,
  FileDto,
  ModelSiteDto,
  ProjectDto,
} from '../api/generated'
import { ApiError } from '../core/api/error'
import { BROWSE_TEXT_MAX, type BrowseDeps } from '../core/browse'
import { setLanguage } from '../core/i18n'
import { Dialog } from '../ui'
import BrowsePage from './browse'

/**
 * The model browser's page: what it asks the shell for and what it tells the user, against the
 * desktop client seam with a real component. A port of the Angular `DesktopBrowsePage` spec,
 * case for case, with two things moved: the *match* is the shell's now (it has the registry rows
 * the renderer never had), so the page is asserted to ask for it and nothing more; and the
 * overlay case is driven through a real `Dialog`.
 */

const SITES: ModelSiteDto[] = [
  { id: 'thingiverse', displayName: 'Thingiverse', homeUrl: 'https://www.thingiverse.com/' },
  { id: 'printables', displayName: 'Printables', homeUrl: 'https://www.printables.com/' },
]

const THING_URL = 'https://www.thingiverse.com/thing:1234'

const IDLE: BrowseStateDto = {
  tabId: 'tab-1',
  url: THING_URL,
  title: 'A thing',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  siteId: 'thingiverse',
  lastError: null,
}

/** One tab, in front, as the shell reports the set of them. */
function tabsOf(...states: BrowseStateDto[]): BrowseTabsDto {
  const tabs = states.length > 0 ? states : [IDLE]
  return {
    attached: true,
    tabs,
    activeTabId: tabs[0]!.tabId,
    canOpenMore: true,
  }
}

function project(over: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'p1',
    name: 'Benchy',
    isArchived: false,
    state: 'ok',
    tags: [],
    fileCounts: { model: 0, slicerProject: 0, other: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function download(over: Partial<BrowseDownloadDto> = {}): BrowseDownloadDto {
  return {
    downloadId: 'd1',
    fileName: 'benchy.zip',
    sourceUrl: 'blob:https://www.thingiverse.com/8c1f',
    pageUrl: THING_URL,
    siteId: 'thingiverse',
    mimeType: 'application/zip',
    state: 'completed',
    receivedBytes: 21_060_699,
    totalBytes: 21_060_699,
    hadUserGesture: true,
    startedAt: 0,
    isOrphan: false,
    isVerifiable: true,
    isDecided: true,
    ...over,
  }
}

function landedFile(over: Partial<FileDto> = {}): FileDto {
  return {
    id: 'f1',
    name: 'benchy.zip',
    kind: 'other',
    sizeBytes: 21_060_699,
    previewState: 'unsupported',
    rawUrl: '/api/files/f1/raw',
    ...over,
  }
}

type Browse = {
  sites: Mock
  attach: Mock
  detach: Mock
  hide: Mock
  show: Mock
  setBounds: Mock
  navigate: Mock
  back: Mock
  forward: Mock
  reload: Mock
  tabs: Mock
  openTab: Mock
  selectTab: Mock
  closeTab: Mock
  capture: Mock
  downloads: Mock
  discard: Mock
  notices: Mock
  dismissNotice: Mock
  land: Mock
  decide: Mock
  cancel: Mock
  match: Mock
}

type Options = {
  projects?: ProjectDto[]
  downloads?: BrowseDownloadDto[]
  notices?: BrowseNoticeDto[]
  state?: BrowseStateDto
  mode?: 'local' | 'remote'
  matches?: string[]
  overrides?: Partial<Browse>
  list?: Mock
  interstitialTicks?: number
}

function setup(options: Options = {}) {
  const browse: Browse = {
    sites: vi.fn().mockResolvedValue(SITES),
    attach: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    detach: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    setBounds: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    back: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    forward: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    reload: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    tabs: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    openTab: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    selectTab: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    closeTab: vi.fn().mockResolvedValue(tabsOf(options.state ?? IDLE)),
    capture: vi.fn().mockResolvedValue(null),
    downloads: vi.fn().mockResolvedValue(options.downloads ?? []),
    discard: vi.fn().mockResolvedValue(undefined),
    notices: vi.fn().mockResolvedValue(options.notices ?? []),
    dismissNotice: vi.fn().mockResolvedValue(undefined),
    land: vi.fn().mockResolvedValue(landedFile()),
    decide: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue({
      url: THING_URL,
      key: 'thingiverse:1234',
      projects: (options.matches ?? []).map((id) => ({ id, name: id })),
    }),
    ...options.overrides,
  }
  const list = options.list ?? vi.fn().mockResolvedValue(options.projects ?? [])
  const create = vi.fn().mockResolvedValue(project({ id: 'new', name: 'New' }))
  const deps: Partial<BrowseDeps> = {
    browse: browse as unknown as BrowseDeps['browse'],
    projects: { list, create } as unknown as BrowseDeps['projects'],
    libraryMode: vi.fn().mockResolvedValue(options.mode ?? 'local'),
    pollMs: 10,
    interstitialTicks: options.interstitialTicks ?? 3,
  }
  const view = render(() => <BrowsePage deps={deps} />)
  return { browse, list, create, ...view }
}

async function ready(browse: Browse) {
  await waitFor(() => expect(browse.attach).toHaveBeenCalled())
  await waitFor(() => expect(browse.downloads).toHaveBeenCalled())
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

/** Opens the tray, which is where everything about downloads now lives. */
const openTray = () => press('Downloads')

/**
 * The way to the dialog for a download that is already on disk: open the tray and file it. A
 * download that is still coming down opens it by itself, which is the point of the redesign.
 */
function fileIt() {
  openTray()
  press('File…')
}

/**
 * The whole document, not the page's own element: the dialog is in a portal, and the tray's rows
 * are the page's but easier to read for as one text.
 */
const bodyText = () => document.body.textContent ?? ''

beforeEach(async () => {
  vi.clearAllMocks()
  await setLanguage('en')
  // jsdom has no layout: a fixed rectangle, and frames that run.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the native view is not a DOM element', () => {
  it('attaches once on mount and detaches once on teardown', async () => {
    const { browse, unmount } = setup()
    await ready(browse)
    expect(browse.attach).toHaveBeenCalledTimes(1)
    // Only the rectangle: where to open is the shell's, and the tabs are already there.
    expect(browse.attach.mock.calls[0]).toHaveLength(1)
    expect(browse.detach).not.toHaveBeenCalled()
    unmount()
    await waitFor(() => expect(browse.detach).toHaveBeenCalledTimes(1))
  })

  it('hides the view for a modal and never detaches it', async () => {
    const [open, setOpen] = createSignal(false)
    const browse = setup().browse
    render(() => (
      <Dialog open={open()} onOpenChange={setOpen} title="A dialog">
        body
      </Dialog>
    ))
    await ready(browse)
    expect(browse.hide).not.toHaveBeenCalled()
    setOpen(true)
    await waitFor(() => expect(browse.hide).toHaveBeenCalledTimes(1))
    setOpen(false)
    await waitFor(() => expect(browse.show).toHaveBeenCalledTimes(1))
    expect(browse.detach).not.toHaveBeenCalled()
  })

  it('reports the placeholder rectangle when the window resizes, and only when it changed', async () => {
    let rect = { x: 80, y: 200, width: 600, height: 400 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          ...rect,
          top: rect.y,
          left: rect.x,
          right: 0,
          bottom: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    const { browse } = setup()
    await ready(browse)
    await waitFor(() => expect(browse.attach).toHaveBeenCalledWith(rect))
    // A scroll that moved nothing is not a report.
    fireEvent.scroll(window)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(browse.setBounds).not.toHaveBeenCalled()
    rect = { x: 80, y: 200, width: 500, height: 400 }
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(browse.setBounds).toHaveBeenCalledWith(rect))
    rect = { x: 80, y: 120, width: 500, height: 400 }
    fireEvent.scroll(document.body)
    await waitFor(() => expect(browse.setBounds).toHaveBeenLastCalledWith(rect))
    expect(browse.setBounds).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('detaches again, and loads nothing, when the page is destroyed while attach is outstanding', async () => {
    let finish: (tabs: BrowseTabsDto) => void = () => {}
    const attach = vi
      .fn()
      .mockReturnValue(new Promise<BrowseTabsDto>((resolve) => (finish = resolve)))
    const { browse, unmount } = setup({ overrides: { attach } })
    await waitFor(() => expect(attach).toHaveBeenCalled())
    unmount()
    finish(tabsOf())
    await waitFor(() => expect(browse.detach).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(browse.tabs).not.toHaveBeenCalled()
    expect(browse.downloads).not.toHaveBeenCalled()
  })

  it('starts no polling and no landing when the page is destroyed while the project list is outstanding', async () => {
    let finish: (list: ProjectDto[]) => void = () => {}
    const list = vi.fn().mockReturnValue(new Promise<ProjectDto[]>((resolve) => (finish = resolve)))
    const { browse, unmount } = setup({ downloads: [download()], list })
    await ready(browse)
    fileIt()
    await waitFor(() => expect(list).toHaveBeenCalled())
    unmount()
    const polls = browse.tabs.mock.calls.length
    finish([project()])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(browse.tabs.mock.calls.length).toBe(polls)
    expect(browse.land).not.toHaveBeenCalled()
  })
})

describe('site-controlled strings', () => {
  it('renders a hostile title and a javascript: URL as text, and creates no element from either', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const { browse, container } = setup({
      state: {
        ...IDLE,
        title: hostile,
        url: 'javascript:alert(document.cookie)',
        lastError: '<a href="javascript:evil()">click</a>',
      },
    })
    await ready(browse)
    await waitFor(() => expect(container.textContent).toContain(hostile.slice(0, 20)))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/javascript:/)
    }
    expect(container.querySelector('a[href*="evil"]')).toBeNull()
    // The address field shows the URL as a value, which is text.
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe(
      'javascript:alert(document.cookie)',
    )
  })

  it('renders a download name and its page as bounded text', async () => {
    const long = 'x'.repeat(BROWSE_TEXT_MAX * 3)
    const { browse, container } = setup({
      downloads: [download({ fileName: `${long}.zip`, pageUrl: `https://e.com/${long}` })],
    })
    await ready(browse)
    await waitFor(() => expect(container.textContent).toContain('x'.repeat(50)))
    expect(container.textContent).not.toContain('x'.repeat(BROWSE_TEXT_MAX + 5))
    expect(container.textContent).toContain('…')
  })

  it('bounds a notice and a page error, which reach the template through their own paths', async () => {
    const long = 'n'.repeat(BROWSE_TEXT_MAX * 3)
    const { browse, container } = setup({
      state: { ...IDLE, lastError: long },
      notices: [{ id: 'n1', kind: 'refused', fileName: long, detail: long, at: 0 }],
    })
    await ready(browse)
    await waitFor(() => expect(container.textContent).toContain('n'.repeat(50)))
    expect(container.textContent).not.toContain('n'.repeat(BROWSE_TEXT_MAX + 5))
  })

  it('bounds the project name in the landed sentence, though it is library data', async () => {
    const name = 'P'.repeat(BROWSE_TEXT_MAX * 3)
    const { browse, container } = setup({
      downloads: [download()],
      projects: [project({ id: 'p1', name })],
      matches: ['p1'],
    })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByRole('button', { name: 'Add it to this project' }))
    press('Add it to this project')
    await waitFor(() => expect(container.textContent).toContain('was added to'))
    expect(container.textContent).not.toContain('P'.repeat(BROWSE_TEXT_MAX + 5))
  })

  it('goes somewhere through the shell, never through an anchor', async () => {
    const { browse, container } = setup()
    await ready(browse)
    const address = screen.getByLabelText('Address')
    fireEvent.input(address, { target: { value: 'https://www.printables.com/model/1-x' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() =>
      expect(browse.navigate).toHaveBeenCalledWith('https://www.printables.com/model/1-x'),
    )
    expect(container.querySelectorAll('a[href]')).toHaveLength(0)
    // The start-site picker asks the shell too.
    fireEvent.change(screen.getByLabelText('Start on a site'), { target: { value: 'printables' } })
    await waitFor(() =>
      expect(browse.navigate).toHaveBeenLastCalledWith('https://www.printables.com/'),
    )
  })

  it('says why a navigation was refused rather than doing nothing visible', async () => {
    const navigate = vi
      .fn()
      .mockRejectedValue(
        new ApiError('Validation', 'that URL cannot be opened in the model browser'),
      )
    const { browse } = setup({ overrides: { navigate } })
    await ready(browse)
    const address = screen.getByLabelText('Address')
    fireEvent.input(address, { target: { value: 'bambustudio://open?model=1' } })
    fireEvent.submit(address.closest('form')!)
    await screen.findByText('that URL cannot be opened in the model browser')
  })

  it('sends back, forward and reload to the shell and enables them from what the shell says', async () => {
    const { browse } = setup({ state: { ...IDLE, canGoBack: true, canGoForward: false } })
    await ready(browse)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    press('Back')
    press('Reload')
    await waitFor(() => expect(browse.back).toHaveBeenCalledTimes(1))
    expect(browse.reload).toHaveBeenCalledTimes(1)
  })

  it('opens, selects and closes tabs through the shell', async () => {
    const { browse } = setup()
    await ready(browse)

    press('New tab')
    await waitFor(() => expect(browse.openTab).toHaveBeenCalledTimes(1))
    press('Close A thing')
    await waitFor(() => expect(browse.closeTab).toHaveBeenCalledWith('tab-1'))
  })

  it('names a tab after the page, falling back to its host', async () => {
    const { browse } = setup({
      state: { ...IDLE, title: null, url: 'https://www.printables.com/model/1' },
    })
    await ready(browse)
    await waitFor(() => expect(screen.getByRole('tab').textContent).toContain('www.printables.com'))
  })
})

describe('loading and the interstitial', () => {
  it('shows an ordinary loading state first and says the site is verifying only after a generous wait', async () => {
    const { browse, container } = setup({
      state: { ...IDLE, isLoading: true },
      interstitialTicks: 6,
    })
    await ready(browse)
    // The tab itself says it is loading; the sentence below the address only appears later.
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeTruthy()
    expect(container.textContent).not.toContain('checking the connection')
    await waitFor(() => expect(container.textContent).toContain('checking the connection'))
    // Nothing gave up: the view was not reloaded, retried or detached.
    expect(browse.reload).not.toHaveBeenCalled()
    expect(browse.detach).not.toHaveBeenCalled()
    expect(browse.navigate).not.toHaveBeenCalled()
  })

  it('drops the interstitial the moment the page finishes loading', async () => {
    const tabs = vi.fn().mockResolvedValue(tabsOf({ ...IDLE, isLoading: true }))
    const { browse, container } = setup({
      state: { ...IDLE, isLoading: true },
      overrides: { tabs },
    })
    await ready(browse)
    await waitFor(() => expect(container.textContent).toContain('checking the connection'))
    tabs.mockResolvedValue(tabsOf())
    await waitFor(() => expect(container.textContent).not.toContain('checking the connection'))
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull()
  })
})

describe('the landing UI', () => {
  it('preselects the project the shell matched, and lands nothing', async () => {
    const { browse, list } = setup({
      downloads: [download()],
      projects: [project({ id: 'p0', name: 'Aardvark' }), project({ id: 'p1', name: 'Benchy' })],
      matches: ['p1'],
    })
    await ready(browse)
    fileIt()
    await waitFor(() => expect(screen.getByLabelText('Choose a project')).toBeTruthy())
    expect((screen.getByLabelText('Choose a project') as HTMLSelectElement).value).toBe('p1')
    expect(
      screen.getByText(
        'This looks like a project you already have. It is a suggestion — check it before adding.',
      ),
    ).toBeTruthy()
    expect(browse.land).not.toHaveBeenCalled()
    // The library is read from the library API, archived projects included.
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true }))
    // And the match is the shell's, asked with the page the download came from.
    expect(browse.match).toHaveBeenCalledWith(THING_URL)
  })

  it('lands nothing when a download completes, however many times the page polls', async () => {
    const { browse } = setup({ downloads: [download()], projects: [project()], matches: ['p1'] })
    await ready(browse)
    await waitFor(() => expect(browse.downloads.mock.calls.length).toBeGreaterThan(4))
    expect(browse.land).not.toHaveBeenCalled()
    expect(browse.match).not.toHaveBeenCalled()
  })

  it('offers every project the shell matched, and reports none of it as an error', async () => {
    const { browse, container } = setup({
      downloads: [download()],
      projects: [project({ id: 'a', name: 'Alpha' }), project({ id: 'z', name: 'Zed' })],
      matches: ['a', 'z'],
    })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('Choose a project'))
    const options = [...(screen.getByLabelText('Choose a project') as HTMLSelectElement).options]
    expect(options.filter((option) => option.textContent?.includes('(Suggested)'))).toHaveLength(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers creating a project beside choosing one, with nothing reported as an error', async () => {
    const { browse, container } = setup({ downloads: [download()], projects: [] })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('New project name'))
    expect(screen.getByText('There are no projects yet. Create one below.')).toBeTruthy()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Create it and add the file' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('sets a new project website to the page the download came from, then lands into it', async () => {
    const { browse, create } = setup({ downloads: [download()] })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('New project name'))
    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: 'Benchy' } })
    press('Create it and add the file')
    await waitFor(() => expect(browse.land).toHaveBeenCalledWith('d1', 'new', null))
    expect(create).toHaveBeenCalledWith({ name: 'Benchy', website: THING_URL })
    await screen.findByText(/was added to/)
  })

  it('says a popup download named no page, rather than rendering a blank field or the word null', async () => {
    const { browse, create } = setup({
      downloads: [download({ pageUrl: null, siteId: null })],
    })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('New project name'))
    // The dialog says where it came from, and 'nowhere' is a sentence, not an empty field.
    expect(bodyText()).toContain('came down through a pop-up window')
    expect(bodyText()).not.toMatch(/[^a-z]null[^a-z]/)
    expect(browse.match).toHaveBeenCalledWith(null)
    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: 'Mystery' } })
    press('Create it and add the file')
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith({ name: 'Mystery', website: undefined })
  })

  it('does not persist a page that is not a web page as a project website', async () => {
    const { browse, create } = setup({
      downloads: [download({ pageUrl: 'data:text/html,<b>x</b>' })],
    })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('New project name'))
    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: 'Data' } })
    press('Create it and add the file')
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith({ name: 'Data', website: undefined })
  })

  it('reports a failed project creation in words about a project, not about a file', async () => {
    const { browse, create } = setup({ downloads: [download()] })
    create.mockRejectedValue(new ApiError('Validation', 'name'))
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByLabelText('New project name'))
    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: ' ' } })
    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: 'x'.repeat(5) } })
    press('Create it and add the file')
    await waitFor(() => expect(bodyText()).toContain('not a name a project can have'))
    expect(browse.land).not.toHaveBeenCalled()
  })

  it('offers discard and not landing for a download whose record cannot vouch for it', async () => {
    const { browse } = setup({
      downloads: [download({ isVerifiable: false, isOrphan: true, state: 'interrupted' })],
    })
    await ready(browse)
    openTray()
    await waitFor(() => screen.getByRole('button', { name: 'Discard benchy.zip' }))
    // Nothing offers to file bytes the record cannot vouch for.
    expect(screen.queryByRole('button', { name: 'File…' })).toBeNull()
    expect(bodyText()).toContain('Nothing can vouch for these bytes')

    press('Discard benchy.zip')
    await waitFor(() => expect(browse.discard).toHaveBeenCalledWith('d1'))
  })

  it('reports a refused landing and adds again under the name the user types', async () => {
    const land = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Conflict', 'exists'))
      .mockResolvedValue(landedFile({ name: 'benchy-2.zip' }))
    const { browse } = setup({
      downloads: [download()],
      projects: [project()],
      matches: ['p1'],
      overrides: { land },
    })
    await ready(browse)
    fileIt()
    await waitFor(() => screen.getByRole('button', { name: 'Add it to this project' }))
    press('Add it to this project')
    await waitFor(() => expect(bodyText()).toContain('nothing is renamed for you'))
    fireEvent.input(screen.getByLabelText('File name'), { target: { value: 'benchy-2.zip' } })
    press('Add it to this project')
    await waitFor(() => expect(land).toHaveBeenLastCalledWith('d1', 'p1', 'benchy-2.zip'))
    expect(land).toHaveBeenNthCalledWith(1, 'd1', 'p1', null)
  })

  it('maps the shell refusals to sentences a person can act on', async () => {
    for (const [code, sentence] of [
      ['QuotaExceeded', 'over its quota'],
      ['NotFound', 'not there any more'],
      ['Internal', 'cannot be added'],
    ] as const) {
      const { browse, unmount } = setup({
        downloads: [download()],
        projects: [project()],
        matches: ['p1'],
        overrides: { land: vi.fn().mockRejectedValue(new ApiError(code, 'x')) },
      })
      await ready(browse)
      fileIt()
      await waitFor(() => screen.getByRole('button', { name: 'Add it to this project' }))
      press('Add it to this project')
      await waitFor(() => expect(bodyText()).toContain(sentence))
      unmount()
    }
  })

  it('asks in a real modal dialog, which is what hides the view behind it', async () => {
    const { browse } = setup({ downloads: [download()] })
    await ready(browse)
    fileIt()

    // A modal over the page is what makes the shell take the native views off screen; the old
    // inline panel claimed no modality and so never did.
    await screen.findByRole('dialog', { name: 'Add to a project' })
    await waitFor(() => expect(browse.hide).toHaveBeenCalled())
  })
})

describe('the archive obligation', () => {
  async function landOne(options: Options) {
    const view = setup({
      downloads: [download()],
      projects: [project()],
      matches: ['p1'],
      ...options,
    })
    await ready(view.browse)
    fileIt()
    await waitFor(() => screen.getByRole('button', { name: 'Add it to this project' }))
    press('Add it to this project')
    await waitFor(() => expect(view.container.textContent).toContain('was added to'))
    return view
  }

  it('names what a landed archive costs in remote mode', async () => {
    const { container } = await landOne({ mode: 'remote' })
    await waitFor(() =>
      expect(container.textContent).toContain('The project folder is on the server'),
    )
    expect(container.textContent).not.toContain('unzip it into the project folder')
  })

  it('names the remedy for a landed archive in local mode', async () => {
    const { container } = await landOne({ mode: 'local' })
    await waitFor(() =>
      expect(container.textContent).toContain('unzip it into the project folder and rescan'),
    )
    expect(container.textContent).not.toContain('The project folder is on the server')
  })

  it('says nothing about archives when what landed is not one', async () => {
    const { container } = await landOne({
      overrides: {
        land: vi.fn().mockResolvedValue(landedFile({ name: 'cube.stl', kind: 'model' })),
      },
    })
    expect(container.textContent).not.toContain('an archive')
  })
})

describe('staged downloads', () => {
  it('offers discard for an orphan whose record still says progressing, and does not call it running', async () => {
    const { browse } = setup({
      downloads: [
        download({
          state: 'progressing',
          isOrphan: true,
          isVerifiable: false,
          receivedBytes: 0,
          totalBytes: 40_000_000,
        }),
      ],
    })
    await ready(browse)
    openTray()
    await waitFor(() => screen.getByRole('button', { name: 'Discard benchy.zip' }))
    expect(bodyText()).not.toContain('Still downloading')
    expect(bodyText()).toContain('Downloaded by an earlier run')
  })

  it('still refuses to offer discard for a download this process is writing', async () => {
    const { browse } = setup({
      downloads: [
        download({
          state: 'progressing',
          isVerifiable: false,
          receivedBytes: 1000,
          totalBytes: 4000,
        }),
      ],
    })
    await ready(browse)
    openTray()
    await waitFor(() => expect(bodyText()).toContain('Still downloading'))
    // It can be cancelled, but not discarded and not filed: it is not there yet.
    expect(screen.queryByRole('button', { name: 'Discard benchy.zip' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'File…' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel the download benchy.zip' })).toBeTruthy()
  })

  it('says how much has arrived, not "of 0 B", when the server named no size', async () => {
    const { browse } = setup({
      downloads: [
        download({ state: 'progressing', isVerifiable: false, receivedBytes: 2048, totalBytes: 0 }),
      ],
    })
    await ready(browse)
    openTray()
    await waitFor(() => expect(bodyText()).toContain('did not say how big the file is'))
    expect(bodyText()).not.toContain('of 0')
  })
})

describe('notices', () => {
  const notice = (over: Partial<BrowseNoticeDto> = {}): BrowseNoticeDto => ({
    id: 'n1',
    kind: 'refused',
    fileName: 'huge.zip',
    detail: '4 downloads are already running; wait for one to finish',
    at: 0,
    ...over,
  })

  it('renders a notice, dismisses it, and offers to make room beside a refusal', async () => {
    const { browse } = setup({
      notices: [notice()],
      downloads: [download({ downloadId: 'old1' }), download({ downloadId: 'old2' })],
    })
    await ready(browse)
    openTray()
    await waitFor(() => expect(bodyText()).toContain('huge.zip'))
    expect(bodyText()).toContain('wait for one to finish')
    press('Discard the 2 downloads that are not still running')
    await waitFor(() => expect(browse.discard).toHaveBeenCalledTimes(2))
    press('Dismiss huge.zip')
    await waitFor(() => expect(browse.dismissNotice).toHaveBeenCalledWith('n1'))
    await waitFor(() => expect(bodyText()).not.toContain('huge.zip'))
  })

  it('leaves a still-running download out of the make-room control', async () => {
    const { browse } = setup({
      notices: [notice()],
      downloads: [
        download({ downloadId: 'done' }),
        download({ downloadId: 'running', state: 'progressing', isVerifiable: false }),
      ],
    })
    await ready(browse)
    openTray()
    await waitFor(() =>
      screen.getByRole('button', { name: 'Discard the 1 downloads that are not still running' }),
    )
    press('Discard the 1 downloads that are not still running')
    await waitFor(() => expect(browse.discard).toHaveBeenCalledWith('done'))
    expect(browse.discard).not.toHaveBeenCalledWith('running')
  })

  it('offers no make-room control beside a notice that is not a refusal', async () => {
    const { browse } = setup({
      notices: [notice({ kind: 'completed', detail: 'this download finished in the background' })],
      downloads: [download()],
    })
    await ready(browse)
    openTray()
    await waitFor(() => screen.getByRole('button', { name: 'Dismiss huge.zip' }))
    expect(screen.queryByRole('button', { name: /Discard the/ })).toBeNull()
  })
})

/**
 * The whole point of the redesign: a download is decided when it *starts*, so the file files
 * itself when it arrives — including when the user has walked away from the page by then.
 */
describe('deciding where a download goes, when it starts', () => {
  const arriving = (over: Partial<BrowseDownloadDto> = {}) =>
    download({
      state: 'progressing',
      isVerifiable: false,
      isDecided: false,
      receivedBytes: 2048,
      totalBytes: 0,
      ...over,
    })

  it('opens the dialog by itself for a download that has just started', async () => {
    const { browse } = setup({ downloads: [arriving()], projects: [project()] })
    await ready(browse)

    await screen.findByRole('dialog', { name: 'Add to a project' })
    expect(bodyText()).toContain('it will be added when the download finishes')
  })

  it('leaves an already-decided download alone, and an orphan from a previous run too', async () => {
    const { browse } = setup({
      downloads: [arriving({ isDecided: true }), download({ downloadId: 'old', isOrphan: true })],
    })
    await ready(browse)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes a picture of the view first, and shows it where the view was', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw==')
    const { browse } = setup({
      downloads: [arriving()],
      projects: [project()],
      overrides: { capture },
    })
    await ready(browse)

    await screen.findByRole('dialog', { name: 'Add to a project' })
    expect(capture).toHaveBeenCalledTimes(1)
    const still = screen.getByRole('img', { name: 'The page, while this dialog is open' })
    expect(still.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
  })

  it('opens the dialog anyway when the picture cannot be taken', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('no'))
    const { browse } = setup({
      downloads: [arriving()],
      projects: [project()],
      overrides: { capture },
    })
    await ready(browse)

    await screen.findByRole('dialog', { name: 'Add to a project' })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('records the choice with the shell rather than landing bytes that are not there yet', async () => {
    const { browse } = setup({
      downloads: [arriving()],
      projects: [project()],
      matches: ['p1'],
    })
    await ready(browse)
    await screen.findByRole('button', { name: 'Add it to this project' })

    press('Add it to this project')

    await waitFor(() => expect(browse.decide).toHaveBeenCalledWith('d1', 'p1', 'benchy.zip'))
    expect(browse.land).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('creates the project the user named before recording the choice against it', async () => {
    const { browse, create } = setup({ downloads: [arriving()] })
    await ready(browse)
    await screen.findByLabelText('New project name')

    fireEvent.input(screen.getByLabelText('New project name'), { target: { value: 'Dragons' } })
    press('Create it and add the file')

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: 'Dragons', website: THING_URL }),
    )
    await waitFor(() => expect(browse.decide).toHaveBeenCalledWith('d1', 'new', 'benchy.zip'))
  })

  it('cancels the download when the dialog is closed without an answer', async () => {
    const { browse } = setup({ downloads: [arriving()] })
    await ready(browse)
    await screen.findByRole('button', { name: 'Cancel the download' })

    press('Cancel the download')

    await waitFor(() => expect(browse.cancel).toHaveBeenCalledWith('d1'))
    expect(browse.land).not.toHaveBeenCalled()
    expect(browse.decide).not.toHaveBeenCalled()
  })

  it('leaves a file that is already on disk alone when its dialog is closed', async () => {
    // Opened by hand from the tray: backing out must not delete what is already there.
    const { browse } = setup({ downloads: [download()] })
    await ready(browse)
    fileIt()
    await screen.findByRole('button', { name: 'Cancel' })

    press('Cancel')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(browse.cancel).not.toHaveBeenCalled()
    expect(browse.discard).not.toHaveBeenCalled()
  })

  it('says where a file went once the shell has filed it', async () => {
    const downloads = vi.fn().mockResolvedValue([arriving()])
    const { browse, container } = setup({
      downloads: [arriving()],
      projects: [project()],
      matches: ['p1'],
      overrides: { downloads },
    })
    await ready(browse)
    await screen.findByRole('button', { name: 'Add it to this project' })
    press('Add it to this project')
    await waitFor(() => expect(browse.decide).toHaveBeenCalled())

    // The shell filed it, so it leaves the list: that is the page's cue.
    downloads.mockResolvedValue([])

    await waitFor(() => expect(container.textContent).toContain('was added to'))
    expect(container.textContent).toContain('Benchy')
  })
})
