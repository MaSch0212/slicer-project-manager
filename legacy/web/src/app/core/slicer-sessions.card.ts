import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core'
import { interpolate, InterpolatePipe } from '@ngneers/signal-translate'
import { JigButton } from '@awdlab/jig/button'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import type { SlicerSessionDto } from '@spm/contract/dtos.ts'
import { isAppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import { API_CLIENT, SHELL_CLIENT } from './api/api-client.token'
import { slicerDisplayName } from './slicer-products'
import { TranslateService } from './i18n/translate.service'
import { formatBytes } from './format-bytes'

/**
 * After a launch: what came back, what did not, and what the user wants done about it.
 *
 * **It lives in `core/` rather than under `features/desktop/`, and that is deliberate.** Two
 * pages render it — `/settings/slicers`, which is desktop-only, and the project page, which is
 * shared code that both builds contain — and spec 2.5 forbids shared code importing anything from
 * `features/desktop/`. Putting one copy here is the alternative to two copies that can drift. It
 * costs the web bundle a component that never renders there: `canLaunchSlicer` is false in the
 * browser column, so nothing mounts it, and `SHELL_CLIENT` is an `HttpApiClient` that refuses
 * every call it would make. That is the capability model doing its job in place of a build-time
 * condition, which is the same argument the launch controls on the project page already rest on.
 *
 * ## What it will not say
 *
 * - **Never "the slicer was closed".** The only observable fact is whether the process this app
 *   spawned is still running, and several slicers hand the file to an already-running instance
 *   and exit immediately — so a dead process routinely means a live slicer. The label says what
 *   was measured and nothing more.
 * - **Never which setting changed.** The diff is computed, by name, over the entries of the
 *   archive; it can say that `Metadata/project_settings.config` changed and it cannot say what
 *   inside it did. The limit is printed beside the findings, in the same size type.
 * - **Never that anything was deleted on the user's behalf.** Nothing in this list disappears
 *   without one of the two buttons on it being pressed.
 *
 * ## Stale
 *
 * A session whose launch is more than {@link STALE_SESSION_MS} old is labelled stale and offered
 * to the bulk discard. It is deliberately about the launch rather than about the file — a stale
 * session may well hold a file that came back yesterday, which is exactly why being stale is a
 * label and never a reason to delete anything.
 */

/**
 * Thirty days, after which a session is *listed as stale* — listed, never deleted.
 *
 * **A judgement, not a measurement**, chosen in spec 6.3, which is the one home of the reasoning.
 * And **this is the only copy of the number in the codebase**: the desktop package used to export
 * one too, read by nothing, under a docblock claiming it gave the number "one home". It did the
 * opposite, and the spec that was supposed to keep the two honest asserted
 * `STALE_SESSION_MS === 30 * 24 * 60 * 60 * 1000` — a constant compared against its own literal,
 * in the module that defines it, which stays green whatever the other copy says. Deleting the
 * unread one is the honest fix; inventing a coupling to guard would have been the other kind.
 *
 * It lives *here* rather than there because staleness is applied here and nowhere else: the main
 * process does not act on it, and `SlicerSessionDto` carries `startedAt` precisely so a consumer
 * can age a session itself.
 */
export const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000

/** One row, with everything the template would otherwise recompute per binding. */
type SessionRow = {
  session: SlicerSessionDto
  stale: boolean
  /** True when the user must say where this file belongs before it can be imported. */
  needsProject: boolean
  /** Whether "add to the project" is offered at all. */
  canImport: boolean
  /** Whether to restate why this session will never have anything to import. */
  curaLimit: boolean
}

@Component({
  selector: 'app-slicer-sessions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InterpolatePipe, JigButton, JigInputField, JigMessage, JigSelect, JigSpinner, JigTag],
  template: `
    <section class="spm-card spm-stack">
      <div>
        <h2>{{ t.translations().slicerSessions.title }}</h2>
        <p class="spm-muted">{{ t.translations().slicerSessions.lead }}</p>
      </div>

      @if (failure(); as message) {
        <jig-message color="error" role="alert">{{ message }}</jig-message>
      }

      <div class="spm-row">
        <!--
          The only way to re-ask. Nothing pushes from the main process — there is no IPC channel
          back and no dependable "slicer closed" signal to push on — so this page is a pull, and
          a pull with no control on it reads as broken to somebody who has just pressed Ctrl+S.
        -->
        <button jigButton kind="secondary" type="button" [disabled]="busy()" (click)="reload()">
          {{ t.translations().slicerSessions.refresh }}
        </button>
        @if (loading() || busy()) {
          <jig-spinner [size]="20" />
        }
      </div>

      @if (rows().length === 0) {
        <p class="spm-muted">{{ t.translations().slicerSessions.none }}</p>
      }

      @if (staleRows().length > 1) {
        <span>
          <button
            jigButton
            kind="secondary"
            type="button"
            [disabled]="busy()"
            (click)="onDiscardStale()"
          >
            {{
              t.translations().slicerSessions.discardStale
                | interpolate: { count: staleRows().length }
            }}
          </button>
        </span>
      }

      @for (row of rows(); track row.session.launchId) {
        <div class="spm-stack spm-stack--tight spm-session">
          <div class="spm-row">
            <strong>{{ row.session.fileName }}</strong>
            <jig-tag [color]="stateColour(row.session.fileState)">
              {{ stateLabel(row.session.fileState) }}
            </jig-tag>
            @if (row.session.isOrphan) {
              <jig-tag color="warning">{{ t.translations().slicerSessions.orphan }}</jig-tag>
            }
            @if (row.stale) {
              <jig-tag color="secondary">{{ t.translations().slicerSessions.stale }}</jig-tag>
            }
          </div>

          <p class="spm-muted">{{ describe(row.session) }}</p>

          @if (row.curaLimit) {
            <!--
              Restated where the user meets the consequence. Cura never saves in place — its
              Ctrl+S is always a Save-As into a folder of its own — so a Cura session sits here
              reading "Nothing came back" for ever, and the pre-launch warning that said why was
              dismissible and is long gone by the time anybody reads this row.
            -->
            <jig-message color="warning" role="status">
              {{ t.translations().slicerSessions.curaLimit }}
            </jig-message>
          }

          <!--
            Constraint 11. Whether the process the app spawned is alive is the only thing it can
            observe, and it is not "the slicer is open": several slicers hand the file over and
            exit while the window stays up.
          -->
          <p class="spm-muted">
            {{
              row.session.processAlive
                ? t.translations().slicerSessions.processAlive
                : t.translations().slicerSessions.processGone
            }}
          </p>

          @if (row.session.entryDiff; as diff) {
            <div class="spm-stack spm-stack--tight">
              <span>{{ t.translations().slicerSessions.diffTitle }}</span>
              <ul>
                @for (name of diff.changed; track name) {
                  <li>{{ t.translations().slicerSessions.diffChanged | interpolate: { name } }}</li>
                }
                @for (name of diff.added; track name) {
                  <li>{{ t.translations().slicerSessions.diffAdded | interpolate: { name } }}</li>
                }
                @for (name of diff.removed; track name) {
                  <li>
                    {{ t.translations().slicerSessions.diffRemoved | interpolate: { name } }}
                  </li>
                }
              </ul>
              <!-- Stated as plainly as the findings: it says an entry changed, never which
                   setting inside it did. -->
              <p class="spm-muted">{{ t.translations().slicerSessions.diffLimit }}</p>
            </div>
          }

          @if (row.needsProject) {
            <jig-input-field
              class="spm-block"
              [inputId]="'session-project-' + row.session.launchId"
              [label]="t.translations().slicerSessions.whichProject"
            >
              <jig-select
                [inputId]="'session-project-' + row.session.launchId"
                [label]="t.translations().slicerSessions.whichProject"
                [options]="projectOptions()"
                [placeholder]="t.translations().slicerSessions.whichProjectPlaceholder"
                [disabled]="busy()"
                [value]="chosenProject(row.session.launchId)"
                (valueChange)="setChosenProject(row.session.launchId, $event ?? null)"
              />
            </jig-input-field>
          }

          <div class="spm-row">
            @if (row.canImport) {
              <button
                jigButton
                kind="primary"
                type="button"
                [disabled]="
                  busy() || (row.needsProject && chosenProject(row.session.launchId) === null)
                "
                (click)="onImport(row)"
              >
                {{ t.translations().slicerSessions.import }}
              </button>
            }
            <button
              jigButton
              kind="text"
              color="error"
              type="button"
              [disabled]="busy()"
              (click)="onDiscard(row)"
            >
              {{ t.translations().slicerSessions.discard }}
            </button>
          </div>
        </div>
      }
    </section>
  `,
})
export class SlicerSessionsCard {
  private readonly shell = inject(SHELL_CLIENT)
  private readonly api = inject(API_CLIENT)
  protected readonly t = inject(TranslateService)

  /**
   * The project this card is being shown beside, or null on a page that is about no project.
   *
   * When it is set the list is narrowed to that project's own sessions plus any orphan — an
   * orphan has to be offered *somewhere*, and a page that is already about a project is the one
   * place the app can offer to adopt it without asking a second question.
   */
  readonly projectId = input<string | null>(null)

  /** Fired after something was imported, so the page holding this can reload what it shows. */
  readonly imported = output<void>()

  readonly #sessions = signal<SlicerSessionDto[] | null>(null)
  readonly #busy = signal(false)
  /** The sentence to show, already resolved. Null when the last thing that happened worked. */
  readonly #failure = signal<string | null>(null)
  readonly #now = signal(Date.now())
  readonly sessions = this.#sessions.asReadonly()
  readonly busy = this.#busy.asReadonly()
  readonly failure = this.#failure.asReadonly()
  readonly loading = computed(() => this.#sessions() === null && this.#failure() === null)

  /**
   * The project each orphan is being adopted into, keyed by its own `launchId`.
   *
   * **Keyed, and not one signal, because `/settings/slicers` shows every orphan there is.** A
   * single signal bound to every row meant choosing a project for one filled in the select of all
   * the others and enabled their import buttons with it — "only the user can say where an orphan
   * belongs", answered once for all of them. Visible rather than silent, but it is the wrong
   * question asked once.
   */
  readonly #chosenProjects = signal<Readonly<Record<string, string | null>>>({})
  readonly #projects = signal<{ label: string; value: string }[]>([])
  readonly projectOptions = this.#projects.asReadonly()

  chosenProject(launchId: string): string | null {
    return this.#chosenProjects()[launchId] ?? null
  }

  setChosenProject(launchId: string, projectId: string | null): void {
    this.#chosenProjects.update((current) => ({ ...current, [launchId]: projectId }))
  }

  /** Resolves once the first load has settled, so a spec can await it rather than count ticks. */
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.reload()
  }

  readonly rows = computed<SessionRow[]>(() => {
    const scope = this.projectId()
    const now = this.#now()
    return (this.#sessions() ?? [])
      .filter(
        (session) => scope === null || session.projectId === scope || session.projectId === '',
      )
      .map((session) => ({
        session,
        stale: now - session.startedAt > STALE_SESSION_MS,
        needsProject: session.projectId === '' && scope === null,
        // A file that has not settled is refused by the shell anyway, and offering a button that
        // is going to be refused is worse than not offering it. `unchanged` keeps its button: for
        // a new-project launch the copy that was handed over is a genuinely different file from
        // the original, and the user is the one who knows whether they want it.
        canImport: session.fileState === 'changed' || session.fileState === 'unchanged',
        // Only while nothing has come back, which for Cura is for ever. A Cura session that did
        // change is one the user aimed a Save-As at deliberately, and telling them it cannot
        // happen while it is on screen having happened would be the app arguing with the disk.
        curaLimit: session.slicerId === 'cura' && session.fileState === 'unchanged',
      }))
  })

  readonly staleRows = computed(() => this.rows().filter((row) => row.stale))

  /** Re-asks the shell, and clears whatever the last answer said. The refresh control calls it. */
  async reload(): Promise<void> {
    this.#failure.set(null)
    await this.#load()
  }

  /**
   * Re-reads the list **without touching the failure state**, which is the whole of the fix.
   *
   * `#run`'s `finally` reloads, because every action changes what the list would say. When that
   * reload also cleared the failure, the banner an action had just set was wiped before Angular
   * ever rendered it — so a refused import, a `QuotaExceeded`, a dead bridge all showed the user
   * nothing at all, on a row that then stayed listed with "Throw it away" beside it. A listing
   * that fails still raises its own failure here; it only may not *clear* one.
   */
  async #load(): Promise<void> {
    try {
      const sessions = await this.shell.slicers.sessions()
      this.#sessions.set(sessions)
      this.#now.set(Date.now())
      // Only where somebody actually has to answer "which project", so the ordinary case costs no
      // second round trip.
      if (sessions.some((session) => session.projectId === '') && this.projectId() === null) {
        await this.#loadProjects()
      }
    } catch (error) {
      this.#failure.set(describeFailure(error, this.t))
      this.#sessions.set([])
      console.error('slicer sessions: could not be listed', error)
    }
  }

  async onImport(row: SessionRow): Promise<void> {
    const launchId = row.session.launchId
    const projectId = row.needsProject ? this.chosenProject(launchId) : this.projectId()
    await this.#run(async () => {
      await this.shell.slicers.resolveSession(launchId, 'import', {
        ...(projectId === null ? {} : { projectId }),
      })
      // Only on the way past the call: a failed import leaves the row, and the answer the user
      // gave for it, exactly where they were.
      this.#chosenProjects.update(({ [launchId]: _gone, ...rest }) => rest)
      this.imported.emit()
    })
  }

  async onDiscard(row: SessionRow): Promise<void> {
    await this.#run(() => this.shell.slicers.resolveSession(row.session.launchId, 'discard'))
  }

  async onDiscardStale(): Promise<void> {
    const launchIds = this.staleRows().map((row) => row.session.launchId)
    await this.#run(() => this.shell.slicers.discardSessions(launchIds))
  }

  protected stateLabel(state: SlicerSessionDto['fileState']): string {
    const strings = this.t.translations().slicerSessions
    switch (state) {
      case 'unchanged':
        return strings.stateUnchanged
      case 'changed':
        return strings.stateChanged
      case 'settling':
        return strings.stateSettling
      case 'unreadable':
        return strings.stateUnreadable
    }
  }

  protected stateColour(state: SlicerSessionDto['fileState']): 'primary' | 'secondary' | 'error' {
    if (state === 'changed') return 'primary'
    if (state === 'unreadable') return 'error'
    return 'secondary'
  }

  /** The one sentence under a row: where it came from, and what it weighs now. */
  protected describe(session: SlicerSessionDto): string {
    const strings = this.t.translations().slicerSessions
    const parts: string[] = []
    if (session.isOrphan) parts.push(strings.orphanLead)
    if (session.returnedAs !== undefined && session.returnedAs !== null) {
      parts.push(
        // Product names, not ids. Every other surface in the app says "OrcaSlicer"; this said
        // "orca", which reads as a different thing rather than as the same thing abbreviated.
        interpolate(strings.returnedAs, {
          source:
            session.sourceSlicer == null
              ? strings.unknownSlicer
              : slicerDisplayName(session.sourceSlicer),
          returned: slicerDisplayName(session.returnedAs),
        }),
      )
    }
    if (session.sourceSizeBytes !== undefined && session.returnedSizeBytes !== undefined) {
      parts.push(
        interpolate(strings.sizes, {
          before: formatBytes(session.sourceSizeBytes),
          after: formatBytes(session.returnedSizeBytes),
        }),
      )
    } else if (session.returnedSizeBytes !== undefined) {
      parts.push(formatBytes(session.returnedSizeBytes))
    }
    return parts.join(' ')
  }

  async #loadProjects(): Promise<void> {
    try {
      const projects = await this.api.projects.list({})
      this.#projects.set(projects.map((project) => ({ label: project.name, value: project.id })))
    } catch (error) {
      // Not a failure of the list itself: the sessions are still shown, and the only thing lost is
      // the ability to adopt an orphan from this page.
      console.error('slicer sessions: the project list could not be loaded', error)
    }
  }

  /**
   * One call, one reload, one message. Everything here changes what `sessions()` would answer.
   *
   * The reload is `#load` and not `reload`, and that is not a detail: `reload` clears the failure
   * state, so reloading through it in this `finally` wiped the message this `catch` had just set
   * before anything rendered it.
   */
  async #run(action: () => Promise<unknown>): Promise<void> {
    if (this.#busy()) return
    this.#busy.set(true)
    this.#failure.set(null)
    try {
      await action()
    } catch (error) {
      this.#failure.set(describeFailure(error, this.t))
      if (!isAppError(error)) console.error('slicer sessions: an unexpected failure', error)
      else console.error(`slicer sessions: ${error.code}`, error.message)
    } finally {
      this.#busy.set(false)
      await this.#load()
    }
  }
}

