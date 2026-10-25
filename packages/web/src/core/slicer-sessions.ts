import { createSignal } from 'solid-js'
import {
  PROJECT_LIMIT_MAX,
  type FileState,
  type SlicerSessionDto,
  type ProjectDto,
} from '../api/generated'
import { api, type ApiClient } from './api/client'
import { isApiError } from './api/error'
import { desktop, type DesktopClient } from './desktop'
import { formatBytes } from './format-bytes'
import { t } from './i18n'
import { slicerDisplayName } from './slicer-names'

/**
 * After a launch: what came back, what did not, and what the user wants done about it.
 *
 * ## What it will not say
 *
 * - **Never "the slicer was closed".** The only observable fact is whether the process the app
 *   spawned is still running, and several slicers hand the file to an already-running instance and
 *   exit at once, so a dead process routinely means a live slicer. The label says what was measured
 *   and nothing more.
 * - **Never which setting changed.** The diff is computed by name over the entries of the archive;
 *   it can say `Metadata/project_settings.config` changed and not what inside it did. The limit is
 *   printed beside the findings.
 * - **Never that anything was deleted on the user's behalf.** Nothing in the list disappears
 *   without one of the two buttons on it being pressed.
 *
 * ## Stale
 *
 * A session whose launch is more than {@link STALE_SESSION_MS} old is labelled stale and offered to
 * the bulk discard. It is about the launch rather than about the file: a stale session may well
 * hold a file that came back yesterday, which is exactly why being stale is a label and never a
 * reason to delete anything.
 */

/**
 * Thirty days, after which a session is *listed as stale*: listed, never deleted. **A judgement,
 * not a measurement** (spec 6.3), and the only copy of the number: staleness is applied here and
 * nowhere else, over the `startedAt` every `SlicerSessionDto` carries.
 */
export const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000

/** One row, with everything the page would otherwise recompute per binding. */
export type SessionRow = {
  session: SlicerSessionDto
  stale: boolean
  /** True when the user must say where this file belongs before it can be imported. */
  needsProject: boolean
  /** Whether "add to the project" is offered at all. */
  canImport: boolean
  /** Whether to restate why this session will never have anything to import. */
  curaLimit: boolean
}

/**
 * The rows to show. With a `scope` the list is narrowed to that project's own sessions plus any
 * orphan: an orphan has to be offered *somewhere*, and a page that is already about a project is
 * the one place the app can offer to adopt it without asking a second question.
 */
export function sessionRows(
  sessions: readonly SlicerSessionDto[],
  scope: string | null,
  now: number,
): SessionRow[] {
  return sessions
    .filter((session) => scope === null || session.projectId === scope || session.projectId === '')
    .map((session) => ({
      session,
      stale: now - session.startedAt > STALE_SESSION_MS,
      needsProject: session.projectId === '' && scope === null,
      // A file that has not settled is refused by the shell anyway, and offering a button that is
      // going to be refused is worse than not offering it. `unchanged` keeps its button: for a
      // new-project launch the copy that was handed over is a genuinely different file from the
      // original, and the user is the one who knows whether they want it.
      canImport: session.fileState === 'changed' || session.fileState === 'unchanged',
      // Only while nothing has come back, which for Cura is for ever. A Cura session that did
      // change is one the user aimed a Save-As at deliberately.
      curaLimit: session.slicerId === 'cura' && session.fileState === 'unchanged',
    }))
}

export function stateKey(
  state: FileState,
):
  | 'slicerSessions.stateUnchanged'
  | 'slicerSessions.stateChanged'
  | 'slicerSessions.stateSettling'
  | 'slicerSessions.stateUnreadable' {
  switch (state) {
    case 'unchanged':
      return 'slicerSessions.stateUnchanged'
    case 'changed':
      return 'slicerSessions.stateChanged'
    case 'settling':
      return 'slicerSessions.stateSettling'
    case 'unreadable':
      return 'slicerSessions.stateUnreadable'
  }
}

/** The one sentence under a row: where it came from, and what it weighs now. */
export function describeSession(session: SlicerSessionDto): string {
  const parts: string[] = []
  if (session.isOrphan) parts.push(t('slicerSessions.orphanLead'))
  if (session.returnedAs !== undefined && session.returnedAs !== null) {
    parts.push(
      t('slicerSessions.returnedAs', {
        // Product names, not ids: every other surface says "OrcaSlicer".
        source:
          session.sourceSlicer == null
            ? t('slicerSessions.unknownSlicer')
            : slicerDisplayName(session.sourceSlicer),
        returned: slicerDisplayName(session.returnedAs),
      }),
    )
  }
  if (session.sourceSizeBytes !== undefined && session.returnedSizeBytes !== undefined) {
    parts.push(
      t('slicerSessions.sizes', {
        before: formatBytes(session.sourceSizeBytes),
        after: formatBytes(session.returnedSizeBytes),
      }),
    )
  } else if (session.returnedSizeBytes !== undefined) {
    parts.push(formatBytes(session.returnedSizeBytes))
  }
  return parts.join(' ')
}

