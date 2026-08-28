import { Component, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SlicerSessionDto } from '@spm/contract/dtos.ts'
import { AppError } from '@spm/contract/errors.ts'
import { provideJigForTests } from '../../testing/jig'
import { API_CLIENT, SHELL_CLIENT } from './api/api-client.token'
import en from './i18n/locales/en.json'
import { TranslateService } from './i18n/translate.service'
import { SlicerSessionsCard, STALE_SESSION_MS } from './slicer-sessions.card'

/**
 * The card that answers "what came back?", and the three things it is not allowed to say.
 *
 * Everything here is against the `SHELL_CLIENT` seam with a real component: the shell's answers
 * are the input, and what the user reads and presses is the output. Nothing reimplements the
 * main process — the interesting assertions are about what the card does with a `SlicerSessionDto`
 * it was handed, and a double that computed one itself would be testing itself.
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

type Shell = {
  sessions: Mock
  resolveSession: Mock
  discardSessions: Mock
}

/** A host so the card's `projectId` input can be bound the way a real page binds it. */
@Component({
  selector: 'app-session-host',
  imports: [SlicerSessionsCard],
  template: `<app-slicer-sessions [projectId]="projectId()" (imported)="imports.set(1)" />`,
})
class Host {
  readonly projectId = signal<string | null>(null)
  readonly imports = signal(0)
}

async function setup(
  sessions: SlicerSessionDto[],
  options: { projectId?: string | null; projects?: { id: string; name: string }[] } = {},
): Promise<{ fixture: ReturnType<typeof TestBed.createComponent<Host>>; shell: Shell }> {
  vi.setSystemTime(NOW)
  const shell: Shell = {
    sessions: vi.fn().mockResolvedValue(sessions),
    resolveSession: vi.fn().mockResolvedValue(null),
    discardSessions: vi.fn().mockResolvedValue({ discarded: sessions.length }),
  }
  const api = {
    projects: { list: vi.fn().mockResolvedValue(options.projects ?? []) },
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideJigForTests(),
      { provide: SHELL_CLIENT, useValue: { slicers: shell } },
      { provide: API_CLIENT, useValue: api },
    ],
  })
  const translate = TestBed.inject(TranslateService)
  await translate.ready
  const fixture = TestBed.createComponent(Host)
  fixture.componentInstance.projectId.set(options.projectId ?? null)
  await card(fixture).ready
  await settle(fixture)
  return { fixture, shell }
}

function card(fixture: ReturnType<typeof TestBed.createComponent<Host>>): SlicerSessionsCard {
  return fixture.debugElement.children[0]!.componentInstance as SlicerSessionsCard
}

async function settle(fixture: ReturnType<typeof TestBed.createComponent<Host>>): Promise<void> {
  await fixture.whenStable()
  fixture.detectChanges()
}

function text(fixture: ReturnType<typeof TestBed.createComponent<Host>>): string {
  return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? ''
}

function buttonNamed(
  fixture: ReturnType<typeof TestBed.createComponent<Host>>,
  label: string,
): HTMLButtonElement | undefined {
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(label),
  )
}