/**
 * What went wrong, as a sentence, keeping the two codes that mean something specific here.
 *
 * Constraint 5 carries an `AppError`'s identity all the way across the IPC boundary, and the last
 * frame is the one that decides whether that was worth anything. `Conflict` on this card is
 * "the file is still being written", which is the one refusal a user can act on by waiting;
 * `QuotaExceeded` is the one they can act on by making room, and it is the only one with numbers
 * in it. Everything else says so plainly rather than pretending to a diagnosis.
 *
 * Resolved at the moment of failure rather than kept as a kind, unlike `/settings/slicers`: the
 * two interesting sentences interpolate values off the error, so they cannot be re-rendered from
 * a kind alone after a language switch. The cost is a message that stays in the old language
 * until the next action; the alternative is keeping the error object alive in a signal.
 */
function describeFailure(error: unknown, t: TranslateService): string {
  const strings = t.translations().slicerSessions
  if (isAppError(error)) {
    // Two different `Conflict`s reach here, and mapping both to the settling sentence made the
    // shell's carefully named refusal — "launched from a different library" — surface as advice to
    // wait a moment, which can never work. They are told apart by `details.fileState`, which only
    // the settling refusal carries; a code alone cannot, and inventing a third `AppErrorCode` for
    // a distinction one screen makes would be widening a closed union for a sentence.
    if (error.code === 'Conflict') {
      return error.details?.['fileState'] === undefined
        ? strings.failedElsewhere
        : strings.failedSettling
    }
    if (error.code === 'QuotaExceeded') {
      const details = error.details as QuotaExceededDetails | undefined
      if (details) {
        return interpolate(t.translations().errors.quotaExceeded, {
          usage: formatBytes(details.usageBytes),
          quota: formatBytes(details.quotaBytes),
        })
      }
    }
  }
  return strings.failed
}
