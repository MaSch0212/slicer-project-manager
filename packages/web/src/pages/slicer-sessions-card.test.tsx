import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SlicerSessionDto } from '../api/generated'
import { ApiError } from '../core/api/error'
import type { DesktopClient } from '../core/desktop'
import { setLanguage } from '../core/i18n'
import en from '../core/i18n/en.json'
import { sessionRows, STALE_SESSION_MS } from '../core/slicer-sessions'
import { SlicerSessionsCard } from './slicer-sessions-card'

/**
 * The card that answers "what came back?", and the three things it is not allowed to say. A port of
 * the Angular `SlicerSessionsCard` spec, case for case.
 *
 * Everything here is against the shell-client seam with a real component: the shell's answers are
 * the input, and what the user reads and presses is the output. Nothing reimplements the shell: the
 * interesting assertions are about what the card does with a `SlicerSessionDto` it was handed.
 */

const NOW = 1_756_000_000_000

function session(overrides: Partial<SlicerSessionDto> = {}): SlicerSessionDto {
  return {
    launchId: 'launch-1',
    projectId: 'p1',
    fileId: 'f1',
    fileName: 'bracket.3mf',
    slicerId: 'orca',
    startedAt: NOW,
    processAlive: false,
    fileState: 'changed',
    isOrphan: false,
    ...overrides,
  }
}

type Shell = { sessions: Mock; resolveSession: Mock; discardSessions: Mock }

function setup(
  sessions: SlicerSessionDto[],
  options: {
    projectId?: string
    projects?: { id: string; name: string }[]
    onImported?: () => void
    shell?: Partial<Shell>
  } = {},
) {
  const shell: Shell = {
    sessions: vi.fn().mockResolvedValue(sessions),
    resolveSession: vi.fn().mockResolvedValue(null),
    discardSessions: vi.fn().mockResolvedValue({ discarded: sessions.length }),
    ...options.shell,
  }
  const projects = { list: vi.fn().mockResolvedValue(options.projects ?? []) }
  render(() => (
    <SlicerSessionsCard
      projectId={options.projectId}
      onImported={options.onImported}
      deps={{
        client: shell as unknown as DesktopClient['slicers'],
        projects: projects as never,
        now: () => NOW,
      }}
    />
  ))
  return { shell, projects }
}

/** The first read has landed once the refresh control is enabled and the spinner has gone. */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull())
}

const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? ''
const buttonNamed = (label: string) =>
  screen.queryAllByRole('button').find((button) => (button.textContent ?? '').includes(label))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await setLanguage('en')
})

