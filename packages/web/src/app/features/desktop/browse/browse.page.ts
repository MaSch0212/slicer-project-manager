import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core'
import { InterpolatePipe } from '@ngneers/signal-translate'
import { JigButton } from '@awdlab/jig/button'
import { JigIcon } from '@awdlab/jig/icon'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigInput } from '@awdlab/jig/input'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import tablerArrowLeft from '@iconify/icons-tabler/arrow-left'
import tablerArrowRight from '@iconify/icons-tabler/arrow-right'
import tablerRefresh from '@iconify/icons-tabler/refresh'
import tablerTrash from '@iconify/icons-tabler/trash'
import type {
  BrowseBounds,
  BrowseDownloadDto,
  BrowseNoticeDto,
  BrowseStateDto,
  FileDto,
  ModelSiteDto,
  ProjectDto,
} from '@spm/contract/dtos.ts'
import { isAppError } from '@spm/contract/errors.ts'
import { matchKey, type ModelSiteIdentity } from '@spm/contract/match-key.ts'
import { API_CLIENT, SHELL_CLIENT } from '../../../core/api/api-client.token'
import { CapabilitiesStore } from '../../../core/capabilities.store'
import { formatBytes } from '../../../core/format-bytes'
import { TranslateService } from '../../../core/i18n/translate.service'

/**
 * How often the page asks the shell what the view is doing.
 *
 * A poll rather than a push, because the view's state changes without the renderer having done
 * anything — a site navigates itself, a load finishes, a download starts — and there is no IPC
 * channel back from the main process to say so.
 *
 * **This is the app's first background timer, and there is no idiom here to inherit.** Outside a
 * spec, `setInterval` appears in exactly one file under `packages/web/src/app`, and it is this one.
 * `slicer-sessions.card.ts` is the other page that re-asks the shell for something that moves
 * underneath it, and it does *not* answer the question this way: it re-asks when the user presses
 * its refresh control. So nothing about this timer is unremarkable — one that outlives its
 * component keeps making three IPC calls a tick for the life of the window, which is why the page's
 * `#open` checks its `#destroyed` flag after every await before it schedules this.
 *
 * Spec 4.5's rule is that the app waits on a **navigation** and not on a timer, and this number is
 * only how promptly the answer is noticed.
 */
export const BROWSE_POLL_MS = 500

/**
 * How many consecutive still-loading polls it takes before the page says the site is verifying
 * the connection (spec 4.5).
 *
 * **This is not a timeout and nothing gives up when it is reached.** Two of the four sites answer
 * 403 with Cloudflare's non-interactive managed challenge, which cleared in about 5.6 s and 6.4 s
 * when the spike measured it; a spinner that gave up first would turn a working page into an error
 * message. Past this count the wording changes from "loading" to "the site is checking the
 * connection", the view stays exactly where it is, and nothing retries, reloads or detaches.
 *
 * It is a **count of polls** rather than a duration, and that is deliberate: what the page has
 * observed is "the shell said `isLoading` this many times in a row", which is ordering a test can
 * drive. A wall-clock bound would be the thing CI has twice caught on this project.
 *
 * At {@link BROWSE_POLL_MS} the count lands at about eight seconds, which is beyond both measured
 * clearances with room to spare. The word is "about": the polls are scheduled by `setInterval` and
 * each one awaits three IPC round trips, so the wall-clock moment is not a number this file can
 * state — which is the other half of why the constant is a count.
 */
export const BROWSE_INTERSTITIAL_TICKS = 16

/** How much of a stranger's string is rendered before it is cut. */
export const BROWSE_TEXT_MAX = 160