describe('SlicerSessionsCard', () => {
  it('says nothing came back when there is nothing to answer', async () => {
    const { fixture } = await setup([])

    expect(text(fixture)).toContain(en.slicerSessions.none)
  })

  it('uploads nothing on its own: the list is read and no answer is given', async () => {
    const { shell } = await setup([session()])

    expect(shell.sessions).toHaveBeenCalledTimes(1)
    // The one property the whole reconcile rests on. Rendering a session is not consenting to
    // anything, and neither is looking at it.
    expect(shell.resolveSession).not.toHaveBeenCalled()
    expect(shell.discardSessions).not.toHaveBeenCalled()
  })

  it('never calls a dead process "the slicer was closed"', async () => {
    const { fixture } = await setup([session({ processAlive: false })])

    expect(text(fixture)).toContain(en.slicerSessions.processGone)
    // Constraint 11, pinned on the copy itself rather than on a substring search: the sentence
    // has to carry the disclaimer, because a process ending routinely means nothing at all —
    // several slicers hand the file to a copy of themselves that is already running and exit.
    expect(en.slicerSessions.processGone).toMatch(/does not mean the slicer was closed/)
    expect(en.slicerSessions.processAlive).toMatch(/never means the slicer was closed/)
    // And the live label does not claim the slicer is open either.
    expect(en.slicerSessions.processAlive).not.toMatch(/the slicer is open/)
  })

  it('states the diff limit beside the diff', async () => {
    const { fixture } = await setup([
      session({
        entryDiff: {
          added: ['Metadata/plate_1.png'],
          removed: ['Metadata/cut_information.xml'],
          changed: ['Metadata/project_settings.config'],
        },
      }),
    ])

    const rendered = text(fixture)
    expect(rendered).toContain('Metadata/project_settings.config')
    expect(rendered).toContain('Metadata/plate_1.png')
    expect(rendered).toContain('Metadata/cut_information.xml')
    // The findings and their limit, in the same place. A diff that named a file and implied it
    // knew what inside it changed is the exact overstatement spec 7.4 rejected.
    expect(rendered).toContain(en.slicerSessions.diffLimit)
  })

  it('imports into the project it is shown beside, and reports it upwards', async () => {
    const { fixture, shell } = await setup([session()], { projectId: 'p1' })

    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)

    expect(shell.resolveSession).toHaveBeenCalledWith('launch-1', 'import', { projectId: 'p1' })
    // The page holding the card is what reloads; the card cannot know what it is beside.
    expect(fixture.componentInstance.imports()).toBe(1)
    // And the list is re-read, because the answer changed what it would say.
    expect(shell.sessions).toHaveBeenCalledTimes(2)
  })

  it('asks which project an orphan belongs to, and will not import until it is told', async () => {
    const { fixture, shell } = await setup(
      [session({ projectId: '', fileId: '', isOrphan: true, slicerId: 'cura' })],
      { projects: [{ id: 'p9', name: 'Bracket' }] },
    )

    expect(text(fixture)).toContain(en.slicerSessions.whichProject)
    expect(buttonNamed(fixture, en.slicerSessions.import)?.disabled).toBe(true)

    card(fixture).setChosenProject('launch-1', 'p9')
    await settle(fixture)
    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)

    expect(shell.resolveSession).toHaveBeenCalledWith('launch-1', 'import', { projectId: 'p9' })
  })

  it('offers no import for a file that has not settled, and discard either way', async () => {
    const { fixture } = await setup([session({ fileState: 'settling' })])

    expect(text(fixture)).toContain(en.slicerSessions.stateSettling)
    // The shell refuses this anyway; a button that is going to be refused is worse than none.
    expect(buttonNamed(fixture, en.slicerSessions.import)).toBeUndefined()
    expect(buttonNamed(fixture, en.slicerSessions.discard)).toBeDefined()
  })

  it('labels a session stale after thirty days, and not before', async () => {
    expect(STALE_SESSION_MS).toBe(30 * 24 * 60 * 60 * 1000)
    const { fixture } = await setup([
      session({ launchId: 'fresh', startedAt: NOW - STALE_SESSION_MS + 1000 }),
      session({ launchId: 'old-1', startedAt: NOW - STALE_SESSION_MS - 1000 }),
      session({ launchId: 'old-2', startedAt: NOW - STALE_SESSION_MS - 2000 }),
    ])

    expect(
      card(fixture)
        .staleRows()
        .map((row) => row.session.launchId),
    ).toEqual(['old-1', 'old-2'])
  })

  it('discards the stale ones together, and only those', async () => {
    const { fixture, shell } = await setup([
      session({ launchId: 'fresh', startedAt: NOW }),
      session({ launchId: 'old-1', startedAt: NOW - STALE_SESSION_MS - 1 }),
      session({ launchId: 'old-2', startedAt: NOW - STALE_SESSION_MS - 2 }),
    ])

    buttonNamed(fixture, 'old')?.click()
    await settle(fixture)

    expect(shell.discardSessions).toHaveBeenCalledWith(['old-1', 'old-2'])
  })

  it('shows only this project sessions, plus an orphan that belongs to nobody', async () => {
    const { fixture } = await setup(
      [
        session({ launchId: 'mine', projectId: 'p1', fileName: 'mine.3mf' }),
        session({ launchId: 'theirs', projectId: 'p2', fileName: 'theirs.3mf' }),
        session({ launchId: 'stray', projectId: '', isOrphan: true, fileName: 'stray.3mf' }),
      ],
      { projectId: 'p1' },
    )

    // An orphan has to be offered somewhere, and a page that already names a project is the one
    // place the app can offer to adopt it without asking a second question.
    expect(
      card(fixture)
        .rows()
        .map((row) => row.session.launchId),
    ).toEqual(['mine', 'stray'])
    expect(text(fixture)).not.toContain('theirs.3mf')
  })

  /*
   * The failure path an action takes, which showed the user nothing at all until this round.
   *
   * `#run`'s `finally` reloads, because every answer changes what the list would say — and the
   * reload used to clear the failure state as its first statement, so the banner the `catch` had
   * just set was wiped before Angular rendered a frame. Every one of these three would have been
   * silent: a refusal, a quota, and a bridge that is not there.
   */
  it('shows the shell refusal when an import is refused, and leaves the session listed', async () => {
    const { fixture, shell } = await setup([session()], { projectId: 'p1' })
    shell.resolveSession.mockRejectedValue(
      new AppError('Conflict', 'that file is still being written; try again in a moment'),
    )

    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)

    expect(text(fixture)).toContain(en.slicerSessions.failedSettling)
    // Still there, because `#sweep` only runs after a successful upload — which is why saying
    // nothing was worse than it sounds: "Throw it away" sits beside work that was never imported.
    expect(card(fixture).rows()).toHaveLength(1)
  })

  it('puts the numbers in front of the user when the upload would not fit', async () => {
    const { fixture, shell } = await setup([session()], { projectId: 'p1' })
    shell.resolveSession.mockRejectedValue(
      new AppError('QuotaExceeded', 'no room', {
        usageBytes: 1024 * 1024 * 900,
        quotaBytes: 1024 * 1024 * 1024,
        incomingBytes: 4096,
      }),
    )

    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)

    const rendered = text(fixture)
    expect(rendered).toContain('900.0 MB')
    expect(rendered).toContain('1.0 GB')
  })

  it('shows a failed discard rather than swallowing it', async () => {
    const { fixture, shell } = await setup([session()], { projectId: 'p1' })
    shell.discardSessions.mockRejectedValue(new Error('bridge gone'))
    shell.resolveSession.mockRejectedValue(new Error('bridge gone'))

    buttonNamed(fixture, en.slicerSessions.discard)?.click()
    await settle(fixture)

    expect(text(fixture)).toContain(en.slicerSessions.failed)
  })

  it('clears the message once something works', async () => {
    const { fixture, shell } = await setup([session()], { projectId: 'p1' })
    shell.resolveSession.mockRejectedValueOnce(new AppError('Conflict', 'wait'))

    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)
    expect(text(fixture)).toContain(en.slicerSessions.failedSettling)

    // The pair: a banner that never cleared would be as wrong as one that never showed.
    buttonNamed(fixture, en.slicerSessions.import)?.click()
    await settle(fixture)
    expect(text(fixture)).not.toContain(en.slicerSessions.failedSettling)
  })

  it('re-asks the shell when the refresh control is pressed', async () => {
    const { fixture, shell } = await setup([session()])
    expect(shell.sessions).toHaveBeenCalledTimes(1)

    buttonNamed(fixture, en.slicerSessions.refresh)?.click()
    await settle(fixture)

    // Nothing pushes from the main process, so this is the only way to re-ask, and a page with
    // no way to re-ask reads as broken to somebody who has just pressed Ctrl+S.
    expect(shell.sessions).toHaveBeenCalledTimes(2)
  })

  it('answers each orphan separately, and forgets the answer once it is used', async () => {
    const { fixture, shell } = await setup(
      [
        session({ launchId: 'a', projectId: '', isOrphan: true, fileName: 'a.3mf' }),
        session({ launchId: 'b', projectId: '', isOrphan: true, fileName: 'b.3mf' }),
      ],
      { projects: [{ id: 'p9', name: 'Bracket' }] },
    )

    card(fixture).setChosenProject('a', 'p9')
    await settle(fixture)

    // One signal for every row meant answering for A also answered for B — and enabled B's
    // import button with a project nobody chose for it.
    expect(card(fixture).chosenProject('a')).toBe('p9')
    expect(card(fixture).chosenProject('b')).toBeNull()
    const imports = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].filter(
      (button) => (button.textContent ?? '').includes(en.slicerSessions.import),
    )
    expect(imports.map((button) => button.disabled)).toEqual([false, true])

    imports[0]!.click()
    await settle(fixture)

    expect(shell.resolveSession).toHaveBeenCalledWith('a', 'import', { projectId: 'p9' })
    expect(card(fixture).chosenProject('a')).toBeNull()
  })

  it('restates why a Cura session will never have anything to import', async () => {
    const { fixture } = await setup([session({ slicerId: 'cura', fileState: 'unchanged' })])

    // The pre-launch warning is dismissible and long gone by the time anybody reads this row.
    expect(text(fixture)).toContain(en.slicerSessions.curaLimit)
  })

  it('does not restate the Cura limit over a Cura file that did come back', async () => {
    const { fixture } = await setup([session({ slicerId: 'cura', fileState: 'changed' })])

    // The user aimed a Save-As at the launch directory. Telling them it cannot happen while it is
    // on screen having happened would be the app arguing with the disk.
    expect(text(fixture)).not.toContain(en.slicerSessions.curaLimit)
  })

  it('says so when the list cannot be read, and adds nothing', async () => {
    vi.setSystemTime(NOW)
    const shell = {
      sessions: vi.fn().mockRejectedValue(new Error('bridge gone')),
      resolveSession: vi.fn(),
      discardSessions: vi.fn(),
    }
    TestBed.configureTestingModule({
      providers: [
        ...provideJigForTests(),
        { provide: SHELL_CLIENT, useValue: { slicers: shell } },
        { provide: API_CLIENT, useValue: { projects: { list: vi.fn() } } },
      ],
    })
    await TestBed.inject(TranslateService).ready
    const fixture = TestBed.createComponent(Host)
    await card(fixture).ready
    await settle(fixture)

    expect(text(fixture)).toContain(en.slicerSessions.failed)
    expect(shell.resolveSession).not.toHaveBeenCalled()
  })
})