describe('SlicerSessionsCard', () => {
  it('says nothing came back when there is nothing to answer', async () => {
    setup([])
    await loaded()

    expect(text()).toContain(en.slicerSessions.none)
  })

  it('uploads nothing on its own: the list is read and no answer is given', async () => {
    const { shell } = setup([session()])
    await loaded()

    expect(shell.sessions).toHaveBeenCalledTimes(1)
    // The one property the whole reconcile rests on. Rendering a session is not consenting to
    // anything, and neither is looking at it.
    expect(shell.resolveSession).not.toHaveBeenCalled()
    expect(shell.discardSessions).not.toHaveBeenCalled()
  })

  it('never calls a dead process "the slicer was closed"', async () => {
    setup([session({ processAlive: false })])
    await loaded()

    expect(text()).toContain(en.slicerSessions.processGone)
    // Constraint 11, pinned on the copy itself rather than on a substring search: the sentence has
    // to carry the disclaimer, because a process ending routinely means nothing at all (several
    // slicers hand the file to a copy of themselves that is already running and exit).
    expect(en.slicerSessions.processGone).toMatch(/does not mean the slicer was closed/)
    expect(en.slicerSessions.processAlive).toMatch(/never means the slicer was closed/)
    // And the live label does not claim the slicer is open either.
    expect(en.slicerSessions.processAlive).not.toMatch(/the slicer is open/)
  })

  it('says a live process is alive and still never that the slicer is open', async () => {
    setup([session({ processAlive: true })])
    await loaded()

    expect(text()).toContain(en.slicerSessions.processAlive)
    expect(text()).not.toContain(en.slicerSessions.processGone)
  })

  it('states the diff limit beside the diff', async () => {
    setup([
      session({
        entryDiff: {
          added: ['Metadata/plate_1.png'],
          removed: ['Metadata/cut_information.xml'],
          changed: ['Metadata/project_settings.config'],
        },
      }),
    ])
    await loaded()

    const rendered = text()
    expect(rendered).toContain('Metadata/project_settings.config')
    expect(rendered).toContain('Metadata/plate_1.png')
    expect(rendered).toContain('Metadata/cut_information.xml')
    // The findings and their limit, in the same place. A diff that named a file and implied it knew
    // what inside it changed is the exact overstatement spec 7.4 rejected.
    expect(rendered).toContain(en.slicerSessions.diffLimit)
  })

  it('imports into the project it is shown beside, and reports it upwards', async () => {
    const onImported = vi.fn()
    const { shell } = setup([session()], { projectId: 'p1', onImported })
    await loaded()

    fireEvent.click(buttonNamed(en.slicerSessions.import)!)

    await waitFor(() =>
      expect(shell.resolveSession).toHaveBeenCalledWith('launch-1', 'import', { projectId: 'p1' }),
    )
    // The page holding the card is what reloads; the card cannot know what it is beside.
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
    // And the list is re-read, because the answer changed what it would say.
    await waitFor(() => expect(shell.sessions).toHaveBeenCalledTimes(2))
  })

  it('asks which project an orphan belongs to, and will not import until it is told', async () => {
    const { shell } = setup(
      [session({ projectId: '', fileId: '', isOrphan: true, slicerId: 'cura' })],
      { projects: [{ id: 'p9', name: 'Bracket' }] },
    )
    await loaded()

    expect(text()).toContain(en.slicerSessions.whichProject)
    expect((buttonNamed(en.slicerSessions.import) as HTMLButtonElement).disabled).toBe(true)

    await waitFor(() =>
      expect(
        (screen.getByLabelText(en.slicerSessions.whichProject) as HTMLSelectElement).options,
      ).toHaveLength(2),
    )
    fireEvent.change(screen.getByLabelText(en.slicerSessions.whichProject), {
      target: { value: 'p9' },
    })
    await waitFor(() =>
      expect((buttonNamed(en.slicerSessions.import) as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(buttonNamed(en.slicerSessions.import)!)

    await waitFor(() =>
      expect(shell.resolveSession).toHaveBeenCalledWith('launch-1', 'import', { projectId: 'p9' }),
    )
  })

  it('offers no import for a file that has not settled, and discard either way', async () => {
    setup([session({ fileState: 'settling' })])
    await loaded()

    expect(text()).toContain(en.slicerSessions.stateSettling)
    // The shell refuses this anyway; a button that is going to be refused is worse than none.
    expect(buttonNamed(en.slicerSessions.import)).toBeUndefined()
    expect(buttonNamed(en.slicerSessions.discard)).toBeDefined()
  })

  it('labels a session stale after thirty days, and not before', async () => {
    // The unit spelled so it is legible. What the relative assertions below are all built from is
    // the constant itself, and they would survive a threshold accidentally written in seconds.
    expect(STALE_SESSION_MS / (24 * 60 * 60 * 1000)).toBe(30)
    const rows = sessionRows(
      [
        session({ launchId: 'fresh', startedAt: NOW - STALE_SESSION_MS + 1000 }),
        session({ launchId: 'old-1', startedAt: NOW - STALE_SESSION_MS - 1000 }),
        session({ launchId: 'old-2', startedAt: NOW - STALE_SESSION_MS - 2000 }),
      ],
      null,
      NOW,
    )

    expect(rows.filter((row) => row.stale).map((row) => row.session.launchId)).toEqual([
      'old-1',
      'old-2',
    ])
  })

  it('shows the stale label on an old session and the bulk control only for two or more', async () => {
    setup([
      session({ launchId: 'fresh', startedAt: NOW }),
      session({ launchId: 'old-1', startedAt: NOW - STALE_SESSION_MS - 1 }),
    ])
    await loaded()

    expect(screen.getAllByText(en.slicerSessions.stale)).toHaveLength(1)
    // One old one is a row's own discard; the bulk button is for several.
    expect(buttonNamed('Throw away the')).toBeUndefined()
  })

  it('discards the stale ones together, and only those', async () => {
    const { shell } = setup([
      session({ launchId: 'fresh', startedAt: NOW }),
      session({ launchId: 'old-1', startedAt: NOW - STALE_SESSION_MS - 1 }),
      session({ launchId: 'old-2', startedAt: NOW - STALE_SESSION_MS - 2 }),
    ])
    await loaded()

    fireEvent.click(buttonNamed('Throw away the 2 old ones')!)

    await waitFor(() => expect(shell.discardSessions).toHaveBeenCalledWith(['old-1', 'old-2']))
  })

  it('shows only this project sessions, plus an orphan that belongs to nobody', async () => {
    setup(
      [
        session({ launchId: 'mine', projectId: 'p1', fileName: 'mine.3mf' }),
        session({ launchId: 'theirs', projectId: 'p2', fileName: 'theirs.3mf' }),
        session({ launchId: 'stray', projectId: '', isOrphan: true, fileName: 'stray.3mf' }),
      ],
      { projectId: 'p1' },
    )
    await loaded()

    // An orphan has to be offered somewhere, and a page that already names a project is the one
    // place the app can offer to adopt it without asking a second question.
    expect(text()).toContain('mine.3mf')
    expect(text()).toContain('stray.3mf')
    expect(text()).not.toContain('theirs.3mf')
    // And beside a project the orphan is not asked "which project?".
    expect(text()).not.toContain(en.slicerSessions.whichProject)
  })

  // The failure path an action takes, which showed the user nothing at all until it was fixed: the
  // reload every action ends with used to clear the failure as its first statement, so the banner
  // the catch had just set was wiped before a frame was drawn. Every one of the next four would
  // have been silent: a refusal, a quota, another library, and a bridge that is not there.
  it('shows the shell refusal when an import is refused, and leaves the session listed', async () => {
    const { shell } = setup([session()], { projectId: 'p1' })
    await loaded()
    // `details.fileState`, because that is what the shell actually sends and it is the only thing
    // that tells this `Conflict` from the other one the same call can raise.
    shell.resolveSession.mockRejectedValue(
      new ApiError('Conflict', 'that file is still being written; try again in a moment', {
        details: { fileState: 'settling' },
      }),
    )

    fireEvent.click(buttonNamed(en.slicerSessions.import)!)

    await waitFor(() => expect(text()).toContain(en.slicerSessions.failedSettling))
    // Still there, because the sweep only runs after a successful upload.
    expect(text()).toContain('bracket.3mf')
  })

  it('puts the numbers in front of the user when the upload would not fit', async () => {
    const { shell } = setup([session()], { projectId: 'p1' })
    await loaded()
    shell.resolveSession.mockRejectedValue(
      new ApiError('QuotaExceeded', 'no room', {
        details: {
          usageBytes: 1024 * 1024 * 900,
          quotaBytes: 1024 * 1024 * 1024,
          incomingBytes: 4096,
        },
      }),
    )

    fireEvent.click(buttonNamed(en.slicerSessions.import)!)

    await waitFor(() => expect(text()).toContain('900.0 MB'))
    expect(text()).toContain('1.0 GB')
  })

  it('does not tell a user to wait for a file that belongs to another library', async () => {
    const { shell } = setup([session()], { projectId: 'p1' })
    await loaded()
    // The other `Conflict` this call can raise: reachable only across a race, since a foreign
    // session is not listed, which is exactly why it has to be right.
    shell.resolveSession.mockRejectedValue(
      new ApiError('Conflict', 'that file was launched from a different library', {
        details: { launchId: 'launch-1' },
      }),
    )

    fireEvent.click(buttonNamed(en.slicerSessions.import)!)

    await waitFor(() => expect(text()).toContain(en.slicerSessions.failedElsewhere))
    expect(text()).not.toContain(en.slicerSessions.failedSettling)
  })

  it('shows a failed discard rather than swallowing it', async () => {
    const { shell } = setup([session()], { projectId: 'p1' })
    await loaded()
    shell.resolveSession.mockRejectedValue(new Error('bridge gone'))

    fireEvent.click(buttonNamed(en.slicerSessions.discard)!)

    await waitFor(() => expect(text()).toContain(en.slicerSessions.failed))
  })

  it('clears the message once something works', async () => {
    const { shell } = setup([session()], { projectId: 'p1' })
    await loaded()
    shell.resolveSession.mockRejectedValueOnce(
      new ApiError('Conflict', 'wait', { details: { fileState: 'settling' } }),
    )

    fireEvent.click(buttonNamed(en.slicerSessions.import)!)
    await waitFor(() => expect(text()).toContain(en.slicerSessions.failedSettling))

    // The pair: a banner that never cleared would be as wrong as one that never showed.
    fireEvent.click(buttonNamed(en.slicerSessions.import)!)
    await waitFor(() => expect(text()).not.toContain(en.slicerSessions.failedSettling))
  })

  it('re-asks the shell when the refresh control is pressed', async () => {
    const { shell } = setup([session()])
    await loaded()
    expect(shell.sessions).toHaveBeenCalledTimes(1)

    fireEvent.click(buttonNamed(en.slicerSessions.refresh)!)

    // Nothing pushes from the shell, so this is the only way to re-ask, and a page with no way to
    // re-ask reads as broken to somebody who has just pressed Ctrl+S.
    await waitFor(() => expect(shell.sessions).toHaveBeenCalledTimes(2))
  })

  it('answers each orphan separately, and forgets the answer once it is used', async () => {
    const { shell } = setup(
      [
        session({ launchId: 'a', projectId: '', isOrphan: true, fileName: 'a.3mf' }),
        session({ launchId: 'b', projectId: '', isOrphan: true, fileName: 'b.3mf' }),
      ],
      { projects: [{ id: 'p9', name: 'Bracket' }] },
    )
    await loaded()
    await waitFor(() =>
      expect(screen.getAllByLabelText(en.slicerSessions.whichProject)[0]!.children).toHaveLength(2),
    )

    fireEvent.change(screen.getAllByLabelText(en.slicerSessions.whichProject)[0]!, {
      target: { value: 'p9' },
    })

    // One signal for every row meant answering for A also answered for B, and enabled B's import
    // button with a project nobody chose for it.
    const imports = () =>
      screen
        .getAllByRole('button')
        .filter((button) =>
          (button.textContent ?? '').includes(en.slicerSessions.import),
        ) as HTMLButtonElement[]
    await waitFor(() => expect(imports().map((button) => button.disabled)).toEqual([false, true]))

    fireEvent.click(imports()[0]!)

    await waitFor(() =>
      expect(shell.resolveSession).toHaveBeenCalledWith('a', 'import', { projectId: 'p9' }),
    )
    // The answer was used, so it is forgotten: both rows are asking again.
    await waitFor(() => expect(imports().map((button) => button.disabled)).toEqual([true, true]))
  })

  it('restates why a Cura session will never have anything to import', async () => {
    setup([session({ slicerId: 'cura', fileState: 'unchanged' })])
    await loaded()

    // The pre-launch warning is dismissible and long gone by the time anybody reads this row.
    expect(text()).toContain(en.slicerSessions.curaLimit)
  })

  it('does not restate the Cura limit over a Cura file that did come back', async () => {
    setup([session({ slicerId: 'cura', fileState: 'changed' })])
    await loaded()

    // The user aimed a Save-As at the launch directory. Telling them it cannot happen while it is
    // on screen having happened would be the app arguing with the disk.
    expect(text()).not.toContain(en.slicerSessions.curaLimit)
  })

  it('says what became of a file in the words of the products, not their ids', async () => {
    setup([
      session({
        sourceSlicer: 'bambu',
        returnedAs: 'orca',
        sourceSizeBytes: 2048,
        returnedSizeBytes: 4096,
      }),
    ])
    await loaded()

    expect(text()).toContain(
      'It went out as a Bambu Studio project and came back as a OrcaSlicer one.',
    )
    expect(text()).toContain('2.0 kB when it went out, 4.0 kB now.')
  })

  it('says so when the list cannot be read, and adds nothing', async () => {
    const { shell } = setup([], {
      shell: { sessions: vi.fn().mockRejectedValue(new Error('bridge gone')) },
    })

    await waitFor(() => expect(text()).toContain(en.slicerSessions.failed))
    expect(shell.resolveSession).not.toHaveBeenCalled()
  })

  it('follows the project it is shown beside when that changes', async () => {
    const [projectId, setProjectId] = createSignal('p1')
    const shell = {
      sessions: vi
        .fn()
        .mockResolvedValue([
          session({ launchId: 'one', projectId: 'p1', fileName: 'one.3mf' }),
          session({ launchId: 'two', projectId: 'p2', fileName: 'two.3mf' }),
        ]),
      resolveSession: vi.fn(),
      discardSessions: vi.fn(),
    }
    render(() => (
      <SlicerSessionsCard
        projectId={projectId()}
        deps={{
          client: shell as unknown as DesktopClient['slicers'],
          projects: { list: vi.fn() } as never,
          now: () => NOW,
        }}
      />
    ))
    await loaded()
    expect(text()).toContain('one.3mf')
    expect(text()).not.toContain('two.3mf')

    setProjectId('p2')

    await waitFor(() => expect(text()).toContain('two.3mf'))
    expect(text()).not.toContain('one.3mf')
  })
})