/**
 * The renderer's registry rows for {@link matchKey}, and **there are none.**
 *
 * This is not an oversight and it is not a placeholder. `matchKey` matches on
 * `ModelSiteIdentity`, whose `identity` is a **function**; `browse.sites()` answers
 * `ModelSiteDto`, which carries `id`, `displayName` and `homeUrl` and deliberately not `hosts` or
 * `identity` — a function cannot cross IPC, and `ModelSiteDto`'s own docblock says the two shapes
 * are for different jobs. So the site list the shell can send is not a list this call can use, and
 * the only two ways to give the renderer real rows are to re-implement four third-party sites'
 * URL rules here — a second copy of `packages/desktop/src/browse/registry.ts`, which that file's
 * "code, not configuration" docblock exists to prevent — or to move matching into the main
 * process, which spec 6.4 rejects for a list the page is fetching anyway.
 *
 * **What it costs, exactly.** With no rows, every key is `matchKey`'s fallback: lowercased
 * `hostname + pathname`, with any port joined on as `_<port>` and the query and the fragment
 * already dropped. `hostname` and not `host`, which is the distinction `match-key.ts`'s port note
 * turns on: a port rendered `hostname:port` would let a crafted `website` synthesise a registry
 * key. That is *narrower*, never
 * wider — `matchKey` is total and errs towards not matching — so this cannot produce a wrong
 * match, only fewer right ones. It matches a stored `website` against a browsed URL for
 * Thingiverse's `thing:<id>` shape, for a trailing slash either way, and across `?lang=`,
 * `?from=recommend` and `#profileId-` variants, which is most of what the spike measured. It does
 * **not** match across MakerWorld's locale path segment or Cults3D's translated path segments, it
 * does not match a Thingiverse sub-path (`/files`) back to the model page, and it does not survive
 * a model being retitled on a site whose path is `<id>-<slug>`. A user in any of those positions
 * picks the project from the list, which is the same control a first-time download uses.
 *
 * Every clause above was measured against this code rather than reasoned about: the six
 * Thingiverse variants come out as one key, and the four that are named as non-matches come out as
 * four different ones.
 *
 * Spec 6.4 says matching runs "using `matchKey` and the site list from `browse.sites()`"; that
 * sentence cannot be implemented against the DTO the shell actually publishes, and this is the
 * honest half of it rather than a paraphrase of the whole.
 */
const NO_REGISTRY_ROWS: readonly ModelSiteIdentity[] = []

/**
 * The extensions this page will call an archive.
 *
 * Deliberately short and deliberately about the **name**, because that is all there is: spec 5.5
 * lands an archive whole and classified `kind: 'other'`, which is also what an `.ini` lands as, so
 * `FileDto.kind` cannot tell them apart. A name this misses costs a message the user did not get;
 * a name this over-claims would tell someone their `.stl` is an archive.
 */
const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.zipx']

/** Whether a landed file's name says it is an archive. See {@link ARCHIVE_EXTENSIONS}. */
export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * A stranger's string, bounded for display (constraint 13, spec 3.10).
 *
 * Angular escapes interpolated text by default, so this is not the escaping — it is the other half
 * of the same rule: a page can set a title, or produce a URL, of any length, and the app's own
 * chrome must not be re-laid-out by one. The ellipsis is what says the value was cut, so a
 * truncated URL does not read as a whole one.
 */