/**
 * What went wrong, as a sentence, keeping the two codes that mean something specific here.
 *
 * `Conflict` on this card is two different refusals: "the file is still being written" (the one a
 * user can act on by waiting) and "launched from a different library". They are told apart by
 * `details.fileState`, which only the settling refusal carries. `QuotaExceeded` is the one a user
 * can act on by making room, and the only one with numbers in it.
 */
export function sessionFailureMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'Conflict') {
      return error.details['fileState'] === undefined
        ? t('slicerSessions.failedElsewhere')
        : t('slicerSessions.failedSettling')
    }
    if (error.code === 'QuotaExceeded') {
      const usage = error.details['usageBytes']
      const quota = error.details['quotaBytes']
      if (typeof usage === 'number' && typeof quota === 'number') {
        return t('errors.quotaExceeded', { usage: formatBytes(usage), quota: formatBytes(quota) })
      }
    }
  }
  return t('slicerSessions.failed')
}

export type SessionsDeps = {
  client: DesktopClient['slicers']
  projects: Pick<ApiClient['projects'], 'list'>
  now: () => number
}

/**
 * The session list as state. A pull: nothing is pushed from the shell (there is no dependable
 * "slicer closed" signal to push on), so the page re-asks, and a refresh control exists because a
 * pull with no control on it reads as broken to somebody who has just pressed Ctrl+S.
 *
 * `scope` is the project the card is shown beside, or `null` on a page about no project.
 * `onImported` fires after something was imported, so the page holding the card can reload.
 */
export function createSlicerSessions(
  options: {
    scope?: () => string | null
    onImported?: () => void
  } = {},
  deps: Partial<SessionsDeps> = {},
) {
  const client = deps.client ?? desktop.slicers
  const projectsApi = deps.projects ?? api.projects
  const now = deps.now ?? Date.now
  const scope = options.scope ?? (() => null)

  const [sessions, setSessions] = createSignal<SlicerSessionDto[] | null>(null)
  const [busy, setBusy] = createSignal(false)
  /** The sentence to show, already resolved. Null when the last thing that happened worked. */
  const [failure, setFailure] = createSignal<string | null>(null)
  const [clock, setClock] = createSignal(now())
  const [projects, setProjects] = createSignal<ProjectDto[]>([])
  /**
   * The project each orphan is being adopted into, keyed by its own `launchId`: the settings page
   * shows every orphan there is, and one signal bound to every row would fill in all of them at
   * once ("only the user can say where an orphan belongs", answered once for all of them).
   */
  const [chosen, setChosen] = createSignal<Readonly<Record<string, string | null>>>({})

  const rows = () => sessionRows(sessions() ?? [], scope(), clock())
  const staleRows = () => rows().filter((row) => row.stale)

  /**
   * Re-reads the list **without touching the failure**: every action reloads, because every action
   * changes what the list would say, and a reload that also cleared the failure wiped the message
   * an action had just set before anything rendered it. A listing that fails still raises its own
   * failure; it only may not *clear* one.
   */
  async function load(): Promise<void> {
    try {
      const listed = await client.sessions()
      setSessions(listed)
      setClock(now())
      // Only where somebody actually has to answer "which project", so the ordinary case costs no
      // second round trip.
      if (listed.some((session) => session.projectId === '') && scope() === null) {
        await loadProjects()
      }
    } catch (error) {
      setFailure(sessionFailureMessage(error))
      setSessions([])
      console.error('slicer sessions: could not be listed', error)
    }
  }

  async function loadProjects(): Promise<void> {
    try {
      setProjects(await projectsApi.list({ limit: PROJECT_LIMIT_MAX }))
    } catch (error) {
      // Not a failure of the list itself: the sessions are still shown, and the only thing lost is
      // the ability to adopt an orphan from this page.
      console.error('slicer sessions: the project list could not be loaded', error)
    }
  }

  /** One call, one reload, one message. */
  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    try {
      await action()
    } catch (error) {
      setFailure(sessionFailureMessage(error))
      console.error('slicer sessions: an action failed', error)
    } finally {
      setBusy(false)
      await load()
    }
  }

  return {
    sessions,
    rows,
    staleRows,
    busy,
    failure,
    projects,
    loading: () => sessions() === null && failure() === null,
    chosenProject: (launchId: string) => chosen()[launchId] ?? null,
    setChosenProject: (launchId: string, projectId: string | null) =>
      setChosen((current) => ({ ...current, [launchId]: projectId })),
    /** Re-asks the shell, and clears whatever the last answer said. */
    async reload(): Promise<void> {
      setFailure(null)
      await load()
    },
    async importRow(row: SessionRow): Promise<void> {
      const launchId = row.session.launchId
      const projectId = row.needsProject ? chosen()[launchId] : scope()
      await run(async () => {
        await client.resolveSession(launchId, 'import', projectId ? { projectId } : {})
        // Only on the way past the call: a failed import leaves the row, and the answer the user
        // gave for it, exactly where they were.
        setChosen(({ [launchId]: _gone, ...rest }) => rest)
        options.onImported?.()
      })
    },
    discardRow: (row: SessionRow) =>
      run(() => client.resolveSession(row.session.launchId, 'discard')),
    discardStale: () =>
      run(() => client.discardSessions(staleRows().map((row) => row.session.launchId))),
  }
}

export type SlicerSessions = ReturnType<typeof createSlicerSessions>
