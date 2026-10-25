import { createMemoryHistory, MemoryRouter, Route } from '@solidjs/router'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type Capabilities,
  type FileDto,
  type ProjectDetailDto,
  type SlicerConfigDto,
  type SlicerLaunchDto,
} from '../api/generated'
import { ApiError } from '../core/api/error'

// Ported from the former Angular project-detail.page.spec.ts "handing a file to a slicer" cases: the launch
// controls, the Cura warning, and what the page says about a launch. The launch logic has its own
// unit tests (core/slicer-launch.test.ts); these drive the real page over a fake API and a fake
// shell.

const api = vi.hoisted(() => ({
  projects: {
    list: vi.fn(),
    tags: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
  },
  files: { uploadWithProgress: vi.fn(), rename: vi.fn(), delete: vi.fn() },
  settings: { get: vi.fn(), put: vi.fn() },
}))
vi.mock('../core/api/client', () => ({ api }))

const slicers = vi.hoisted(() => ({
  get: vi.fn(),
  open: vi.fn(),
  sessions: vi.fn(),
  resolveSession: vi.fn(),
  discardSessions: vi.fn(),
}))
vi.mock('../core/desktop', () => ({ desktop: { slicers }, isDesktop: () => true }))

import { curaHazard } from '../core/cura-hazard'
import { setLanguage } from '../core/i18n'
import en from '../core/i18n/en.json'
import { capabilities, settings } from '../core/stores'
import ProjectDetailPage from './project-detail'

const BENCHY: FileDto = {
  id: 'f1',
  name: 'benchy.stl',
  kind: 'model',
  sizeBytes: 2048,
  previewState: 'ready',
  rawUrl: '/api/files/f1/raw',
  thumbUrl: '/api/files/f1/thumb',
}

/** A `.3mf` Cura wrote, which is the only kind of file the as-is control is offered for. */
const BRACKET: FileDto = {
  id: 'f2',
  name: 'bracket.3mf',
  kind: 'slicer_project',
  slicer: 'cura',
  sizeBytes: 4096,
  previewState: 'ready',
  rawUrl: '/api/files/f2/raw',
}

const detail: ProjectDetailDto = {
  id: 'p1',
  name: 'Benchy',
  isArchived: false,
  state: 'ok',
  tags: [],
  fileCounts: { model: 1, slicerProject: 1, other: 0 },
  createdAt: 0,
  updatedAt: 0,
  files: [BENCHY, BRACKET],
}

const CONFIG: SlicerConfigDto = {
  installs: [
    {
      id: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
      slicerId: 'orca',
      label: 'OrcaSlicer',
      version: '2.4.3.0',
      path: 'C:\\OrcaSlicer\\orca-slicer.exe',
      origin: 'msix',
      state: 'ok',
    },
    {
      id: 'registry:HKLM:Cura',
      slicerId: 'cura',
      label: 'UltiMaker Cura 5.13.0',
      version: '5.13.0',
      path: 'C:\\Cura\\UltiMaker-Cura.exe',
      origin: 'registry',
      state: 'ok',
    },
  ],
  bindings: { orca: 'msix:OrcaSlicer.OrcaSlicer_3qd7h69xpne0g', cura: 'registry:HKLM:Cura' },
  defaultSlicerId: 'orca',
  detectionSupported: true,
}

const LAUNCH: SlicerLaunchDto = {
  launchId: 'launch-1',
  slicerId: 'orca',
  installLabel: 'OrcaSlicer',
  stripped: true,
  notices: ['It will show one informational notice, "loading geometry data only".'],
  pid: 4242,
}

const DESKTOP: Capabilities = {
  requiresAuth: false,
  canManageUsers: false,
  canPickLocalFolder: true,
  canLaunchSlicer: true,
  canConfigureSlicers: true,
  canBrowseModelSites: false,
}
const BROWSER: Capabilities = {
  ...DESKTOP,
  canPickLocalFolder: false,
  canLaunchSlicer: false,
  canConfigureSlicers: false,
}

function renderPage() {
  const history = createMemoryHistory()
  history.set({ value: '/projects/p1' })
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/projects/:id" component={ProjectDetailPage} />
    </MemoryRouter>
  ))
}

/** The page, with the shell able to launch (or not). */
async function open(caps: Capabilities = DESKTOP) {
  vi.spyOn(capabilities, 'capabilities').mockReturnValue(caps)
  renderPage()
  await screen.findByRole('heading', { name: 'bracket.3mf', level: 3 })
}