export function truncateForDisplay(value: string, max = BROWSE_TEXT_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Which sentence the landing panel is showing, as a kind rather than as a resolved string. */
type LandFailure = 'clash' | 'quota' | 'name' | 'gone' | 'refused'

/**
 * `AppError.code` is what the UI switches on, and `Conflict` is the one that needs a note.
 *
 * **`Conflict` is not distinguishable here and the message must not pretend it is.** `land` throws
 * it in four places: a record that cannot vouch for its bytes, a staging file whose size has moved
 * since that verdict, a local mode with no library folder open, and — through `uploadFile` — a
 * name the project already has. The page only ever offers the control for a download whose record
 * *does* vouch for it, and a window with no library open has no project list to have picked from,
 * so the clash is by far the likeliest; but "likeliest" is not "known", so the sentence names the
 * clash as a possibility, says what to do about it, and does not assert which of the four
 * happened. The shell's own message is the diagnosis and goes to the console, exactly as
 * `/settings/slicers` does with its own.
 */
function classifyLandFailure(error: unknown): LandFailure {
  if (!isAppError(error)) return 'refused'
  switch (error.code) {
    case 'Conflict':
      return 'clash'
    case 'QuotaExceeded':
      return 'quota'
    case 'Validation':
      return 'name'
    case 'NotFound':
      return 'gone'
    default:
      return 'refused'
  }
}

/**
 * The model browser: somebody else's website, in a native view this page never touches (spec E).
 *
 * **Desktop-only in the way spec 2.5 prescribes**: it lives under `features/desktop/` and is
 * referenced only from `routes.electron.ts`, so the web build physically cannot contain it — CI
 * greps both bundles for `DesktopBrowsePage` to prove it. That grep is stronger here than for any
 * other page: a browse UI in the web build would be a UI expecting a containment the browser
 * cannot provide.
 *
 * ## Both seams, and why
 *
 * `SHELL_CLIENT` for the view, its bounds, its navigation and its downloads, because those are
 * properties of *this process on this machine* and must work in both library modes. `API_CLIENT`
 * for `projects.list` and `projects.create`, because the library is whichever transport it is on.
 * A page about a machine capability that lands its result in a library is correctly a page that
 * injects both.
 *
 * ## The view is not a DOM element
 *
 * A `WebContentsView` is a native sibling of the renderer's own view. It cannot be laid out by
 * CSS, it paints over the renderer unconditionally with no z-index to negotiate, and it outlives
 * this component unless something destroys it. Three consequences are load-bearing here:
 *
 * - **All the app's own chrome is outside the placeholder's rectangle.** Anything this template
 *   draws under it would be invisible.
 * - **A modal calls `browse.hide()` first and `browse.show()` after** — never `detach`, which
 *   destroys the page the user was on.
 * - **Teardown calls `browse.detach()`.** Angular unmounting this component does nothing at all to
 *   the native view, and a view that survives a route change is a third-party page painted over
 *   the project list.
 *
 * ## Every string out of the view is a stranger's
 *
 * `title`, `url`, `lastError`, `fileName`, `sourceUrl` and `pageUrl` are rendered as **text**,
 * truncated — never into `[innerHTML]`, `bypassSecurityTrust*`, a `[href]`, a `[src]`, a CSS
 * `url()` or a `window.open`. The site links below are buttons calling `browse.navigate`, and not
 * anchors, for the same reason: the way to go somewhere is a call the main process runs through
 * `browseNavigationPolicy`, not a URL handed to Chromium in the privileged document.
 */
@Component({
  selector: 'app-desktop-browse-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    InterpolatePipe,
    JigButton,
    JigIcon,
    JigInput,
    JigInputField,
    JigMessage,
    JigSelect,
    JigSpinner,
    JigTag,
  ],
  template: `
    <main class="spm-main spm-browse">
      <div class="spm-stack">
        <div>
          <h1>{{ t.translations().browse.title }}</h1>
          <p class="spm-muted">{{ t.translations().browse.lead }}</p>
        </div>

        @if (openFailed()) {
          <jig-message color="error" role="alert">{{
            t.translations().browse.openFailed
          }}</jig-message>
        }

        <!-- Every start link is a button, not an anchor: the way to go somewhere is
             "browse.navigate", which runs the URL through the shell's own policy. -->
        <div class="spm-row" role="group" [attr.aria-label]="t.translations().browse.startOn">
          @for (site of sites(); track site.id) {
            <button jigButton kind="secondary" type="button" (click)="onOpenSite(site)">
              {{ site.displayName }}
            </button>
          }
        </div>

        <div class="spm-row spm-browse-bar">
          <button
            jigButton
            kind="icon"
            type="button"
            [disabled]="!state()?.canGoBack"
            [attr.aria-label]="t.translations().browse.back"
            (click)="onBack()"
          >
            <jig-icon [icon]="icons.back" />
          </button>
          <button
            jigButton
            kind="icon"
            type="button"
            [disabled]="!state()?.canGoForward"
            [attr.aria-label]="t.translations().browse.forward"
            (click)="onForward()"
          >
            <jig-icon [icon]="icons.forward" />
          </button>
          <button
            jigButton
            kind="icon"
            type="button"
            [attr.aria-label]="t.translations().browse.reload"
            (click)="onReload()"
          >
            <jig-icon [icon]="icons.reload" />
          </button>
          <form class="spm-row spm-grow" (submit)="onGo(); $event.preventDefault()">
            <jig-input-field
              class="spm-grow"
              [label]="t.translations().browse.addressLabel"
              labelKind="on"
            >
              <input jigInput [value]="address()" (valueChange)="address.set($event ?? '')" />
            </jig-input-field>
            <button jigButton kind="primary" type="submit">
              {{ t.translations().browse.go }}
            </button>
          </form>
        </div>

        <!--
          The current page, as text and nothing else. A "[href]" here would be the one place
          Angular's default escaping does not save the page, and the value is a stranger's.
        -->
        <p class="spm-muted spm-browse-address">
          <span>{{ displayTitle() }}</span>
          <span class="spm-code">{{ displayUrl() }}</span>
        </p>

        @if (interstitial()) {
          <!-- Spec 4.5. Not an error, not a timeout, and the view is left exactly where it is. -->
          <jig-message color="info" role="status">
            {{ t.translations().browse.verifying }}
          </jig-message>
        } @else if (state()?.isLoading) {
          <div class="spm-row" role="status">
            <jig-spinner [size]="20" />
            <span>{{ t.translations().browse.loading }}</span>
          </div>
        }

        @if (state()?.lastError; as detail) {
          <jig-message color="error" role="alert">
            <span>{{ t.translations().browse.pageFailed }}</span>
            <span class="spm-code">{{ truncate(detail) }}</span>
          </jig-message>
        }

        <!--
          The placeholder, and the whole of what this page knows about where the view goes: it
          reports this element's rectangle in CSS pixels and the main process decides what becomes
          of it. Empty on purpose — anything drawn inside it is painted over.
        -->
        <div #viewport data-browse-viewport class="spm-browse-viewport"></div>

        @if (notices().length > 0) {
          <section class="spm-card spm-stack">
            <h2>{{ t.translations().browse.noticesTitle }}</h2>
            @for (notice of notices(); track notice.id) {
              <jig-message [color]="notice.kind === 'refused' ? 'warning' : 'info'" role="status">
                <div class="spm-stack spm-stack--tight">
                  <span class="spm-code">{{ truncate(notice.fileName) }}</span>
                  <span>{{ truncate(notice.detail) }}</span>
                  <span>
                    <button jigButton kind="text" type="button" (click)="onDismiss(notice.id)">
                      {{ t.translations().browse.dismiss }}
                    </button>
                    @if (notice.kind === 'refused' && discardableCount() > 0) {
                      <!--
                        Beside a refusal, because a refusal is what "there is no room" looks like
                        from the user's side. It names its own count, and it leaves a still-running
                        download alone: "discard" refuses one of those with "Conflict".
                      -->
                      <button
                        jigButton
                        kind="secondary"
                        color="error"
                        type="button"
                        (click)="onMakeRoom()"
                      >
                        {{
                          t.translations().browse.makeRoom
                            | interpolate: { count: discardableCount() }
                        }}
                      </button>
                    }
                  </span>
                </div>
              </jig-message>
            }
          </section>
        }

        <section class="spm-card spm-stack">
          <h2>{{ t.translations().browse.downloadsTitle }}</h2>
          @if (downloads().length === 0) {
            <p class="spm-muted">{{ t.translations().browse.downloadsNone }}</p>
          }
          @for (item of downloads(); track item.downloadId) {
            <div class="spm-stack spm-stack--tight spm-browse-download">
              <span class="spm-row">
                <span class="spm-code spm-grow">{{ truncate(item.fileName) }}</span>
                @if (item.isOrphan) {
                  <jig-tag>{{ t.translations().browse.downloadOrphan }}</jig-tag>
                }
              </span>
              <!-- "pageUrl" is null for a popup download and is its own case, never a blank
                   field. Spec 6.3, measured in task 3. -->
              @if (item.pageUrl; as page) {
                <span class="spm-muted">{{
                  t.translations().browse.fromPage | interpolate: { url: truncate(page) }
                }}</span>
              } @else {
                <span class="spm-muted">{{ t.translations().browse.fromNoPage }}</span>
              }
              @if (item.state === 'progressing') {
                <span class="spm-muted">{{
                  t.translations().browse.downloadRunning
                    | interpolate
                      : {
                          received: bytes(item.receivedBytes),
                          total: bytes(item.totalBytes),
                        }
                }}</span>
              } @else if (!item.isVerifiable) {
                <jig-message color="warning" role="status">
                  {{ t.translations().browse.downloadUnverifiable }}
                </jig-message>
              } @else if (item.state !== 'completed') {
                <jig-message color="warning" role="status">
                  {{ t.translations().browse.downloadFailed }}
                </jig-message>
              }
              <span>
                @if (item.state === 'completed' && item.isVerifiable) {
                  <button jigButton kind="primary" type="button" (click)="onOpenLanding(item)">
                    {{ t.translations().browse.addToProject }}
                  </button>
                }
                @if (item.state !== 'progressing') {
                  <button
                    jigButton
                    kind="text"
                    color="error"
                    type="button"
                    (click)="onDiscard(item.downloadId)"
                  >
                    <jig-icon [icon]="icons.discard" />
                    {{ t.translations().browse.discard }}
                  </button>
                }
              </span>
            </div>
          }
        </section>

        @if (landing(); as item) {
          <!--
            The landing panel. It is a modal in the only sense that matters here: the native view is
            hidden while it is up ("onOpenLanding"), and put back when it closes. Its shape is
            "choose a project" with "create a new project" beside it, never a fallback reached after
            a failure — a first-time download matches nothing by definition, because the project
            does not exist yet, which is why the user was on the site.
          -->
          <section class="spm-card spm-stack" role="dialog" aria-modal="true">
            <h2 class="spm-code">{{ truncate(item.fileName) }}</h2>
            @if (item.pageUrl; as page) {
              <p class="spm-muted">
                {{ t.translations().browse.fromPage | interpolate: { url: truncate(page) } }}
              </p>
            } @else {
              <jig-message color="info" role="status">
                {{ t.translations().browse.fromNoPage }}
              </jig-message>
            }

            @if (landFailureMessage(); as message) {
              <jig-message color="error" role="alert">{{ message }}</jig-message>
            }

            <jig-input-field
              class="spm-block"
              inputId="browse-file-name"
              [label]="t.translations().browse.fileNameLabel"
            >
              <input jigInput [value]="fileName()" (valueChange)="fileName.set($event ?? '')" />
            </jig-input-field>

            @if (suggestedProjectIds().length > 0) {
              <!-- A suggestion the user confirms, never applied silently: "matchKey" is derived
                   rather than measured, and a wrong silent match puts someone's file in someone
                   else's project. -->
              <jig-message color="info" role="status">
                {{ t.translations().browse.suggestedLead }}
              </jig-message>
            }

            @if (projectOptions().length > 0) {
              <jig-input-field
                class="spm-block"
                inputId="browse-project"
                [label]="t.translations().browse.chooseProject"
              >
                <jig-select
                  inputId="browse-project"
                  [label]="t.translations().browse.chooseProject"
                  [options]="projectOptions()"
                  [placeholder]="t.translations().browse.chooseProjectPlaceholder"
                  [value]="selectedProjectId()"
                  (valueChange)="selectedProjectId.set($event)"
                />
              </jig-input-field>
              <span>
                <button
                  jigButton
                  kind="primary"
                  type="button"
                  [disabled]="busy() || selectedProjectId() === null"
                  (click)="onLand()"
                >
                  {{ t.translations().browse.addHere }}
                </button>
              </span>
            } @else {
              <p class="spm-muted">{{ t.translations().browse.noProjects }}</p>
            }

            <form
              class="spm-stack spm-stack--tight"
              (submit)="onCreateAndLand(); $event.preventDefault()"
            >
              <h3>{{ t.translations().browse.orCreate }}</h3>
              <jig-input-field
                class="spm-block"
                inputId="browse-new-project"
                [label]="t.translations().browse.newProjectName"
              >
                <input
                  jigInput
                  [value]="newProjectName()"
                  (valueChange)="newProjectName.set($event ?? '')"
                />
              </jig-input-field>
              <span>
                <button
                  jigButton
                  kind="secondary"
                  type="submit"
                  [disabled]="busy() || newProjectName().trim() === ''"
                >
                  {{ t.translations().browse.createAndAdd }}
                </button>
              </span>
            </form>

            <span>
              <button jigButton kind="text" type="button" (click)="onCloseLanding()">
                {{ t.translations().browse.cancel }}
              </button>
              @if (busy()) {
                <jig-spinner [size]="20" />
              }
            </span>
          </section>
        }

        @if (landed(); as result) {
          <section class="spm-card spm-stack" role="dialog" aria-modal="true">
            <p>
              {{
                t.translations().browse.landed
                  | interpolate: { name: truncate(result.file.name), project: result.projectName }
              }}
            </p>
            @if (isArchive(result.file.name)) {
              <!--
                Spec 5.5 and open question 9.1, and this is not a nicety: it is the whole reason
                the extraction deferral is honest. The two sentences are chosen off
                "canPickLocalFolder", which is the capability spec 5.5's own argument rests on —
                false in the remote column means there is no folder on this machine to unzip into.
              -->
              <jig-message color="warning" role="status">
                {{
                  capabilities.capabilities().canPickLocalFolder
                    ? t.translations().browse.archiveLocal
                    : t.translations().browse.archiveRemote
                }}
              </jig-message>
            }
            <span>
              <button jigButton kind="primary" type="button" (click)="onCloseResult()">
                {{ t.translations().browse.close }}
              </button>
            </span>
          </section>
        }

        <span>
          <!-- Open question 9.9: "attach" reopens on the page the last session left, which is one
               entry of persisted third-party browsing history the user did not ask for. This is
               the only thing that removes it. -->
          <button jigButton kind="text" type="button" (click)="onForgetLastPage()">
            {{ t.translations().browse.forgetLastPage }}
          </button>
        </span>
        <p class="spm-muted">{{ t.translations().browse.forgetLastPageHint }}</p>
      </div>
    </main>
  `,
})
export class DesktopBrowsePage {
  private readonly shell = inject(SHELL_CLIENT)
  private readonly api = inject(API_CLIENT)
  protected readonly capabilities = inject(CapabilitiesStore)
  protected readonly t = inject(TranslateService)

