import { Component, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SlicerSessionDto } from '@spm/contract/dtos.ts'
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

    card(fixture).chosenProject.set('p9')
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