const ready = async () => {
  await waitFor(() => expect(slicers.get).toHaveBeenCalled())
  await screen.findByRole('button', { name: `${en.projects.newSlicerProject} benchy.stl` })
}
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const names = () =>
  screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '')
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? ''

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await setLanguage('en')
  curaHazard.reset()
  settings.reset()
  api.projects.get.mockResolvedValue(detail)
  api.projects.list.mockResolvedValue([])
  api.projects.tags.mockResolvedValue([])
  api.settings.put.mockImplementation((patch: object) =>
    Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
  )
  slicers.get.mockResolvedValue(CONFIG)
  slicers.open.mockResolvedValue(LAUNCH)
  // The unfinished-session card renders beside the launch control and asks for this on mount; its
  // own behaviour is `slicer-sessions-card.test.tsx`'s, and what this file asserts is only that it
  // is mounted where the launch controls are and nowhere else.
  slicers.sessions.mockResolvedValue([])
})

describe('handing a file to a slicer', () => {
  it('offers "open as it is" for a slicer project only, and the other path for every file', async () => {
    await open()
    await ready()

    expect(names()).toContain(`${en.projects.openInSlicer} bracket.3mf`)
    expect(names()).not.toContain(`${en.projects.openInSlicer} benchy.stl`)
    expect(names()).toContain(`${en.projects.newSlicerProject} bracket.3mf`)
    expect(names()).toContain(`${en.projects.newSlicerProject} benchy.stl`)
  })

  it('renders no launch control at all where the shell cannot launch one', async () => {
    await open(BROWSER)

    expect(names()).not.toContain(`${en.projects.newSlicerProject} benchy.stl`)
    expect(names()).not.toContain(`${en.projects.openInSlicer} bracket.3mf`)
    expect(screen.queryByLabelText(en.projects.slicerChoice)).toBeNull()
    // And nothing asked the shell anything.
    expect(slicers.get).not.toHaveBeenCalled()
  })

  it('shows the unfinished-session card beside the launch controls', async () => {
    await open()
    await ready()

    await screen.findByRole('heading', { name: en.slicerSessions.title })
    expect(slicers.sessions).toHaveBeenCalled()
  })

  it('shows no session card at all where the shell cannot launch anything', async () => {
    // The pair to the test above: `canLaunchSlicer` is false here, so a card that rendered anyway
    // would be a card asking a refusing transport for a list on every project page in the browser.
    await open(BROWSER)

    expect(screen.queryByRole('heading', { name: en.slicerSessions.title })).toBeNull()
    expect(slicers.sessions).not.toHaveBeenCalled()
  })

  it('sends ids and a mode, and never a path or a slicer it was not given', async () => {
    await open()
    await ready()

    press(`${en.projects.newSlicerProject} benchy.stl`)

    await waitFor(() =>
      expect(slicers.open).toHaveBeenCalledWith('f1', 'p1', { mode: 'new-project' }),
    )
    // `slicerId` absent rather than null: "not stated" is what makes the shell apply its own rule,
    // and a null would be a `Validation` failure at the command.
    const [, , options] = slicers.open.mock.calls[0] as [string, string, object]
    expect('slicerId' in options).toBe(false)
  })

  it('sends the chosen slicer when the user picks one', async () => {
    await open()
    await ready()
    fireEvent.change(screen.getByLabelText(en.projects.slicerChoice), { target: { value: 'cura' } })
    // Cura is warned about first, and this test is about what is sent after.
    press(`${en.projects.openInSlicer} bracket.3mf`)
    press(en.projects.curaHazardContinue)

    await waitFor(() =>
      expect(slicers.open).toHaveBeenCalledWith('f2', 'p1', { mode: 'as-is', slicerId: 'cura' }),
    )
  })

  it('offers only the products with an install bound to them, and "automatic" first', async () => {
    await open()
    await ready()

    const select = screen.getByLabelText(en.projects.slicerChoice) as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      en.projects.slicerAutomatic,
      'UltiMaker Cura',
      'OrcaSlicer',
    ])
    expect(select.value).toBe('')
  })

  it('says what it handed over and to what, and never that anything opened', async () => {
    await open()
    await ready()

    press(`${en.projects.newSlicerProject} benchy.stl`)

    await screen.findByText('Handed benchy.stl to OrcaSlicer (OrcaSlicer)')
    expect(text()).toContain('loading geometry data only')
    // Constraint 11, asserted as an absence because that is what the constraint is.
    expect(text().toLowerCase()).not.toContain('opened in')
    // And it can be dismissed.
    fireEvent.click(screen.getByRole('button', { name: en.projects.dismiss }))
    expect(text()).not.toContain('Handed benchy.stl')
  })

  it("shows the shell's own refusal rather than a generic apology", async () => {
    slicers.open.mockRejectedValue(
      new ApiError(
        'Validation',
        'mixed.3mf could not be prepared for a new project because stripping it left slicer configuration behind. Opening it as it is, without stripping, is still available.',
        { details: { reason: 'configuration-left-behind' } },
      ),
    )
    await open()
    await ready()

    press(`${en.projects.newSlicerProject} benchy.stl`)

    await waitFor(() => expect(text()).toContain('stripping it left slicer configuration behind'))
    expect(text()).not.toContain(en.errors.generic)
  })

  it('warns about Cura before handing it anything, and does not launch until answered', async () => {
    await open()
    await ready()

    // Cura is what the file itself names, so an as-is launch with no explicit choice is a Cura
    // launch, which the page has to work out for itself, before the call.
    press(`${en.projects.openInSlicer} bracket.3mf`)

    await screen.findByText(en.projects.curaHazardTitle)
    expect(slicers.open).not.toHaveBeenCalled()

    press(en.projects.curaHazardContinue)

    await waitFor(() => expect(slicers.open).toHaveBeenCalledWith('f2', 'p1', { mode: 'as-is' }))
    await waitFor(() => expect(screen.queryByText(en.projects.curaHazardTitle)).toBeNull())
  })

  it('lets the user back out of the warning, and launches nothing', async () => {
    await open()
    await ready()
    press(`${en.projects.openInSlicer} bracket.3mf`)
    await screen.findByText(en.projects.curaHazardTitle)

    press(en.common.cancel)

    await waitFor(() => expect(screen.queryByText(en.projects.curaHazardTitle)).toBeNull())
    expect(slicers.open).not.toHaveBeenCalled()
  })

  it('warns every time until the user says not to, and then never again', async () => {
    await open()
    await ready()

    press(`${en.projects.openInSlicer} bracket.3mf`)
    press(en.projects.curaHazardContinue)
    await waitFor(() => expect(slicers.open).toHaveBeenCalledTimes(1))
    // Not ticked, so the next Cura launch is held back again.
    press(`${en.projects.openInSlicer} bracket.3mf`)
    await screen.findByText(en.projects.curaHazardTitle)
    expect(slicers.open).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('checkbox', { name: en.projects.curaHazardDontShow }))
    press(en.projects.curaHazardContinue)
    await waitFor(() => expect(slicers.open).toHaveBeenCalledTimes(2))
    press(`${en.projects.openInSlicer} bracket.3mf`)

    await waitFor(() => expect(slicers.open).toHaveBeenCalledTimes(3))
    expect(screen.queryByText(en.projects.curaHazardTitle)).toBeNull()
  })

  it('warns about Cura on the new-project path too, not only on as-is', async () => {
    await open()
    await ready()
    // Nothing about this path consults the file's own slicer, so the only way it reaches Cura is an
    // explicit pick, and the warning is about what Cura does on save, which is the same whichever
    // path handed it the file.
    fireEvent.change(screen.getByLabelText(en.projects.slicerChoice), { target: { value: 'cura' } })

    press(`${en.projects.newSlicerProject} benchy.stl`)

    await screen.findByText(en.projects.curaHazardTitle)
    expect(slicers.open).not.toHaveBeenCalled()

    press(en.projects.curaHazardContinue)

    await waitFor(() =>
      expect(slicers.open).toHaveBeenCalledWith('f1', 'p1', {
        mode: 'new-project',
        slicerId: 'cura',
      }),
    )
  })

  it('launches the product it warned about, even if the picker moved while the warning was up', async () => {
    await open()
    await ready()
    const picker = screen.getByLabelText(en.projects.slicerChoice)
    fireEvent.change(picker, { target: { value: 'cura' } })
    press(`${en.projects.newSlicerProject} benchy.stl`)
    await screen.findByText(en.projects.curaHazardTitle)

    // The picker is live behind the warning. "Hand it to Cura anyway" has to mean Cura.
    fireEvent.change(picker, { target: { value: 'orca' } })
    press(en.projects.curaHazardContinue)

    await waitFor(() =>
      expect(slicers.open).toHaveBeenCalledWith('f1', 'p1', {
        mode: 'new-project',
        slicerId: 'cura',
      }),
    )
  })

  it('does not warn about Cura for a launch that would not use it', async () => {
    await open()
    await ready()

    // The same Cura-authored file down the other path: that one defaults to the configured default,
    // which is Orca, so there is nothing to warn about. This is the new-project path of the user's
    // rule: a copy of the .3mf with its slicer configuration stripped, handed to the default.
    press(`${en.projects.newSlicerProject} bracket.3mf`)

    await waitFor(() =>
      expect(slicers.open).toHaveBeenCalledWith('f2', 'p1', { mode: 'new-project' }),
    )
    expect(screen.queryByText(en.projects.curaHazardTitle)).toBeNull()
  })

  it('offers no launch control while the configuration cannot be read', async () => {
    slicers.get.mockRejectedValue(new ApiError('Conflict', 'newer'))
    await open()

    await waitFor(() => expect(slicers.get).toHaveBeenCalled())
    // Without the facts the shell reads the page cannot say which product a launch would use, and
    // so cannot warn before the call: it offers nothing instead of guessing.
    expect(names()).not.toContain(`${en.projects.newSlicerProject} benchy.stl`)
  })
})