  protected readonly icons = {
    back: tablerArrowLeft,
    forward: tablerArrowRight,
    reload: tablerRefresh,
    discard: tablerTrash,
  }

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport')

  // Writable in here, readable everywhere else — `CapabilitiesStore`'s convention.
  readonly #state = signal<BrowseStateDto | null>(null)
  readonly #sites = signal<ModelSiteDto[]>([])
  readonly #downloads = signal<BrowseDownloadDto[]>([])
  readonly #notices = signal<BrowseNoticeDto[]>([])
  readonly #projects = signal<ProjectDto[]>([])
  readonly #landing = signal<BrowseDownloadDto | null>(null)
  readonly #landed = signal<{ file: FileDto; projectName: string } | null>(null)
  readonly #landFailure = signal<LandFailure | null>(null)
  readonly #openFailed = signal(false)
  readonly #busy = signal(false)
  /** Consecutive polls that came back loading. See {@link BROWSE_INTERSTITIAL_TICKS}. */
  readonly #loadingPolls = signal(0)

  readonly state = this.#state.asReadonly()
  readonly sites = this.#sites.asReadonly()
  readonly downloads = this.#downloads.asReadonly()
  readonly notices = this.#notices.asReadonly()
  readonly projects = this.#projects.asReadonly()
  readonly landing = this.#landing.asReadonly()
  readonly landed = this.#landed.asReadonly()
  readonly openFailed = this.#openFailed.asReadonly()
  readonly busy = this.#busy.asReadonly()
  /**
   * Readable so a spec can say where in the sequence it is rather than counting refreshes.
   *
   * The count matters to the spec because the interstitial is the one piece of behaviour on this
   * page that a clock could have driven, and a clock is what CI has twice caught here.
   */
  readonly loadingPolls = this.#loadingPolls.asReadonly()

  /** The address control's own text. Not the view's URL: the user is allowed to edit it. */
  readonly address = signal('')
  readonly fileName = signal('')
  readonly newProjectName = signal('')
  readonly selectedProjectId = signal<string | null>(null)

  /**
   * Resolves once the first attach has settled, so a spec can await it rather than counting
   * microtasks. The same device `DesktopSlicersPage.ready` is, for the same reason.
   */
  readonly ready: Promise<void>

  /** The rectangle last reported, so a scroll that moved nothing costs no IPC. */
  #lastBounds: BrowseBounds | null = null
  #poll: ReturnType<typeof setInterval> | null = null
  #observer: ResizeObserver | null = null

  readonly #onWindowChange = (): void => this.reportBounds()

  constructor() {
    // `Promise.withResolvers` is ES2024 and this project's lib target is older; the executor is
    // the same shape with one more line.
    let settle = (): void => {}
    this.ready = new Promise<void>((resolve) => {
      settle = resolve
    })
    // After the first render, so the placeholder exists and `attach` is given the rectangle the
    // view is actually going to. Attaching from the constructor would hand the shell a zero rect,
    // which spec 4.2 reads as a request to hide.
    //
    // `#open` never rejects — it catches — so one arm is enough here and a `catch` arm would be a
    // line no test could ever reach.
    afterNextRender(() => void this.#open().then(settle))
    inject(DestroyRef).onDestroy(() => this.#close())
  }

  protected readonly displayUrl = computed(() => {
    const url = this.state()?.url
    return url ? truncateForDisplay(url) : this.t.translations().browse.noPage
  })

  protected readonly displayTitle = computed(() => {
    const title = this.state()?.title
    return title ? truncateForDisplay(title) : this.t.translations().browse.untitled
  })

  /** Spec 4.5: past the count the wording changes and nothing else does. */
  protected readonly interstitial = computed(
    () => this.state()?.isLoading === true && this.#loadingPolls() >= BROWSE_INTERSTITIAL_TICKS,
  )

  /**
   * The projects whose `website` keys the same as the page this download came from, by name.
   *
   * Empty for a `pageUrl` of `null`, and that is the popup case rather than a failure to match:
   * there is no input, so there is nothing to suggest. Empty is also the ordinary first-time case.
   */
  readonly suggestedProjectIds = computed(() => {
    const page = this.#landing()?.pageUrl ?? null
    if (page === null) return []
    const key = matchKey(page, NO_REGISTRY_ROWS)
    return this.#byName()
      .filter(
        (project) =>
          project.website !== undefined && matchKey(project.website, NO_REGISTRY_ROWS) === key,
      )
      .map((project) => project.id)
  })

  protected readonly projectOptions = computed(() =>
    this.#byName().map((project) => ({ label: project.name, value: project.id })),
  )

  /** Downloads `discard` will actually take: it refuses a still-running one with `Conflict`. */
  protected readonly discardableCount = computed(
    () => this.downloads().filter((item) => item.state !== 'progressing').length,
  )

  protected readonly landFailureMessage = computed(() => {
    const kind = this.#landFailure()
    if (kind === null) return null
    const strings = this.t.translations().browse
    switch (kind) {
      case 'clash':
        return strings.errorClash
      case 'quota':
        return strings.errorQuota
      case 'name':
        return strings.errorName
      case 'gone':
        return strings.errorGone
      case 'refused':
        return strings.errorRefused
    }
  })

  protected truncate(value: string): string {
    return truncateForDisplay(value)
  }

  protected bytes(value: number): string {
    return formatBytes(value)
  }

  protected isArchive(name: string): boolean {
    return isArchiveName(name)
  }

  /**
   * One poll: what the view is doing, what is staged, and what the shell has to say out of band.
   *
   * Public because the specs drive it directly rather than waiting on the interval — what the
   * interstitial depends on is the *count* of consecutive loading answers, which is ordering, and
   * a test that slept for it would be the wall-clock assertion CI has twice caught.
   */
  async refresh(): Promise<void> {
    try {
      const [state, downloads, notices] = await Promise.all([
        this.shell.browse.state(),
        this.shell.browse.downloads(),
        this.shell.browse.notices(),
      ])
      this.#loadingPolls.update((polls) => (state.isLoading ? polls + 1 : 0))
      this.#state.set(state)
      this.#downloads.set(downloads)
      this.#notices.set(notices)
    } catch (error) {
      // A poll that failed is not worth a banner — the next one is 500 ms away — but it is worth
      // the one line of diagnosis this app's other failures get.
      console.error('browse: a poll failed', error)
    }
  }

  /** Spec 4.2: the renderer owns the intent, the main process owns the rectangle. */
  reportBounds(): void {
    const bounds = this.#currentBounds()
    if (bounds === null) return
    const last = this.#lastBounds
    if (
      last !== null &&
      last.x === bounds.x &&
      last.y === bounds.y &&
      last.width === bounds.width &&
      last.height === bounds.height
    ) {
      return
    }
    this.#lastBounds = bounds
    void this.shell.browse.setBounds(bounds).catch((error: unknown) => {
      console.error('browse: reporting the view bounds failed', error)
    })
  }

  async onOpenSite(site: ModelSiteDto): Promise<void> {
    await this.#go(() => this.shell.browse.navigate(site.homeUrl))
  }

  async onGo(): Promise<void> {
    const url = this.address().trim()
    if (url === '') return
    await this.#go(() => this.shell.browse.navigate(url))
  }

  async onBack(): Promise<void> {
    await this.#go(() => this.shell.browse.back())
  }

  async onForward(): Promise<void> {
    await this.#go(() => this.shell.browse.forward())
  }

  async onReload(): Promise<void> {
    await this.#go(() => this.shell.browse.reload())
  }

  async onForgetLastPage(): Promise<void> {
    try {
      await this.shell.browse.clearLastPage()
    } catch (error) {
      console.error('browse: forgetting the last page failed', error)
    }
  }

  async onDismiss(id: string): Promise<void> {
    try {
      await this.shell.browse.dismissNotice(id)
    } catch (error) {
      console.error('browse: dismissing a notice failed', error)
    }
    await this.refresh()
  }

  async onDiscard(downloadId: string): Promise<void> {
    try {
      await this.shell.browse.discard(downloadId)
    } catch (error) {
      // The measured refusal: `discard` answers `Conflict` for a download that is still running,
      // because removing the directory would not stop Chromium writing to the path it already
      // has. The row's own control is not offered for one, so this is the race rather than the
      // ordinary case, and the next poll shows what really happened.
      console.error('browse: discarding a staged download failed', error)
    }
    await this.refresh()
  }

  /** Everything `discard` will take. A still-running download is left where it is. */
  async onMakeRoom(): Promise<void> {
    for (const item of this.downloads()) {
      if (item.state === 'progressing') continue
      await this.onDiscard(item.downloadId)
    }
  }

  /**
   * Opens the landing panel, which means hiding the view first.
   *
   * **`hide`, never `detach`.** The view paints over the renderer unconditionally, so the panel
   * below it would be invisible; `detach` would also make it visible, and would throw away the
   * page the user was on to do it.
   */
  async onOpenLanding(item: BrowseDownloadDto): Promise<void> {
    this.#landFailure.set(null)
    this.#landed.set(null)
    this.fileName.set(item.fileName)
    this.newProjectName.set('')
    this.#landing.set(item)
    await this.#hide()
    await this.#loadProjects()
    // Preselected, never applied: the user confirms it. Only after the list has landed, or there
    // would be nothing to select from.
    this.selectedProjectId.set(this.suggestedProjectIds()[0] ?? null)
  }

  async onCloseLanding(): Promise<void> {
    this.#landing.set(null)
    this.#landFailure.set(null)
    await this.#show()
  }

  async onCloseResult(): Promise<void> {
    this.#landed.set(null)
    await this.#show()
  }

  async onLand(): Promise<void> {
    const projectId = this.selectedProjectId()
    if (projectId === null) return
    const name = this.#projects().find((project) => project.id === projectId)?.name ?? ''
    await this.#land(projectId, name)
  }

  /**
   * Creates a project and lands into it — the first-class option beside choosing one, not a
   * fallback reached after a failure.
   *
   * The new project's `website` is the canonical URL of the page the download came from, which is
   * what makes the *second* download from that model match. For a popup download there is no such
   * URL, and the key is left off entirely rather than sent as `null` or as an empty string: a
   * `website` invented here is a `website` a later download would match against wrongly.
   */
  async onCreateAndLand(): Promise<void> {
    const name = this.newProjectName().trim()
    if (name === '' || this.busy()) return
    const pageUrl = this.#landing()?.pageUrl ?? null
    this.#busy.set(true)
    this.#landFailure.set(null)
    let project: ProjectDto
    try {
      project = await this.api.projects.create(
        pageUrl === null ? { name } : { name, website: pageUrl },
      )
    } catch (error) {
      this.#landFailure.set(classifyLandFailure(error))
      console.error('browse: creating a project for a download failed', error)
      this.#busy.set(false)
      return
    }
    this.#busy.set(false)
    await this.#land(project.id, project.name)
  }

  async #land(projectId: string, projectName: string): Promise<void> {
    const item = this.#landing()
    if (item === null || this.busy()) return
    this.#busy.set(true)
    this.#landFailure.set(null)
    try {
      const file = await this.shell.browse.land(item.downloadId, projectId, {
        name: this.fileName(),
      })
      this.#landing.set(null)
      // The view stays hidden: the result panel — and the archive obligation it may carry — is
      // drawn where the view would paint over it. `onCloseResult` puts the view back.
      this.#landed.set({ file, projectName })
    } catch (error) {
      // Reported and not worked around. The panel stays open with the name field in it, which is
      // the whole remedy for a clash: `benchy-1.zip` beside `benchy.zip` would hide exactly the
      // fact the user was trying to discover.
      this.#landFailure.set(classifyLandFailure(error))
      console.error('browse: landing a download failed', error)
    } finally {
      this.#busy.set(false)
    }
    await this.refresh()
  }

  async #go(call: () => Promise<BrowseStateDto>): Promise<void> {
    try {
      const state = await call()
      this.#loadingPolls.set(0)
      this.#state.set(state)
      this.address.set(state.url ?? '')
    } catch (error) {
      // `navigate` refuses a URL `browseNavigationPolicy` blocks, in the main process, with a
      // `Validation`. The next poll carries `lastError` if the load itself failed instead.
      console.error('browse: a navigation was refused', error)
    }
  }

  async #open(): Promise<void> {
    try {
      const [sites, state] = await Promise.all([
        this.shell.browse.sites(),
        this.shell.browse.attach(this.#currentBounds() ?? { x: 0, y: 0, width: 0, height: 0 }),
      ])
      this.#lastBounds = this.#currentBounds()
      this.#sites.set(sites)
      this.#state.set(state)
      this.address.set(state.url ?? '')
    } catch (error) {
      this.#openFailed.set(true)
      console.error('browse: the model browser could not be opened', error)
      return
    }
    await Promise.all([this.#loadProjects(), this.refresh()])
    window.addEventListener('resize', this.#onWindowChange)
    // Passive: this only reads a rectangle, and a scroll listener that can call `preventDefault`
    // is a scroll listener Chromium has to wait for.
    window.addEventListener('scroll', this.#onWindowChange, { passive: true })
    const element = this.viewport()?.nativeElement
    // Guarded because jsdom has no `ResizeObserver`, and because the two window events above are
    // the coarse half of the same report: an element that changes size without the window doing
    // so — a panel above it opening — is what this one adds.
    if (element && typeof ResizeObserver !== 'undefined') {
      this.#observer = new ResizeObserver(() => this.reportBounds())
      this.#observer.observe(element)
    }
    this.#poll = setInterval(() => void this.refresh(), BROWSE_POLL_MS)
  }

  /**
   * Teardown, and `detach` is the point of it.
   *
   * Angular unmounting this component does nothing at all to a native sibling view, so without
   * this the user's next route is a project list with a third-party page painted over it.
   */
  #close(): void {
    if (this.#poll !== null) clearInterval(this.#poll)
    this.#poll = null
    this.#observer?.disconnect()
    this.#observer = null
    window.removeEventListener('resize', this.#onWindowChange)
    window.removeEventListener('scroll', this.#onWindowChange)
    void this.shell.browse.detach().catch((error: unknown) => {
      console.error('browse: detaching the view failed', error)
    })
  }

  async #hide(): Promise<void> {
    try {
      await this.shell.browse.hide()
    } catch (error) {
      console.error('browse: hiding the view failed', error)
    }
  }

  async #show(): Promise<void> {
    try {
      this.#state.set(await this.shell.browse.show())
    } catch (error) {
      console.error('browse: showing the view failed', error)
    }
  }

  async #loadProjects(): Promise<void> {
    try {
      // `includeArchived`, because a project the user archived is still a project this model
      // belongs to, and landing a file into it is a better answer than a duplicate beside it.
      this.#projects.set(await this.api.projects.list({ includeArchived: true }))
    } catch (error) {
      console.error('browse: the project list could not be read', error)
    }
  }

  #byName(): ProjectDto[] {
    return [...this.#projects()].sort((a, b) => a.name.localeCompare(b.name))
  }

  #currentBounds(): BrowseBounds | null {
    const element = this.viewport()?.nativeElement
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
}
